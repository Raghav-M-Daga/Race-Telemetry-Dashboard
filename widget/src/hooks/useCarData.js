import { useEffect, useRef, useState } from 'react'
import {
  SERVER_ENDPOINT,
  SENSOR_IDS,
  SHOCK_SENSOR_IDS,
  SMOOTHING_ALPHA,
  STALE_AFTER_MS,
  UNSMOOTHED_FIELDS,
} from '../config.js'
import { RAD_TO_DEG, toCompassBearing, unwrapHeading } from '../lib/vehicle.js'

/** Connection states surfaced to the UI. */
export const LINK_STATE = {
  CONNECTING: 'connecting',
  LIVE: 'live',
  STALE: 'stale', // connected, but the replay is paused between loops
  DISCONNECTED: 'disconnected',
}

const EMPTY_READINGS = {
  steeringAngle: 0,
  lateralAcceleration: 0,
  yawRate: 0, // deg/s
  globalHeading: 0, // 0..360
  headingUnwrapped: 0, // continuous across the 0/360 seam, for CSS rotation
  speed: 0, // m/s, forward (velocityBody.x)
  lateralVelocity: 0, // m/s, sideways (velocityBody.y)
  latitude: 0,
  longitude: 0,
  throttle: 0, // 0..1
  // Derived per tick rather than read from a sensor: how fast the driver is
  // moving the wheel. Lives here with the other readings because it is an
  // instantaneous property of the car, not a coaching judgement.
  steeringRate: 0, // deg of steering wheel per second
  shock_fl: null,
  shock_fr: null,
  shock_rl: null,
  shock_rr: null,
}

// Reverse lookup: sensor id -> the readings key it feeds. Built once so the hot
// path is a map lookup per sample instead of a chain of comparisons.
const ID_TO_FIELD = new Map()
for (const [field, id] of Object.entries({ ...SENSOR_IDS, ...SHOCK_SENSOR_IDS })) {
  if (id !== null && id !== undefined) ID_TO_FIELD.set(id, field)
}

/**
 * Convert a raw sample to the unit the dashboard displays.
 * Everything else passes through untouched.
 */
function toDisplayUnits(field, rawValue) {
  // compensatedAngularRate.z is radians/s on the wire; the dashboard is deg/s.
  // Verified against the log: peaks of ~2.3 rad/s = ~135 deg/s, which is a
  // believable FSAE yaw rate, whereas 2.3 deg/s would be nearly straight-line.
  if (field === 'yawRate') return rawValue * RAD_TO_DEG
  return rawValue
}

/**
 * Subscribe to the PER replay server and expose the latest vehicle-dynamics
 * readings, already converted to display units and lightly smoothed.
 *
 * The server pushes ~108 samples every 50 ms. Rather than calling setState per
 * sample, each tick is reduced to one mean value per sensor and committed as a
 * single state update — a proper decimation that also kills a lot of IMU noise.
 */
export function useCarData() {
  const [readings, setReadings] = useState(EMPTY_READINGS)
  const [linkState, setLinkState] = useState(LINK_STATE.CONNECTING)
  const [tickCount, setTickCount] = useState(0)
  // The raw frame, passed straight through for the coaching engine, which does
  // its own conditioning rather than reusing the display smoothing.
  const [rawTick, setRawTick] = useState(null)

  // Smoothed values live in a ref: they carry across ticks but must not
  // re-trigger the effect that owns the EventSource.
  const smoothedRef = useRef({ ...EMPTY_READINGS })
  const lastMessageAtRef = useRef(0)
  // Fields that have received at least one real sample. The first sample for a
  // field is taken as-is; without this the EMA would drag every needle up from
  // zero over the first ~10 ticks, which looks like data that isn't there.
  const seededFieldsRef = useRef(new Set())
  // Previous steering angle + wall clock, for the steering-rate derivative.
  const previousSteeringRef = useRef({ angle: null, at: 0 })

  useEffect(() => {
    const source = new EventSource(SERVER_ENDPOINT)

    source.onopen = () => setLinkState(LINK_STATE.LIVE)

    source.onmessage = (event) => {
      let tick
      try {
        tick = JSON.parse(event.data)
      } catch {
        return // ignore a malformed frame rather than tearing down the stream
      }
      if (!tick?.id?.length) return

      // Accumulate sum + count per field so we can average within the tick.
      const sums = {}
      const counts = {}
      for (let i = 0; i < tick.id.length; i++) {
        const field = ID_TO_FIELD.get(tick.id[i])
        if (field === undefined) continue
        const value = tick.v[i]
        if (!Number.isFinite(value)) continue
        sums[field] = (sums[field] ?? 0) + value
        counts[field] = (counts[field] ?? 0) + 1
      }

      const previous = smoothedRef.current
      const next = { ...previous }

      for (const field of Object.keys(counts)) {
        const tickMean = toDisplayUnits(field, sums[field] / counts[field])

        if (field === 'globalHeading') {
          // Heading is circular, so an EMA across the seam would be wrong.
          // Track it unwrapped instead and let the transition handle the rest.
          const bearing = toCompassBearing(tickMean)
          next.headingUnwrapped = unwrapHeading(previous.headingUnwrapped, bearing)
          next.globalHeading = bearing
          continue
        }

        // Position is excluded from smoothing: the INS has already filtered it,
        // and another 150 ms lag would drag every map point metres behind the car.
        if (UNSMOOTHED_FIELDS.has(field)) {
          next[field] = tickMean
          continue
        }

        if (seededFieldsRef.current.has(field)) {
          next[field] = previous[field] + SMOOTHING_ALPHA * (tickMean - previous[field])
        } else {
          next[field] = tickMean
          seededFieldsRef.current.add(field)
        }
      }

      // Steering rate, from the smoothed angle so it isn't dominated by noise.
      // dt is guarded: a stalled or duplicated tick would otherwise divide by
      // ~0 and produce a spike that reads as violent steering.
      const now = Date.now()
      const previousSteering = previousSteeringRef.current
      if (previousSteering.angle !== null) {
        const dt = (now - previousSteering.at) / 1000
        if (dt > 0.005 && dt < 1) {
          next.steeringRate = (next.steeringAngle - previousSteering.angle) / dt
        }
      }
      previousSteering.angle = next.steeringAngle
      previousSteering.at = now

      smoothedRef.current = next
      lastMessageAtRef.current = Date.now()
      setRawTick(tick)
      setReadings(next)
      setTickCount((count) => count + 1)
      setLinkState(LINK_STATE.LIVE)
    }

    // EventSource reconnects on its own; we just reflect the outage in the UI
    // and keep the last known values on screen.
    source.onerror = () => {
      setLinkState(
        source.readyState === EventSource.CLOSED
          ? LINK_STATE.DISCONNECTED
          : LINK_STATE.CONNECTING,
      )
    }

    // Watchdog: the socket can stay open while data stops (the replay pauses
    // ~10 s each time it loops), which onerror never reports.
    const watchdog = setInterval(() => {
      if (!lastMessageAtRef.current) return
      if (Date.now() - lastMessageAtRef.current > STALE_AFTER_MS) {
        setLinkState((current) =>
          current === LINK_STATE.LIVE ? LINK_STATE.STALE : current,
        )
      }
    }, 500)

    return () => {
      clearInterval(watchdog)
      source.close()
    }
  }, [])

  return { readings, linkState, tickCount, rawTick }
}

/**
 * Integration test: connects to the REAL PER server and pushes real ticks
 * through the same code the browser runs.
 *
 * Start the server first, then: npm run test:live
 * (Unit tests need no server: npm run test:unit)
 */

import http from 'node:http'
import { close, equal, report, suite, truthy } from './harness.mjs'
import {
  SENSOR_IDS, SERVER_ENDPOINT, SMOOTHING_ALPHA, UNSMOOTHED_FIELDS,
  AY_BINS, STEADY_STATE_MAX_YAW_ACCEL_DEG_S2,
} from '../src/config.js'
import { RAD_TO_DEG, toCompassBearing, unwrapHeading } from '../src/lib/vehicle.js'
import { handlingBalance, ayBinIndex, median } from '../src/lib/handling.js'
import { createProjection, isValidFix, cellKey } from '../src/lib/geo.js'
import { createLapDetector, formatLapTime } from '../src/lib/lapTiming.js'
import { percentileOf } from '../src/engine/track.js'

const TARGET_TICKS = Number(process.env.TICKS ?? 3000) // ~150 s of replay
const TIMEOUT_MS = 300000

const ID_TO_FIELD = new Map(Object.entries(SENSOR_IDS).map(([field, id]) => [id, field]))
const FRAME_SEPARATOR = /\r?\n\r?\n/

const state = {
  steeringAngle: 0, lateralAcceleration: 0, yawRate: 0, globalHeading: 0,
  headingUnwrapped: 0, speed: 0, lateralVelocity: 0, latitude: 0, longitude: 0, throttle: 0,
}
const seeded = new Set()
// Every field that arrived at least once. Tracked separately from `seeded`
// because heading and position deliberately bypass the smoothing path, so
// `seeded` is not the same thing as "was this channel present in the stream".
const seenFields = new Set()

const stats = {
  ticks: 0, samples: 0, validFixes: 0, unwrapJumps: 0, nonFinite: 0,
  bins: AY_BINS.map(() => []), gripSamples: [],
  cells: new Set(), speeds: [], slips: [], gatedSlips: [],
}
let projection = null
const detector = createLapDetector()
const lapTimes = []
let lapStart = null
let previousSteering = { angle: null, at: 0, rate: 0 }
let previousYaw = { rate: null, at: 0, accel: 0 }

function handleTick(tick) {
  stats.samples += tick.id.length

  // --- exactly what useCarData does: mean per field per tick, then EMA -------
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
  for (const field of Object.keys(counts)) {
    seenFields.add(field)
    let mean = sums[field] / counts[field]
    if (field === 'yawRate') mean *= RAD_TO_DEG
    if (field === 'globalHeading') {
      const bearing = toCompassBearing(mean)
      const unwrapped = unwrapHeading(state.headingUnwrapped, bearing)
      if (Math.abs(unwrapped - state.headingUnwrapped) > 180) stats.unwrapJumps++
      state.headingUnwrapped = unwrapped
      state.globalHeading = bearing
      continue
    }
    if (UNSMOOTHED_FIELDS.has(field)) { state[field] = mean; continue }
    if (seeded.has(field)) state[field] += SMOOTHING_ALPHA * (mean - state[field])
    else { state[field] = mean; seeded.add(field) }
  }
  for (const value of Object.values(state)) if (!Number.isFinite(value)) stats.nonFinite++

  const now = stats.ticks * 50 // the server's own 50 ms cadence

  // --- steering rate --------------------------------------------------------
  if (previousSteering.angle !== null) {
    const dt = (now - previousSteering.at) / 1000
    if (dt > 0.005 && dt < 1) previousSteering.rate = (state.steeringAngle - previousSteering.angle) / dt
  }
  previousSteering.angle = state.steeringAngle
  previousSteering.at = now

  // --- handling balance + the steady-state gate -----------------------------
  if (previousYaw.rate !== null) {
    const dt = (now - previousYaw.at) / 1000
    if (dt > 0) previousYaw.accel += SMOOTHING_ALPHA * ((state.yawRate - previousYaw.rate) / dt - previousYaw.accel)
  }
  previousYaw.rate = state.yawRate
  previousYaw.at = now
  const balance = handlingBalance(state)
  if (balance.isCornering && Math.abs(previousYaw.accel) <= STEADY_STATE_MAX_YAW_ACCEL_DEG_S2) {
    const bin = ayBinIndex(state.lateralAcceleration)
    if (bin >= 0) stats.bins[bin].push(balance.signedBalance)
  }

  // --- speed, slip and the measured grip limit ------------------------------
  if (state.speed > 8 && Math.abs(state.lateralAcceleration) > 1) {
    stats.gripSamples.push(Math.abs(state.lateralAcceleration))
  }
  // Body slip angle: where the car is pointing versus where it is going. Same
  // definition engine/derive.js uses, computed here from the smoothed state so
  // this test exercises the decode path rather than the engine's own filtering.
  const slip = state.speed > 1
    ? Math.atan2(state.lateralVelocity, state.speed) * RAD_TO_DEG
    : 0
  // No seed constant: until enough samples exist there simply is no limit, and
  // the gate below is skipped rather than applied against a guess.
  const gripLimit = stats.gripSamples.length > 600
    ? percentileOf(stats.gripSamples, 0.99)
    : 0
  if (state.speed > 8) {
    stats.speeds.push(state.speed)
    stats.slips.push(Math.abs(slip))
    // Slip as the engine actually consumes it: only where the tyres are
    // working. The raw channel has a ~4% tail of INS dropouts reaching tens of
    // degrees, so a percentile over all of it measures the sensor, not the car.
    if (gripLimit > 0 && Math.abs(state.lateralAcceleration) / gripLimit > 0.4) {
      stats.gatedSlips.push(Math.abs(slip))
    }
  }

  // --- track map ------------------------------------------------------------
  if (isValidFix(state.latitude, state.longitude)) {
    stats.validFixes++
    if (!projection) projection = createProjection(state.latitude, state.longitude)
    const { x, y } = projection.toLocal(state.latitude, state.longitude)
    stats.cells.add(cellKey(x, y))
    const elapsed = now / 1000
    if (detector.update(x, y, state.speed, elapsed)) {
      if (lapStart !== null) lapTimes.push(elapsed - lapStart)
      lapStart = elapsed
    }
  }

  stats.ticks++
}

function runAssertions() {
  suite('Stream and decoding')
  truthy(`received ${stats.ticks} ticks`, stats.ticks >= TARGET_TICKS)
  truthy(`~110 samples per tick (got ${(stats.samples / stats.ticks).toFixed(0)})`,
    stats.samples / stats.ticks > 50)
  equal('no non-finite value ever reached the UI state', stats.nonFinite, 0)
  const configured = Object.keys(SENSOR_IDS)
  const missing = configured.filter((field) => !seenFields.has(field))
  equal(`all ${configured.length} configured channels appeared in the stream`, missing, [])

  suite('Derived values stay physical')
  const p99Speed = percentileOf(stats.speeds, 0.99)
  truthy(`top speed is plausible for FSAE (${p99Speed.toFixed(1)} m/s)`, p99Speed > 15 && p99Speed < 40)
  const gripLimit = percentileOf(stats.gripSamples, 0.99)
  truthy(`learned grip limit is plausible (${(gripLimit / 9.81).toFixed(2)} g)`,
    gripLimit > 8 && gripLimit < 25)
  // Raw slip is reported for visibility but NOT asserted: the channel's dropout
  // tail is a known sensor defect, and a percentile over it measures the
  // VectorNav rather than the driving.
  console.log(`       raw slip p95 = ${percentileOf(stats.slips, 0.95).toFixed(2)} deg ` +
    `(includes the known INS dropout tail)`)
  // The gate needs a measured grip limit, and that needs enough loaded samples
  // to exist. A short window (npm run test:live with a small TICKS) legitimately
  // may not contain them — so this reports "too thin" rather than failing, in
  // the same way the handling bands below do. Asserting on an empty sample and
  // calling the pass meaningful would be worse than not asserting at all.
  if (stats.gatedSlips.length < 100) {
    console.log(`       slip gate not armed in this window `
      + `(${stats.gatedSlips.length} loaded samples, needs 100) — too thin to assert`)
    console.log('       run the default TICKS=3000 window to exercise it')
  } else {
    const gatedP95 = percentileOf(stats.gatedSlips, 0.95)
    console.log(`       slip where the tyres are actually loaded: p95 = ${gatedP95.toFixed(2)} deg`)
    // The whole point of the gate: the raw channel's p95 is tens of degrees
    // because of the dropout tail, and gating on load must bring it back to
    // something a tyre could actually do.
    truthy(`gated slip is physically sensible (p95 = ${gatedP95.toFixed(2)} deg)`, gatedP95 < 15)
  }

  suite('Compass never spins the long way')
  equal('zero heading unwrap jumps over 180 deg', stats.unwrapJumps, 0)

  suite('GPS builds a track')
  truthy(`${stats.validFixes} valid fixes`, stats.validFixes > stats.ticks * 0.9)
  truthy(`${stats.cells.size} distinct 5 m cells occupied`, stats.cells.size > 50)

  suite('Lap detection on the real stream')
  // 3,000 ticks is ~150 s of replay and laps run 64-76 s, so expect 1-2.
  console.log(`       detector armed: ${detector.isArmed}; laps closed: ${lapTimes.length}` +
    (lapTimes.length ? ` (${lapTimes.map(formatLapTime).join(', ')})` : ''))
  truthy('the start/finish line got armed', detector.isArmed)
  for (const lapTime of lapTimes) {
    truthy(`lap time is plausible for this course (${formatLapTime(lapTime)})`,
      lapTime > 45 && lapTime < 120)
  }

  suite('Handling signature')
  // Reference medians from the offline analysis over the WHOLE 766 s log. This
  // test only sees a ~150 s window starting wherever the replay happens to be,
  // and different parts of the lap have a genuinely different corner mix — so
  // the per-band numbers are printed for eyeballing but asserted only loosely.
  // A unit or sign error would blow past +/-15; window-to-window variation of a
  // few deg/s would not.
  const offline = [5.7, 0.0, -0.8, -1.4, -7.3]
  stats.bins.forEach((values, index) => {
    if (values.length < 40) {
      console.log(`       ${AY_BINS[index].label.padEnd(6)} n=${values.length} — too thin to assert`)
      return
    }
    const live = median(values)
    console.log(`       ${AY_BINS[index].label.padEnd(6)} n=${String(values.length).padStart(4)}  live ${live.toFixed(1).padStart(6)}  offline ${offline[index].toFixed(1).padStart(6)}`)
    close(`band ${AY_BINS[index].label} is in the right ballpark`, live, offline[index], 15)
  })

  // THIS is the robust claim, and the one that actually held across every
  // window tried: whatever the absolute numbers, the car trends toward
  // oversteer as lateral load builds.
  const populated = stats.bins.map((v, i) => ({ v, i })).filter((b) => b.v.length >= 40)
  if (populated.length >= 2) {
    const drift = median(populated[populated.length - 1].v) - median(populated[0].v)
    truthy(`balance drifts toward oversteer as load builds (${drift.toFixed(1)} deg/s)`, drift < 0)
  } else {
    console.log('       too few populated bands in this window to test the trend')
  }
}

console.log(`Connecting to ${SERVER_ENDPOINT} — collecting ${TARGET_TICKS} ticks…`)
let buffer = ''
const request = http.get(SERVER_ENDPOINT, (response) => {
  if (response.statusCode !== 200) {
    console.error(`Server returned ${response.statusCode}. Is it running?`)
    process.exit(1)
  }
  response.on('data', (chunk) => {
    buffer += chunk.toString()
    let match
    // sse-starlette separates frames with CRLF CRLF; the browser's EventSource
    // handles this natively, so only this test has to parse it by hand.
    while ((match = FRAME_SEPARATOR.exec(buffer)) !== null) {
      const frame = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const line = frame.split(/\r?\n/).find((l) => l.startsWith('data:'))
      if (!line) continue
      try { handleTick(JSON.parse(line.slice(5).trim())) } catch { /* skip a bad frame */ }
      if (stats.ticks >= TARGET_TICKS) {
        request.destroy()
        runAssertions()
        process.exit(report())
      }
    }
  })
})

request.on('error', (error) => {
  console.error(`\nCould not reach ${SERVER_ENDPOINT}: ${error.message}`)
  console.error('Start the PER server first:')
  console.error('  uvicorn server.server:app --host 0.0.0.0 --port 8081\n')
  process.exit(1)
})

setTimeout(() => {
  console.error(`\nTimed out after ${TIMEOUT_MS / 1000}s with only ${stats.ticks} ticks.`)
  process.exit(1)
}, TIMEOUT_MS)

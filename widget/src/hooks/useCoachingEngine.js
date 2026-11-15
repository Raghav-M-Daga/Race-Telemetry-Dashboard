import { useEffect, useRef, useState } from 'react'
import { SENSOR_IDS } from '../config.js'
import { CONFIG } from '../engine/config.js'
import {
  createChannelBuffer, fillForFiltering, pushSample, resampleChannel,
} from '../engine/conditioning.js'
import { analyseSession, calibrationReport } from '../engine/engine.js'
import { createReplayClock } from '../engine/replayClock.js'
import { createEnuFrame } from '../engine/track.js'
import { createLapDetector } from '../lib/lapTiming.js'

/**
 * Runs the coaching engine on the live stream.
 *
 * The engine wants uniformly sampled channels; the stream delivers sparse,
 * asynchronous ones. So samples accumulate per channel here and are resampled
 * onto the analysis grid only when an analysis actually runs.
 *
 * WHEN IT RUNS
 *
 * Only when a lap closes. A full pass over the reference log's 766 s takes
 * about 800 ms — fine once, ruinous twenty times a second — and the output
 * cannot change until another lap exists to compare. So a cheap line-crossing
 * detector counts laps on the raw stream, and the expensive analysis runs only
 * when that count moves. A timer polls, but the poll usually does nothing.
 */

// Channel-name mapping from the widget's sensor IDs to the engine's names.
const ENGINE_CHANNELS = {
  latitude: SENSOR_IDS.latitude,
  longitude: SENSOR_IDS.longitude,
  speedX: SENSOR_IDS.speed,
  speedY: SENSOR_IDS.lateralVelocity,
  lateralAccel: SENSOR_IDS.lateralAcceleration,
  yawRate: SENSOR_IDS.yawRate,
  yaw: SENSOR_IDS.globalHeading,
  steeringAngle: SENSOR_IDS.steeringAngle,
  throttle: SENSOR_IDS.throttle,
  wheelSpeedFL: 0, // pcm.wheelSpeeds.frontLeft — not otherwise used by the widget
}

/**
 * How much history to keep, in seconds.
 *
 * Long enough for a whole run — the reference log is 766 s — plus headroom, so
 * that laps do not silently vanish off the back of the buffer while the driver
 * is still looking at them. Past this the oldest samples are dropped, because
 * an unbounded buffer in a long session is a memory leak with extra steps.
 */
const MAX_SECONDS = 1800

export function useCoachingEngine(rawTick, isLive, options = {}) {
  // Polled often; the poll only DOES anything when a lap has closed.
  const { intervalMs = 3000 } = options
  const buffersRef = useRef(null)
  const startRef = useRef(null)
  // A cheap lap counter, so the expensive analysis can run on lap completion
  // rather than on a blind timer. A full pass costs ~0.8 s at 766 s of data;
  // doing that every few seconds is most of a core for no benefit, since the
  // output only changes when a lap closes.
  const detectorRef = useRef(createLapDetector())
  const frameRef = useRef(null)
  // Absorbs the replay restarting from the beginning of the log. Extracted and
  // tested in engine/replayClock.js — this went wrong twice, and both failures
  // were silent: the session simply stopped growing.
  const clockRef = useRef(createReplayClock())
  // Laps dropped off the back of the buffer, so the UI can say so rather than
  // appearing to lose them.
  const trimmedLapsRef = useRef(0)
  const lapTimeEstimateRef = useRef(0)
  const lapsSeenRef = useRef(0)
  const analysedAtRef = useRef(-1)
  const [analysis, setAnalysis] = useState(null)
  const [status, setStatus] = useState({ samples: 0, seconds: 0, running: false, laps: 0 })

  if (!buffersRef.current) {
    buffersRef.current = Object.fromEntries(
      Object.keys(ENGINE_CHANNELS).map((name) => [name, createChannelBuffer()]),
    )
  }

  // --- ingest ---------------------------------------------------------------
  useEffect(() => {
    if (!isLive || !rawTick?.id?.length) return
    const buffers = buffersRef.current

    // Rebase this frame onto a timeline that never goes backwards.
    const offset = clockRef.current.accept(
      rawTick.ts[0] / 1e6,
      rawTick.ts[rawTick.ts.length - 1] / 1e6,
    )

    for (let i = 0; i < rawTick.id.length; i++) {
      const id = rawTick.id[i]
      const t = rawTick.ts[i] / 1e6 + offset
      if (startRef.current === null) startRef.current = t
      const value = rawTick.v[i]
      for (const [name, channelId] of Object.entries(ENGINE_CHANNELS)) {
        if (id === channelId) pushSample(buffers[name], t - startRef.current, value)
      }
    }

    // Cheap lap counting on the raw fixes, purely to decide WHEN to analyse.
    // This is not the lap detection the analysis uses — it only has to notice
    // that a lap boundary went past.
    const latitudes = buffers.latitude.values
    const longitudes = buffers.longitude.values
    const speeds = buffers.speedX.values
    const times = buffers.speedX.times
    if (latitudes.length > 2 && speeds.length > 2) {
      const lat = latitudes[latitudes.length - 1]
      const lon = longitudes[longitudes.length - 1]
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) > 0.0001) {
        if (!frameRef.current) frameRef.current = createEnuFrame(lat, lon)
        const enu = frameRef.current.toEnu(lat, lon)
        const speed = speeds[speeds.length - 1] ?? 0
        const t = times[times.length - 1] ?? 0
        if (detectorRef.current.update(enu.east, enu.north, speed, t)) lapsSeenRef.current++
      }
    }

    // Trim anything older than the window. Laps that fall off are counted, not
    // silently forgotten — "6 of 18 shown" is information; 6 alone looks broken.
    const newest = times[times.length - 1] ?? 0
    if (newest > MAX_SECONDS) {
      const cutoff = newest - MAX_SECONDS
      const before = buffers.speedX.times[0] ?? 0
      for (const buffer of Object.values(buffers)) {
        let drop = 0
        while (drop < buffer.times.length && buffer.times[drop] < cutoff) drop++
        if (drop > 0) {
          buffer.times.splice(0, drop)
          buffer.values.splice(0, drop)
        }
      }
      const after = buffers.speedX.times[0] ?? 0
      // Rough, and honestly labelled as such in the UI: laps are not uniform.
      if (after > before && lapTimeEstimateRef.current > 0) {
        trimmedLapsRef.current = Math.floor(after / lapTimeEstimateRef.current)
      }
    }
  }, [rawTick, isLive])

  // --- analyse, on a slow timer --------------------------------------------
  useEffect(() => {
    const run = () => {
      const buffers = buffersRef.current
      const times = buffers.speedX.times
      if (times.length < 2000) {
        setStatus({
          samples: times.length, seconds: times[times.length - 1] ?? 0,
          running: false, laps: lapsSeenRef.current,
          replayLoops: clockRef.current.restarts, analysedAt: null,
        })
        return
      }

      // Only when a lap has closed since the last pass — or when nothing has
      // been analysed yet, so the first laps appear without waiting.
      const lapsSeen = lapsSeenRef.current
      if (analysedAtRef.current === lapsSeen) return
      analysedAtRef.current = lapsSeen

      const spacing = 1 / CONFIG.sampleRateHz
      const from = times[0]
      const to = times[times.length - 1]
      const grid = []
      for (let t = from; t <= to; t += spacing) grid.push(t)
      if (grid.length < 1000) return

      const session = { time: grid }
      for (const name of Object.keys(ENGINE_CHANNELS)) {
        const { values, present } = resampleChannel(buffers[name], grid, spacing)
        session[name] = fillForFiltering(values, present)
      }

      setStatus({
        samples: times.length, seconds: to - from, running: true, laps: lapsSeen,
        replayLoops: clockRef.current.restarts, analysedAt: Date.now(),
      })
      try {
        const result = analyseSession(session)
        // Keep a lap-time estimate so trimmed laps can be counted.
        if (result.laps?.length) {
          const durations = result.laps.map((lap) => lap.lapTime).sort((a, b) => a - b)
          lapTimeEstimateRef.current = durations[durations.length >> 1]
        }
        result.calibration = calibrationReport(result)
        setAnalysis(result)
      } catch (error) {
        // A failure here must not take the page down with it.
        setAnalysis({ ok: false, warnings: [`Analysis failed: ${error.message}`], lapReports: [] })
      }
      setStatus((current) => ({ ...current, running: false, analysedAt: Date.now() }))
    }

    const timer = setInterval(run, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  const reset = () => {
    buffersRef.current = Object.fromEntries(
      Object.keys(ENGINE_CHANNELS).map((name) => [name, createChannelBuffer()]),
    )
    startRef.current = null
    detectorRef.current = createLapDetector()
    frameRef.current = null
    clockRef.current.reset()
    trimmedLapsRef.current = 0
    lapTimeEstimateRef.current = 0
    lapsSeenRef.current = 0
    analysedAtRef.current = -1
    setAnalysis(null)
    setStatus({ samples: 0, seconds: 0, running: false, laps: 0 })
  }

  return { analysis, status, reset }
}

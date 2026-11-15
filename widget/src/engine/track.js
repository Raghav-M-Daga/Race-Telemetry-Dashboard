/**
 * Track spine: position, path distance, lap segmentation, and the shared
 * distance grid every comparison happens on.
 */

import { CONFIG } from './config.js'

const METRES_PER_DEG_LAT = 111132.0
const METRES_PER_DEG_LON_EQUATOR = 111320.0

/** Flat-earth ENU about a fixed origin. Over a few hundred metres the error is
 *  millimetres — far below GPS noise — for two multiplications. */
export function createEnuFrame(originLat, originLon) {
  const metresPerDegLon = METRES_PER_DEG_LON_EQUATOR * Math.cos((originLat * Math.PI) / 180)
  return {
    originLat,
    originLon,
    toEnu(lat, lon) {
      return {
        east: (lon - originLon) * metresPerDegLon,
        north: (lat - originLat) * METRES_PER_DEG_LAT,
      }
    },
  }
}

/**
 * Cumulative path distance by integrating SPEED, not GPS deltas.
 *
 * Integrating position differences accumulates every metre of GPS jitter as
 * real distance, which inflates the total and — worse — inflates it by a
 * different amount on every lap, so laps stop being comparable. Speed is far
 * quieter. GPS is used only to close the loop.
 */
export function integrateDistance(speed, spacing) {
  const distance = new Array(speed.length)
  distance[0] = 0
  for (let i = 1; i < speed.length; i++) {
    const v = Number.isFinite(speed[i]) ? Math.max(0, speed[i]) : 0
    distance[i] = distance[i - 1] + v * spacing
  }
  return distance
}

/**
 * Lap boundaries by start/finish LINE crossing.
 *
 * The obvious method — "a lap ends when the car comes back within N metres of
 * where it started" — was implemented here first and is wrong. It fires early
 * (on entering the circle rather than at the line), it fires late or not at all
 * when the car takes a slightly different line, and on the reference log it
 * merged pairs of laps into single 136 s and 143 s "laps". It also gives a
 * different answer each time the buffer grows, which is why the live lap count
 * kept changing.
 *
 * Real timing systems define a LINE and count passes through it. With a
 * reference point p0 and the unit heading h the car had there:
 *
 *   along   = (p - p0) · h     distance along the direction of travel
 *   lateral = (p - p0) · n     offset from the centre of the line
 *
 * A lap closes when `along` crosses zero upward — the car has just passed
 * through the plane of the line going the way it was going at the start.
 * `lateral` is gated so crossing that infinite plane elsewhere on the circuit
 * does not count, and a debounce stops a wobble over the line racking up laps.
 *
 * Validated on the reference log: 10 laps, every one between 993 m and 1006 m —
 * within 1.3% of each other — and the same answer for gate widths anywhere from
 * 10 m to 25 m, which is what a stable detector looks like.
 */
export function detectLaps({ east, north, speed, distance, time }, options = {}) {
  const {
    lineGateM = CONFIG.lapLineGateM,
    // Debounced by DISTANCE, not time. A time debounce silently encodes an
    // assumption about how long a lap takes — a 19 s autocross lap would be
    // rejected by a 20 s guard, which is a bug waiting for a shorter circuit.
    minDistance = CONFIG.lapMinDistanceM,
    armSpeed = null,
    headingBaselineM = CONFIG.lapHeadingBaselineM,
  } = options

  const n = east.length
  if (n < 10) return { laps: [], origin: null, line: null }

  // Arm at a speed taken from the session itself: half the median of the moving
  // samples is a robust "properly under way", and a heading measured while
  // crawling through the paddock would put the line in the wrong place for the
  // whole session.
  const moving = [...speed].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  const armAt = armSpeed ?? (moving.length ? moving[Math.floor(moving.length * 0.5)] * 0.5 : 0)

  let anchorIndex = 0
  while (anchorIndex < n && !(speed[anchorIndex] > armAt)) anchorIndex++
  if (anchorIndex >= n - 2) return { laps: [], origin: null, line: null }

  // Travel far enough past the anchor for the heading to be trustworthy.
  let headingIndex = anchorIndex + 1
  while (
    headingIndex < n
    && Math.hypot(east[headingIndex] - east[anchorIndex], north[headingIndex] - north[anchorIndex])
       < headingBaselineM
  ) headingIndex++
  if (headingIndex >= n) return { laps: [], origin: null, line: null }

  const dx = east[headingIndex] - east[anchorIndex]
  const dy = north[headingIndex] - north[anchorIndex]
  const length = Math.hypot(dx, dy) || 1
  const heading = { x: dx / length, y: dy / length }
  const normal = { x: -heading.y, y: heading.x }
  const origin = { east: east[anchorIndex], north: north[anchorIndex], index: anchorIndex }
  const line = { origin, heading, normal, gate: lineGateM }

  const boundaries = [anchorIndex]
  let previousAlong = null
  let lastCrossDistance = distance[anchorIndex]

  for (let i = anchorIndex + 1; i < n; i++) {
    const relEast = east[i] - origin.east
    const relNorth = north[i] - origin.north
    const along = relEast * heading.x + relNorth * heading.y
    const lateral = relEast * normal.x + relNorth * normal.y

    const crossed = previousAlong !== null
      && previousAlong < 0 && along >= 0
      && Math.abs(lateral) < lineGateM
      && speed[i] > armAt * 0.4
      && distance[i] - lastCrossDistance > minDistance

    previousAlong = along
    if (crossed) {
      boundaries.push(i)
      lastCrossDistance = distance[i]
    }
  }

  const laps = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = boundaries[i]
    const to = boundaries[i + 1]
    laps.push({
      index: laps.length + 1,
      startIndex: from,
      endIndex: to,
      startTime: time[from],
      endTime: time[to],
      lapTime: time[to] - time[from],
      length: distance[to] - distance[from],
    })
  }
  return { laps, origin, line }
}

/**
 * Median and median absolute deviation. Used everywhere a threshold has to come
 * from the data rather than from a constant.
 */
export function medianOf(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function madOf(values) {
  const centre = medianOf(values)
  return medianOf(values.map((v) => Math.abs(v - centre)))
}

export function percentileOf(values, fraction) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))))
  return sorted[index]
}

/**
 * Clean-lap gate.
 *
 * A lap counts only if its time sits inside a robust band of the session's own
 * lap times, and it contains no long low-speed dwell — the signature of traffic,
 * a spin, or an in/out lap. Both tests are relative to this session; neither
 * uses an absolute number.
 */
export function classifyLaps(laps, { speed, time }, options = {}) {
  const {
    madMultiplier = CONFIG.lapTimeMadMultiplier,
    dwellFraction = CONFIG.dwellSpeedFraction,
    dwellSecondsMax = CONFIG.dwellSecondsMax,
  } = options

  if (laps.length === 0) return []
  const times = laps.map((lap) => lap.lapTime)
  const centre = medianOf(times)
  const spread = madOf(times)
  // With too few laps MAD can be zero; fall back to a proportion of the median
  // so a single outlier is still caught.
  const band = spread > 0 ? madMultiplier * spread : centre * 0.25

  return laps.map((lap) => {
    const reasons = []
    if (lap.lapTime > centre + band) reasons.push(`lap time ${lap.lapTime.toFixed(1)}s is outside the session band (${(centre + band).toFixed(1)}s)`)
    if (lap.lapTime < centre - band) reasons.push('lap time is implausibly short — likely a mis-detected boundary')

    // Dwell: the longest continuous run below a fraction of this lap's own
    // median speed.
    const lapSpeeds = speed.slice(lap.startIndex, lap.endIndex).filter(Number.isFinite)
    const lapMedianSpeed = medianOf(lapSpeeds)
    const dwellLimit = lapMedianSpeed * dwellFraction
    let longestDwell = 0
    let dwellStart = null
    for (let i = lap.startIndex; i < lap.endIndex; i++) {
      if (speed[i] < dwellLimit) {
        if (dwellStart === null) dwellStart = i
        longestDwell = Math.max(longestDwell, time[i] - time[dwellStart])
      } else dwellStart = null
    }
    if (longestDwell > dwellSecondsMax) {
      reasons.push(`dwelt below ${dwellLimit.toFixed(1)} m/s for ${longestDwell.toFixed(1)}s — traffic or an excursion`)
    }

    return { ...lap, clean: reasons.length === 0, reasons, longestDwell, medianSpeed: lapMedianSpeed }
  })
}

/**
 * Resample a lap onto a shared distance grid, so every lap is compared at the
 * same places.
 */
export function resampleLapOntoGrid(lap, channels, distance, gridSpacing = CONFIG.gridSpacingM) {
  const start = distance[lap.startIndex]
  const length = distance[lap.endIndex] - start
  if (!(length > 0)) return null

  const gridLength = Math.floor(length / gridSpacing)
  const grid = new Array(gridLength)
  for (let i = 0; i < gridLength; i++) grid[i] = i * gridSpacing

  const output = {}
  for (const [name, series] of Object.entries(channels)) {
    output[name] = new Array(gridLength).fill(NaN)
  }

  // Walk the lap once, filling each grid cell from the straddling samples.
  let cursor = lap.startIndex
  for (let g = 0; g < gridLength; g++) {
    const target = start + grid[g]
    while (cursor < lap.endIndex - 1 && distance[cursor + 1] < target) cursor++
    const d0 = distance[cursor]
    const d1 = distance[cursor + 1]
    const span = d1 - d0
    const fraction = span > 1e-9 ? (target - d0) / span : 0
    for (const [name, series] of Object.entries(channels)) {
      const a = series[cursor]
      const b = series[cursor + 1]
      output[name][g] = Number.isFinite(a) && Number.isFinite(b)
        ? a + (b - a) * fraction
        : (Number.isFinite(a) ? a : b)
    }
  }

  return { grid, channels: output, length, gridSpacing }
}

/**
 * Correct lap-to-lap GPS drift by finding the small distance shift that best
 * aligns two laps' curvature traces.
 *
 * Trusting raw distance means a metre of drift shifts every corner boundary,
 * and a comparison of a corner against a slightly different piece of track is
 * not a comparison at all.
 */
export function alignByCrossCorrelation(reference, candidate, maxShift = CONFIG.driftAlignSpanM) {
  const n = Math.min(reference.length, candidate.length)
  if (n < 3 * maxShift) return 0

  let bestShift = 0
  let bestScore = -Infinity
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    let dot = 0
    let count = 0
    for (let i = maxShift; i < n - maxShift; i++) {
      const a = reference[i]
      const b = candidate[i + shift]
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      dot += a * b
      count++
    }
    if (count === 0) continue
    const score = dot / count
    if (score > bestScore) { bestScore = score; bestShift = shift }
  }
  return bestShift
}

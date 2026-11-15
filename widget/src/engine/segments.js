/**
 * Corner segmentation, with the threshold derived from the data.
 *
 * The split between STRAIGHT and CORNER comes from an Otsu analysis of the
 * lap's own curvature histogram: the threshold that best separates the
 * distribution into two classes. A fixed "radius under 45 m" would encode an
 * opinion about what a corner is; Otsu asks the track.
 *
 * Segmentation is computed ONCE on a reference lap and reused for every lap, so
 * boundaries are fixed in distance and comparisons are like for like.
 */

import { CONFIG } from './config.js'
import { savitzkyGolay } from './savitzkyGolay.js'

/**
 * Otsu's method: the threshold maximising between-class variance.
 * Standard in image binarisation; the problem here is identical — one series,
 * two populations, no prior about where they divide.
 */
export function otsuThreshold(values, bins = CONFIG.curvatureHistogramBins) {
  const finite = values.filter(Number.isFinite)
  if (finite.length < bins) return null
  let min = Infinity
  let max = -Infinity
  for (const v of finite) { if (v < min) min = v; if (v > max) max = v }
  if (!(max > min)) return null

  const histogram = new Array(bins).fill(0)
  const width = (max - min) / bins
  for (const v of finite) {
    const index = Math.min(bins - 1, Math.floor((v - min) / width))
    histogram[index]++
  }

  const total = finite.length
  let sumAll = 0
  for (let i = 0; i < bins; i++) sumAll += i * histogram[i]

  let weightBackground = 0
  let sumBackground = 0
  let best = -1
  let bestIndex = 0
  for (let i = 0; i < bins; i++) {
    weightBackground += histogram[i]
    if (weightBackground === 0) continue
    const weightForeground = total - weightBackground
    if (weightForeground === 0) break
    sumBackground += i * histogram[i]
    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sumAll - sumBackground) / weightForeground
    const between = weightBackground * weightForeground
      * (meanBackground - meanForeground) ** 2
    if (between > best) { best = between; bestIndex = i }
  }
  return min + (bestIndex + 0.5) * width
}

/**
 * Split a lap into alternating STRAIGHT and CORNER runs.
 *
 * Hysteresis and a minimum length keep the boundaries stable lap to lap; without
 * them a corner with a brief straightening in the middle arrives as three
 * segments on one lap and one on the next, and nothing can be compared.
 */
export function segmentLap({ grid, curvature }, options = {}) {
  const {
    hysteresis = CONFIG.curvatureHysteresis,
    minCornerLength = CONFIG.minCornerLengthM,
    minStraightLength = CONFIG.minStraightLengthM,
  } = options

  const magnitude = curvature.map((k) => Math.abs(k))
  const threshold = otsuThreshold(magnitude)
  if (threshold === null) return { segments: [], threshold: null }

  const enter = threshold * (1 + hysteresis)
  const exit = threshold * (1 - hysteresis)

  const states = new Array(magnitude.length)
  let inCorner = magnitude[0] > enter
  for (let i = 0; i < magnitude.length; i++) {
    if (inCorner && magnitude[i] < exit) inCorner = false
    else if (!inCorner && magnitude[i] > enter) inCorner = true
    states[i] = inCorner
  }

  // Runs, then absorb anything shorter than the minimum into its neighbour.
  let runs = []
  let start = 0
  for (let i = 1; i <= states.length; i++) {
    if (i === states.length || states[i] !== states[start]) {
      runs.push({ start, end: i, corner: states[start] })
      start = i
    }
  }
  // Absorb runs that are too short to stand alone. The rule differs by type,
  // and getting this wrong is how an earlier version deleted two thirds of the
  // corners on this circuit: a short corner absorbed into a longer straight
  // took the STRAIGHT's type and simply vanished.
  let changed = true
  while (changed && runs.length > 1) {
    changed = false
    for (let i = 0; i < runs.length; i++) {
      const length = grid[Math.min(runs[i].end, grid.length - 1)] - grid[runs[i].start]
      const limit = runs[i].corner ? minCornerLength : minStraightLength
      if (length >= limit) continue

      const previous = runs[i - 1]
      const next = runs[i + 1]
      if (runs[i].corner) {
        // A corner below the noise floor: genuinely spurious, so let the
        // neighbour swallow it and keep the neighbour's type.
        if (previous && next) {
          const previousLength = grid[previous.end - 1] - grid[previous.start]
          const nextLength = grid[Math.min(next.end, grid.length - 1)] - grid[next.start]
          if (previousLength >= nextLength) previous.end = runs[i].end
          else next.start = runs[i].start
        } else if (previous) previous.end = runs[i].end
        else if (next) next.start = runs[i].start
      } else {
        // A short straight between corners is a straightening WITHIN one
        // corner. Absorb it into a neighbouring corner so the two join up.
        if (previous?.corner) previous.end = runs[i].end
        else if (next?.corner) next.start = runs[i].start
        else if (previous) previous.end = runs[i].end
        else if (next) next.start = runs[i].start
      }
      runs.splice(i, 1)
      changed = true
      break
    }
  }

  // Coalesce neighbours that ended up the same type.
  const merged = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (last && last.corner === run.corner) last.end = run.end
    else merged.push({ ...run })
  }
  runs = merged

  let cornerNumber = 0
  let straightNumber = 0
  const segments = runs.map((run) => {
    const label = run.corner ? `T${++cornerNumber}` : `S${++straightNumber}`
    return {
      id: label,
      label,
      type: run.corner ? 'corner' : 'straight',
      startIndex: run.start,
      endIndex: run.end,
      startS: grid[run.start],
      endS: grid[Math.min(run.end, grid.length - 1)],
      length: grid[Math.min(run.end, grid.length - 1)] - grid[run.start],
    }
  })

  return { segments, threshold, enter, exit }
}

/**
 * Split a corner into entry / apex / exit by distance.
 *
 * Entry runs from the last sustained positive longitudinal acceleration before
 * the corner to the minimum-speed point; exit runs from there to where positive
 * acceleration is sustained again. The offset between the minimum-speed point
 * and the maximum-curvature point is recorded because it is diagnostic in
 * itself: braking deep past the geometric apex shows up here.
 */
export function splitCornerPhases(segment, { speed, accelX, curvature, grid }, options = {}) {
  const { accelHysteresis = null } = options
  const from = segment.startIndex
  const to = Math.min(segment.endIndex, speed.length)
  if (to - from < 4) return null

  // "Sustained positive acceleration" threshold derived from the lap's own
  // acceleration distribution, not a constant.
  const positives = accelX.filter((a) => Number.isFinite(a) && a > 0).sort((a, b) => a - b)
  const sustained = accelHysteresis ?? (positives.length
    ? positives[Math.floor(positives.length * 0.4)]
    : 0)

  let minSpeed = Infinity
  let apexIndex = from
  for (let i = from; i < to; i++) {
    if (speed[i] < minSpeed) { minSpeed = speed[i]; apexIndex = i }
  }
  let maxCurvature = -Infinity
  let curvatureApex = from
  for (let i = from; i < to; i++) {
    const k = Math.abs(curvature[i])
    if (k > maxCurvature) { maxCurvature = k; curvatureApex = i }
  }

  // Entry begins where the car was last still accelerating before the corner.
  let entryStart = from
  for (let i = from; i > Math.max(0, from - 400); i--) {
    if (accelX[i] > sustained) { entryStart = i; break }
    entryStart = i
  }
  // Exit ends where it is sustainedly accelerating again.
  let exitEnd = to - 1
  for (let i = apexIndex; i < Math.min(accelX.length, to + 400); i++) {
    if (accelX[i] > sustained) { exitEnd = i; break }
    exitEnd = i
  }

  return {
    entryStart,
    apexIndex,
    curvatureApexIndex: curvatureApex,
    exitEnd,
    minSpeed,
    entryS: grid[entryStart],
    apexS: grid[apexIndex],
    exitS: grid[Math.min(exitEnd, grid.length - 1)],
    // Positive means the minimum speed falls AFTER the tightest point.
    apexOffsetM: grid[apexIndex] - grid[curvatureApex],
    sustainedAccelThreshold: sustained,
  }
}

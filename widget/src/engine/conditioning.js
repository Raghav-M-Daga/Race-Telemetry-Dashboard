/**
 * Turning the sparse, asynchronous stream into a uniform analysis grid.
 *
 * Channels arrive at different rates and any given tick carries an arbitrary
 * subset of them. Everything downstream assumes a common 100 Hz time base, so
 * that alignment happens exactly once, here.
 *
 * The important rule is that a gap is a GAP. A channel that has not updated
 * within the staleness limit is marked missing rather than held or
 * extrapolated — holding a stale value silently invents data, and the
 * derivative of an invented plateau is a fictitious zero acceleration.
 */

import { CONFIG } from './config.js'

/** Per-channel ring of (time, value) pairs, appended as the stream arrives. */
export function createChannelBuffer() {
  return { times: [], values: [] }
}

export function pushSample(buffer, timeSeconds, value) {
  if (!Number.isFinite(value)) return
  const n = buffer.times.length
  // The stream is not strictly ordered within a tick; keep it monotonic.
  if (n && timeSeconds < buffer.times[n - 1]) return
  buffer.times.push(timeSeconds)
  buffer.values.push(value)
}

/**
 * Resample one channel onto `grid` by linear interpolation, marking samples
 * whose nearest real observation is further away than the staleness limit.
 *
 * @returns {{ values: number[], present: boolean[] }}
 */
export function resampleChannel(buffer, grid, spacing, stalenessSteps = CONFIG.stalenessSteps) {
  const { times, values } = buffer
  const out = new Array(grid.length).fill(NaN)
  const present = new Array(grid.length).fill(false)
  if (times.length < 2) return { values: out, present }

  const maxGap = stalenessSteps * spacing
  let cursor = 0
  for (let i = 0; i < grid.length; i++) {
    const t = grid[i]
    while (cursor < times.length - 2 && times[cursor + 1] < t) cursor++
    const t0 = times[cursor]
    const t1 = times[cursor + 1]
    if (t < t0 - maxGap || t > t1 + maxGap) continue
    // Outside the observed span we do not extrapolate; inside, interpolate.
    if (t <= t0) { out[i] = values[cursor]; present[i] = t0 - t <= maxGap; continue }
    if (t >= t1) { out[i] = values[cursor + 1]; present[i] = t - t1 <= maxGap; continue }
    const span = t1 - t0
    // A pair straddling a long dropout must not be bridged.
    if (span > maxGap) continue
    const fraction = span > 0 ? (t - t0) / span : 0
    out[i] = values[cursor] + (values[cursor + 1] - values[cursor]) * fraction
    present[i] = true
  }
  return { values: out, present }
}

/**
 * Fill gaps so a filter can run, while keeping the `present` mask so callers
 * can still tell real data from scaffolding. Held values are never presented
 * as measurements — they only stop a NaN poisoning a convolution.
 */
export function fillForFiltering(values, present) {
  const out = [...values]
  let lastGood = null
  for (let i = 0; i < out.length; i++) {
    if (present[i] && Number.isFinite(out[i])) lastGood = out[i]
    else out[i] = lastGood ?? 0
  }
  // Back-fill the leading run, which had nothing to hold.
  let firstGood = null
  for (let i = 0; i < out.length; i++) {
    if (present[i] && Number.isFinite(values[i])) { firstGood = values[i]; break }
  }
  for (let i = 0; i < out.length && !present[i]; i++) out[i] = firstGood ?? 0
  return out
}

/** Unwrap a wrapped angular series (degrees) so it can be differentiated. */
export function unwrapDegrees(values) {
  const out = new Array(values.length)
  let offset = 0
  out[0] = values[0]
  for (let i = 1; i < values.length; i++) {
    let step = values[i] - values[i - 1]
    // Yaw crossing north jumps ~360; that jump is not rotation.
    if (step > 180) offset -= 360
    else if (step < -180) offset += 360
    out[i] = values[i] + offset
  }
  return out
}

/** Fraction of a mask that is true — the coverage of a channel. */
export function coverage(present) {
  if (!present.length) return 0
  let count = 0
  for (const flag of present) if (flag) count++
  return count / present.length
}

/**
 * Median filter: the right tool for an isolated-spike defect.
 *
 * The slip channel's INS dropouts are single-sample excursions to tens of
 * degrees. A mean filter smears them across their neighbours; a median filter
 * removes them outright while leaving a sustained excursion — a real slide,
 * which develops over tens of metres — untouched.
 *
 * A percentile cut was tried first and does not work: the dropouts are ~4% of
 * samples, so any percentile high enough to keep genuine slides is already
 * inside the dropout tail.
 */
export function medianFilter(values, window = 9) {
  const n = values.length
  if (n === 0 || window < 3) return [...values]
  const half = Math.floor(window / 2)
  const out = new Array(n)
  const buffer = []
  for (let i = 0; i < n; i++) {
    buffer.length = 0
    for (let k = -half; k <= half; k++) {
      let index = i + k
      if (index < 0) index = -index
      if (index >= n) index = 2 * (n - 1) - index
      const value = values[Math.max(0, Math.min(n - 1, index))]
      if (Number.isFinite(value)) buffer.push(value)
    }
    if (!buffer.length) { out[i] = values[i]; continue }
    buffer.sort((a, b) => a - b)
    out[i] = buffer[buffer.length >> 1]
  }
  return out
}

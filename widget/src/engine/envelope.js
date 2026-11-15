/**
 * The g-g-V envelope: what this car has been shown to do, by speed and by
 * direction in the acceleration plane.
 *
 * COVERAGE IS THE POINT
 *
 * An envelope built from a driver who never braked hard is not a capability
 * estimate — it is a record of that timidity, and using it as a reference would
 * congratulate the driver for reaching a limit they invented. So every cell
 * carries its sample count, cells below the minimum are marked low-confidence,
 * and utilisation computed against such a cell may not drive a suggestion.
 *
 * On the reference log this is not hypothetical. Lateral p95 reaches about
 * 15 m/s2 while pure braking reaches only 7.2-7.5 — roughly half. That is
 * either a genuinely brake-limited car or an under-braking driver, and the
 * coverage map is what lets a race engineer tell the difference instead of the
 * engine guessing.
 */

import { CONFIG } from './config.js'

/**
 * Build the envelope from clean-lap samples.
 *
 * Direction 0 is pure acceleration, +-180 pure braking, +90/-90 pure cornering.
 */
export function buildEnvelope(samples, options = {}) {
  const {
    speedBins = CONFIG.speedBins,
    directionBins = CONFIG.directionBins,
    percentile = CONFIG.envelopePercentile,
    minCellSamples = CONFIG.envelopeMinCellSamples,
  } = options

  const speeds = samples.map((s) => s.speed).filter(Number.isFinite)
  if (speeds.length < speedBins * directionBins) {
    return { ready: false, reason: 'not enough samples to populate the envelope' }
  }
  const sorted = [...speeds].sort((a, b) => a - b)
  // Trim the extremes so one crawl or one spike cannot define a bin edge.
  const minSpeed = sorted[Math.floor(sorted.length * 0.01)]
  const maxSpeed = sorted[Math.floor(sorted.length * 0.99)]
  const speedWidth = (maxSpeed - minSpeed) / speedBins || 1

  // cells[speedBin][directionBin] = array of |a|
  const cells = Array.from({ length: speedBins }, () => (
    Array.from({ length: directionBins }, () => [])
  ))

  for (const sample of samples) {
    if (!Number.isFinite(sample.speed) || !Number.isFinite(sample.magnitude)) continue
    if (!Number.isFinite(sample.direction)) continue
    const sBin = Math.min(speedBins - 1, Math.max(0,
      Math.floor((sample.speed - minSpeed) / speedWidth)))
    // Map -180..180 onto 0..directionBins.
    const dBin = Math.min(directionBins - 1, Math.max(0,
      Math.floor(((sample.direction + 180) / 360) * directionBins)))
    cells[sBin][dBin].push(sample.magnitude)
  }

  const values = Array.from({ length: speedBins }, () => new Array(directionBins).fill(NaN))
  const counts = Array.from({ length: speedBins }, () => new Array(directionBins).fill(0))
  for (let s = 0; s < speedBins; s++) {
    for (let d = 0; d < directionBins; d++) {
      const bucket = cells[s][d]
      counts[s][d] = bucket.length
      if (!bucket.length) continue
      bucket.sort((a, b) => a - b)
      const index = Math.min(bucket.length - 1,
        Math.max(0, Math.floor(percentile * (bucket.length - 1))))
      values[s][d] = bucket[index]
    }
  }

  // Smooth around the direction circle: adjacent directions are physically
  // continuous, and a thin bin should borrow from its neighbours rather than
  // read as a notch in the envelope.
  const smoothed = values.map((row) => row.map((_, d) => {
    let sum = 0
    let weight = 0
    for (let k = -1; k <= 1; k++) {
      const index = (d + k + directionBins) % directionBins
      const value = row[index]
      if (!Number.isFinite(value)) continue
      const w = k === 0 ? 2 : 1
      sum += value * w
      weight += w
    }
    return weight > 0 ? sum / weight : NaN
  }))

  // Fill any still-empty cell from the nearest populated one in the same speed
  // row, and mark it low-confidence via its own count.
  for (let s = 0; s < speedBins; s++) {
    for (let d = 0; d < directionBins; d++) {
      if (Number.isFinite(smoothed[s][d])) continue
      for (let radius = 1; radius < directionBins; radius++) {
        const left = smoothed[s][(d - radius + directionBins) % directionBins]
        const right = smoothed[s][(d + radius) % directionBins]
        if (Number.isFinite(left)) { smoothed[s][d] = left; break }
        if (Number.isFinite(right)) { smoothed[s][d] = right; break }
      }
    }
  }

  const totalCells = speedBins * directionBins
  let wellSampled = 0
  for (let s = 0; s < speedBins; s++) {
    for (let d = 0; d < directionBins; d++) if (counts[s][d] >= minCellSamples) wellSampled++
  }

  return {
    ready: true,
    values: smoothed,
    counts,
    minSpeed,
    maxSpeed,
    speedWidth,
    speedBins,
    directionBins,
    percentile,
    minCellSamples,
    coverage: wellSampled / totalCells,
    totalSamples: samples.length,
  }
}

/** Cell indices for a (speed, direction) pair. */
export function cellIndex(envelope, speed, direction) {
  const s = Math.min(envelope.speedBins - 1, Math.max(0,
    Math.floor((speed - envelope.minSpeed) / envelope.speedWidth)))
  const d = Math.min(envelope.directionBins - 1, Math.max(0,
    Math.floor(((direction + 180) / 360) * envelope.directionBins)))
  return { s, d }
}

/**
 * Envelope value at a point, interpolated across speed.
 * `confident` is false where the cell is under-sampled — the caller MUST NOT
 * base a suggestion on an unconfident utilisation.
 */
export function envelopeAt(envelope, speed, direction) {
  if (!envelope?.ready) return { value: NaN, confident: false, samples: 0 }
  const { s, d } = cellIndex(envelope, speed, direction)

  // Linear interpolation between adjacent speed rows.
  const exact = (speed - envelope.minSpeed) / envelope.speedWidth
  const lower = Math.min(envelope.speedBins - 1, Math.max(0, Math.floor(exact)))
  const upper = Math.min(envelope.speedBins - 1, lower + 1)
  const fraction = Math.min(1, Math.max(0, exact - lower))
  const a = envelope.values[lower][d]
  const b = envelope.values[upper][d]
  const value = Number.isFinite(a) && Number.isFinite(b)
    ? a + (b - a) * fraction
    : (Number.isFinite(a) ? a : b)

  const samples = envelope.counts[s][d]
  return { value, confident: samples >= envelope.minCellSamples, samples }
}

/**
 * Utilisation: the fraction of demonstrated capability in use.
 * Returns `confident: false` where the envelope cell is thin, so callers can
 * refuse to draw a conclusion rather than trusting a number built on nothing.
 */
export function utilisationAt(envelope, speed, direction, magnitude) {
  const { value, confident, samples } = envelopeAt(envelope, speed, direction)
  if (!Number.isFinite(value) || value <= 0) {
    return { utilisation: NaN, confident: false, samples, envelope: value }
  }
  return { utilisation: magnitude / value, confident, samples, envelope: value }
}

/**
 * Human-readable coverage warnings — the honest statement of what the envelope
 * does and does not know.
 */
export function coverageWarnings(envelope) {
  if (!envelope?.ready) return ['Envelope not yet established.']
  const warnings = []
  const zones = [
    { name: 'braking', from: 135, to: 225 },
    { name: 'acceleration', from: -45, to: 45 },
    { name: 'left cornering', from: 45, to: 135 },
    { name: 'right cornering', from: 225, to: 315 },
  ]
  for (const zone of zones) {
    let total = 0
    let cells = 0
    for (let d = 0; d < envelope.directionBins; d++) {
      const degrees = (d / envelope.directionBins) * 360
      const inZone = zone.from < zone.to
        ? degrees >= zone.from && degrees < zone.to
        : degrees >= zone.from || degrees < zone.to
      if (!inZone) continue
      for (let s = 0; s < envelope.speedBins; s++) { total += envelope.counts[s][d]; cells++ }
    }
    const mean = cells ? total / cells : 0
    if (mean < envelope.minCellSamples) {
      warnings.push(
        `${zone.name} envelope under-sampled (${mean.toFixed(0)} samples per cell, `
        + `needs ${envelope.minCellSamples}) — it records what the driver did, not what the car can do`,
      )
    }
  }
  return warnings
}

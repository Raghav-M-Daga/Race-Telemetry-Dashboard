/**
 * Unit conversions, the corner-load model, and small display helpers.
 * Pure functions only — no React, no I/O, so this stays easy to reason about.
 */

import { LATERAL_ACCEL_FULL_SCALE, COLORS } from '../config.js'

export const RAD_TO_DEG = 180 / Math.PI

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** Linear interpolation, used for the corner-load colour ramp. */
const lerp = (a, b, t) => a + (b - a) * t

/**
 * The VectorNav reports yaw as -180..+180. The dashboard wants a 0..360 compass
 * bearing, so fold the negative half over.
 */
export function toCompassBearing(signedYawDeg) {
  return ((signedYawDeg % 360) + 360) % 360
}

/**
 * Unwrap a heading so it stays numerically continuous across the 359 -> 0 seam.
 *
 * A CSS rotate transition interpolates the raw number, so going 359 -> 1 would
 * spin the compass 358 degrees backwards. Adding whole turns keeps each step on
 * the short arc while the CSS transition still animates smoothly.
 */
export function unwrapHeading(previousUnwrapped, nextBearing) {
  const previousBearing = toCompassBearing(previousUnwrapped)
  let delta = nextBearing - previousBearing
  if (delta > 180) delta -= 360
  if (delta < -180) delta += 360
  return previousUnwrapped + delta
}

/**
 * Estimate per-corner suspension load (0-100%) from lateral acceleration.
 *
 * Real shock pots measure this directly; this replay has none, so we model the
 * thing they would show: lateral weight transfer. Sign convention, confirmed
 * against the log (steering and AY correlate at +0.78, yaw rate and AY at
 * +0.96): positive AY = right-hand turn, which throws load onto the LEFT tyres.
 *
 * Front and rear don't transfer equally — the end with more roll stiffness
 * takes a bigger share — so FRONT_ROLL_SHARE splits the transfer between axles.
 */
const STATIC_LOAD_PCT = 50 // each corner at rest
const MAX_TRANSFER_PCT = 42 // transfer at full-scale AY
const FRONT_ROLL_SHARE = 0.55 // front axle takes 55% of the lateral transfer

export function estimateCornerLoads(lateralAccel) {
  const normalized = clamp(lateralAccel / LATERAL_ACCEL_FULL_SCALE, -1, 1)
  const transfer = normalized * MAX_TRANSFER_PCT

  // Doubling the share converts "fraction of total" into "multiple of average",
  // so front and rear straddle `transfer` instead of both being under it.
  const frontTransfer = transfer * 2 * FRONT_ROLL_SHARE
  const rearTransfer = transfer * 2 * (1 - FRONT_ROLL_SHARE)

  const corner = (delta) => clamp(STATIC_LOAD_PCT + delta, 0, 100)

  return {
    shock_fl: corner(frontTransfer),
    shock_fr: corner(-frontTransfer),
    shock_rl: corner(rearTransfer),
    shock_rr: corner(-rearTransfer),
  }
}

/**
 * Corner-load colour ramp: green (unloaded) -> yellow (working) -> red (loaded).
 * Interpolated rather than stepped so weight transfer reads as a smooth wash of
 * colour across the car instead of three discrete states.
 */
export function loadColor(loadPct) {
  const t = clamp(loadPct, 0, 100) / 100
  // Two-segment hue ramp: 145 (green) -> 52 (yellow) -> 0 (red).
  const hue = t < 0.5 ? lerp(145, 52, t / 0.5) : lerp(52, 0, (t - 0.5) / 0.5)
  return `hsl(${hue.toFixed(0)}, 82%, 52%)`
}

/** Yaw-rate severity band, driving both the colour and the label. */
export function yawRateSeverity(yawRateDegS, moderate, high) {
  const magnitude = Math.abs(yawRateDegS)
  if (magnitude >= high) return { level: 'high', color: COLORS.pennRedBright, label: 'HIGH' }
  if (magnitude >= moderate) return { level: 'moderate', color: COLORS.amber, label: 'MODERATE' }
  return { level: 'low', color: COLORS.green, label: 'STABLE' }
}

/** Cardinal label for a compass bearing, e.g. 47 -> "NE". */
export function cardinalFor(bearing) {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return points[Math.round(toCompassBearing(bearing) / 45) % 8]
}

/** Fixed-width numeric readout that keeps a sign column so values don't jitter. */
export function formatSigned(value, decimals = 1) {
  if (!Number.isFinite(value)) return '--'
  const sign = value < 0 ? '-' : '+'
  return `${sign}${Math.abs(value).toFixed(decimals)}`
}

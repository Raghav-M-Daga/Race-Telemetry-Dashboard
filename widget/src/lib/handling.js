/**
 * Handling balance: the understeer / oversteer model.
 *
 * The dashboard already shows three things that all describe the same corner —
 * how much the driver is steering, how hard the car is being pushed sideways,
 * and how fast it is actually rotating. When those three disagree, the
 * disagreement has a name, and it is the most useful thing in the log.
 *
 * Two relationships tie them together:
 *
 *   1. Kinematics (no vehicle parameters needed):  a_y = r * v_x
 *      A car in steady-state cornering has lateral acceleration equal to yaw
 *      rate times forward speed. Holds at r = 0.973 on this log, slope 0.962.
 *      What is left over, a_y - r*v_x, is the rate the car is building or
 *      shedding sideslip — the transient "it's letting go" term.
 *
 *   2. The bicycle model (one fitted constant):  r_ref = delta * V / (L * SR)
 *      The yaw rate a given steering angle commands at a given speed. Comparing
 *      that with measured yaw rate gives the balance:
 *
 *          balance = r_ref - r_actual
 *          balance > 0  ->  turning LESS than commanded  ->  understeer
 *          balance < 0  ->  turning MORE than commanded  ->  oversteer
 *
 * All pure functions — see config.js for the fitted constants and how they were
 * obtained, and the README for the validation.
 */

import {
  AY_BINS,
  BALANCE_MIN_AY,
  BALANCE_MIN_SPEED_MS,
  BALANCE_NEUTRAL_DEG_S,
  COLORS,
  STEERING_ZERO_OFFSET_DEG,
  YAW_GAIN_LSR_M,
} from '../config.js'
import { RAD_TO_DEG } from './vehicle.js'

/** Steering angle with the sensor zero offset removed, in degrees. */
export function correctedSteeringAngle(rawSteeringDeg) {
  return rawSteeringDeg - STEERING_ZERO_OFFSET_DEG
}

/**
 * Yaw rate (deg/s) that this steering angle commands at this speed.
 * Zero at a standstill: with no forward speed, steering commands no rotation.
 */
export function referenceYawRate(correctedSteeringDeg, speedMs) {
  const steeringRad = correctedSteeringDeg / RAD_TO_DEG
  return ((steeringRad * speedMs) / YAW_GAIN_LSR_M) * RAD_TO_DEG
}

/**
 * Rate of sideslip build-up (m/s²), from the kinematic identity above.
 * Parameter-free — no fitted constants — and it correlates at 0.89 with the
 * measured d(sideslip)/dt, which is what makes it trustworthy.
 */
export function slipRate(lateralAcceleration, yawRateDegS, speedMs) {
  return lateralAcceleration - (yawRateDegS / RAD_TO_DEG) * speedMs
}

/**
 * Full balance assessment for one instant.
 *
 * `signedBalance` folds out the turn direction so understeer is always positive
 * whichever way the car is turning — otherwise a left and a right corner with
 * identical handling would read as opposite numbers.
 */
export function handlingBalance({ steeringAngle, yawRate, lateralAcceleration, speed }) {
  const corrected = correctedSteeringAngle(steeringAngle)
  const refYawRate = referenceYawRate(corrected, speed)
  const rawBalance = refYawRate - yawRate

  // Below these the numbers are dominated by noise: at low speed the reference
  // yaw rate collapses toward zero, and off-throttle straight-line running has
  // no balance to speak of. Say so rather than showing a meaningless needle.
  const isCornering =
    speed >= BALANCE_MIN_SPEED_MS && Math.abs(lateralAcceleration) >= BALANCE_MIN_AY

  const turnDirection = Math.sign(lateralAcceleration) || 1
  const signedBalance = rawBalance * turnDirection

  let state = 'neutral'
  if (isCornering) {
    if (signedBalance > BALANCE_NEUTRAL_DEG_S) state = 'understeer'
    else if (signedBalance < -BALANCE_NEUTRAL_DEG_S) state = 'oversteer'
  }

  return {
    isCornering,
    refYawRate,
    signedBalance: isCornering ? signedBalance : 0,
    state,
    slipRate: slipRate(lateralAcceleration, yawRate, speed),
  }
}

/** Which |AY| bin an instant belongs to, or -1 if it is below the first bin. */
export function ayBinIndex(lateralAcceleration) {
  const magnitude = Math.abs(lateralAcceleration)
  return AY_BINS.findIndex(({ min, max }) => magnitude >= min && magnitude < max)
}

/** Colour + copy for a balance state. Never colour alone — the label ships with it. */
export function balancePresentation(state) {
  if (state === 'understeer') return { color: COLORS.understeer, label: 'UNDERSTEER' }
  if (state === 'oversteer') return { color: COLORS.oversteer, label: 'OVERSTEER' }
  return { color: COLORS.neutralBalance, label: 'NEUTRAL' }
}

/**
 * Median of a numeric array. Used for the per-bin signature rather than a mean
 * because a handful of transient spikes would otherwise drag a bin's value
 * around; the offline analysis used medians for the same reason.
 */
export function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

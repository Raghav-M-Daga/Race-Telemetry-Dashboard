/**
 * Derived channels, and the convention discovery that has to happen before any
 * of them can be trusted.
 *
 * The car does not tell us its axis conventions or its units, so we determine
 * them from the data and fail loudly if the result does not hold together.
 * Everything here was validated against the reference log; the numbers quoted
 * in the comments are what that validation produced.
 */

import { CONFIG } from './config.js'
import { savitzkyGolay } from './savitzkyGolay.js'

const RAD_TO_DEG = 180 / Math.PI

/**
 * Max and min over an array, WITHOUT spreading it into Math.max.
 *
 * `Math.max(...array)` passes every element as a separate argument, and V8
 * overflows the call stack somewhere past ~125,000 of them. On a 100 Hz grid
 * that is about 21 minutes of running — so the engine worked perfectly through
 * one replay and then threw `RangeError: Maximum call stack size exceeded` as
 * soon as the session grew past it, which is exactly when laps stopped
 * appearing. Never spread a per-sample array.
 */
export function maxOf(values, initial = -Infinity) {
  let best = initial
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v) && v > best) best = v
  }
  return best
}

export function minOf(values, initial = Infinity) {
  let best = initial
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v) && v < best) best = v
  }
  return best
}

/** Pearson correlation, ignoring non-finite pairs. */
export function correlation(a, b, mask = null) {
  let n = 0
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < a.length; i++) {
    if (mask && !mask[i]) continue
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue
    sumA += a[i]; sumB += b[i]; n++
  }
  if (n < 3) return 0
  const meanA = sumA / n
  const meanB = sumB / n
  let cov = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < a.length; i++) {
    if (mask && !mask[i]) continue
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue
    const da = a[i] - meanA
    const db = b[i] - meanB
    cov += da * db; varA += da * da; varB += db * db
  }
  if (varA <= 0 || varB <= 0) return 0
  return cov / Math.sqrt(varA * varB)
}

/** Least-squares slope and intercept of y on x. */
export function linearFit(x, y, mask = null) {
  let n = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < x.length; i++) {
    if (mask && !mask[i]) continue
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue
    sx += x[i]; sy += y[i]; n++
  }
  if (n < 3) return { slope: 0, intercept: 0, r2: 0, samples: n }
  const mx = sx / n
  const my = sy / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < x.length; i++) {
    if (mask && !mask[i]) continue
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue
    const dx = x[i] - mx
    const dy = y[i] - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  if (sxx <= 0) return { slope: 0, intercept: my, r2: 0, samples: n }
  const slope = sxy / sxx
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0
  return { slope, intercept: my - slope * mx, r2, samples: n }
}

/**
 * Body-frame derived channels.
 *
 * beta  = atan2(v_y, v_x)          sideslip: pointing versus going
 * a_x   = dv_x/dt - r * v_y        longitudinal, body frame
 * a_y_k = dv_y/dt + r * v_x        lateral, kinematic
 *
 * The cross terms are the transport terms of a rotating frame; without them the
 * derivative of a body velocity is not an acceleration. Their necessity is not
 * assumed — see `checkConventions`, which finds the kinematic lateral matches
 * the measured accelerometer at r = +0.9891 with these signs and r = -0.9374
 * with the cross term negated.
 */
export function deriveChannels({ speedX, speedY, yawRateRadS }, spacing = 1 / CONFIG.sampleRateHz) {
  const opts = { window: CONFIG.sgWindow, order: CONFIG.sgOrder, spacing }

  const vx = savitzkyGolay(speedX, opts)
  const vy = savitzkyGolay(speedY, opts)
  const r = savitzkyGolay(yawRateRadS, opts)
  const dvx = savitzkyGolay(speedX, { ...opts, deriv: 1 })
  const dvy = savitzkyGolay(speedY, { ...opts, deriv: 1 })

  const n = vx.length
  const beta = new Array(n)
  const accelX = new Array(n)
  const accelYKinematic = new Array(n)
  const magnitude = new Array(n)
  const direction = new Array(n)

  for (let i = 0; i < n; i++) {
    beta[i] = vx[i] > 1 ? Math.atan2(vy[i], vx[i]) * RAD_TO_DEG : 0
    accelX[i] = dvx[i] - r[i] * vy[i]
    accelYKinematic[i] = dvy[i] + r[i] * vx[i]
    magnitude[i] = Math.hypot(accelX[i], accelYKinematic[i])
    // Direction in the g-g plane: 0 = pure acceleration, +-180 = pure braking,
    // +-90 = pure cornering.
    direction[i] = Math.atan2(accelYKinematic[i], accelX[i]) * RAD_TO_DEG
  }

  return { vx, vy, r, beta, accelX, accelYKinematic, magnitude, direction }
}

/**
 * Startup health check and unit discovery. Nothing downstream may run until
 * this passes.
 *
 * Reference-log results, for comparison when this runs on new data:
 *   kinematic lateral vs sensor 10 : r = +0.9891, slope 1.027
 *   steering vs yaw rate           : r = +0.894
 *   steering range                 : +-87.1 -> degrees
 *   wheel speed vs v_x slope       : 2.2015 (R2 0.957) -> mph
 *   front-left under power/braking : asymmetry 0.149 -> free-rolling
 */
export function checkConventions({
  derived, lateralAccel, steeringAngle, wheelSpeedFL, yawRateRaw,
}) {
  const { vx, accelYKinematic } = derived
  const moving = vx.map((v) => v > 5)

  // --- the load-bearing check: does the kinematic lateral match the sensor? --
  const withCross = correlation(accelYKinematic, lateralAccel, moving)
  const negatedCross = accelYKinematic.map((_, i) => {
    const dvy = accelYKinematic[i] - derived.r[i] * vx[i]
    return dvy - derived.r[i] * vx[i]
  })
  const withoutCross = correlation(negatedCross, lateralAccel, moving)
  const scale = linearFit(accelYKinematic, lateralAccel, moving)

  // A correlation needs variation in both series. A car held at exactly
  // constant speed on a constant radius has none, and reporting "the frame is
  // wrong" there would be false — the honest answer is that it cannot be
  // checked yet. Distinguish the two cases explicitly.
  const spread = (series) => {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < series.length; i++) {
      if (!moving[i] || !Number.isFinite(series[i])) continue
      if (series[i] < min) min = series[i]
      if (series[i] > max) max = series[i]
    }
    return Number.isFinite(min) ? max - min : 0
  }
  const derivedSpread = spread(accelYKinematic)
  const measuredSpread = spread(lateralAccel)
  // 0.1 m/s^2 is a hundredth of a g — below this the signal is a constant.
  const verifiable = derivedSpread > 0.1 && measuredSpread > 0.1

  const warnings = []
  // NOT Math.abs: an inverted axis correlates at -0.998, which is perfect
  // agreement in magnitude and completely wrong in sign. Accepting it would
  // mirror every left corner into a right one.
  const healthy = verifiable && withCross >= CONFIG.minKinematicCorrelation
  if (!verifiable) {
    warnings.push(
      'Lateral acceleration has too little variation to verify the frame '
      + `convention (derived spread ${derivedSpread.toFixed(3)}, measured `
      + `${measuredSpread.toFixed(3)} m/s^2). Not an error — there is simply nothing to check yet.`,
    )
  } else if (!healthy) {
    warnings.push(
      `Kinematic lateral acceleration correlates only ${withCross.toFixed(3)} with the `
      + `measured accelerometer (needs ${CONFIG.minKinematicCorrelation}). The frame `
      + 'convention is wrong or a channel is mis-mapped; coaching is suppressed.',
    )
  }
  if (withCross < 0) {
    warnings.push('Lateral axis is inverted relative to the accelerometer.')
  }

  // --- steering sign --------------------------------------------------------
  const steeringVsYaw = correlation(steeringAngle, derived.r, moving)
  const steeringSign = steeringVsYaw >= 0 ? 1 : -1

  // --- units ----------------------------------------------------------------
  let steeringMax = 0
  for (const value of steeringAngle) {
    if (Number.isFinite(value)) steeringMax = Math.max(steeringMax, Math.abs(value))
  }
  // A wheel turned more than 2pi of "radians" is really degrees.
  const steeringUnits = steeringMax > 6.5 ? 'degrees' : 'radians'

  let yawMax = 0
  for (const value of yawRateRaw ?? []) {
    if (Number.isFinite(value)) yawMax = Math.max(yawMax, Math.abs(value))
  }
  const yawRateUnits = yawMax > 12 ? 'deg/s' : 'rad/s'

  // Wheel-speed scale is fitted only during steady cruise: fitting over
  // everything folds tyre slip into the calibration.
  const steady = derived.accelX.map((a, i) => moving[i] && Math.abs(a) < 1)
  const wheelFit = linearFit(vx, wheelSpeedFL, steady)
  // Without speed variation the slope is meaningless; fall back to the ratio of
  // the means, which still separates mph from m/s.
  const speedSpread = spread(vx)
  let wheelScale = wheelFit.slope
  let scaleSource = 'regression'
  if (!(speedSpread > 1) || !(wheelFit.r2 > 0.5)) {
    let sumWheel = 0
    let sumSpeed = 0
    let n = 0
    for (let i = 0; i < vx.length; i++) {
      if (!moving[i] || !Number.isFinite(wheelSpeedFL[i])) continue
      sumWheel += wheelSpeedFL[i]
      sumSpeed += vx[i]
      n++
    }
    wheelScale = n && sumSpeed > 0 ? sumWheel / sumSpeed : 1
    scaleSource = 'ratio of means (insufficient speed variation to regress)'
  }
  const wheelUnits = wheelScale > 3.0 ? 'kph'
    : wheelScale > 1.8 ? 'mph' : 'm/s'
  if (!(wheelScale > 0)) wheelScale = 1

  // --- driven or free-rolling? ---------------------------------------------
  // A driven wheel runs ahead of the body under power by MORE than it does
  // under braking. A constant offset in both directions is a calibration error,
  // not drive slip.
  let accelSum = 0
  let accelCount = 0
  let brakeSum = 0
  let brakeCount = 0
  for (let i = 0; i < vx.length; i++) {
    if (!moving[i] || !Number.isFinite(wheelSpeedFL[i])) continue
    const wheelMs = wheelSpeedFL[i] / wheelScale
    if (derived.accelX[i] > 1.5) { accelSum += wheelMs - vx[i]; accelCount++ }
    else if (derived.accelX[i] < -1.5) { brakeSum += wheelMs - vx[i]; brakeCount++ }
  }
  const underPower = accelCount ? accelSum / accelCount : 0
  const underBraking = brakeCount ? brakeSum / brakeCount : 0
  // The DIFFERENCE is what distinguishes drive slip from a scale offset.
  const slipAsymmetry = underPower - underBraking
  const frontLeftDriven = slipAsymmetry > 0.25
  if (!frontLeftDriven) {
    // Free-rolling: usable as a lockup reference.
  } else {
    warnings.push('Front-left wheel appears driven; it cannot serve as a lockup reference.')
  }

  return {
    healthy,
    verifiable,
    warnings,
    kinematic: {
      derivedSpread,
      measuredSpread,
      correlationWithCrossTerm: withCross,
      correlationWithoutCrossTerm: withoutCross,
      scaleSlope: scale.slope,
      scaleIntercept: scale.intercept,
      samples: scale.samples,
    },
    steering: { units: steeringUnits, sign: steeringSign, correlationWithYaw: steeringVsYaw, maxObserved: steeringMax },
    yawRate: { units: yawRateUnits, maxObserved: yawMax },
    wheelSpeed: {
      units: wheelUnits,
      scaleToMetresPerSecond: wheelScale,
      scaleSource,
      fitR2: wheelFit.r2,
      offsetUnderPower: underPower,
      offsetUnderBraking: underBraking,
      slipAsymmetry,
      driven: frontLeftDriven,
      usableAsLockupReference: !frontLeftDriven,
    },
  }
}

/**
 * Event taxonomy: what KIND of mistake was made, not merely where.
 *
 * Every divergence gets every factor measured — entry speed, minimum speed,
 * exit speed, lateral g, slip angle, steering angle and rate, throttle,
 * braking — against the driver's own fastest clean lap at the same place. The
 * pattern those numbers form is what names the event.
 *
 * NO FIXED THRESHOLDS
 *
 * "Slip was more than 4 degrees" is an opinion about cars. What matters is
 * whether a difference is larger than this driver's own lap-to-lap scatter at
 * that place, so every comparison is expressed in multiples of the measured
 * scatter of that metric. A driver who is consistently within 0.2 m/s at a
 * corner has a much lower bar for "meaningfully slower" than one who varies by
 * 2 m/s, and that is correct.
 */

export const EVENT_TYPES = {
  OVER_DRIVEN: 'overDriven',
  UNDER_DRIVEN: 'underDriven',
  MID_CORNER: 'midCornerLoss',
  SLOW_STRAIGHT: 'slowStraight',
  INHERITED: 'inheritedEntry',
  INCIDENT: 'incident',
  UNEXPLAINED: 'unexplained',
}

/**
 * Presentation for each type.
 *
 * Four chromatic colours, validated as a categorical set on both dashboard
 * surfaces (worst pair dE 9.9 deuteranopia, 16.9 normal vision). A fifth
 * distinct hue is not achievable — blue against violet measures dE 1.9 under
 * protanopia — so "inherited" takes an achromatic grey, which is right anyway:
 * it is a pointer to an earlier flag rather than a mistake in its own right.
 *
 * `shape` is a second, redundant channel so the map never relies on colour.
 */
export const EVENT_INFO = {
  [EVENT_TYPES.OVER_DRIVEN]: {
    label: 'Pushed too hard',
    color: '#d03b3b',
    shape: 'triangle',
    summary: 'Over-drove the entry — the car slid and the exit paid for it.',
  },
  [EVENT_TYPES.UNDER_DRIVEN]: {
    label: 'Not pushed hard enough',
    color: '#3987e5',
    shape: 'circle',
    summary: 'Carried less speed and less grip than the car had available.',
  },
  [EVENT_TYPES.MID_CORNER]: {
    label: 'Lost it mid-corner',
    color: '#c98500',
    shape: 'diamond',
    summary: 'Entry and exit matched, but time went missing in between.',
  },
  [EVENT_TYPES.SLOW_STRAIGHT]: {
    label: 'Slow on the straight',
    color: '#1baf7a',
    shape: 'square',
    summary: 'Time lost on a straight that the corner before it does not explain.',
  },
  [EVENT_TYPES.INHERITED]: {
    label: 'Arrived slow',
    color: '#5b626d',
    shape: 'chevron',
    summary: 'The speed was already gone — the cause is an earlier flag.',
  },
  /**
   * Something went badly wrong: a spin, an excursion, a stop.
   *
   * Near-white rather than a sixth hue. Five distinguishable chromatic colours
   * are already unachievable, and a sixth would certainly collide — but an
   * incident differs from the others in LUMINANCE, which no form of colour
   * blindness affects. It is also the loudest thing on the map, which is right.
   */
  /**
   * Time was lost, but no input differs enough from the reference to say why.
   *
   * This exists because the alternative is worse. Without it, every straight
   * that was not "arrived slow" fell through to "not pushed hard enough" by
   * default — a verdict with no evidence behind it. On the reference log that
   * produced flags reading "less throttle than your best lap" on stretches
   * where the driver used MORE throttle and MORE grip.
   *
   * Naming the absence of a cause is more useful than inventing one.
   */
  [EVENT_TYPES.UNEXPLAINED]: {
    label: 'No clear cause',
    color: '#5b626d',
    shape: 'hollow',
    summary: 'Time was lost here, but no input differs enough from your best lap to explain it.',
  },
  [EVENT_TYPES.INCIDENT]: {
    label: 'Incident',
    color: '#f2f4f8',
    shape: 'star',
    summary: 'Something went badly wrong here — a spin, an off, or a stop.',
    isIncident: true,
  },
}

/**
 * Scatter of a metric across the driver's own clean laps, as a MAD.
 * This is the yardstick every comparison below is measured in.
 */
export function metricScatter(values) {
  const finite = values.filter(Number.isFinite)
  if (finite.length < 3) return null
  const sorted = [...finite].sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]
  const deviations = finite.map((v) => Math.abs(v - median)).sort((a, b) => a - b)
  return { median, mad: deviations[deviations.length >> 1], samples: finite.length }
}

/** How many scatter-widths a difference is. Infinity when scatter is zero. */
function significance(delta, scatter, floor) {
  const width = Math.max(scatter?.mad ?? 0, floor)
  if (!(width > 0)) return 0
  return delta / width
}

/**
 * Classify one divergence event, having measured everything.
 *
 * `measured` carries every factor as { observed, reference, delta }.
 * `scatter` carries the driver's own MAD for each, from their clean laps.
 * `floors` are the smallest differences worth discussing at all — sensor
 * resolution, not judgement.
 */
export function classifyEvent({ measured, scatter = {}, isCorner, deficitBefore, floors = {} }) {
  const {
    minSpeedFloor = 0.15, speedFloor = 0.15, lateralFloor = 0.3,
    slipFloor = 0.3, steerRateFloor = 15, throttleFloor = 0.04,
  } = floors

  const sig = {
    entry: significance(measured.entrySpeed.delta, scatter.entrySpeed, speedFloor),
    min: significance(measured.minSpeed.delta, scatter.minSpeed, minSpeedFloor),
    exit: significance(measured.exitSpeed.delta, scatter.exitSpeed, speedFloor),
    lateral: significance(measured.peakLateral.delta, scatter.peakLateral, lateralFloor),
    slip: significance(measured.peakSlip.delta, scatter.peakSlip, slipFloor),
    steerRate: significance(measured.peakSteerRate.delta, scatter.peakSteerRate, steerRateFloor),
    throttle: significance(measured.meanThrottle.delta, scatter.meanThrottle, throttleFloor),
  }

  // One scatter-width is "the same as usual"; two is a real difference.
  const REAL = 2
  const slow = (s) => s < -REAL
  const high = (s) => s > REAL

  // The deficit was already there before this point: whatever happened here,
  // the cause is upstream. Checked first because every other verdict would be
  // describing a symptom.
  const arrivedSlow = slow(sig.entry) && deficitBefore > 0.3

  const factors = {
    lostExit: slow(sig.exit),
    lostApex: slow(sig.min),
    lessGrip: slow(sig.lateral),
    moreGrip: high(sig.lateral),
    moreSlip: high(sig.slip) && measured.peakSlip.trustworthy,
    lessSlip: slow(sig.slip) && measured.peakSlip.trustworthy,
    sharperSteering: high(sig.steerRate),
    lessThrottle: slow(sig.throttle),
    arrivedSlow,
  }

  let type
  let reasons = []

  if (!isCorner) {
    // On a straight there is only one thing a driver controls: how much of the
    // car they use. So "slow on the straight" REQUIRES positive evidence of
    // that — less throttle, or a speed that decayed while the reference's did
    // not. Without evidence the honest answer is that we do not know, and
    // saying so beats defaulting to a verdict nobody can act on.
    if (arrivedSlow) {
      type = EVENT_TYPES.INHERITED
      reasons = ['entered the straight already down on speed']
    } else if (factors.lessThrottle) {
      type = EVENT_TYPES.SLOW_STRAIGHT
      reasons.push('less throttle than the reference lap over the same stretch')
      if (factors.lostExit) reasons.push('and lower speed leaving it')
    } else if (factors.lostExit && factors.lostApex) {
      type = EVENT_TYPES.SLOW_STRAIGHT
      reasons.push('speed decayed along the straight while the reference lap held on')
    } else {
      type = EVENT_TYPES.UNEXPLAINED
      reasons.push('time was lost but throttle, speed and grip all match your best lap')
      reasons.push('most likely a different line, or a segment boundary falling awkwardly')
    }
  } else if (arrivedSlow && !factors.lostExit && !factors.moreSlip) {
    type = EVENT_TYPES.INHERITED
    reasons = ['arrived below the reference speed and simply carried the deficit through']
  } else if (factors.lostExit && (factors.moreSlip || factors.sharperSteering)) {
    // Over-driven: the exit is gone AND the car was working harder than the
    // reference to get there. This is the one that looks fast and is not.
    type = EVENT_TYPES.OVER_DRIVEN
    if (factors.moreSlip) reasons.push('more slip angle than the reference lap')
    if (factors.sharperSteering) reasons.push('sharper steering input')
    reasons.push('exit speed below the reference')
  } else if (factors.lostExit && factors.lessGrip && (factors.lostApex || factors.lessSlip)) {
    // Under-driven: slower AND working the tyres less. Grip was left unused.
    type = EVENT_TYPES.UNDER_DRIVEN
    reasons.push('less lateral grip used than the reference lap')
    if (factors.lostApex) reasons.push('lower minimum speed')
    reasons.push('exit speed below the reference')
  } else if (!factors.lostExit && !slow(sig.entry)) {
    // Entry and exit both matched, yet time went missing between them.
    type = EVENT_TYPES.MID_CORNER
    if (factors.lostApex) reasons.push('minimum speed dipped below the reference')
    if (factors.moreSlip) reasons.push('extra slip angle mid-corner')
    if (factors.sharperSteering) reasons.push('a steering correction')
    if (!reasons.length) reasons.push('no single input differs — most likely a different line')
  } else if (factors.lessGrip || factors.lostApex) {
    type = EVENT_TYPES.UNDER_DRIVEN
    if (factors.lessGrip) reasons.push('less lateral grip used than the reference lap')
    if (factors.lostApex) reasons.push('lower minimum speed')
  } else {
    // Same principle in a corner: no differing input means no verdict.
    type = EVENT_TYPES.UNEXPLAINED
    reasons.push('time was lost but no input differs meaningfully from your best lap')
    reasons.push('most likely a line difference rather than a technique one')
  }

  // How firmly this is held: the strongest evidence, capped.
  const strength = Math.max(
    Math.abs(sig.exit), Math.abs(sig.min), Math.abs(sig.lateral),
    Math.abs(sig.slip), Math.abs(sig.steerRate), Math.abs(sig.throttle),
  )
  const confidence = Math.max(0, Math.min(1, (strength - REAL) / 6))

  return { type, info: EVENT_INFO[type], reasons, significance: sig, factors, confidence }
}

/**
 * A one-sentence headline in driver language, always carrying a number and a
 * comparison to their own best lap.
 */
export function headlineFor(type, measured, secondsLost, segmentLabel) {
  const where = segmentLabel ? `${segmentLabel}` : 'here'
  const s = `${secondsLost.toFixed(2)}s`
  switch (type) {
    case EVENT_TYPES.OVER_DRIVEN:
      return `${where}: ${measured.peakSlip.delta.toFixed(1)}° more slip than your best lap and `
        + `${Math.abs(measured.exitSpeed.delta).toFixed(1)} m/s less exit speed — ${s}.`
    case EVENT_TYPES.UNDER_DRIVEN:
      return `${where}: ${Math.abs(measured.peakLateral.delta / 9.81).toFixed(2)}g less grip used and `
        + `${Math.abs(measured.exitSpeed.delta).toFixed(1)} m/s less exit speed — ${s}.`
    case EVENT_TYPES.MID_CORNER:
      return `${where}: entry and exit matched your best lap but `
        + `${Math.abs(measured.minSpeed.delta).toFixed(1)} m/s went missing at the apex — ${s}.`
    case EVENT_TYPES.SLOW_STRAIGHT:
      return `${where}: ${Math.abs(measured.meanThrottle.delta * 100).toFixed(0)}% less throttle than `
        + `your best lap along here — ${s}.`
    case EVENT_TYPES.INHERITED:
      return `${where}: arrived ${Math.abs(measured.entrySpeed.delta).toFixed(1)} m/s down — `
        + `the speed was lost before this point (${s}).`
    case EVENT_TYPES.UNEXPLAINED:
      return `${where}: ${s} lost, but every input matches your best lap — look at the line.`
    default:
      return `${where}: ${s} lost.`
  }
}

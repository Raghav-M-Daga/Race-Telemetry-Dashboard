/**
 * Why a lap started losing time at a given point.
 *
 * Time delta says WHERE. This says WHAT THE DRIVER DID DIFFERENTLY, by
 * comparing their inputs and the car's response against the quickest clean lap
 * at the same places on track.
 *
 * Every comparison is against that reference lap. No thresholds on absolute
 * values appear here: "1.4 degrees more steering than your best lap for the
 * same corner" is a statement about this driver; "more than 4 degrees of
 * steering" would be an opinion about cars in general.
 *
 * The slip channel is the one exception needing care. It carries a known ~4%
 * tail of INS dropouts reaching tens of degrees, and those land at low lateral
 * g — so any slip-based cause is gated on the tyres actually being loaded.
 */

/** Mean of a series over a window, skipping non-finite samples. */
function windowMean(series, from, to) {
  let sum = 0
  let count = 0
  for (let i = Math.max(0, from); i < Math.min(to, series.length); i++) {
    if (Number.isFinite(series[i])) { sum += series[i]; count++ }
  }
  return count ? sum / count : NaN
}

function windowMax(series, from, to, validMask = null) {
  let best = -Infinity
  for (let i = Math.max(0, from); i < Math.min(to, series.length); i++) {
    if (validMask && !validMask[i]) continue
    if (Number.isFinite(series[i]) && series[i] > best) best = series[i]
  }
  return Number.isFinite(best) ? best : NaN
}

function windowMin(series, from, to) {
  let best = Infinity
  for (let i = Math.max(0, from); i < Math.min(to, series.length); i++) {
    if (Number.isFinite(series[i]) && series[i] < best) best = series[i]
  }
  return Number.isFinite(best) ? best : NaN
}

import { classifyEvent, headlineFor } from './events.js'

/**
 * Explain one divergence event.
 *
 * `lap` and `reference` carry the same channel names on the same distance grid.
 * The lead-in window before the onset matters as much as the event itself: an
 * arrival that was already slow is a different mistake from one made here.
 */
export function explainDivergence(event, lap, reference, options = {}) {
  const {
    leadInM = 30,
    gridSpacing = 1,
    slipGripGate = 0.4,
    gripLimit = null,
    isCorner = false,
    segmentLabel = null,
    scatter = {},
  } = options

  const onset = event.onsetIndex
  const peak = event.peakIndex
  const leadIn = Math.max(0, onset - Math.round(leadInM / gridSpacing))
  // The event window is the one the COST is integrated over. Everything that
  // describes what happened during the event is measured across exactly this
  // span, so the numbers shown always explain the seconds claimed.
  //
  // An earlier version used three different windows — the deficit-growth span
  // for minimum speed, the growth span plus lead-in for the peaks, and the full
  // cost window for throttle — so a flag could report speeds from a stretch of
  // road where none of its time was actually lost.
  const eventEnd = Math.max(peak + 1, event.recoveryIndex)

  // --- what the car was doing, here and just before -------------------------
  const speedAtOnset = lap.speed[onset]
  const referenceSpeedAtOnset = reference.speed[onset]
  const speedBefore = windowMean(lap.speed, leadIn, onset)
  const referenceSpeedBefore = windowMean(reference.speed, leadIn, onset)

  const minSpeed = windowMin(lap.speed, onset, eventEnd)
  const referenceMinSpeed = windowMin(reference.speed, onset, eventEnd)

  const lateral = windowMax(lap.absLateral, onset, eventEnd)
  const referenceLateral = windowMax(reference.absLateral, onset, eventEnd)

  const braking = windowMin(lap.accelX, leadIn, eventEnd)
  const referenceBraking = windowMin(reference.accelX, leadIn, eventEnd)

  const steering = windowMax(lap.absSteering, onset, eventEnd)
  const referenceSteering = windowMax(reference.absSteering, onset, eventEnd)

  const steerRate = windowMax(lap.absSteerRate, onset, eventEnd)
  const referenceSteerRate = windowMax(reference.absSteerRate, onset, eventEnd)

  const throttle = windowMean(lap.throttle, onset, eventEnd)
  const referenceThrottle = windowMean(reference.throttle, onset, eventEnd)

  // Exit speed: the last sample of the event window. This is the number that
  // pays out down whatever follows, so it is measured explicitly rather than
  // inferred from the deficit.
  const exitIdx = Math.min(eventEnd, lap.speed.length - 1)
  const exitSpeed = lap.speed[exitIdx]
  const referenceExitSpeed = reference.speed[exitIdx]

  // Slip is read only through the validity mask built in the engine, which
  // rejects the INS dropout tail. Without it this comparison reported 38 and 66
  // degrees of "extra slip" on the reference log — sensor glitches that
  // outranked every genuine cause.
  const slip = windowMax(lap.absSlip, onset, eventEnd, lap.slipValid)
  const referenceSlip = windowMax(reference.absSlip, onset, eventEnd, reference.slipValid)
  // And only trusted where the tyres are actually loaded: a car using a
  // fraction of its grip is not sliding, whatever the channel says.
  const gripFraction = gripLimit > 0 ? lateral / gripLimit : 0
  const slipTrustworthy = Number.isFinite(slip) && Number.isFinite(referenceSlip)
    && gripFraction > slipGripGate

  // ------------------------------------------------------------------------
  // EVERY factor, measured, for every event. Nothing is skipped because some
  // other factor already looked decisive — the taxonomy needs the whole
  // picture, and the detail panel shows all of it whatever the verdict.
  // ------------------------------------------------------------------------
  const measured = {
    entrySpeed: {
      observed: speedBefore, reference: referenceSpeedBefore,
      delta: speedBefore - referenceSpeedBefore, units: 'm/s',
      label: 'Entry speed',
    },
    speedAtFlag: {
      observed: speedAtOnset, reference: referenceSpeedAtOnset,
      delta: speedAtOnset - referenceSpeedAtOnset, units: 'm/s',
      label: 'Speed at the flag',
    },
    minSpeed: {
      observed: minSpeed, reference: referenceMinSpeed,
      delta: minSpeed - referenceMinSpeed, units: 'm/s',
      label: 'Minimum speed',
    },
    exitSpeed: {
      observed: exitSpeed, reference: referenceExitSpeed,
      delta: exitSpeed - referenceExitSpeed, units: 'm/s',
      label: 'Exit speed',
    },
    peakLateral: {
      observed: lateral, reference: referenceLateral,
      delta: lateral - referenceLateral, units: 'm/s²',
      label: 'Peak lateral g', inG: true,
    },
    peakSlip: {
      observed: slip, reference: referenceSlip,
      delta: (Number.isFinite(slip) && Number.isFinite(referenceSlip)) ? slip - referenceSlip : 0,
      units: '°', label: 'Peak slip angle', trustworthy: slipTrustworthy,
    },
    peakSteering: {
      observed: steering, reference: referenceSteering,
      delta: steering - referenceSteering, units: '°', label: 'Peak steering angle',
    },
    peakSteerRate: {
      observed: steerRate, reference: referenceSteerRate,
      delta: steerRate - referenceSteerRate, units: '°/s', label: 'Peak steering rate',
    },
    meanThrottle: {
      observed: throttle, reference: referenceThrottle,
      delta: throttle - referenceThrottle, units: 'fraction', label: 'Average throttle',
      asPercent: true,
    },
    peakBraking: {
      observed: braking, reference: referenceBraking,
      delta: braking - referenceBraking, units: 'm/s²', label: 'Peak deceleration',
    },
  }

  const verdict = classifyEvent({
    measured,
    scatter,
    isCorner,
    deficitBefore: event.deficitBefore,
  })

  return {
    ...verdict,
    measured,
    slipTrustworthy,
    headline: headlineFor(verdict.type, measured, event.secondsLost, segmentLabel),
    action: ACTIONS[verdict.type],
  }
}

/** What to actually do about each kind of event. */
export const ACTIONS = {
  overDriven: 'Slow the entry slightly and turn in less abruptly. The car is sliding rather '
    + 'than turning, and everything past the apex is paying for it.',
  underDriven: 'There is grip here you did not use. Carry more speed in and lean on the tyres '
    + 'through the middle — your own best lap proves the car will take it.',
  midCornerLoss: 'Entry and exit were right, so look at the line: a tighter apex or a '
    + 'mid-corner correction is costing the time rather than the speed you carried.',
  slowStraight: 'Get to full throttle sooner and stay there. Nothing about the corner before '
    + 'explains this one.',
  inheritedEntry: 'Nothing to fix here — the speed was lost earlier. Work on the flag before this one.',
}

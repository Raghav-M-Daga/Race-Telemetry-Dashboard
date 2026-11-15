/**
 * The delta-time engine.
 *
 * On a distance grid, time is the integral of 1/speed, so the time difference
 * between two laps accumulates at
 *
 *     dt_rate(s) = 1/v_current(s) - 1/v_reference(s)      seconds per metre
 *
 * and the loss over a stretch is that rate integrated across it. This is exact
 * — no vehicle model, no threshold — and it is checkable: the sum over all
 * segments must equal the lap-time difference. That assertion is enforced.
 *
 * THE ATTRIBUTION PROBLEM
 *
 * Naively charging each segment with its own integral is wrong, and wrong in
 * the way that matters most. A corner exited 2 m/s slow keeps losing time all
 * the way down the following straight, where the driver is doing nothing wrong.
 * Blaming the straight sends the driver to fix the wrong place.
 *
 * So loss is attributed by where the speed DEFICIT GROWS:
 *
 *   - deficit widening across a segment: that segment generated the loss.
 *   - deficit narrowing: the driver recovered there; it is not to blame.
 *   - the rest is inherited from upstream and reported separately.
 */

import { CONFIG } from './config.js'

/** Cumulative time along a distance grid: t(s) = integral of ds / v. */
export function integrateTime(speed, gridSpacing) {
  const time = new Array(speed.length)
  time[0] = 0
  for (let i = 1; i < speed.length; i++) {
    // Guard a stopped or missing sample; an infinite dt would poison the lap.
    const v = Number.isFinite(speed[i]) && speed[i] > 0.5 ? speed[i] : 0.5
    time[i] = time[i - 1] + gridSpacing / v
  }
  return time
}

/**
 * Theoretical-best reference: for each segment, the speed trace of whichever
 * clean lap covered that segment quickest, concatenated.
 *
 * Requires two clean laps. With one, the caller must fall back to that lap and
 * mark confidence low — a lap compared against itself has nothing to say.
 */
export function buildTheoreticalBest(laps, segments, gridSpacing) {
  if (!laps.length || !segments.length) return null

  const gridLength = Math.min(...laps.map((lap) => lap.speed.length))
  const speed = new Array(gridLength).fill(NaN)
  const sources = []

  for (const segment of segments) {
    const from = segment.startIndex
    const to = Math.min(segment.endIndex, gridLength)
    if (to <= from) continue

    let bestLap = null
    let bestTime = Infinity
    for (const lap of laps) {
      let elapsed = 0
      let valid = true
      for (let i = from; i < to; i++) {
        const v = lap.speed[i]
        if (!Number.isFinite(v) || v <= 0.5) { valid = false; break }
        elapsed += gridSpacing / v
      }
      if (valid && elapsed < bestTime) { bestTime = elapsed; bestLap = lap }
    }
    if (!bestLap) continue
    for (let i = from; i < to; i++) speed[i] = bestLap.speed[i]
    sources.push({ segmentId: segment.id, lapNumber: bestLap.lapNumber, seconds: bestTime })
  }

  // A theoretical best is a composite; whether it is physically achievable is
  // a separate question, answered per corner by detectTradeoff.
  return {
    speed,
    sources,
    isComposite: new Set(sources.map((s) => s.lapNumber)).size > 1,
    contributingLaps: [...new Set(sources.map((s) => s.lapNumber))].sort((a, b) => a - b),
  }
}

/**
 * Per-sample loss rate and speed deficit against a reference.
 */
export function computeDelta(currentSpeed, referenceSpeed, gridSpacing) {
  const n = Math.min(currentSpeed.length, referenceSpeed.length)
  const rate = new Array(n).fill(0)
  const deficit = new Array(n).fill(0)
  const cumulative = new Array(n).fill(0)

  for (let i = 0; i < n; i++) {
    const vc = Number.isFinite(currentSpeed[i]) && currentSpeed[i] > 0.5 ? currentSpeed[i] : NaN
    const vr = Number.isFinite(referenceSpeed[i]) && referenceSpeed[i] > 0.5 ? referenceSpeed[i] : NaN
    if (!Number.isFinite(vc) || !Number.isFinite(vr)) {
      rate[i] = 0
      deficit[i] = 0
    } else {
      rate[i] = 1 / vc - 1 / vr
      deficit[i] = vr - vc
    }
    cumulative[i] = (i ? cumulative[i - 1] : 0) + rate[i] * gridSpacing
  }
  return { rate, deficit, cumulative, total: cumulative[n - 1] ?? 0 }
}

/**
 * Attribution units: the pieces loss is charged to.
 *
 * These are NOT the raw curvature segments. A corner's braking zone lies in the
 * straight before it, and that is where an over-slow entry actually creates its
 * deficit — charging it to the straight is technically true and useless, since
 * the driver thinks "I got T1 wrong", not "I got the last 30 m of S1 wrong".
 *
 * So each corner is widened to its entry/exit phases and the neighbouring
 * straights are trimmed to what is left. Units still tile the lap exactly, so
 * conservation is unaffected.
 */
export function buildAttributionUnits(segments, phasesBySegmentId, gridLength) {
  const units = segments.map((segment) => ({
    id: segment.id,
    label: segment.label,
    type: segment.type,
    startIndex: segment.startIndex,
    endIndex: Math.min(segment.endIndex, gridLength),
    startS: segment.startS,
    endS: segment.endS,
  }))

  for (const unit of units) {
    if (unit.type !== 'corner') continue
    const phases = phasesBySegmentId?.[unit.id]
    if (!phases) continue
    // Claim the braking approach and the exit run.
    unit.startIndex = Math.max(0, Math.min(unit.startIndex, phases.entryStart))
    unit.endIndex = Math.min(gridLength, Math.max(unit.endIndex, phases.exitEnd + 1))
  }

  // Resolve the overlaps that widening created. Straights yield to corners,
  // because the corner is the thing the driver can act on — but no unit is ever
  // squeezed out of existence: the SET of units must be identical on every lap
  // or the reports stop being comparable, which is the whole point of fixing
  // the segmentation once.
  units.sort((a, b) => a.startIndex - b.startIndex)
  for (let i = 1; i < units.length; i++) {
    const previous = units[i - 1]
    const current = units[i]
    if (current.startIndex >= previous.endIndex) continue
    if (previous.type === 'corner' && current.type === 'straight') {
      current.startIndex = previous.endIndex
    } else if (previous.type === 'straight' && current.type === 'corner') {
      previous.endIndex = current.startIndex
    } else {
      const midpoint = Math.floor((current.startIndex + previous.endIndex) / 2)
      previous.endIndex = midpoint
      current.startIndex = midpoint
    }
  }

  // Enforce a minimum width of one sample, left to right, so nothing vanishes.
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]
    if (i > 0) unit.startIndex = Math.max(unit.startIndex, units[i - 1].endIndex)
    unit.startIndex = Math.min(unit.startIndex, gridLength - 1)
    unit.endIndex = Math.max(unit.endIndex, unit.startIndex + 1)
    unit.endIndex = Math.min(unit.endIndex, gridLength)
    if (unit.endIndex <= unit.startIndex) {
      unit.startIndex = Math.max(0, gridLength - 1)
      unit.endIndex = gridLength
    }
  }
  return units
}

/**
 * Attribute a lap's loss.
 *
 * Two figures per unit, and the difference between them is the whole point:
 *
 *   rawSeconds       time lost INSIDE this unit's bounds
 *   generatedSeconds time lost ANYWHERE that this unit is responsible for
 *
 * The second is what a driver can act on. A corner entered 8 m/s too slow keeps
 * bleeding time until the deficit is recovered, and all of that belongs to the
 * corner — not to the straight that merely inherited it.
 *
 * Ownership is tracked sample by sample: whenever the deficit GROWS, the unit
 * containing that sample takes ownership of the deficit, and keeps it until
 * some later unit grows it further or it is recovered. Every sample's loss is
 * therefore charged to exactly one owner, so both figures conserve to the lap
 * total independently.
 */
export function attributeLoss(delta, units, gridSpacing) {
  const n = delta.rate.length
  const owner = new Array(n).fill(-1)

  // Which unit contains each sample.
  const unitAt = new Array(n).fill(-1)
  units.forEach((unit, index) => {
    for (let i = unit.startIndex; i < Math.min(unit.endIndex, n); i++) unitAt[i] = index
  })

  // 1 cm/s of deficit change is noise, not a mistake being made.
  const growthEpsilon = 0.01
  let currentOwner = -1
  for (let i = 0; i < n; i++) {
    const previousDeficit = i > 0 ? delta.deficit[i - 1] : 0
    const deficit = delta.deficit[i]
    if (deficit <= growthEpsilon) {
      // Back on terms with the reference: nobody owns anything.
      currentOwner = -1
    } else if (deficit > previousDeficit + growthEpsilon && unitAt[i] >= 0) {
      currentOwner = unitAt[i]
    } else if (currentOwner === -1 && unitAt[i] >= 0) {
      // A deficit already present with no owner (start of lap): charge it here.
      currentOwner = unitAt[i]
    }
    // Where nobody owns a deficit — the lap is level with or AHEAD of the
    // reference — the loss (a gain, in that case) still belongs to whichever
    // unit the car is in. Dropping it would break conservation, and would also
    // hide the places the driver is genuinely quicker.
    owner[i] = currentOwner >= 0 ? currentOwner : unitAt[i]
  }

  const raw = new Array(units.length).fill(0)
  const generated = new Array(units.length).fill(0)
  const generatedInside = new Array(units.length).fill(0)
  for (let i = 0; i < n; i++) {
    const loss = delta.rate[i] * gridSpacing
    if (unitAt[i] >= 0) raw[unitAt[i]] += loss
    if (owner[i] >= 0) {
      generated[owner[i]] += loss
      if (owner[i] === unitAt[i]) generatedInside[owner[i]] += loss
    }
  }

  return units.map((unit, index) => ({
    segmentId: unit.id,
    label: unit.label,
    type: unit.type,
    startS: unit.startS,
    endS: unit.endS,
    startIndex: unit.startIndex,
    endIndex: unit.endIndex,
    rawSeconds: raw[index],
    generatedSeconds: generated[index],
    // What this unit lost because of somebody else's deficit.
    inheritedSeconds: raw[index] - generatedInside[index],
    deficitIn: unit.startIndex > 0 ? delta.deficit[unit.startIndex - 1] : 0,
    deficitOut: delta.deficit[Math.min(unit.endIndex, n) - 1],
    deficitGrew: delta.deficit[Math.min(unit.endIndex, n) - 1]
      - (unit.startIndex > 0 ? delta.deficit[unit.startIndex - 1] : 0),
  }))
}

/**
 * Exit-speed carry-back.
 *
 * Re-integrates the straight AFTER a corner with the corner's exit speed
 * replaced by the reference exit speed, holding the observed acceleration
 * profile. The difference is the time the following straight lost purely
 * because of how the corner was exited — and it belongs to the corner.
 */
export function computeDownstreamCost(corner, following, currentSpeed, referenceSpeed, gridSpacing) {
  if (!following) return 0
  const exitIndex = Math.min(corner.endIndex, currentSpeed.length - 1)
  const from = following.startIndex
  const to = Math.min(following.endIndex, currentSpeed.length)
  if (to <= from + 1) return 0

  const actualExit = currentSpeed[exitIndex]
  const referenceExit = referenceSpeed[exitIndex]
  if (!Number.isFinite(actualExit) || !Number.isFinite(referenceExit)) return 0
  if (referenceExit <= actualExit) return 0 // exited at or above reference

  // The observed acceleration profile along the straight, as dv per metre.
  let counterfactual = referenceExit
  let counterfactualTime = 0
  let actualTime = 0
  for (let i = from; i < to; i++) {
    const v = currentSpeed[i]
    if (!Number.isFinite(v) || v <= 0.5) continue
    const next = Number.isFinite(currentSpeed[i + 1]) ? currentSpeed[i + 1] : v
    const dv = next - v
    actualTime += gridSpacing / v
    counterfactualTime += gridSpacing / Math.max(counterfactual, 0.5)
    // Same acceleration, higher starting speed.
    counterfactual = Math.max(counterfactual + dv, 0.5)
  }
  return Math.max(0, actualTime - counterfactualTime)
}

/**
 * Trade-off detection.
 *
 * If the quickest entry and the quickest exit through a corner came from
 * different laps, the composite "best" may not be physically achievable — the
 * entry that produced the quick apex may be exactly what spoiled the exit.
 * Saying "do both" would then be advice no driver can follow.
 */
export function detectTradeoff(corner, phases, laps, gridSpacing) {
  if (!phases || laps.length < 2) return { tradeoff: false }

  const entryFrom = phases.entryStart
  const entryTo = phases.apexIndex
  const exitFrom = phases.apexIndex
  const exitTo = Math.min(phases.exitEnd, Math.min(...laps.map((l) => l.speed.length)) - 1)

  const timeOver = (lap, from, to) => {
    let total = 0
    for (let i = from; i < to; i++) {
      const v = lap.speed[i]
      if (!Number.isFinite(v) || v <= 0.5) return Infinity
      total += gridSpacing / v
    }
    return total
  }

  let bestEntryLap = null
  let bestEntry = Infinity
  let bestExitLap = null
  let bestExit = Infinity
  for (const lap of laps) {
    const entry = timeOver(lap, entryFrom, entryTo)
    if (entry < bestEntry) { bestEntry = entry; bestEntryLap = lap.lapNumber }
    const exit = timeOver(lap, exitFrom, exitTo)
    if (exit < bestExit) { bestExit = exit; bestExitLap = lap.lapNumber }
  }

  return {
    tradeoff: bestEntryLap !== null && bestExitLap !== null && bestEntryLap !== bestExitLap,
    bestEntryLap,
    bestExitLap,
  }
}

/**
 * Conservation check: attributed losses must sum to the lap-time delta.
 *
 * Asserted rather than assumed. If this fails, the attribution is unsound and
 * every diagnosis built on it would be confidently wrong.
 */
export function checkConservation(attributions, totalDelta, tolerance = 0.02) {
  const sum = attributions.reduce((acc, a) => acc + a.rawSeconds, 0)
  const generatedSum = attributions.reduce((acc, a) => acc + a.generatedSeconds, 0)
  const error = Math.abs(sum - totalDelta)
  // Ownership charges every sample to exactly one unit, so the generated
  // figures must conserve independently. If they do not, the ownership walk has
  // dropped or double-counted a sample.
  const generatedError = Math.abs(generatedSum - totalDelta)
  return {
    ok: error <= tolerance && generatedError <= tolerance,
    attributedSum: sum,
    generatedSum,
    totalDelta,
    error,
    generatedError,
    tolerance,
  }
}

export { CONFIG }

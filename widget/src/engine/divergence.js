/**
 * Divergence events: the POINTS where a lap starts losing time.
 *
 * WHY POINTS AND NOT SEGMENTS
 *
 * Painting whole segments answers "where were you slow", which the lap time
 * already told you. What a driver can act on is where the two laps started to
 * come apart — the moment of the mistake, not the stretch of road that
 * inherited it.
 *
 * A divergence event is a run over which the speed deficit GROWS. Its onset is
 * the flag. Its cost is the time lost from that onset until the deficit is paid
 * back, which is what makes a corner responsible for the straight it ruined
 * without having to special-case corner-then-straight at all: if the exit is
 * worse, the deficit grows at the exit, and the flag lands on the corner.
 *
 * TWO REFERENCES, DELIBERATELY
 *
 *   timing reference  the theoretical best — a composite of the quickest
 *                     segments. Right for measuring time, since it is the
 *                     ceiling the driver has demonstrated.
 *   action reference  the single quickest CLEAN lap. Right for asking "what did
 *                     you do differently", because a composite lap was never
 *                     driven, so its steering trace belongs to nobody.
 *
 * Comparing driver inputs against a composite would be comparing against a
 * driver who does not exist.
 */

/**
 * Find the runs where the deficit grows, and cost each one.
 *
 * All thresholds are derived from the lap's own deficit distribution rather
 * than assumed — see `deficitNoiseFloor`.
 */
export function findDivergenceOnsets(delta, options = {}) {
  const {
    gridSpacing = 1,
    minDeficitGain = null, // derived when null
    recoveryFraction = 0.25,
    mergeGapM = 20,
    maxWindowM = 220,
  } = options

  const deficit = delta.deficit
  const n = deficit.length
  if (n < 10) return []

  const noise = deficitNoiseFloor(deficit)
  // A deficit gain worth flagging: several times the sample-to-sample noise of
  // this lap's own deficit trace.
  // Detection is deliberately generous: the top-N ranking downstream decides
  // what is worth showing, so a tight threshold here only starves it. An
  // earlier value of 8x noise found so few candidates that whole laps came back
  // with a single flag.
  const gainThreshold = minDeficitGain ?? Math.max(0.25, noise * 4)
  // Growth must exceed the noise floor to count as growth at all.
  const growthEpsilon = Math.max(noise, 1e-4)

  const events = []
  let i = 1
  while (i < n) {
    if (deficit[i] - deficit[i - 1] <= growthEpsilon) { i++; continue }

    const start = i
    let end = i
    // Extend while the deficit is not meaningfully falling back.
    while (end < n && deficit[end] - deficit[end - 1] > -growthEpsilon) end++

    const deficitBefore = deficit[start - 1]
    const deficitPeak = deficit[end - 1]
    const gained = deficitPeak - deficitBefore

    if (gained >= gainThreshold) {
      // Cost: time lost from the onset until the deficit this event created is
      // paid back. That is what charges a bad exit for the straight after it.
      const payback = deficitBefore + gained * recoveryFraction
      let recoveryIndex = end
      while (recoveryIndex < n && deficit[recoveryIndex] > payback) recoveryIndex++

      let seconds = 0
      for (let k = start; k < Math.min(recoveryIndex, n); k++) seconds += delta.rate[k] * gridSpacing

      events.push({
        onsetIndex: start,
        peakIndex: end - 1,
        recoveryIndex: Math.min(recoveryIndex, n - 1),
        deficitBefore,
        deficitPeak,
        deficitGained: gained,
        secondsLost: seconds,
      })
    }
    i = end
  }

  // Merge events that BEGIN within a few metres of one another: one mistake
  // often produces a stepped deficit rather than a single smooth ramp.
  //
  // Compared onset-to-onset, not onset-to-previous-recovery. A cost window runs
  // up to 220 m, so measuring from its END meant any two mistakes closer than
  // ~240 m collapsed into one — which is why whole laps were coming back with a
  // single flag. Two onsets 30 m apart are two mistakes however long the first
  // one goes on costing.
  const merged = []
  for (const event of events) {
    const previous = merged[merged.length - 1]
    if (previous && (event.onsetIndex - previous.onsetIndex) * gridSpacing < mergeGapM) {
      previous.peakIndex = Math.max(previous.peakIndex, event.peakIndex)
      previous.recoveryIndex = Math.max(previous.recoveryIndex, event.recoveryIndex)
      previous.deficitPeak = Math.max(previous.deficitPeak, event.deficitPeak)
      previous.deficitGained = previous.deficitPeak - previous.deficitBefore
    } else merged.push({ ...event })
  }

  // Clip each event's cost window at the NEXT event's onset, and re-integrate.
  //
  // Without this the windows overlap and every event bills for the same
  // seconds: on the reference log, three flags on one lap each claimed 10-19 s
  // of a lap that was only 12 s off the pace. Disjoint windows make the costs
  // additive, which is the only way a ranking by seconds means anything.
  for (let i = 0; i < merged.length; i++) {
    const event = merged[i]
    const next = merged[i + 1]
    // Clipped at the next onset AND at a maximum length: a deficit that is
    // never paid back would otherwise let one flag bill for the rest of the
    // lap, which is real time but no longer attributable to that one moment.
    const limit = next ? next.onsetIndex : n
    const cap = event.onsetIndex + Math.round(maxWindowM / gridSpacing)
    event.recoveryIndex = Math.min(event.recoveryIndex, limit, cap)
    event.windowCapped = event.recoveryIndex >= cap
    let seconds = 0
    for (let k = event.onsetIndex; k < event.recoveryIndex; k++) {
      seconds += delta.rate[k] * gridSpacing
    }
    event.secondsLost = seconds
  }

  return merged.filter((event) => event.secondsLost > 0)
}

/**
 * Noise floor of a deficit trace: the median absolute sample-to-sample change.
 *
 * This is what "a real divergence" is measured against, and it comes from the
 * driver's own consistency rather than from a number anyone chose.
 */
export function deficitNoiseFloor(deficit) {
  const steps = []
  for (let i = 1; i < deficit.length; i++) {
    const step = Math.abs(deficit[i] - deficit[i - 1])
    if (Number.isFinite(step)) steps.push(step)
  }
  if (!steps.length) return 0
  steps.sort((a, b) => a - b)
  return steps[steps.length >> 1]
}

/**
 * Per-segment repeatability, from the driver's own clean laps.
 *
 * A suggestion may only be emitted if the time it claims exceeds what this
 * driver varies by anyway at that place. Their own consistency defines what
 * counts as a real difference — nothing else could.
 */
export function segmentNoiseFloors(cleanLapSpeeds, segments, gridSpacing) {
  const floors = {}
  for (const segment of segments) {
    const times = []
    for (const speed of cleanLapSpeeds) {
      let elapsed = 0
      let valid = true
      for (let i = segment.startIndex; i < Math.min(segment.endIndex, speed.length); i++) {
        const v = speed[i]
        if (!Number.isFinite(v) || v <= 0.5) { valid = false; break }
        elapsed += gridSpacing / v
      }
      if (valid) times.push(elapsed)
    }
    if (times.length < 3) { floors[segment.id] = null; continue }
    times.sort((a, b) => a - b)
    const median = times[times.length >> 1]
    const deviations = times.map((t) => Math.abs(t - median)).sort((a, b) => a - b)
    floors[segment.id] = {
      median,
      mad: deviations[deviations.length >> 1],
      samples: times.length,
    }
  }
  return floors
}

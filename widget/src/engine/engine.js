/**
 * Phase 1 orchestrator.
 *
 * Consumes a session's raw channels and produces, per clean lap, a ranked list
 * of segments by attributed time loss. There is deliberately NO diagnosis here
 * — Phase 2 depends on this layer being right, and a diagnosis built on faulty
 * attribution is confidently wrong rather than merely useless.
 *
 * Everything the engine "knows" is learned at runtime and reported by
 * `calibrationReport`, so a reviewer can see where every number came from.
 */

import { CONFIG } from './config.js'
import { medianFilter, unwrapDegrees } from './conditioning.js'
import { savitzkyGolay } from './savitzkyGolay.js'
import { checkConventions, deriveChannels, linearFit, maxOf, minOf } from './derive.js'
import {
  attributeLoss, buildAttributionUnits, buildTheoreticalBest, checkConservation,
  computeDelta, computeDownstreamCost, detectTradeoff, integrateTime,
} from './deltaTime.js'
import { explainDivergence } from './causes.js'
import { EVENT_INFO, EVENT_TYPES, metricScatter } from './events.js'
import { findDivergenceOnsets, segmentNoiseFloors } from './divergence.js'
import { buildEnvelope, coverageWarnings, utilisationAt } from './envelope.js'
import { segmentLap, splitCornerPhases } from './segments.js'
import {
  alignByCrossCorrelation, classifyLaps, createEnuFrame, detectLaps,
  integrateDistance, medianOf, resampleLapOntoGrid,
} from './track.js'

const RAD_TO_DEG = 180 / Math.PI

/** Nearest-rank percentile of an unsorted array. */
function percentileOfArray(values, fraction) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))))]
}

/**
 * @param session {{
 *   time: number[], latitude: number[], longitude: number[],
 *   speedX: number[], speedY: number[], lateralAccel: number[],
 *   yawRate: number[], yaw: number[], steeringAngle: number[],
 *   wheelSpeedFL: number[], throttle: number[],
 * }} all resampled onto the uniform grid
 */
export function analyseSession(session, options = {}) {
  const spacing = 1 / (options.sampleRateHz ?? CONFIG.sampleRateHz)
  const gridSpacing = options.gridSpacingM ?? CONFIG.gridSpacingM

  // --- 1.2 derived channels and convention discovery ------------------------
  // Yaw rate is checked for units before use: rad/s and deg/s differ by 57x and
  // the cross terms would be nonsense with the wrong one.
  // Loop, never spread: see maxOf in derive.js for what spreading costs here.
  let yawRateMax = 0
  for (let i = 0; i < session.yawRate.length; i++) {
    const value = Math.abs(session.yawRate[i])
    if (Number.isFinite(value) && value > yawRateMax) yawRateMax = value
  }
  const yawRateRadS = yawRateMax > 12
    ? session.yawRate.map((v) => v / RAD_TO_DEG)
    : session.yawRate

  const derived = deriveChannels({
    speedX: session.speedX, speedY: session.speedY, yawRateRadS,
  }, spacing)

  const conventions = checkConventions({
    derived,
    lateralAccel: session.lateralAccel,
    steeringAngle: session.steeringAngle,
    wheelSpeedFL: session.wheelSpeedFL,
    yawRateRaw: session.yawRate,
  })
  conventions.yawRate.convertedToRadians = yawRateMax > 12

  // Unwrapped heading, so it can be differentiated if anything downstream wants it.
  const headingUnwrapped = unwrapDegrees(session.yaw)

  if (!conventions.healthy) {
    return {
      ok: false, conventions, laps: [], warmup: true,
      warnings: conventions.warnings,
    }
  }

  // --- 1.3 track spine ------------------------------------------------------
  const originLat = medianOf(session.latitude)
  const originLon = medianOf(session.longitude)
  const frame = createEnuFrame(originLat, originLon)
  const east = new Array(session.latitude.length)
  const north = new Array(session.latitude.length)
  for (let i = 0; i < session.latitude.length; i++) {
    const enu = frame.toEnu(session.latitude[i], session.longitude[i])
    east[i] = enu.east
    north[i] = enu.north
  }

  const distance = integrateDistance(derived.vx, spacing)
  const { laps: rawLaps, origin } = detectLaps(
    { east, north, speed: derived.vx, distance, time: session.time },
    options,
  )
  const classified = classifyLaps(rawLaps, { speed: derived.vx, time: session.time }, options)
  const cleanLaps = classified.filter((lap) => lap.clean)

  // Curvature: kappa = r / v. Undefined at rest, so gate on speed.
  const curvature = derived.vx.map((v, i) => (v > 3 ? derived.r[i] / v : 0))

  // Steering RATE, derived here so it lands on the distance grid with
  // everything else. Differentiated from the smoothed angle, with dt guarded.
  const steerRate = new Array(session.steeringAngle.length).fill(0)
  for (let i = 1; i < steerRate.length; i++) {
    const previous = session.steeringAngle[i - 1]
    const current = session.steeringAngle[i]
    steerRate[i] = Number.isFinite(previous) && Number.isFinite(current)
      ? (current - previous) / spacing
      : 0
  }
  const steerRateSmoothed = savitzkyGolay(steerRate, {
    window: CONFIG.sgWindow, order: CONFIG.sgOrder, spacing,
  })

  // Slip, de-spiked. See conditioning.medianFilter for why a median rather
  // than a percentile cut.
  const betaClean = medianFilter(derived.beta, CONFIG.slipMedianWindow)

  // Slip validity mask.
  //
  // velocityBody.y carries a tail of INS dropouts reaching tens of degrees, and
  // they land at low lateral g where no real slide can occur. The cut is taken
  // from the session's own distribution of slip among LOADED samples rather
  // than from a chosen angle, so it adapts to a different car or sensor.
  const loadedSlip = []
  for (let i = 0; i < derived.beta.length; i++) {
    if (derived.vx[i] > 5 && Math.abs(derived.accelYKinematic[i]) > 6) {
      loadedSlip.push(Math.abs(betaClean[i]))
    }
  }
  const slipCut = loadedSlip.length > 200 ? percentileOfArray(loadedSlip, 0.995) : Infinity
  const slipValid = betaClean.map((b, i) => (
    Number.isFinite(b) && Math.abs(b) <= slipCut && derived.vx[i] > 3 ? 1 : 0
  ))

  const channels = {
    speed: derived.vx,
    steerRate: steerRateSmoothed,
    slipValid,
    // Position on the grid, so a flag knows where on the map it belongs.
    east,
    north,
    lateralSpeed: derived.vy,
    yawRate: derived.r,
    beta: betaClean,
    accelX: derived.accelX,
    accelY: derived.accelYKinematic,
    magnitude: derived.magnitude,
    direction: derived.direction,
    curvature,
    steering: session.steeringAngle,
    throttle: session.throttle,
    wheelSpeedFL: session.wheelSpeedFL,
    heading: headingUnwrapped,
  }

  const gridded = []
  for (const lap of classified) {
    const resampled = resampleLapOntoGrid(lap, channels, distance, gridSpacing)
    if (!resampled) continue
    gridded.push({ lapNumber: lap.index, meta: lap, ...resampled })
  }

  const analysisLapCount = classified.length
  if (!gridded.length) {
    return {
      ok: true, conventions, laps: classified, warmup: true,
      warnings: [
        `Only ${analysisLapCount} complete lap${analysisLapCount === 1 ? '' : 's'} so far `
        + '— at least two clean laps are needed before there is a reference to compare against.',
      ],
      cleanLapCount: cleanLaps.length,
    }
  }

  // --- 1.4 segmentation, computed ONCE on a reference lap -------------------
  // The reference for GEOMETRY is the quickest clean lap; segment boundaries
  // are then fixed in distance for every lap, so comparisons are like for like.
  const cleanGridded = gridded.filter((lap) => lap.meta.clean)
  const geometryLap = (cleanGridded.length ? cleanGridded : gridded)
    .reduce((a, b) => (b.meta.lapTime < a.meta.lapTime ? b : a))

  const { segments, threshold: curvatureThreshold, enter, exit } = segmentLap({
    grid: geometryLap.grid,
    curvature: geometryLap.channels.curvature,
  }, options)

  // --- drift alignment ------------------------------------------------------
  // Align each lap to the geometry lap on curvature before comparing, so a
  // metre of GPS drift does not shift every corner boundary.
  const aligned = gridded.map((lap) => {
    if (lap.lapNumber === geometryLap.lapNumber) return { ...lap, shift: 0 }
    const shift = alignByCrossCorrelation(
      geometryLap.channels.curvature.map(Math.abs),
      lap.channels.curvature.map(Math.abs),
    )
    if (shift === 0) return { ...lap, shift }
    const shifted = {}
    for (const [name, series] of Object.entries(lap.channels)) {
      shifted[name] = series.map((_, i) => series[Math.min(series.length - 1, Math.max(0, i + shift))])
    }
    return { ...lap, channels: shifted, shift }
  })

  const alignedClean = aligned.filter((lap) => lap.meta.clean)

  // --- 1.6 envelope, from clean laps only -----------------------------------
  const envelopeSamples = []
  for (const lap of alignedClean) {
    const { speed, magnitude, direction } = lap.channels
    for (let i = 0; i < speed.length; i++) {
      if (!Number.isFinite(speed[i]) || speed[i] < 3) continue
      envelopeSamples.push({ speed: speed[i], magnitude: magnitude[i], direction: direction[i] })
    }
  }
  const envelope = buildEnvelope(envelopeSamples, options)

  // A single lateral figure for the slip gate: the 95th percentile of |a_y|
  // over clean laps. Not a capability claim — just "loaded enough that a slide
  // is physically possible".
  const lateralSamples = []
  for (const lap of alignedClean) {
    for (const value of lap.channels.accelY) {
      if (Number.isFinite(value)) lateralSamples.push(Math.abs(value))
    }
  }
  const lateralGripLimit = lateralSamples.length
    ? percentileOfArray(lateralSamples, 0.95)
    : null

  // --- 1.5 reference and delta ---------------------------------------------
  const warmup = alignedClean.length < 2
  let reference = null
  let referenceConfidence = 0
  if (alignedClean.length >= 2) {
    const best = buildTheoreticalBest(
      alignedClean.map((lap) => ({ lapNumber: lap.lapNumber, speed: lap.channels.speed })),
      segments, gridSpacing,
    )
    reference = best
    referenceConfidence = 1
  } else if (alignedClean.length === 1) {
    reference = {
      speed: alignedClean[0].channels.speed,
      sources: [], isComposite: false,
      contributingLaps: [alignedClean[0].lapNumber],
    }
    referenceConfidence = 0.3
  }

  // The ACTION reference is a real lap, not the composite. Asking "what did you
  // do differently" against a theoretical best would be comparing against a
  // driver who does not exist — its steering trace belongs to nobody.
  const actionReference = alignedClean.length
    ? alignedClean.reduce((a, b) => (b.meta.lapTime < a.meta.lapTime ? b : a))
    : null

  // Per-segment repeatability from the driver's own clean laps: the noise floor
  // a claimed time saving has to clear.
  const noiseFloors = actionReference
    ? segmentNoiseFloors(alignedClean.map((l) => l.channels.speed), segments, gridSpacing)
    : {}

  // Per-segment scatter of every factor across the driver's own clean laps.
  // This is what "meaningfully different" is measured in — a driver who repeats
  // a corner to within 0.2 m/s has a far lower bar than one who varies by 2.
  const metricScatterBySegment = {}
  for (const segment of segments) {
    const collect = (pick) => alignedClean.map((lap) => {
      let best = null
      for (let i = segment.startIndex; i < Math.min(segment.endIndex, lap.channels.speed.length); i++) {
        const value = pick(lap.channels, i)
        if (!Number.isFinite(value)) continue
        best = best === null ? value : Math.max(best, value)
      }
      return best
    })
    const collectMin = (pick) => alignedClean.map((lap) => {
      let best = null
      for (let i = segment.startIndex; i < Math.min(segment.endIndex, lap.channels.speed.length); i++) {
        const value = pick(lap.channels, i)
        if (!Number.isFinite(value)) continue
        best = best === null ? value : Math.min(best, value)
      }
      return best
    })
    metricScatterBySegment[segment.id] = {
      entrySpeed: metricScatter(alignedClean.map((l) => l.channels.speed[segment.startIndex])),
      minSpeed: metricScatter(collectMin((c, i) => c.speed[i])),
      exitSpeed: metricScatter(alignedClean.map(
        (l) => l.channels.speed[Math.min(segment.endIndex, l.channels.speed.length) - 1],
      )),
      peakLateral: metricScatter(collect((c, i) => Math.abs(c.accelY[i]))),
      peakSlip: metricScatter(collect((c, i) => Math.abs(c.beta[i]))),
      peakSteerRate: metricScatter(collect((c, i) => Math.abs(c.steerRate[i]))),
      meanThrottle: metricScatter(alignedClean.map((lap) => {
        let sum = 0
        let n = 0
        for (let i = segment.startIndex; i < Math.min(segment.endIndex, lap.channels.throttle.length); i++) {
          if (Number.isFinite(lap.channels.throttle[i])) { sum += lap.channels.throttle[i]; n++ }
        }
        return n ? sum / n : null
      })),
    }
  }

  const lapReports = []
  if (reference) {
    const referenceTime = integrateTime(reference.speed, gridSpacing)
    const referenceLapTime = referenceTime[referenceTime.length - 1]

    for (const lap of aligned) {
      const delta = computeDelta(lap.channels.speed, reference.speed, gridSpacing)

      // Corner phases first: they decide where each corner's braking zone
      // begins, and therefore what the attribution units are.
      const phasesBySegmentId = {}
      for (const segment of segments) {
        if (segment.type !== 'corner') continue
        const phases = splitCornerPhases(segment, {
          speed: lap.channels.speed,
          accelX: lap.channels.accelX,
          curvature: lap.channels.curvature,
          grid: lap.grid,
        }, options)
        if (phases) phasesBySegmentId[segment.id] = phases
      }

      const units = buildAttributionUnits(segments, phasesBySegmentId, delta.rate.length)
      const attributions = attributeLoss(delta, units, gridSpacing)
      const conservation = checkConservation(attributions, delta.total)

      // Per-corner extras: phases, downstream cost, trade-off, utilisation.
      const enriched = attributions.map((attribution) => {
        const segment = segments.find((s) => s.id === attribution.segmentId)
        const isCorner = segment?.type === 'corner'
        const phases = phasesBySegmentId[attribution.segmentId] ?? null

        const followingIndex = segments.indexOf(segment) + 1
        const following = segments[followingIndex]
        const downstream = isCorner && following?.type === 'straight'
          ? computeDownstreamCost(segment, following, lap.channels.speed, reference.speed, gridSpacing)
          : 0

        const tradeoff = isCorner
          ? detectTradeoff(segment, phases, alignedClean.map((l) => ({
            lapNumber: l.lapNumber, speed: l.channels.speed,
          })), gridSpacing)
          : { tradeoff: false }

        // Utilisation across the segment, with confidence from the envelope.
        let utilisationSum = 0
        let utilisationPeak = 0
        let utilisationCount = 0
        let confidentCount = 0
        for (let i = attribution.startIndex; i < Math.min(attribution.endIndex, lap.channels.speed.length); i++) {
          const result = utilisationAt(
            envelope, lap.channels.speed[i], lap.channels.direction[i], lap.channels.magnitude[i],
          )
          if (!Number.isFinite(result.utilisation)) continue
          utilisationSum += result.utilisation
          utilisationPeak = Math.max(utilisationPeak, result.utilisation)
          utilisationCount++
          if (result.confident) confidentCount++
        }

        // Speeds are read over the ATTRIBUTION unit, which for a corner
        // includes its braking approach — the place an over-slow entry shows up.
        const from = attribution.startIndex
        const to = Math.min(attribution.endIndex, lap.channels.speed.length) - 1
        let minSpeed = Infinity
        for (let i = from; i <= to; i++) minSpeed = Math.min(minSpeed, lap.channels.speed[i])
        let referenceMin = Infinity
        for (let i = from; i <= to; i++) referenceMin = Math.min(referenceMin, reference.speed[i])

        return {
          ...attribution,
          downstreamSeconds: downstream,
          totalAttributed: attribution.generatedSeconds + downstream,
          phases,
          tradeoff: tradeoff.tradeoff,
          bestEntryLap: tradeoff.bestEntryLap,
          bestExitLap: tradeoff.bestExitLap,
          meanUtilisation: utilisationCount ? utilisationSum / utilisationCount : NaN,
          peakUtilisation: utilisationCount ? utilisationPeak : NaN,
          utilisationConfidence: utilisationCount ? confidentCount / utilisationCount : 0,
          entrySpeed: lap.channels.speed[from],
          exitSpeed: lap.channels.speed[to],
          minSpeed,
          referenceEntrySpeed: reference.speed[from],
          referenceExitSpeed: reference.speed[to],
          referenceMinSpeed: referenceMin,
        }
      })

      enriched.sort((a, b) => b.totalAttributed - a.totalAttributed)

      // ------------------------------------------------------------------
      // Divergence flags: the POINTS where this lap began losing time, each
      // explained by what the driver did differently from their best lap.
      // ------------------------------------------------------------------
      let flags = []
      if (actionReference && lap.lapNumber !== actionReference.lapNumber) {
        const events = findDivergenceOnsets(delta, {
          gridSpacing, maxWindowM: CONFIG.maxFlagWindowM,
        })
        const forCauses = (source) => ({
          speed: source.channels.speed,
          accelX: source.channels.accelX,
          absLateral: source.channels.accelY.map(Math.abs),
          absSlip: source.channels.beta.map(Math.abs),
          // Resampling can land a grid point between a valid and an invalid
          // sample; require it to be clearly valid.
          slipValid: source.channels.slipValid.map((v) => v > 0.9),
          absSteering: source.channels.steering.map(Math.abs),
          absSteerRate: source.channels.steerRate.map(Math.abs),
          throttle: source.channels.throttle,
        })
        const lapChannels = forCauses(lap)
        const referenceChannels = forCauses(actionReference)

        flags = events.map((event) => {
          const segment = segments.find(
            (seg) => event.onsetIndex >= seg.startIndex && event.onsetIndex < seg.endIndex,
          )
          const explanation = explainDivergence(event, lapChannels, referenceChannels, {
            gridSpacing,
            gripLimit: lateralGripLimit,
            isCorner: segment?.type === 'corner',
            segmentLabel: segment?.label ?? null,
            scatter: segment ? metricScatterBySegment[segment.id] ?? {} : {},
          })
          const floor = segment ? noiseFloors[segment.id] : null
          return {
            onsetIndex: event.onsetIndex,
            onsetS: lap.grid[Math.min(event.onsetIndex, lap.grid.length - 1)],
            recoveryS: lap.grid[Math.min(event.recoveryIndex, lap.grid.length - 1)],
            lengthM: (event.recoveryIndex - event.onsetIndex) * gridSpacing,
            secondsLost: event.secondsLost,
            deficitGained: event.deficitGained,
            segmentId: segment?.id ?? null,
            segmentLabel: segment?.label ?? null,
            segmentType: segment?.type ?? null,
            east: lap.channels.east[Math.min(event.onsetIndex, lap.channels.east.length - 1)],
            north: lap.channels.north[Math.min(event.onsetIndex, lap.channels.north.length - 1)],
            noiseFloor: floor ? floor.mad : null,
            ...explanation,
          }
        })

        // --- incidents -------------------------------------------------------
        //
        // Something that went badly wrong is not a coaching point and must not
        // compete with them on time lost: a spin costs seconds and needs no
        // analysis to explain. These are detected separately, always shown, and
        // never truncated by the ranking.
        const incidents = findIncidents(lap, {
          gridSpacing,
          slipCut,
          lateralGripLimit,
          dwellFraction: options.dwellSpeedFraction ?? CONFIG.dwellSpeedFraction,
        })

        // --- emission --------------------------------------------------------
        //
        // Rank by time lost and take the worst few. An earlier version gated
        // hard on "must beat two MADs of this driver's own scatter", which is
        // defensible in principle but in practice silenced entire laps: a lap
        // several seconds off the pace would show nothing at all, which reads
        // as broken rather than as praise.
        //
        // So the ranking decides, a small floor removes noise, and each flag
        // carries its own confidence and the driver's scatter at that place so
        // a weak one is visible AS weak rather than hidden.
        const minimumSeconds = options.minFlagSeconds ?? 0.04
        flags = flags
          .filter((flag) => flag.type && flag.secondsLost > minimumSeconds)
          .sort((a, b) => b.secondsLost - a.secondsLost)
          .slice(0, options.maxFlags ?? 5)
          .map((flag) => ({
            ...flag,
            // Beyond the driver's own repeatability at this place?
            beyondScatter: flag.noiseFloor === null
              ? null
              : flag.secondsLost > flag.noiseFloor * 2,
          }))

        // Incidents go first and are never dropped.
        flags = [...incidents, ...flags]
      }

      lapReports.push({
        lapNumber: lap.lapNumber,
        lapTime: lap.meta.lapTime,
        clean: lap.meta.clean,
        uncleanReasons: lap.meta.reasons,
        driftShift: lap.shift,
        deltaToReference: delta.total,
        referenceLapTime,
        segments: enriched,
        flags,
        actionReferenceLap: actionReference?.lapNumber ?? null,
        conservation,
        warmup,
      })
    }
  }

  return {
    ok: true,
    warmup,
    conventions,
    origin,
    frame: { originLat, originLon },
    laps: classified,
    cleanLapCount: cleanLaps.length,
    segments,
    curvature: { threshold: curvatureThreshold, enter, exit },
    envelope,
    reference,
    referenceConfidence,
    actionReferenceLapNumber: actionReference?.lapNumber ?? null,
    // The track outline: the action reference lap's path in ENU metres.
    trackPath: actionReference
      ? actionReference.channels.east.map((e, i) => ({ x: e, y: actionReference.channels.north[i] }))
      : [],
    lateralGripLimit,
    slipCut,
    noiseFloors,
    metricScatterBySegment,
    geometryLapNumber: geometryLap.lapNumber,
    lapReports,
    warnings: [
      ...conventions.warnings,
      ...coverageWarnings(envelope),
      ...(warmup ? ['Fewer than two clean laps: no reference established, so no coaching.'] : []),
    ],
    gridSpacing,
  }
}

/**
 * Things that went badly wrong, as distinct from things done imperfectly.
 *
 * A spin, an off or a stop is not a coaching point — it needs no comparison
 * against a reference to be obvious, and letting it compete with genuine
 * coaching on "time lost" would drown everything else. They are reported
 * separately, always, and never ranked away.
 */
export function findIncidents(lap, { gridSpacing, slipCut, lateralGripLimit, dwellFraction }) {
  const { speed, beta, accelY, east, north } = lap.channels
  const grid = lap.grid
  const n = Math.min(speed.length, grid.length)
  if (n < 20) return []

  // "Very slow" relative to this lap's own pace, not an absolute number.
  const sorted = [...speed].filter(Number.isFinite).sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1] ?? 0
  const crawl = median * dwellFraction

  const found = []
  const push = (index, kind, detail) => {
    found.push({
      onsetIndex: index,
      onsetS: grid[index],
      recoveryS: grid[index],
      lengthM: 0,
      secondsLost: 0,
      deficitGained: 0,
      type: EVENT_TYPES.INCIDENT,
      info: EVENT_INFO[EVENT_TYPES.INCIDENT],
      incidentKind: kind,
      headline: detail,
      reasons: [detail],
      action: 'Not a technique point — find out what happened here before reading anything else on this lap.',
      confidence: 1,
      measured: {},
      east: east?.[index],
      north: north?.[index],
      segmentLabel: null,
      noiseFloor: null,
      beyondScatter: true,
    })
  }

  // A stop or an off: a run below a fraction of this lap's own median speed.
  let dwellStart = null
  for (let i = 0; i < n; i++) {
    if (speed[i] < crawl) {
      if (dwellStart === null) dwellStart = i
    } else if (dwellStart !== null) {
      const metres = grid[i] - grid[dwellStart]
      if (metres > 15) {
        const slowest = minOf(speed.slice(dwellStart, i))
        push(dwellStart, 'stopped',
          `Dropped to ${slowest.toFixed(1)} m/s for ${metres.toFixed(0)} m — a stop, an off, or traffic.`)
      }
      dwellStart = null
    }
  }

  // A spin: slip beyond the sensor's own dropout cut WITH the tyres loaded, so
  // it cannot be a dropout.
  let spinStart = null
  for (let i = 0; i < n; i++) {
    const loaded = lateralGripLimit > 0
      && Math.abs(accelY[i]) > lateralGripLimit * 0.35
    const extreme = Number.isFinite(beta[i]) && Math.abs(beta[i]) > Math.min(slipCut, 25) * 0.6
    if (loaded && extreme) {
      if (spinStart === null) spinStart = i
    } else if (spinStart !== null) {
      if (grid[i] - grid[spinStart] > 4) {
        let worst = 0
        for (let k = spinStart; k < i; k++) worst = Math.max(worst, Math.abs(beta[k]))
        push(spinStart, 'slid',
          `Slid to ${worst.toFixed(0)}° of slip while loaded — the car got away here.`)
      }
      spinStart = null
    }
  }

  // One of each kind is enough; more just repeats the same event.
  const seen = new Set()
  return found.filter((incident) => {
    const key = `${incident.incidentKind}-${Math.round(incident.onsetS / 40)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Calibration report — printed once per session.
 *
 * Every learned quantity with the evidence behind it. If a reviewer cannot see
 * where a number came from, the design goal has not been met.
 */
export function calibrationReport(analysis) {
  const lines = []
  const push = (label, value) => lines.push({ label, value })

  const c = analysis.conventions
  push('kinematic check r(a_y derived, a_y measured)',
    `${c.kinematic.correlationWithCrossTerm.toFixed(4)} (needs ${CONFIG.minKinematicCorrelation}; `
    + `without the cross term it would be ${c.kinematic.correlationWithoutCrossTerm.toFixed(4)})`)
  push('kinematic scale', `measured = ${c.kinematic.scaleSlope.toFixed(3)} x derived `
    + `${c.kinematic.scaleIntercept >= 0 ? '+' : ''}${c.kinematic.scaleIntercept.toFixed(3)}, `
    + `n = ${c.kinematic.samples}`)
  push('steering units', `${c.steering.units} (max observed ${c.steering.maxObserved.toFixed(1)})`)
  push('steering sign', `${c.steering.sign > 0 ? 'positive steer gives positive yaw' : 'inverted'} `
    + `(r = ${c.steering.correlationWithYaw.toFixed(3)})`)
  push('yaw rate units', `${c.yawRate.units}${c.yawRate.convertedToRadians ? ' (converted to rad/s)' : ''}`)
  push('wheel speed units', `${c.wheelSpeed.units}, scale ${c.wheelSpeed.scaleToMetresPerSecond.toFixed(3)} `
    + `to m/s, R2 ${c.wheelSpeed.fitR2.toFixed(3)}`)
  push('front-left wheel', c.wheelSpeed.driven
    ? `driven (runs ${c.wheelSpeed.slipAsymmetry.toFixed(3)} m/s further ahead under power than under braking)`
    : `free-rolling, usable as a lockup reference (slip asymmetry only ${c.wheelSpeed.slipAsymmetry.toFixed(3)} m/s)`)

  push('laps detected', `${analysis.laps.length}, of which ${analysis.cleanLapCount} clean`)
  for (const lap of analysis.laps.filter((l) => !l.clean)) {
    push(`  lap ${lap.index} excluded`, lap.reasons.join('; '))
  }

  if (analysis.curvature?.threshold != null) {
    const radius = 1 / analysis.curvature.threshold
    push('curvature split (Otsu)',
      `${analysis.curvature.threshold.toExponential(3)} 1/m (radius ${radius.toFixed(1)} m), `
      + `hysteresis ${analysis.curvature.enter.toExponential(2)} / ${analysis.curvature.exit.toExponential(2)}`)
  }
  push('segments', `${analysis.segments?.length ?? 0} `
    + `(${analysis.segments?.filter((s) => s.type === 'corner').length ?? 0} corners), `
    + `fixed from lap ${analysis.geometryLapNumber}`)

  if (analysis.envelope?.ready) {
    push('envelope percentile', `${(analysis.envelope.percentile * 100).toFixed(0)}th of |a| per cell`)
    push('envelope grid', `${analysis.envelope.speedBins} speed x ${analysis.envelope.directionBins} direction bins, `
      + `${analysis.envelope.totalSamples} samples`)
    push('envelope coverage', `${(analysis.envelope.coverage * 100).toFixed(0)}% of cells have `
      + `at least ${analysis.envelope.minCellSamples} samples`)
  } else {
    push('envelope', 'not established')
  }

  if (analysis.reference) {
    push('reference', analysis.reference.isComposite
      ? `theoretical best from laps ${analysis.reference.contributingLaps.join(', ')}`
      : `single lap ${analysis.reference.contributingLaps.join(', ')} (low confidence)`)
  } else push('reference', 'none — fewer than one clean lap')

  return { lines, warnings: analysis.warnings }
}

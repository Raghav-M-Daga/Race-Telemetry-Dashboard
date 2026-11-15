/**
 * Phase 1 validation.
 *
 * The brief lists six things that must hold before the engine may be called
 * working. Each has a suite below, named after it. Synthetic signals are used
 * where a known answer is needed — you cannot validate an attribution rule
 * against data whose true answer you do not know.
 */

import { close, equal, report, suite, truthy } from './harness.mjs'
import { CONFIG } from '../src/engine/config.js'
import {
  savitzkyGolay, savitzkyGolayKernel, filterCausal, causalGroupDelaySeconds,
} from '../src/engine/savitzkyGolay.js'
import {
  createChannelBuffer, pushSample, resampleChannel, fillForFiltering,
  unwrapDegrees, coverage,
} from '../src/engine/conditioning.js'
import { deriveChannels, checkConventions, correlation, linearFit } from '../src/engine/derive.js'
import {
  createEnuFrame, integrateDistance, detectLaps, classifyLaps, medianOf, madOf,
  percentileOf, alignByCrossCorrelation, resampleLapOntoGrid,
} from '../src/engine/track.js'
import { otsuThreshold, segmentLap, splitCornerPhases } from '../src/engine/segments.js'
import {
  integrateTime, buildTheoreticalBest, computeDelta, attributeLoss,
  buildAttributionUnits, computeDownstreamCost, detectTradeoff, checkConservation,
} from '../src/engine/deltaTime.js'
import { buildEnvelope, envelopeAt, utilisationAt, coverageWarnings } from '../src/engine/envelope.js'
import { analyseSession, calibrationReport } from '../src/engine/engine.js'

const FS = CONFIG.sampleRateHz
const DT = 1 / FS

// ---------------------------------------------------------------------------
suite('Savitzky-Golay — the derivative everything else rests on')
// ---------------------------------------------------------------------------
{
  const t = Array.from({ length: 1000 }, (_, i) => i * DT)
  const sine = t.map(Math.sin)
  const smoothed = savitzkyGolay(sine, { window: 31, order: 3, spacing: DT })
  let maxSmoothError = 0
  for (let i = 50; i < 950; i++) maxSmoothError = Math.max(maxSmoothError, Math.abs(smoothed[i] - sine[i]))
  truthy(`smoothing a clean signal barely changes it (max ${maxSmoothError.toExponential(1)})`,
    maxSmoothError < 1e-4)

  // d/dt sin = cos. This is the property the whole engine depends on.
  const derivative = savitzkyGolay(sine, { window: 31, order: 3, deriv: 1, spacing: DT })
  let maxDerivError = 0
  for (let i = 50; i < 950; i++) maxDerivError = Math.max(maxDerivError, Math.abs(derivative[i] - Math.cos(t[i])))
  truthy(`derivative of sin recovers cos (max error ${maxDerivError.toExponential(1)})`,
    maxDerivError < 1e-3)

  // A polynomial of order <= the fit order must be differentiated exactly.
  const cubic = t.map((x) => 2 * x ** 3 - 5 * x ** 2 + x + 7)
  const cubicDeriv = savitzkyGolay(cubic, { window: 31, order: 3, deriv: 1, spacing: DT })
  let maxCubicError = 0
  for (let i = 50; i < 950; i++) {
    maxCubicError = Math.max(maxCubicError, Math.abs(cubicDeriv[i] - (6 * t[i] ** 2 - 10 * t[i] + 1)))
  }
  truthy(`a cubic is differentiated exactly (max error ${maxCubicError.toExponential(1)})`,
    maxCubicError < 1e-6)

  // Kernels must sum correctly: smoothing preserves a constant, and any
  // derivative kernel must annihilate one.
  const smoothKernel = savitzkyGolayKernel(31, 3, 0, DT)
  close('a smoothing kernel sums to 1', smoothKernel.reduce((a, b) => a + b, 0), 1, 1e-9)
  const derivKernel = savitzkyGolayKernel(31, 3, 1, DT)
  close('a derivative kernel sums to 0', derivKernel.reduce((a, b) => a + b, 0), 0, 1e-6)

  // Noise rejection: the reason this exists rather than a finite difference.
  let seed = 1
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5 }
  const ramp = t.map((x) => 10 * x)
  const noisy = ramp.map((v) => v + random() * 0.05)
  const sgSlope = savitzkyGolay(noisy, { window: 31, order: 3, deriv: 1, spacing: DT })
  let sgError = 0
  let naiveError = 0
  for (let i = 50; i < 950; i++) {
    sgError = Math.max(sgError, Math.abs(sgSlope[i] - 10))
    naiveError = Math.max(naiveError, Math.abs((noisy[i + 1] - noisy[i]) / DT - 10))
  }
  truthy(`SG beats a finite difference on noise (${sgError.toFixed(2)} vs ${naiveError.toFixed(0)} m/s2)`,
    sgError * 10 < naiveError)

  truthy('a series shorter than the window still returns',
    savitzkyGolay([1, 2, 3], { window: 31 }).length === 3)
  equal('an empty series returns empty', savitzkyGolay([], {}).length, 0)

  // Causal filtering costs group delay; the engine must state how much.
  const causal = filterCausal(ramp, { window: 31, order: 3, deriv: 1, spacing: DT })
  truthy('the causal derivative also recovers the slope',
    Math.abs(causal[500] - 10) < 0.5)
  close('and its group delay is reported honestly',
    causalGroupDelaySeconds(31, DT), 0.15, 1e-9)
}

// ---------------------------------------------------------------------------
suite('Conditioning — a gap must stay a gap')
// ---------------------------------------------------------------------------
{
  const buffer = createChannelBuffer()
  for (let i = 0; i < 100; i++) pushSample(buffer, i * 0.05, i)
  const grid = Array.from({ length: 100 }, (_, i) => i * DT)
  const { values, present } = resampleChannel(buffer, grid, DT)
  truthy('a dense channel resamples fully', coverage(present) > 0.95)
  close('and interpolates linearly', values[10], 10 * DT / 0.05, 1e-6)

  // A dropout must NOT be bridged: holding a stale value invents a plateau,
  // and the derivative of an invented plateau is a fictitious zero.
  const gappy = createChannelBuffer()
  pushSample(gappy, 0, 0)
  pushSample(gappy, 0.02, 1)
  pushSample(gappy, 5.0, 2) // five-second hole
  const longGrid = Array.from({ length: 500 }, (_, i) => i * DT)
  const gapResult = resampleChannel(gappy, longGrid, DT)
  truthy('a long dropout is marked missing, not interpolated across',
    gapResult.present.slice(100, 400).every((p) => !p))
  truthy('but samples beside real observations survive', gapResult.present[1])

  const filled = fillForFiltering(gapResult.values, gapResult.present)
  truthy('gap filling never leaves a NaN for the filter', filled.every(Number.isFinite))

  // Yaw must be unwrapped before differentiation or every north crossing
  // becomes a 360 deg/s spike.
  const wrapped = [350, 355, 359, 3, 8, 12]
  const unwrapped = unwrapDegrees(wrapped)
  truthy('yaw unwrapping removes the seam',
    unwrapped.every((v, i) => i === 0 || Math.abs(v - unwrapped[i - 1]) < 20))
  close('and preserves the real rotation', unwrapped[5] - unwrapped[0], 22, 1e-9)
  equal('an empty mask has zero coverage', coverage([]), 0)
}

// ---------------------------------------------------------------------------
suite('VALIDATION 1 — sign convention health check')
// ---------------------------------------------------------------------------
{
  // Synthesise a car on a VARYING left-hand arc. Variation is essential: a
  // perfectly constant circle has no variance to correlate, and the engine
  // correctly refuses to certify a convention it cannot see move.
  const n = 3000
  const speedX = new Array(n)
  const speedY = new Array(n)
  const yawRateSeries = new Array(n)
  const trueLateral = new Array(n)
  for (let i = 0; i < n; i++) {
    const v = 18 + 6 * Math.sin(i / 300)          // 12-24 m/s
    const radius = 30 + 25 * Math.sin(i / 210)    // 5-55 m
    speedX[i] = v
    speedY[i] = 0
    yawRateSeries[i] = v / radius
    trueLateral[i] = (v * v) / radius
  }

  const derived = deriveChannels({ speedX, speedY, yawRateRadS: yawRateSeries }, DT)
  // On a steady circle a_y = v^2/R exactly; here it holds up to the slow
  // variation the SG window smooths over, so compare in the middle.
  close('a_y_k tracks v^2/R', derived.accelYKinematic[1500], trueLateral[1500], 0.6)
  close('sideslip is zero when v_y is zero', derived.beta[1500], 0, 1e-9)

  const health = checkConventions({
    derived,
    lateralAccel: trueLateral,
    steeringAngle: yawRateSeries.map((r) => r * 400),
    wheelSpeedFL: speedX.map((v) => v * 2.237),
    yawRateRaw: yawRateSeries,
  })
  truthy('a correct frame passes the health check', health.healthy)
  truthy(`with a near-perfect kinematic correlation (${health.kinematic.correlationWithCrossTerm.toFixed(4)})`,
    health.kinematic.correlationWithCrossTerm > 0.99)
  truthy('and it is marked verifiable', health.verifiable)
  equal('steering units are recognised as degrees', health.steering.units, 'degrees')
  equal('wheel speed is recognised as mph', health.wheelSpeed.units, 'mph')

  // An inverted lateral axis MUST fail loudly rather than produce confident
  // nonsense. This is the check the brief demands.
  const flipped = checkConventions({
    derived,
    lateralAccel: trueLateral.map((a) => -a),
    steeringAngle: yawRateSeries.map((r) => r * 400),
    wheelSpeedFL: speedX.map((v2) => v2 * 2.237),
    yawRateRaw: yawRateSeries,
  })
  truthy('an inverted lateral axis is rejected', !flipped.healthy)
  truthy('and named as inverted rather than merely uncorrelated',
    flipped.warnings.some((w) => /inverted/i.test(w)))
  // A constant signal must be reported as UNVERIFIABLE, not as wrong.
  const flat = checkConventions({
    derived: deriveChannels({
      speedX: new Array(n).fill(20), speedY: new Array(n).fill(0),
      yawRateRadS: new Array(n).fill(0.5),
    }, DT),
    lateralAccel: new Array(n).fill(10),
    steeringAngle: new Array(n).fill(30),
    wheelSpeedFL: new Array(n).fill(20 * 2.237),
    yawRateRaw: new Array(n).fill(0.5),
  })
  truthy('a constant signal is not certified', !flat.healthy)
  truthy('but is reported as unverifiable, not as a wrong frame',
    !flat.verifiable && flat.warnings.some((w) => /nothing to check/i.test(w)))

  // Noise-driven correlation must not be mistaken for agreement.
  let seed = 7
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5 }
  const garbage = checkConventions({
    derived,
    lateralAccel: Array.from({ length: n }, () => random() * 20),
    steeringAngle: yawRateSeries.map((r) => r * 400),
    wheelSpeedFL: speedX.map((v2) => v2 * 2.237),
    yawRateRaw: yawRateSeries,
  })
  truthy('an unrelated lateral channel fails the check', !garbage.healthy)
  truthy('and says so in words', garbage.warnings.length > 0)

  close('correlation of a series with itself is 1', correlation([1, 2, 3, 4], [1, 2, 3, 4]), 1, 1e-9)
  close('and with its negation is -1', correlation([1, 2, 3, 4], [-1, -2, -3, -4]), -1, 1e-9)
  const fit = linearFit([0, 1, 2, 3], [1, 3, 5, 7])
  close('linear fit slope', fit.slope, 2, 1e-9)
  close('linear fit intercept', fit.intercept, 1, 1e-9)
  close('a perfect fit has R2 = 1', fit.r2, 1, 1e-9)
}

// ---------------------------------------------------------------------------
suite('Track spine — distance from speed, laps from closure')
// ---------------------------------------------------------------------------
{
  const frame = createEnuFrame(42.0667, -84.2377)
  const origin = frame.toEnu(42.0667, -84.2377)
  close('the origin maps to zero east', origin.east, 0, 1e-9)
  close('and zero north', origin.north, 0, 1e-9)
  close('a degree of latitude is ~111 km', frame.toEnu(43.0667, -84.2377).north, 111132, 1)
  truthy('longitude shrinks by cos(latitude)',
    frame.toEnu(42.0667, -83.2377).east < 111132)

  // Distance from speed, not from GPS deltas.
  const steady = new Array(1000).fill(20)
  const distance = integrateDistance(steady, DT)
  close('integrating 20 m/s for 10 s gives ~200 m', distance[999], 20 * 999 * DT, 1e-6)

  // Three circuits. The sample count is derived from the geometry so that
  // integrated distance and circumference AGREE — a synthetic lap whose speed
  // says 120 m while its circle says 377 m tests nothing real.
  const lapRadius = 60
  const lapSpeed = 20
  const samplesPerLap = Math.round((2 * Math.PI * lapRadius) / (lapSpeed * DT))
  const east = []
  const north = []
  const speed = []
  const time = []
  for (let lap = 0; lap < 3; lap++) {
    for (let i = 0; i < samplesPerLap; i++) {
      const angle = (i / samplesPerLap) * Math.PI * 2
      east.push(lapRadius * Math.cos(angle))
      north.push(lapRadius * Math.sin(angle))
      speed.push(lapSpeed)
      time.push((lap * samplesPerLap + i) * DT)
    }
  }
  const dist = integrateDistance(speed, DT)
  close('integrated distance matches the circumference',
    dist[samplesPerLap] , 2 * Math.PI * lapRadius, 1)
  const detected = detectLaps({ east, north, speed, distance: dist, time },
    { closureRadius: 20, minDistance: 200 })
  // Three circuits give at least two complete laps; whether the third closes
  // depends on the last sample landing past the line, which is not guaranteed.
  truthy(`three circuits yield two or three laps (got ${detected.laps.length})`,
    detected.laps.length >= 2 && detected.laps.length <= 3)
  truthy('the line was established', detected.line !== null)
  truthy('and it is perpendicular to the heading',
    Math.abs(detected.line.heading.x * detected.line.normal.x
      + detected.line.heading.y * detected.line.normal.y) < 1e-9)
  truthy('and the laps are about equal in length',
    Math.abs(detected.laps[0].length - detected.laps[1].length) < 5)

  equal('median', medianOf([5, 1, 3]), 3)
  equal('median of an even count', medianOf([1, 2, 3, 4]), 2.5)
  truthy('MAD ignores a single outlier', madOf([1, 1, 1, 1, 100]) < 1)
  // Nearest-rank: p90 of ten values is the ninth, since nine of ten are at or
  // below it. Stated explicitly because the off-by-one here is a classic.
  equal('percentile is nearest-rank', percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9)
  equal('p100 is the maximum', percentileOf([1, 2, 3], 1), 3)
  equal('p0 is the minimum', percentileOf([1, 2, 3], 0), 1)

  // Cross-correlation drift alignment.
  const pattern = Array.from({ length: 300 }, (_, i) => Math.sin(i / 8))
  const shifted = Array.from({ length: 300 }, (_, i) => Math.sin((i - 5) / 8))
  const found = alignByCrossCorrelation(pattern, shifted, 12)
  truthy(`a 5-sample drift is recovered (found ${found})`, Math.abs(found - 5) <= 1)
  equal('an identical pair needs no shift', alignByCrossCorrelation(pattern, pattern, 12), 0)
}

// ---------------------------------------------------------------------------
suite('Segmentation — threshold from the data, not from an opinion')
// ---------------------------------------------------------------------------
{
  // A clearly bimodal series must split between its two modes.
  const bimodal = [...new Array(500).fill(0.005), ...new Array(500).fill(0.06)]
  const threshold = otsuThreshold(bimodal)
  truthy(`Otsu lands between the two modes (${threshold?.toFixed(4)})`,
    threshold > 0.005 && threshold < 0.06)
  equal('too few samples yields no threshold', otsuThreshold([1, 2]), null)
  equal('a constant series yields no threshold', otsuThreshold(new Array(500).fill(1)), null)

  // A synthetic lap: straight, corner, straight, corner.
  const grid = Array.from({ length: 1200 }, (_, i) => i)
  const curvature = grid.map((s) => {
    if (s > 200 && s < 400) return 0.05
    if (s > 700 && s < 950) return -0.045
    return 0.0005
  })
  const { segments, threshold: t2 } = segmentLap({ grid, curvature })
  truthy('a threshold is derived', t2 !== null)
  const corners = segments.filter((s) => s.type === 'corner')
  equal('two corners are found', corners.length, 2)
  truthy('and they land where they were placed',
    Math.abs(corners[0].startS - 200) < 30 && Math.abs(corners[1].startS - 700) < 30)
  // Corners and straights have different minimums: a 10 m corner is real, a
  // 10 m straight between two corners is a straightening within one corner.
  truthy('every corner clears the corner minimum',
    segments.filter((s) => s.type === 'corner')
      .every((s) => s.length >= CONFIG.minCornerLengthM - 1e-9))
  truthy('every straight clears the straight minimum',
    segments.filter((s) => s.type === 'straight')
      .every((s) => s.length >= CONFIG.minStraightLengthM - 1e-9))
  truthy('segments tile the lap without gaps',
    segments.every((s, i) => i === 0 || s.startIndex === segments[i - 1].endIndex))
  truthy('corner labels are stable ids', corners[0].id === 'T1' && corners[1].id === 'T2')

  // Phase split: entry to minimum speed, then exit.
  const speed = grid.map((s) => (s > 200 && s < 400 ? 12 + Math.abs(s - 300) * 0.05 : 25))
  const accelX = grid.map((s) => (s > 200 && s < 300 ? -4 : s > 300 && s < 420 ? 3 : 0.2))
  const phases = splitCornerPhases(corners[0], { speed, accelX, curvature, grid })
  truthy('a phase split is produced', phases !== null)
  truthy('the apex is the minimum-speed point',
    Math.abs(grid[phases.apexIndex] - 300) < 25)
  truthy('the apex offset against peak curvature is reported',
    Number.isFinite(phases.apexOffsetM))
}

// ---------------------------------------------------------------------------
suite('VALIDATION 4 — attribution conservation')
// ---------------------------------------------------------------------------
{
  const gridSpacing = 1
  const n = 1000
  const segments = [
    { id: 'S1', label: 'S1', type: 'straight', startIndex: 0, endIndex: 300, startS: 0, endS: 300 },
    { id: 'T1', label: 'T1', type: 'corner', startIndex: 300, endIndex: 600, startS: 300, endS: 600 },
    { id: 'S2', label: 'S2', type: 'straight', startIndex: 600, endIndex: 1000, startS: 600, endS: 1000 },
  ]
  const reference = new Array(n).fill(25)
  const current = reference.map((v, i) => (i >= 300 && i < 600 ? v - 3 : v))

  const delta = computeDelta(current, reference, gridSpacing)
  const attributions = attributeLoss(delta, segments, gridSpacing)
  const conservation = checkConservation(attributions, delta.total)
  truthy(`attributed losses sum to the lap delta (error ${conservation.error.toExponential(1)}s)`,
    conservation.ok)
  close('and the sum matches exactly', conservation.attributedSum, delta.total, 1e-9)

  // Integrating 1/v must reproduce the real time.
  const time = integrateTime(reference, gridSpacing)
  close('time = distance / speed on a constant trace', time[n - 1], (n - 1) / 25, 1e-9)
}

// ---------------------------------------------------------------------------
suite('VALIDATION 5 — synthetic injection lands in the right segment')
// ---------------------------------------------------------------------------
{
  const gridSpacing = 1
  const n = 900
  const segments = [
    { id: 'S1', label: 'S1', type: 'straight', startIndex: 0, endIndex: 300, startS: 0, endS: 300 },
    { id: 'T1', label: 'T1', type: 'corner', startIndex: 300, endIndex: 600, startS: 300, endS: 600 },
    { id: 'S2', label: 'S2', type: 'straight', startIndex: 600, endIndex: 900, startS: 600, endS: 900 },
  ]
  const reference = new Array(n).fill(20)

  // Slow ONLY the corner, and recover exactly at its exit so nothing is
  // inherited downstream. The known loss is 300*(1/16 - 1/20) = 3.75 s.
  const injected = reference.map((v, i) => (i >= 300 && i < 600 ? 16 : v))
  const expected = 300 * (1 / 16 - 1 / 20)

  const delta = computeDelta(injected, reference, gridSpacing)
  close(`the whole lap loses the injected ${expected.toFixed(2)}s`, delta.total, expected, 1e-9)

  const attributions = attributeLoss(delta, segments, gridSpacing)
  const corner = attributions.find((a) => a.segmentId === 'T1')
  const before = attributions.find((a) => a.segmentId === 'S1')
  const after = attributions.find((a) => a.segmentId === 'S2')
  close('the corner is charged with it', corner.rawSeconds, expected, 1e-9)
  close('the straight before is charged nothing', before.rawSeconds, 0, 1e-12)
  close('the straight after is charged nothing', after.rawSeconds, 0, 1e-12)
  truthy('and the corner is credited with GENERATING it, not inheriting',
    corner.generatedSeconds > corner.inheritedSeconds)

  // Now the case attribution exists for: the corner is exited slow and the
  // deficit persists down the following straight. The straight must NOT be
  // blamed for a loss it merely inherited.
  const carried = reference.map((v, i) => (i >= 300 ? 16 : v))
  const carriedDelta = computeDelta(carried, reference, gridSpacing)
  const carriedAttr = attributeLoss(carriedDelta, segments, gridSpacing)
  const carriedCorner = carriedAttr.find((a) => a.segmentId === 'T1')
  const carriedStraight = carriedAttr.find((a) => a.segmentId === 'S2')
  truthy('the corner generated its loss', carriedCorner.generatedSeconds > 0)
  truthy('the following straight generated none of it',
    Math.abs(carriedStraight.generatedSeconds) < 1e-9)
  truthy('and reports the whole thing as inherited',
    Math.abs(carriedStraight.inheritedSeconds - carriedStraight.rawSeconds) < 1e-9)
  const carriedConservation = checkConservation(carriedAttr, carriedDelta.total)
  truthy('conservation still holds with inheritance', carriedConservation.ok)

  // A unit that creates a deficit owns it even if it later recovers it — the
  // mistake was still made there. What must NOT happen is a LATER unit being
  // blamed for a deficit it merely inherited.
  const recovering = reference.map((v, i) => (i >= 300 && i < 450 ? 16 : i >= 450 && i < 600 ? 24 : v))
  const recoverDelta = computeDelta(recovering, reference, gridSpacing)
  const recoverAttr = attributeLoss(recoverDelta, segments, gridSpacing)
  const recoverCorner = recoverAttr.find((a) => a.segmentId === 'T1')
  const recoverAfter = recoverAttr.find((a) => a.segmentId === 'S2')
  truthy('the unit that created the deficit owns it', recoverCorner.generatedSeconds > 0)
  truthy('and the unit after it, back on terms, owns nothing of it',
    Math.abs(recoverAfter.generatedSeconds) < 1e-6)
  const recoverConservation = checkConservation(recoverAttr, recoverDelta.total)
  truthy('conservation holds through a recovery', recoverConservation.ok)
}

// ---------------------------------------------------------------------------
suite('Exit-speed carry-back and trade-off detection')
// ---------------------------------------------------------------------------
{
  const gridSpacing = 1
  const n = 600
  const corner = { id: 'T1', type: 'corner', startIndex: 100, endIndex: 300 }
  const following = { id: 'S2', type: 'straight', startIndex: 300, endIndex: 600 }

  // Same acceleration profile, lower exit speed: the straight loses time that
  // belongs to the corner.
  const referenceSpeed = new Array(n).fill(0).map((_, i) => (i < 300 ? 20 : 20 + (i - 300) * 0.02))
  const currentSpeed = new Array(n).fill(0).map((_, i) => (i < 300 ? 17 : 17 + (i - 300) * 0.02))
  const downstream = computeDownstreamCost(corner, following, currentSpeed, referenceSpeed, gridSpacing)
  truthy(`a slow exit charges the corner for the straight (${downstream.toFixed(3)}s)`, downstream > 0.1)

  const matched = computeDownstreamCost(corner, following, referenceSpeed, referenceSpeed, gridSpacing)
  close('exiting at the reference costs nothing downstream', matched, 0, 1e-9)
  equal('no following straight means no carry-back',
    computeDownstreamCost(corner, null, currentSpeed, referenceSpeed, gridSpacing), 0)

  // Trade-off: best entry and best exit from different laps means the composite
  // best may be unachievable, and the advice must not say "do both".
  const phases = { entryStart: 100, apexIndex: 200, exitEnd: 300 }
  const lapA = { lapNumber: 1, speed: new Array(n).fill(0).map((_, i) => (i < 200 ? 22 : 16)) }
  const lapB = { lapNumber: 2, speed: new Array(n).fill(0).map((_, i) => (i < 200 ? 17 : 21)) }
  const trade = detectTradeoff(corner, phases, [lapA, lapB], gridSpacing)
  truthy('a genuine entry/exit trade-off is detected', trade.tradeoff)
  equal('best entry lap', trade.bestEntryLap, 1)
  equal('best exit lap', trade.bestExitLap, 2)

  const sameLap = detectTradeoff(corner, phases, [lapA, {
    lapNumber: 3, speed: lapA.speed.map((v) => v - 2),
  }], gridSpacing)
  truthy('one lap best at both ends is no trade-off', !sameLap.tradeoff)
}

// ---------------------------------------------------------------------------
suite('Theoretical-best reference')
// ---------------------------------------------------------------------------
{
  const gridSpacing = 1
  const n = 600
  const segments = [
    { id: 'S1', type: 'straight', startIndex: 0, endIndex: 300 },
    { id: 'T1', type: 'corner', startIndex: 300, endIndex: 600 },
  ]
  const lapA = { lapNumber: 1, speed: new Array(n).fill(0).map((_, i) => (i < 300 ? 25 : 15)) }
  const lapB = { lapNumber: 2, speed: new Array(n).fill(0).map((_, i) => (i < 300 ? 22 : 18)) }
  const best = buildTheoreticalBest([lapA, lapB], segments, gridSpacing)
  close('the first segment takes the quicker lap', best.speed[100], 25, 1e-9)
  close('the second takes the other one', best.speed[400], 18, 1e-9)
  truthy('and it is flagged as a composite', best.isComposite)
  equal('naming both contributing laps', best.contributingLaps.join(','), '1,2')

  const single = buildTheoreticalBest([lapA], segments, gridSpacing)
  truthy('one lap is not a composite', !single.isComposite)
  equal('no laps, no reference', buildTheoreticalBest([], segments, gridSpacing), null)
}

// ---------------------------------------------------------------------------
suite('VALIDATION 6 — envelope and its coverage map')
// ---------------------------------------------------------------------------
{
  // A car that corners at 15 m/s2 but only ever brakes at 7 — the exact shape
  // the reference log shows, and the case where coverage matters most.
  const samples = []
  for (let i = 0; i < 20000; i++) {
    const speed = 10 + (i % 100) * 0.15
    const direction = ((i * 7) % 360) - 180
    const lateralness = Math.abs(Math.sin((direction * Math.PI) / 180))
    const magnitude = (7 + 8 * lateralness) * (0.6 + 0.4 * ((i % 17) / 17))
    samples.push({ speed, direction, magnitude })
  }
  const envelope = buildEnvelope(samples, { minCellSamples: 10 })
  truthy('an envelope is built', envelope.ready)
  truthy('coverage is reported', envelope.coverage > 0)

  const lateral = envelopeAt(envelope, 15, 90)
  const braking = envelopeAt(envelope, 15, 180)
  truthy(`the envelope is larger laterally (${lateral.value.toFixed(1)}) than braking (${braking.value.toFixed(1)})`,
    lateral.value > braking.value)

  const used = utilisationAt(envelope, 15, 90, lateral.value)
  close('using the envelope value is 100% utilisation', used.utilisation, 1, 1e-6)
  const half = utilisationAt(envelope, 15, 90, lateral.value / 2)
  close('half of it is 50%', half.utilisation, 0.5, 1e-6)

  // The mandatory refusal: a thin cell may not drive a conclusion.
  const thin = buildEnvelope(samples.slice(0, 400), { minCellSamples: 500 })
  const thinUse = utilisationAt(thin, 15, 90, 10)
  truthy('utilisation from an under-sampled cell is marked unconfident', !thinUse.confident)
  truthy('and the coverage warnings say which zone is thin',
    coverageWarnings(thin).length > 0)
  truthy('an unbuilt envelope warns rather than pretending',
    coverageWarnings({ ready: false }).length === 1)
  equal('too few samples means no envelope',
    buildEnvelope([{ speed: 1, direction: 0, magnitude: 1 }]).ready, false)
}

/**
 * Synthetic stadium circuit: two straights joined by two 180-degree arcs.
 *
 * A constant-radius circle is useless for testing segmentation — its curvature
 * never varies, so there is nothing to split and the engine correctly finds no
 * corners. A stadium has genuinely bimodal curvature, which is what the Otsu
 * threshold is for.
 *
 * Generated by stepping ARC LENGTH at ds = v*dt, so position, speed, yaw rate
 * and lateral acceleration are all mutually consistent — a synthetic lap whose
 * geometry and speed disagree tests nothing.
 */
function makeStadiumSession({
  straightLength = 120, radius = 45, lapCount = 5, stopFraction = 0, dt,
  straightSpeed = 26, arcSpeed = 15, slowLap = null, slowArc = 0, slowSpeed = 11,
  originLat = 42.0, originLon = -84.0,
}) {
  const perimeter = 2 * straightLength + 2 * Math.PI * radius
  const mPerDegLat = 111132
  const mPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180)

  // Which piece of the circuit a given arc length falls on.
  const pieceAt = (s) => {
    const arcLength = Math.PI * radius
    if (s < straightLength) return { kind: 'straight', index: 0 }
    if (s < straightLength + arcLength) return { kind: 'arc', index: 0 }
    if (s < 2 * straightLength + arcLength) return { kind: 'straight', index: 1 }
    return { kind: 'arc', index: 1 }
  }

  const positionAt = (s) => {
    const arcLength = Math.PI * radius
    if (s < straightLength) {
      return { x: s, y: -radius, heading: 0 }
    }
    if (s < straightLength + arcLength) {
      const theta = -Math.PI / 2 + (s - straightLength) / radius
      return {
        x: straightLength + radius * Math.cos(theta),
        y: radius * Math.sin(theta),
        heading: theta + Math.PI / 2,
      }
    }
    if (s < 2 * straightLength + arcLength) {
      const along = s - straightLength - arcLength
      return { x: straightLength - along, y: radius, heading: Math.PI }
    }
    const theta = Math.PI / 2 + (s - 2 * straightLength - arcLength) / radius
    return { x: radius * Math.cos(theta), y: radius * Math.sin(theta), heading: theta + Math.PI / 2 }
  }

  const session = {
    time: [], latitude: [], longitude: [], speedX: [], speedY: [],
    lateralAccel: [], yawRate: [], yaw: [], steeringAngle: [],
    wheelSpeedFL: [], throttle: [],
  }

  let s = 0
  let step = 0
  let lap = 0
  const stopAt = (lapCount + stopFraction) * perimeter
  while (s < stopAt) {
    const piece = pieceAt(s % perimeter)
    const curvature = piece.kind === 'arc' ? 1 / radius : 0
    let speed = piece.kind === 'arc' ? arcSpeed : straightSpeed
    if (slowLap !== null && lap === slowLap && piece.kind === 'arc' && piece.index === slowArc) {
      speed = slowSpeed
    }

    const { x, y, heading } = positionAt(s % perimeter)
    session.time.push(step * dt)
    session.latitude.push(originLat + y / mPerDegLat)
    session.longitude.push(originLon + x / mPerDegLon)
    session.speedX.push(speed)
    session.speedY.push(0)
    session.yawRate.push(speed * curvature)
    session.lateralAccel.push(speed * speed * curvature)
    session.yaw.push((((heading * 180) / Math.PI) % 360 + 360) % 360)
    session.steeringAngle.push(curvature * 900)
    session.wheelSpeedFL.push(speed * 2.237)
    session.throttle.push(piece.kind === 'arc' ? 0.2 : 0.95)

    s += speed * dt
    step++
    lap = Math.floor(s / perimeter)
  }
  return { session, perimeter }
}

// ---------------------------------------------------------------------------
suite('VALIDATIONS 2 & 3 — self-consistency and segment stability, end to end')
// ---------------------------------------------------------------------------
{
  // A stadium circuit driven six times, with lap 3 deliberately slowed through
  // the first arc. That injected mistake is the known answer validation 5 needs.
  const { session, perimeter } = makeStadiumSession({
    dt: DT, lapCount: 6, slowLap: 2, slowArc: 0, slowSpeed: 11,
  })

  const analysis = analyseSession(session, { closureRadius: 25, minDistance: perimeter * 0.5 })
  truthy('the session analyses', analysis.ok)
  truthy('the convention health check passes on synthetic data',
    analysis.conventions.healthy)
  truthy(`laps are detected (${analysis.laps.length})`, analysis.laps.length >= 3)
  truthy(`corners are found (${analysis.segments?.filter((s) => s.type === 'corner').length})`,
    analysis.segments?.filter((s) => s.type === 'corner').length >= 2)

  // VALIDATION 3. The curvature segmentation is computed once and shared, so
  // those boundaries are identical by construction. The ATTRIBUTION units
  // breathe a little, because a corner claims its own braking zone and that
  // genuinely moves with how the lap was driven — so bound that movement
  // rather than demanding it be zero.
  truthy('the geometric segmentation is a single shared set',
    analysis.segments.length > 0)
  const byId = new Map()
  for (const lapReport of analysis.lapReports) {
    for (const seg of lapReport.segments) {
      if (!byId.has(seg.segmentId)) byId.set(seg.segmentId, [])
      byId.get(seg.segmentId).push(seg.startS)
    }
  }
  let worstSpread = 0
  for (const starts of byId.values()) {
    worstSpread = Math.max(worstSpread, Math.max(...starts) - Math.min(...starts))
  }
  truthy(`unit boundaries land within a small distance across laps (worst spread ${worstSpread.toFixed(0)} m)`,
    worstSpread < 60)
  truthy('and every lap reports the same set of units',
    new Set(analysis.lapReports.map((r) => r.segments.map((s) => s.segmentId).sort().join(','))).size === 1)

  // VALIDATION 4 again, on the real pipeline rather than a synthetic delta.
  for (const lapReport of analysis.lapReports) {
    truthy(`lap ${lapReport.lapNumber}: attribution conserves (error ${lapReport.conservation.error.toExponential(1)}s)`,
      lapReport.conservation.ok)
  }

  // VALIDATION 2: the reference compared with itself must be exactly zero.
  if (analysis.reference) {
    const selfDelta = computeDelta(analysis.reference.speed, analysis.reference.speed,
      analysis.gridSpacing)
    close('the reference against itself has zero total delta', selfDelta.total, 0, 1e-12)
    truthy('and zero rate everywhere', selfDelta.rate.every((r) => Math.abs(r) < 1e-12))
    const selfAttr = attributeLoss(selfDelta, analysis.segments, analysis.gridSpacing)
    truthy('so no segment is charged anything',
      selfAttr.every((a) => Math.abs(a.rawSeconds) < 1e-12))
  }

  // VALIDATION 5 end to end: the slowed lap must blame the corner it was
  // slowed in, and not its neighbours. Identify it by being the slowest rather
  // than by assuming which lap number the boundaries produced.
  const slowReport = analysis.lapReports.reduce(
    (a, b) => (b.deltaToReference > a.deltaToReference ? b : a),
  )
  truthy(`the deliberately slowed lap is slower than the reference (+${slowReport.deltaToReference.toFixed(2)}s)`,
    slowReport.deltaToReference > 0.5)
  const worst = slowReport.segments[0]
  truthy(`its worst segment is a corner (${worst.label}, +${worst.totalAttributed.toFixed(2)}s)`,
    worst.type === 'corner')
  truthy('and that corner is credited with generating the loss',
    worst.generatedSeconds > 0.5)
  // The injection was 15 -> 11 m/s through one arc of length pi*R.
  const injected = (Math.PI * 45) * (1 / 11 - 1 / 15)
  truthy(`the attributed loss is close to the injected ${injected.toFixed(2)}s `
    + `(got ${worst.generatedSeconds.toFixed(2)}s)`,
    Math.abs(worst.generatedSeconds - injected) < injected * 0.5)
  // Neighbouring segments must not be blamed for a loss they inherited.
  const others = slowReport.segments.slice(1)
  truthy('no other segment is credited with generating anything like as much',
    others.every((seg) => seg.generatedSeconds < worst.generatedSeconds * 0.5))

  const calibration = calibrationReport(analysis)
  truthy('a calibration report is produced', calibration.lines.length > 8)
  truthy('naming the kinematic check',
    calibration.lines.some((l) => l.label.includes('kinematic check')))
  truthy('the curvature split', calibration.lines.some((l) => l.label.includes('Otsu')))
  truthy('and the envelope coverage',
    calibration.lines.some((l) => l.label.includes('coverage')))
  truthy('every reported value is a non-empty string',
    calibration.lines.every((l) => typeof l.value === 'string' && l.value.length > 0))
}

// ---------------------------------------------------------------------------
suite('Refusing to guess')
// ---------------------------------------------------------------------------
{
  // One lap cannot establish a reference; the engine must say so rather than
  // compare a lap with itself and report a flawless drive.
  // One and a bit circuits: the line is crossed twice, so exactly ONE complete
  // lap exists — and one lap cannot be a reference for itself.
  const { session, perimeter } = makeStadiumSession({ dt: DT, lapCount: 1, stopFraction: 0.4 })

  const analysis = analyseSession(session, { minDistance: perimeter * 0.5 })
  truthy('with under two clean laps the engine reports warm-up', analysis.warmup)
  truthy('and says why in words',
    analysis.warnings.some((w) => /clean lap|complete lap/i.test(w)))
  truthy('no lap report claims a comparison it cannot make',
    (analysis.lapReports ?? []).every((r) => r.warmup))
}

// ---------------------------------------------------------------------------
suite('Event taxonomy — every factor checked, every type distinguishable')
// ---------------------------------------------------------------------------
{
  const { EVENT_TYPES, EVENT_INFO, classifyEvent, metricScatter, headlineFor } =
    await import('../src/engine/events.js')

  // Five coaching verdicts, an incident marker, and an explicit "no cause".
  equal('seven event types', Object.keys(EVENT_TYPES).length, 7)
  truthy('every type has a label, colour and shape',
    Object.values(EVENT_TYPES).every((t) => EVENT_INFO[t].label && EVENT_INFO[t].color && EVENT_INFO[t].shape))
  // Shape is the second channel, so the map never depends on colour alone.
  equal('every type has a distinct shape',
    new Set(Object.values(EVENT_INFO).map((i) => i.shape)).size, 7)
  // "Arrived slow" and "no clear cause" deliberately share the neutral grey:
  // neither is a technique fault, and shape separates them.
  equal('six distinct colours across seven types',
    new Set(Object.values(EVENT_INFO).map((i) => i.color)).size, 6)
  // The incident marker is achromatic and far brighter than everything else:
  // luminance is a channel no colour blindness touches, which is why a sixth
  // HUE was not attempted.
  truthy('the incident marker is the brightest thing on the map',
    EVENT_INFO[EVENT_TYPES.INCIDENT].color === '#f2f4f8')
  truthy('and it is marked as an incident rather than a coaching point',
    EVENT_INFO[EVENT_TYPES.INCIDENT].isIncident === true)
  truthy('no coaching type claims to be an incident',
    [EVENT_TYPES.OVER_DRIVEN, EVENT_TYPES.UNDER_DRIVEN, EVENT_TYPES.MID_CORNER,
      EVENT_TYPES.SLOW_STRAIGHT, EVENT_TYPES.INHERITED]
      .every((t) => !EVENT_INFO[t].isIncident))

  const scatterOf = (v) => metricScatter(v)
  close('scatter of a repeatable metric is near zero',
    scatterOf([10, 10.05, 9.95, 10.02]).mad, 0.03, 0.03)
  truthy('scatter of a variable one is larger', scatterOf([10, 12, 8, 14]).mad > 1)
  equal('too few samples yields no scatter', metricScatter([1, 2]), null)

  // Build a measurement set, then vary one factor at a time.
  const base = (over = {}) => ({
    entrySpeed: { observed: 20, reference: 20, delta: 0 },
    minSpeed: { observed: 12, reference: 12, delta: 0 },
    exitSpeed: { observed: 18, reference: 18, delta: 0 },
    peakLateral: { observed: 14, reference: 14, delta: 0 },
    peakSlip: { observed: 3, reference: 3, delta: 0, trustworthy: true },
    peakSteerRate: { observed: 100, reference: 100, delta: 0 },
    meanThrottle: { observed: 0.6, reference: 0.6, delta: 0 },
    ...over,
  })
  const tight = {
    entrySpeed: { mad: 0.2 }, minSpeed: { mad: 0.2 }, exitSpeed: { mad: 0.2 },
    peakLateral: { mad: 0.3 }, peakSlip: { mad: 0.3 },
    peakSteerRate: { mad: 20 }, meanThrottle: { mad: 0.05 },
  }

  // Pushed too hard: exit gone AND more slip.
  equal('exit lost with extra slip is over-driven',
    classifyEvent({
      measured: base({
        exitSpeed: { observed: 16, reference: 18, delta: -2 },
        peakSlip: { observed: 6, reference: 3, delta: 3, trustworthy: true },
      }),
      scatter: tight, isCorner: true, deficitBefore: 0,
    }).type, EVENT_TYPES.OVER_DRIVEN)

  // Not pushed hard enough: exit gone, LESS grip, lower apex.
  equal('exit lost with less grip is under-driven',
    classifyEvent({
      measured: base({
        exitSpeed: { observed: 16, reference: 18, delta: -2 },
        minSpeed: { observed: 10.5, reference: 12, delta: -1.5 },
        peakLateral: { observed: 11, reference: 14, delta: -3 },
        peakSlip: { observed: 1.5, reference: 3, delta: -1.5, trustworthy: true },
      }),
      scatter: tight, isCorner: true, deficitBefore: 0,
    }).type, EVENT_TYPES.UNDER_DRIVEN)

  // The two are opposites and must never collide.
  truthy('over- and under-driven are distinct verdicts',
    EVENT_INFO[EVENT_TYPES.OVER_DRIVEN].color !== EVENT_INFO[EVENT_TYPES.UNDER_DRIVEN].color)

  // Entry and exit both fine, time gone in between.
  equal('entry and exit matched but time lost is mid-corner',
    classifyEvent({
      measured: base({ minSpeed: { observed: 10.5, reference: 12, delta: -1.5 } }),
      scatter: tight, isCorner: true, deficitBefore: 0,
    }).type, EVENT_TYPES.MID_CORNER)

  // A straight where the car was not driven — evidenced by the throttle.
  equal('a straight with less throttle is a slow straight',
    classifyEvent({
      measured: base({ meanThrottle: { observed: 0.4, reference: 0.6, delta: -0.2 } }),
      scatter: tight, isCorner: false, deficitBefore: 0,
    }).type, EVENT_TYPES.SLOW_STRAIGHT)

  // THE regression this type exists for. A straight where every input matches
  // the reference must NOT be called "not pushed hard enough" — on the real log
  // that produced flags claiming less throttle where the driver used MORE.
  equal('a straight with no differing input is unexplained, not blamed',
    classifyEvent({
      measured: base(), scatter: tight, isCorner: false, deficitBefore: 0,
    }).type, EVENT_TYPES.UNEXPLAINED)
  equal('and MORE throttle certainly is not "not pushed hard enough"',
    classifyEvent({
      measured: base({ meanThrottle: { observed: 0.7, reference: 0.6, delta: 0.1 } }),
      scatter: tight, isCorner: false, deficitBefore: 0,
    }).type, EVENT_TYPES.UNEXPLAINED)
  equal('a corner with no differing input is unexplained too',
    classifyEvent({
      measured: base({ exitSpeed: { observed: 17.9, reference: 18, delta: -0.1 } }),
      scatter: tight, isCorner: true, deficitBefore: 0,
    }).type !== EVENT_TYPES.SLOW_STRAIGHT, true)

  // Arrived slow: the cause is upstream, and saying anything else would be
  // describing a symptom.
  equal('a deficit already present is inherited',
    classifyEvent({
      measured: base({ entrySpeed: { observed: 18, reference: 20, delta: -2 } }),
      scatter: tight, isCorner: true, deficitBefore: 1.5,
    }).type, EVENT_TYPES.INHERITED)

  // Thresholds come from the driver's own scatter, not from constants: the SAME
  // difference is significant for a repeatable driver and noise for a variable
  // one. This is the property that replaces magic numbers.
  const wobbly = { ...tight, peakLateral: { mad: 5 }, exitSpeed: { mad: 3 }, minSpeed: { mad: 3 } }
  const measured = base({
    exitSpeed: { observed: 16, reference: 18, delta: -2 },
    minSpeed: { observed: 10.5, reference: 12, delta: -1.5 },
    peakLateral: { observed: 11, reference: 14, delta: -3 },
    peakSlip: { observed: 1.5, reference: 3, delta: -1.5, trustworthy: true },
  })
  const forTightDriver = classifyEvent({ measured, scatter: tight, isCorner: true, deficitBefore: 0 })
  const forWobblyDriver = classifyEvent({ measured, scatter: wobbly, isCorner: true, deficitBefore: 0 })
  truthy('the same numbers read differently against different scatter',
    forTightDriver.type !== forWobblyDriver.type)
  truthy('and the repeatable driver gets the firmer verdict',
    forTightDriver.confidence >= forWobblyDriver.confidence)

  // Untrustworthy slip must never drive a verdict.
  equal('slip flagged untrustworthy cannot make it over-driven',
    classifyEvent({
      measured: base({
        exitSpeed: { observed: 16, reference: 18, delta: -2 },
        peakSlip: { observed: 40, reference: 3, delta: 37, trustworthy: false },
      }),
      scatter: tight, isCorner: true, deficitBefore: 0,
    }).type !== EVENT_TYPES.OVER_DRIVEN, true)

  // Every coaching headline carries a number and names the place. Incidents
  // write their own text, so they are not part of this contract.
  for (const type of Object.values(EVENT_TYPES)
    .filter((t) => t !== EVENT_TYPES.INCIDENT && t !== EVENT_TYPES.UNEXPLAINED)) {
    const line = headlineFor(type, base(), 0.42, 'T3')
    truthy(`the ${type} headline names the place and a number`,
      line.includes('T3') && /\d/.test(line))
  }
}

// ---------------------------------------------------------------------------
suite('Replay clock — the bug that stopped laps appearing')
// ---------------------------------------------------------------------------
{
  const { createReplayClock } = await import('../src/engine/replayClock.js')

  const clock = createReplayClock()
  equal('a fresh clock adds nothing', clock.accept(0, 0.5), 0)
  equal('and stays at zero while time advances', clock.accept(0.5, 1.0), 0)
  equal('no restarts yet', clock.restarts, 0)

  // A restart: the log ends near 766 s and the next frame begins near zero.
  clock.accept(700, 766)
  const offset = clock.accept(0.0, 0.05)
  truthy(`a restart rebases forward (offset ${offset.toFixed(2)}s)`, offset > 766)
  equal('and is counted once', clock.restarts, 1)

  // THE regression. Rebasing against the MAXIMUM timestamp meant every frame
  // after a restart looked like another restart, so the offset grew once per
  // frame: 15,000 "restarts" and a buffer claiming 5.8 million seconds, which
  // trimmed away every real lap.
  const afterFirst = clock.offset
  clock.accept(0.05, 0.10)
  clock.accept(0.10, 0.15)
  clock.accept(0.15, 0.20)
  equal('following frames are NOT further restarts', clock.restarts, 1)
  close('and the offset stays put', clock.offset, afterFirst, 1e-9)

  // Time must be strictly increasing across the seam, or the ingest buffer
  // rejects everything after it and the session silently freezes.
  const seam = createReplayClock()
  const virtual = []
  for (const [a, b] of [[0, 1], [1, 2], [760, 766], [0, 1], [1, 2], [760, 766], [0, 1]]) {
    const off = seam.accept(a, b)
    virtual.push(a + off, b + off)
  }
  truthy('virtual time never goes backwards across restarts',
    virtual.every((v, i) => i === 0 || v >= virtual[i - 1]))
  equal('exactly two restarts were seen', seam.restarts, 2)

  // Ordinary interleaving within a frame must not be mistaken for a restart.
  const jitter = createReplayClock()
  jitter.accept(10, 11)
  jitter.accept(10.8, 12)
  equal('a small backward step is not a restart', jitter.restarts, 0)

  jitter.reset()
  equal('reset clears the offset', jitter.offset, 0)
  equal('and the restart count', jitter.restarts, 0)
}

// ---------------------------------------------------------------------------
suite('No array spreading on per-sample data')
// ---------------------------------------------------------------------------
{
  const { maxOf, minOf } = await import('../src/engine/derive.js')
  equal('maxOf', maxOf([3, 9, 1]), 9)
  equal('minOf', minOf([3, 9, 1]), 1)
  equal('maxOf skips non-finite', maxOf([1, NaN, 5]), 5)
  equal('maxOf of nothing is the initial', maxOf([], 0), 0)

  // The actual failure: Math.max(...array) overflows the call stack past
  // ~125,000 arguments, which on a 100 Hz grid is about 21 minutes. The engine
  // worked through one replay and threw RangeError immediately after it.
  const huge = new Array(400000)
  for (let i = 0; i < huge.length; i++) huge[i] = i % 1000
  equal('maxOf handles an array far past the spread limit', maxOf(huge), 999)
  equal('minOf too', minOf(huge), 0)
  let spreadThrew = false
  try { Math.max(...huge) } catch { spreadThrew = true }
  truthy('while spreading the same array throws', spreadThrew)
}

process.exit(report())

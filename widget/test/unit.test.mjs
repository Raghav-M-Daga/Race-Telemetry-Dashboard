/**
 * Unit tests: the maths and the components, with no server needed.
 *
 * Run with `npm test` (this file plus the render tests) or `npm run test:unit`.
 */

import { renderToString } from 'react-dom/server'
import React from 'react'
import { close, equal, rendersCleanly, report, suite, truthy } from './harness.mjs'

// useCarData opens an EventSource on mount; stub it so App can render in Node.
class FakeEventSource {
  static CLOSED = 2
  constructor() { this.readyState = 0 }
  close() {}
}
globalThis.EventSource = FakeEventSource

const h = React.createElement

const {
  AY_BINS, STEERING_ZERO_OFFSET_DEG, TRACK_CELL_SIZE_M,
  YAW_GAIN_LSR_M, STEERING_RATIO,
} = await import('../src/config.js')
const {
  RAD_TO_DEG, clamp, estimateCornerLoads, loadColor, toCompassBearing,
  unwrapHeading, yawRateSeverity, formatSigned, cardinalFor,
} = await import('../src/lib/vehicle.js')
const {
  handlingBalance, ayBinIndex, median, balancePresentation, slipRate,
  referenceYawRate, correctedSteeringAngle,
} = await import('../src/lib/handling.js')
const { createProjection, isValidFix, cellKey, cellCentre, fitBounds } = await import('../src/lib/geo.js')
const { medianOf, madOf, percentileOf } = await import('../src/engine/track.js')
const {
  createLapDetector, formatLapTime, smoothPath, segmentByCategory, LINE_GATE_M, MIN_LAP_SECONDS,
} = await import('../src/lib/lapTiming.js')

const App = (await import('../src/App.jsx')).default
const CarView = (await import('../src/components/CarView.jsx')).default
const SteeringGauge = (await import('../src/components/SteeringGauge.jsx')).default
const LateralAccelBar = (await import('../src/components/LateralAccelBar.jsx')).default
const Compass = (await import('../src/components/Compass.jsx')).default
const YawRateBar = (await import('../src/components/YawRateBar.jsx')).default
const BalanceMeter = (await import('../src/components/BalanceMeter.jsx')).default
const HandlingSignature = (await import('../src/components/HandlingSignature.jsx')).default
const DataGuide = (await import('../src/components/DataGuide.jsx')).default
const { StatusBanner, StatusPill } = await import('../src/components/StatusBanner.jsx')
const { LINK_STATE } = await import('../src/hooks/useCarData.js')

// ---------------------------------------------------------------------------
suite('Unit conversions and helpers')
// ---------------------------------------------------------------------------
close('rad/s -> deg/s uses 180/pi', RAD_TO_DEG, 57.29577951308232, 1e-12)
equal('heading -90 folds to 270', toCompassBearing(-90), 270)
equal('heading 370 wraps to 10', toCompassBearing(370), 10)
equal('heading 0 stays 0', toCompassBearing(0), 0)
// The seam is the whole point: 359 -> 1 must be a +2 step, not -358.
close('unwrap takes the short way over north', unwrapHeading(359, 1), 361)
close('unwrap takes the short way under north', unwrapHeading(1, 359), -1)
close('unwrap is a no-op mid-range', unwrapHeading(180, 190), 190)
equal('clamp low', clamp(-5, 0, 10), 0)
equal('clamp high', clamp(50, 0, 10), 10)
equal('formatSigned keeps a sign column', formatSigned(3.14159, 2), '+3.14')
equal('formatSigned negative', formatSigned(-0.5, 1), '-0.5')
equal('formatSigned handles NaN', formatSigned(NaN), '--')
equal('cardinal N', cardinalFor(0), 'N')
equal('cardinal NE', cardinalFor(47), 'NE')
equal('cardinal wraps to N', cardinalFor(359), 'N')

// ---------------------------------------------------------------------------
suite('Corner load model')
// ---------------------------------------------------------------------------
const flat = estimateCornerLoads(0)
equal('no lateral g means all four corners equal', [flat.shock_fl, flat.shock_fr, flat.shock_rl, flat.shock_rr], [50, 50, 50, 50])
// Positive AY is a RIGHT turn, which throws load onto the LEFT tyres.
const right = estimateCornerLoads(10)
truthy('right turn loads the left front', right.shock_fl > right.shock_fr)
truthy('right turn loads the left rear', right.shock_rl > right.shock_rr)
const left = estimateCornerLoads(-10)
truthy('left turn loads the right front', left.shock_fr > left.shock_fl)
truthy('corner loads stay within 0-100 at absurd input',
  Object.values(estimateCornerLoads(500)).every((v) => v >= 0 && v <= 100))
// Front takes 55% of the transfer, so it must move more than the rear.
truthy('front axle transfers more than rear',
  Math.abs(right.shock_fl - 50) > Math.abs(right.shock_rl - 50))
truthy('loadColor returns an hsl string', loadColor(50).startsWith('hsl('))

// ---------------------------------------------------------------------------
suite('Yaw rate severity')
// ---------------------------------------------------------------------------
equal('near zero is stable', yawRateSeverity(5, 30, 60).level, 'low')
equal('30 is moderate (inclusive)', yawRateSeverity(30, 30, 60).level, 'moderate')
equal('60 is high (inclusive)', yawRateSeverity(60, 30, 60).level, 'high')
equal('severity ignores sign', yawRateSeverity(-70, 30, 60).level, 'high')

// ---------------------------------------------------------------------------
suite('Handling balance (understeer / oversteer)')
// ---------------------------------------------------------------------------
const Z = STEERING_ZERO_OFFSET_DEG
const REF_YAW = (45 * 20) / YAW_GAIN_LSR_M // 45 deg corrected steer at 20 m/s
close('steering zero offset removed', correctedSteeringAngle(Z), 0, 1e-12)
equal('no speed means no commanded yaw', referenceYawRate(45, 0), 0)
close('reference yaw rate scales with speed', referenceYawRate(45, 20), REF_YAW, 1e-9)
equal('standstill is not a balance case',
  handlingBalance({ steeringAngle: 40, yawRate: 0, lateralAcceleration: 0, speed: 0 }).isCornering, false)
equal('straight line is not a balance case',
  handlingBalance({ steeringAngle: 0, yawRate: 0, lateralAcceleration: 0.2, speed: 20 }).isCornering, false)

const pushRight = handlingBalance({ steeringAngle: 45 + Z, yawRate: REF_YAW - 40, lateralAcceleration: 10, speed: 20 })
const looseRight = handlingBalance({ steeringAngle: 45 + Z, yawRate: REF_YAW + 40, lateralAcceleration: 10, speed: 20 })
equal('turning less than commanded is understeer', pushRight.state, 'understeer')
equal('turning more than commanded is oversteer', looseRight.state, 'oversteer')
// The offset is ADDITIVE, so the symmetric raw pair is (X+Z, -X+Z). This is the
// property signedBalance exists to guarantee: identical handling in a left and a
// right corner must read identically, not as mirror images.
const pushLeft = handlingBalance({ steeringAngle: -45 + Z, yawRate: -(REF_YAW - 40), lateralAcceleration: -10, speed: 20 })
equal('a left corner reports the same state', pushLeft.state, 'understeer')
close('a left corner reports the same magnitude', pushLeft.signedBalance, pushRight.signedBalance, 1e-9)
// Kinematics: in true steady state, a_y = r * v_x exactly, so no sideslip builds.
close('slip rate is zero in perfect steady state', slipRate((30 / RAD_TO_DEG) * 20, 30, 20), 0, 1e-9)
truthy('slip rate is positive when a_y exceeds r*v', slipRate((30 / RAD_TO_DEG) * 20 + 2, 30, 20) > 0)
equal('below the first AY bin', ayBinIndex(1), -1)
equal('top AY bin', ayBinIndex(30), AY_BINS.length - 1)
equal('AY bins ignore sign', ayBinIndex(-9), ayBinIndex(9))
equal('median odd length', median([3, 1, 2]), 2)
equal('median even length', median([4, 1, 2, 3]), 2.5)
equal('median of nothing', median([]), null)
truthy('every balance state carries a label, never colour alone',
  ['understeer', 'oversteer', 'neutral'].every((s) => balancePresentation(s).label.length > 0))

// ---------------------------------------------------------------------------
suite('GPS projection and grid')
// ---------------------------------------------------------------------------
truthy('a real fix is valid', isValidFix(42.0667, -84.2377))
truthy('(0,0) is rejected as "no lock"', !isValidFix(0, 0))
truthy('NaN is rejected', !isValidFix(NaN, -84))
truthy('out-of-range latitude is rejected', !isValidFix(95, -84))

const projection = createProjection(42.0667, -84.2377)
const origin = projection.toLocal(42.0667, -84.2377)
close('the origin projects to (0,0) in x', origin.x, 0, 1e-9)
close('the origin projects to (0,0) in y', origin.y, 0, 1e-9)
// One degree of latitude is ~111 km regardless of where you are.
close('a degree of latitude is ~111 km', projection.toLocal(43.0667, -84.2377).y, 111132, 1)
// A degree of LONGITUDE shrinks by cos(lat) — at 42 deg that is ~0.743.
const east = projection.toLocal(42.0667, -83.2377).x
close('a degree of longitude shrinks by cos(latitude)', east, 111320 * Math.cos(42.0667 * Math.PI / 180), 1)
truthy('longitude degrees are shorter than latitude degrees at this latitude', east < 111132)
// North must be north: increasing latitude increases y.
truthy('increasing latitude moves north', projection.toLocal(42.07, -84.2377).y > 0)

equal('cells quantise to the grid', cellKey(0, 0), cellKey(TRACK_CELL_SIZE_M * 0.4, 0))
truthy('points a cell apart get different keys', cellKey(0, 0) !== cellKey(TRACK_CELL_SIZE_M, 0))
equal('cell centre round-trips', cellCentre(cellKey(TRACK_CELL_SIZE_M * 2, 0)).x, TRACK_CELL_SIZE_M * 2)

// fitBounds must preserve aspect ratio, or corner radii would be misdrawn.
const box = fitBounds([{ x: 0, y: 0 }, { x: 100, y: 400 }], 520, 430)
truthy('fitBounds returns a projector', typeof box.project === 'function')
const a = box.project(0, 0)
const b = box.project(100, 400)
close('x and y share one scale (aspect preserved)',
  (b.px - a.px) / 100, (a.py - b.py) / 400, 1e-9)
truthy('north is up: larger y projects higher on screen', b.py < a.py)
equal('fitBounds copes with no points', fitBounds([], 520, 430), null)

// The engine's robust statistics. Every threshold that decides a verdict is
// expressed in these, so their edge cases matter more than their happy path.
equal('percentile of one value', percentileOf([5], 0.99), 5)
equal('percentile indexes the sorted rank', percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9)
equal('percentile of nothing is zero, not NaN', percentileOf([], 0.99), 0)
equal('percentile ignores non-finite samples', percentileOf([1, NaN, 3, Infinity], 0), 1)
equal('median of an even count averages the middle pair', medianOf([1, 2, 3, 4]), 2.5)
equal('median of nothing is zero, not NaN', medianOf([]), 0)
// MAD, not standard deviation: one wild outlier must not move the yardstick.
equal('MAD is unmoved by a single outlier', madOf([10, 10, 10, 10, 1000]), 0)

// ---------------------------------------------------------------------------
suite('Components render across edge cases')
// ---------------------------------------------------------------------------
rendersCleanly('App mounts with no data', () => renderToString(h(App)))
rendersCleanly('DataGuide', () => renderToString(h(DataGuide)))

for (const angle of [-180, -88, -1, 0, 47.3, 180, 400, -400]) {
  rendersCleanly(`SteeringGauge at ${angle} deg`, () => renderToString(h(SteeringGauge, { angle })))
}
for (const ay of [0, -12.8, 13.5, -25.1, 25.9, 100]) {
  rendersCleanly(`LateralAccelBar at ${ay}`, () => renderToString(h(LateralAccelBar, { lateralAcceleration: ay })))
}
for (const yawRate of [0, 29.9, 30, 60, -92.2, 500]) {
  rendersCleanly(`YawRateBar at ${yawRate}`, () => renderToString(h(YawRateBar, { yawRate })))
}
for (const [heading, unwrapped] of [[0, 0], [359, -1], [1, 361], [180, -540]]) {
  rendersCleanly(`Compass at ${heading}/${unwrapped}`,
    () => renderToString(h(Compass, { heading, headingUnwrapped: unwrapped })))
}
for (const ay of [0, -11.18, 12.94, -20, 20]) {
  rendersCleanly(`CarView modelled at ay=${ay}`, () => renderToString(
    h(CarView, { loads: estimateCornerLoads(ay), steeringAngle: ay * 5, isEstimated: true })))
}
rendersCleanly('CarView with real shock data', () => renderToString(h(CarView, {
  loads: { shock_fl: 0, shock_fr: 100, shock_rl: 50, shock_rr: 73.6 },
  steeringAngle: -88, isEstimated: false,
})))
for (const state of Object.values(LINK_STATE)) {
  rendersCleanly(`StatusPill ${state}`, () => renderToString(h(StatusPill, { linkState: state, tickCount: 42 })))
}
for (const r of [
  { steeringAngle: 0, yawRate: 0, lateralAcceleration: 0, speed: 0 },
  { steeringAngle: 45 + Z, yawRate: REF_YAW - 40, lateralAcceleration: 10, speed: 20 },
  { steeringAngle: -45 + Z, yawRate: -(REF_YAW + 40), lateralAcceleration: -10, speed: 20 },
  { steeringAngle: 88, yawRate: -200, lateralAcceleration: 25, speed: 25 },
]) {
  rendersCleanly(`BalanceMeter (${r.steeringAngle.toFixed(0)} deg)`, () => renderToString(
    h(BalanceMeter, { balance: handlingBalance(r), yawRate: r.yawRate })))
}

const emptySig = AY_BINS.map((b) => ({ ...b, median: null, count: 0 }))
const realSig = AY_BINS.map((b, i) => ({ ...b, median: [5.9, -1.1, -0.7, -3.4, -18.7][i], count: [194, 114, 144, 57, 5][i] }))
for (const [name, sig] of [['empty', emptySig], ['real', realSig]]) {
  rendersCleanly(`HandlingSignature ${name}`, () => renderToString(
    h(HandlingSignature, { signature: sig, rejectedTransients: 2523, onReset: () => {} })))
}

// The verdict must read the trend off populated bands only.
const verdictOf = (sig) => {
  const html = renderToString(h(HandlingSignature, { signature: sig, rejectedTransients: 0, onReset: () => {} }))
  return /Trends toward oversteer/.test(html) ? 'oversteer'
    : /Trends toward understeer/.test(html) ? 'understeer'
    : /holds steady/.test(html) ? 'steady' : 'gathering'
}
equal('no data yields no verdict', verdictOf(emptySig), 'gathering')
equal('thin bands are ignored', verdictOf(AY_BINS.map((b) => ({ ...b, median: 3, count: 5 }))), 'gathering')
equal('the real signature reads as an oversteer trend', verdictOf(realSig), 'oversteer')
equal('a flat signature reads as steady',
  verdictOf(AY_BINS.map((b) => ({ ...b, median: 0.5, count: 300 }))), 'steady')
equal('a rising signature reads as an understeer trend',
  verdictOf(AY_BINS.map((b, i) => ({ ...b, median: 2 + i * 3, count: 300 }))), 'understeer')

// ---------------------------------------------------------------------------
suite('Lap detection by start/finish line crossing')
// ---------------------------------------------------------------------------
// Proximity detection ("within N metres of the start") was tried first and
// merged pairs of laps on the real log. Line crossing is what timing systems
// actually use, and it reproduced all 10 laps cleanly.
{
  const detector = createLapDetector()
  // Crawling does not arm the line — a heading taken at walking pace is noise.
  equal('crawling does not arm the detector', detector.update(0, 0, 2, 0), false)
  equal('still unarmed', detector.isArmed, false)
  // Up to speed, then far enough to have a trustworthy heading.
  detector.update(0, 0, 15, 1)
  detector.update(0, 10, 15, 2)
  truthy('armed once moving with a baseline', detector.isArmed)
  truthy('the line is perpendicular to the heading',
    Math.abs(detector.line.h.x * detector.line.n.x + detector.line.h.y * detector.line.n.y) < 1e-9)

  // Drive a lap: away from the line, round, and back through it.
  equal('no lap while still going out', detector.update(0, 200, 15, 20), false)
  equal('no lap while behind the line', detector.update(0, -30, 15, 40), false)
  equal('crossing the line completes a lap', detector.update(0, 5, 15, 60), true)
}
{
  // A crossing far to the side is a different part of the circuit, not the line.
  const detector = createLapDetector()
  detector.update(0, 0, 15, 0)
  detector.update(0, 10, 15, 1)
  detector.update(LINE_GATE_M + 50, -20, 15, 40)
  equal('a crossing outside the gate does not count',
    detector.update(LINE_GATE_M + 50, 20, 15, 41), false)
}
{
  // Wobbling over the line must not rack up laps.
  const detector = createLapDetector()
  detector.update(0, 0, 15, 0)
  detector.update(0, 10, 15, 1)
  detector.update(0, -5, 15, 2)
  equal('a wobble inside the debounce window is not a lap',
    detector.update(0, 5, 15, 3), false)
  detector.update(0, -5, 15, MIN_LAP_SECONDS + 5)
  equal('the same crossing after the debounce is a lap',
    detector.update(0, 5, 15, MIN_LAP_SECONDS + 6), true)
}
equal('lap time formatting', formatLapTime(65.1), '1:05.1')
equal('lap time pads seconds under ten', formatLapTime(63.2), '1:03.2')
equal('lap time past two minutes', formatLapTime(125.5), '2:05.5')
equal('no lap time yet', formatLapTime(0), '--:--')

// smoothPath must not move the endpoints or change the point count.
{
  const noisy = [
    { x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: -5 }, { x: 3, y: 5 },
    { x: 4, y: -5 }, { x: 5, y: 0 },
  ]
  const smoothed = smoothPath(noisy, 2)
  equal('smoothing keeps every point', smoothed.length, noisy.length)
  equal('smoothing pins the first point', [smoothed[0].x, smoothed[0].y], [0, 0])
  equal('smoothing pins the last point',
    [smoothed[smoothed.length - 1].x, smoothed[smoothed.length - 1].y], [5, 0])
  truthy('smoothing reduces the wobble',
    Math.abs(smoothed[2].y) < Math.abs(noisy[2].y))
  equal('a path too short to smooth is returned as-is', smoothPath([{ x: 0, y: 0 }], 2).length, 1)
}

// Segments must tile the path with no gaps, which is what keeps the drawn line
// continuous where the colour changes.
{
  const path = [
    { x: 0, y: 0, category: 'a' }, { x: 1, y: 0, category: 'a' },
    { x: 2, y: 0, category: 'b' }, { x: 3, y: 0, category: 'b' },
    { x: 4, y: 0, category: 'a' },
  ]
  const segments = segmentByCategory(path)
  equal('runs are split by category', segments.map((seg) => seg.category), ['a', 'b', 'a'])
  truthy('consecutive segments share a point (no visible gap)',
    segments[0].points[segments[0].points.length - 1] === segments[1].points[0])
  equal('an empty path yields no segments', segmentByCategory([]).length, 0)
  equal('a single-category path is one run', segmentByCategory(path.slice(0, 2)).length, 1)
}

// ---------------------------------------------------------------------------
process.exit(report())

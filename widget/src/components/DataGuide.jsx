import {
  LATERAL_ACCEL_FULL_SCALE,
  SMOOTHING_ALPHA,
  STEERING_ZERO_OFFSET_DEG,
  YAW_RATE_HIGH_DEG_S,
} from '../config.js'
import { CONFIG } from '../engine/config.js'
import { EVENT_INFO, EVENT_TYPES } from '../engine/events.js'

/**
 * Every quantity on the dashboard, where it comes from, and how it is used.
 *
 * Three kinds of row, kept visually distinct because the difference matters:
 * MEASURED values come off a sensor; DERIVED values are computed here and are
 * only as good as the assumption behind them; the VERDICTS are what the engine
 * is willing to say out loud, and on what evidence.
 *
 * This page is generated from the same constants and the same EVENT_INFO table
 * the engine itself uses, so it cannot drift out of date the way a hand-written
 * description would. An earlier version of this file did exactly that — it went
 * on documenting a 4-degree slip threshold and a 135 deg/s steering-jerk
 * threshold for weeks after the code that used them had been deleted.
 */

const MEASURED = [
  {
    name: 'steeringAngle', id: 21, channel: 'ludwig.steeringWheel.angle', unit: 'degrees',
    what: 'Steering wheel rotation. Negative left, positive right.',
    used: 'The steering gauge, the front wheels on the car view, and (after the zero correction) the commanded yaw rate in the handling model. Its derivative, steering RATE, is one of the factors the coaching engine compares against your best lap.',
    note: `The sensor zero is off by about ${STEERING_ZERO_OFFSET_DEG}°; that is corrected for the handling maths but the gauge shows the raw reading.`,
  },
  {
    name: 'lateralAcceleration (AY)', id: 10, channel: 'pcm.vnav.compensatedAccel.y', unit: 'm/s²',
    what: 'Sideways acceleration measured by the VectorNav IMU. This is the cornering force the tyres are actually generating.',
    used: `The AY bar (full scale ±${LATERAL_ACCEL_FULL_SCALE}), the modelled corner loads, and the "how much grip did you use here" comparison in the coaching engine.`,
    note: 'Divide by 9.81 for g. This car peaks around 1.5 g. It is also the reference the engine checks its own derived kinematics against at startup.',
  },
  {
    name: 'yawRate', id: 12, channel: 'pcm.vnav.compensatedAngularRate.z', unit: 'rad/s on the wire → deg/s shown',
    what: 'How fast the car is rotating about its vertical axis — how much the car is actually turning, as distinct from how much the driver asked for.',
    used: `The yaw readout (red past ${YAW_RATE_HIGH_DEG_S}°/s), the handling balance, and the rotating-frame correction that makes lateral acceleration meaningful at all.`,
    note: 'Arrives in radians per second and is converted by ×180/π. Peaks of ~2.3 rad/s would be nearly straight-line if read as deg/s, which contradicts the lateral g at the same moments.',
  },
  {
    name: 'speed', id: 8, channel: 'pcm.vnav.velocityBody.x', unit: 'm/s',
    what: 'Forward speed along the car’s own axis.',
    used: 'Everything. Distance is integrated from it, and the whole time-loss calculation is built on it.',
    note: 'Cross-checked against GPS-implied speed: medians agree to within 0.3%.',
  },
  {
    name: 'lateralVelocity', id: 9, channel: 'pcm.vnav.velocityBody.y', unit: 'm/s',
    what: 'Sideways speed of the car body — how fast it is moving crabwise.',
    used: 'With speed, gives the body slip angle: the "is it sliding?" test.',
    note: `About 4% of samples are INS dropouts giving absurd values. They are removed with a ${CONFIG.slipMedianWindow}-sample median filter, and any slip-based conclusion is additionally gated on the tyres being loaded.`,
  },
  {
    name: 'globalHeading', id: 11, channel: 'pcm.vnav.yawPitchRoll.yaw', unit: 'degrees',
    what: 'Compass direction the car is pointing.',
    used: 'The compass rose.',
    note: 'Arrives as ±180 and is folded to 0–360. Tracked unwrapped so the compass never spins the long way round at north.',
  },
  {
    name: 'latitude / longitude', id: '6 / 7', channel: 'pcm.vnav.posLla', unit: 'degrees',
    what: 'Position on Earth, 190 Hz, from the VectorNav’s fused GPS+INS solution.',
    used: 'Defining the start/finish line and drawing the track. NOT used to measure distance — that is integrated from speed, because GPS jitter accumulates into path length and inflates it differently on every lap.',
    note: 'Deliberately NOT smoothed — an extra 150 ms lag would drag every map point ~2 m behind the car.',
  },
  {
    name: 'throttle', id: 1, channel: 'pcm.pedals.accel', unit: '0–1',
    what: 'Accelerator pedal position.',
    used: 'The only positive evidence the engine will accept for "slow on the straight".',
    note: 'Without it, low grip usage flags good driving constantly: on this log the median throttle in low-grip corners is 63%, i.e. corner exit.',
  },
]

const DERIVED = [
  {
    name: 'Body-frame acceleration', formula: 'a_x = dv_x/dt − r·v_y     a_y = dv_y/dt + r·v_x', unit: 'm/s²',
    what: 'Acceleration in the car’s own frame. Because that frame is rotating, the derivative of a body velocity is not an acceleration on its own — the cross terms are what make it one.',
    used: 'Everything that reasons about grip, and the startup health check.',
    why: 'Not a refinement. Reconstructed lateral acceleration correlates r = +0.9891 with the measured accelerometer WITH the cross term and r = −0.9374 without it. Omitting it does not degrade the channel, it inverts it — every left-hander would read as a right-hander.',
  },
  {
    name: 'Derivatives', formula: `Savitzky–Golay, ${CONFIG.sgWindow}-sample window, order ${CONFIG.sgOrder}`, unit: 'varies',
    what: 'A least-squares polynomial is fitted over a sliding window and its analytic derivative evaluated at the centre, smoothing and differentiating in one pass.',
    used: 'Steering rate, longitudinal acceleration, path curvature.',
    why: 'A naive finite difference on this log produced ±35 m/s² — over 3 g, physically impossible for the car. The SG derivative gives p1/p99 of −6.6/+5.6, and widening the window from 31 to 201 samples moves p1 by only 0.26 m/s². That stability is the test that matters: it says the estimate has converged, not merely been smoothed until it looks calm.',
  },
  {
    name: 'The distance grid', formula: `one sample every ${CONFIG.gridSpacingM} m of track`, unit: 'metres',
    what: 'Every lap is resampled onto a shared distance axis before anything is compared.',
    used: 'All lap-to-lap comparison.',
    why: 'The single most important structural decision here. Two laps compared against elapsed TIME drift apart immediately and meaninglessly. Compared against distance travelled, the same index always refers to the same piece of tarmac, and the difference between them is exactly the thing worth measuring.',
  },
  {
    name: 'Time delta', formula: 'dt_rate(s) = 1/v_this(s) − 1/v_reference(s)', unit: 'seconds per metre',
    what: 'The rate at which this lap is gaining or losing time on the reference, at each metre of track. Its integral is the seconds lost so far.',
    used: 'The cost of every flag. Nothing else determines it.',
    why: 'Two properties make it the right quantity. It is LOCAL, so a loss can be attributed to a place. And its integral is EXACTLY the lap-time gap, so the flag costs are a real decomposition of the lap rather than loosely related estimates. Note the reciprocal: a plain speed difference is not proportional to time lost — being 1 m/s down at 8 m/s costs far more per metre than at 25 m/s.',
  },
  {
    name: 'Corner / straight split', formula: 'Otsu threshold on the curvature histogram', unit: 'm⁻¹',
    what: 'The track is split into corners and straights by thresholding path curvature — with the threshold chosen by Otsu’s method, the classical image-binarisation algorithm, rather than picked.',
    used: 'Deciding which rulebook a flag is judged by.',
    why: 'A fixed "radius under 45 m is a corner" encodes an opinion about what a corner is; Otsu asks the track. See the limits below — on a course this tight it is the weakest part of the engine.',
  },
  {
    name: 'Significance', formula: 'delta ÷ max(your own MAD here, sensor resolution)', unit: 'multiples of your own scatter',
    what: 'How unusual a difference is, measured in multiples of how much YOU normally vary at that place. One is a normal amount of variation; two is a real difference.',
    used: 'Every verdict below. This is what replaced every hard-coded threshold in the previous version of this dashboard.',
    why: 'Median absolute deviation rather than standard deviation, because a single incident lap would inflate a standard deviation enough to hide everything else. It self-adjusts: a driver who repeats a corner within 0.2 m/s has a much lower bar for "meaningfully slower" than one who varies by 2 m/s — and that is correct.',
  },
  {
    name: 'Two references', formula: 'theoretical best for cost · fastest clean lap for cause', unit: '—',
    what: 'Cost is measured against a composite assembled from your quickest version of each segment. Inputs are compared against the single fastest lap you actually drove.',
    used: 'The seconds, and the explanation, respectively.',
    why: 'Conflating them would be a category error. The composite is the right ceiling for timing because you have demonstrated every piece of it — but nobody ever drove it, so its steering trace belongs to no one and comparing your inputs against it would be comparing you to a driver who does not exist.',
  },
  {
    name: 'Confidence', formula: 'clamp((strongest |significance| − 2) ÷ 6, 0, 1)', unit: '0–1',
    what: 'How firmly a verdict is held.',
    used: 'Shown on every flag, so a marginal finding reads as marginal.',
    why: 'A flag sitting right at the 2-MAD bar reports 0.0 and is presented as tentative; one at 8 MAD reports 1.0. A coaching tool that states everything with equal certainty is asking to be ignored.',
  },
  {
    name: 'Handling balance', formula: 'commanded yaw rate − actual yaw rate', unit: 'deg/s',
    what: 'Understeer (positive) or oversteer (negative).',
    used: 'The Car Setup tab only. It is a setup diagnostic, not a coaching one.',
    why: 'Commanded yaw = steering × speed ÷ 6.99, that constant (wheelbase × steering ratio) fitted from this log at R² 0.93.',
  },
  {
    name: 'Corner load', formula: 'lateral weight transfer from AY', unit: '% per corner',
    what: 'Estimated suspension load at each wheel, on the Instruments tab.',
    used: 'Displayed only. No coaching decision uses it.',
    why: 'This log has no shock pot channels, so it is modelled from ONE number — lateral acceleration. The four corners carry one degree of freedom, not four. It is the AY bar drawn a second way, and it is labelled as an estimate on screen.',
  },
]

/** The seven things the engine is willing to say, and what each one requires. */
const VERDICTS = [
  {
    type: EVENT_TYPES.OVER_DRIVEN,
    evidence: 'exit speed down AND (more slip OR sharper steering)',
    reads: 'The exit is gone and the car was working harder than your best lap to get there — sliding rather than turning. This is the one that feels fast and is not.',
  },
  {
    type: EVENT_TYPES.UNDER_DRIVEN,
    evidence: 'exit speed down AND less grip used AND (lower minimum speed OR less slip)',
    reads: 'Slower and working the tyres less. Grip was left unused — and your own best lap proves the car will take it.',
  },
  {
    type: EVENT_TYPES.MID_CORNER,
    evidence: 'entry matched AND exit matched, but time went missing between them',
    reads: 'Points at the line rather than the speed carried.',
  },
  {
    type: EVENT_TYPES.SLOW_STRAIGHT,
    evidence: 'measurably less throttle, OR speed decayed while the reference held on',
    reads: 'On a straight the line is fixed and the tyres are nowhere near their limit, so the only available mistake is not using the car. This verdict therefore requires positive evidence of exactly that.',
  },
  {
    type: EVENT_TYPES.INHERITED,
    evidence: 'entry speed down AND more than 0.3 s already lost before this point',
    reads: 'The speed was already gone. Nothing to fix here — work on the flag before it. Checked first, because every other verdict would otherwise be describing a symptom.',
  },
  {
    type: EVENT_TYPES.INCIDENT,
    evidence: 'detected from the speed and yaw traces before the tree runs at all',
    reads: 'A spin, an excursion or a stop.',
  },
  {
    type: EVENT_TYPES.UNEXPLAINED,
    evidence: 'time was demonstrably lost, and NO input differs by more than two MAD',
    reads: 'The most important verdict here. A coaching tool that always produces a cause will produce a wrong one whenever the true cause lies outside its instrumentation — and the most common such cause is the racing line, which this sensor set cannot observe. "No clear cause, look at the line" is honest and actionable; a fabricated throttle instruction is neither.',
  },
]

export default function DataGuide() {
  return (
    <div className="guide">
      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">How this dashboard reads the car</h2>
          <span className="panel__unit">data guide</span>
        </header>

        <p className="guide__intro">
          Every 50 ms the server sends about 110 samples as three parallel arrays — a timestamp,
          a sensor ID, and a value. The widget picks out the channels below, averages the samples
          for each channel within the tick (a decimation that also cancels a lot of IMU noise),
          then applies a light exponential smoothing of α&nbsp;=&nbsp;{SMOOTHING_ALPHA}, about a
          150&nbsp;ms time constant, for the live instruments.
        </p>
        <p className="guide__intro">
          The coaching engine does not use that path. It keeps the raw stream, resamples every
          channel onto a uniform {CONFIG.sampleRateHz}&nbsp;Hz grid, and runs at the end of each
          completed lap — which is what lets it use a zero-phase filter that needs to see
          slightly into the future.
        </p>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">Measured — straight off a sensor</h2>
          <span className="panel__unit">{MEASURED.length} channels</span>
        </header>
        <div className="guide__grid">
          {MEASURED.map((row) => (
            <article key={row.name} className="guide__card guide__card--measured">
              <h3>{row.name}</h3>
              <p className="guide__meta">ID {row.id} · <code>{row.channel}</code> · {row.unit}</p>
              <p><strong>What it is:</strong> {row.what}</p>
              <p><strong>Used for:</strong> {row.used}</p>
              {row.note && <p className="guide__note">{row.note}</p>}
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">Derived — computed here</h2>
          <span className="panel__unit">only as good as the assumption behind it</span>
        </header>
        <div className="guide__grid">
          {DERIVED.map((row) => (
            <article key={row.name} className="guide__card guide__card--derived">
              <h3>{row.name}</h3>
              <p className="guide__meta"><code>{row.formula}</code> · {row.unit}</p>
              <p><strong>What it is:</strong> {row.what}</p>
              <p><strong>Used for:</strong> {row.used}</p>
              <p className="guide__note">{row.why}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">How a flag gets its verdict</h2>
          <span className="panel__unit">rank by seconds, then explain</span>
        </header>
        <p className="guide__intro">
          Cost is measured first, from speed and distance alone — no steering, no throttle, no
          grip. Only then are those channels consulted, and only to explain seconds that have
          already been measured. A flag with a compelling story but no time behind it is never
          emitted, and a flag may only be published at all if the seconds it claims exceed the
          scatter of your own segment times there.
        </p>
        <ol className="guide__rules">
          {VERDICTS.map(({ type, evidence, reads }) => (
            <li key={type}>
              <span className="guide__swatch" style={{ background: EVENT_INFO[type].color }} />
              <span>
                <strong style={{ color: EVENT_INFO[type].color }}>{EVENT_INFO[type].label}</strong>
                <code>{evidence}</code>
                <span>{reads}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="panel__note">
          Every flag also carries a distinct shape, so the map never relies on colour alone.
          Four chromatic colours are used because that is the practical ceiling under
          colour-vision deficiency — red against green failed at ΔE 4.1 under deuteranopia, and
          a fifth hue is not achievable. &ldquo;Arrived slow&rdquo; and &ldquo;no clear
          cause&rdquo; therefore take an achromatic grey, which is right anyway: neither is a
          mistake in its own right. An incident is separated by LUMINANCE, which no form of
          colour blindness affects.
        </p>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">What this dashboard cannot tell you</h2>
          <span className="panel__unit">limits, stated rather than hidden</span>
        </header>
        <ul className="guide__limits">
          <li><strong>Segmentation is coarse where the track is busiest — a known open defect.</strong> Otsu’s threshold assumes the curvature distribution has two clear populations; a tight autocross course does not have one. On the reference log it cuts at a 19.1 m radius and returns 7 corners and 7 straights over 993 m. The corner share is reasonable at 25%, but the boundaries are not: S1 alone spans 247 m — a quarter of the lap as one undifferentiated straight — while T1, T3 and T4 come out at 13, 12 and 10 m. A flag placed in S1 is far less spatially specific than it should be. The fix is to segment on lateral-acceleration DEMAND (v²/R against the measured grip limit) rather than raw geometry, so what counts as a corner depends on what the tyres are being asked to do. Not yet implemented.</li>
          <li><strong>Everything is relative to this driver, this session.</strong> The reference is assembled from your own quickest segments, so the time on offer is time you have already proved is there — not the car’s theoretical limit. A faster driver would move the whole reference.</li>
          <li><strong>The racing line is invisible.</strong> There is no channel for it, which is precisely why the engine has a verdict for &ldquo;time was lost and I cannot tell you why&rdquo;. On the reference session 11 of 52 flags land there. That number is a feature.</li>
          <li><strong>Sharp steering has no measured time cost.</strong> Tested by splitting each corner’s laps by peak steering rate: the smooth half carried 11.999 m/s minimum speed, the jerky half 12.161 — jerky was marginally FASTER, and only 5 of 13 corners showed it slower. It survives as part of the over-driven pattern, never as an independent penalty.</li>
          <li><strong>There are no shock pots in this log.</strong> The corner-load car view is modelled from lateral acceleration alone, so it adds no information the AY bar does not already carry.</li>
          <li><strong>The acceleration envelope is under-sampled.</strong> The braking cells hold 14 samples against the {CONFIG.envelopeMinCellSamples} required. It is therefore reported as a record of what the driver did, not an estimate of what the car can do, and is never used as a limit in a diagnosis.</li>
          <li><strong>The rear-right tyre temperature channels (IDs 38–53) are dead</strong> — a single zero sample each, against 16 working channels on the rear left. That is a broken sensor or loom, worth fixing on the car.</li>
          <li><strong>Segments are numbered by the order they appear</strong> on the reference lap, not by any official track map.</li>
          <li><strong>A flag will not bill for more than {CONFIG.maxFlagWindowM} m.</strong> A deficit that is never recovered is real time, but past that distance it is no longer safely attributable to one moment, so it is left unexplained rather than pinned on the wrong place.</li>
        </ul>
      </section>
    </div>
  )
}

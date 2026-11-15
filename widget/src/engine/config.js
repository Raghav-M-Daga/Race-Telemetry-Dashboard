/**
 * The ONLY constants in the engine.
 *
 * Every one of these is a signal-processing parameter — a sample rate, a filter
 * width, a bin count. None of them is a threshold on vehicle behaviour. Any
 * number that decides whether the driver did something well is derived at
 * runtime from the data: a percentile, a regression coefficient, a learned
 * optimum, or a comparison against this driver's own prior best.
 *
 * If a diagnostic value ever appears here, that is a design failure.
 */
export const CONFIG = {
  // --- resampling ---------------------------------------------------------
  /** Uniform analysis grid. 100 Hz is well above the ~10 Hz of real vehicle
   *  motion and matches the fastest channel (the VectorNav runs near 190 Hz). */
  sampleRateHz: 100,
  /** A channel not updated within this many grid steps is MISSING, not held.
   *  At 100 Hz this is 150 ms — longer than any channel's normal gap, short
   *  enough that a dropout is never silently interpolated across. */
  stalenessSteps: 15,

  // --- filtering ----------------------------------------------------------
  /**
   * Savitzky-Golay window for smoothing and for derivatives, in samples.
   *
   * Chosen empirically. A naive finite difference of velocity produced peaks
   * of +/-35 m/s2 — over 3 g, physically impossible. Swept against the log:
   * a 31-sample (0.31 s) cubic SG window brings a_x to p1/p99 of -6.6/+5.6
   * with a peak of 11.5 m/s2, and widening to 201 samples changes p1 by only
   * 0.26 m/s2, so the estimate is stable rather than merely smoothed flat.
   */
  sgWindow: 31,
  sgOrder: 3,
  /** Wider window for curvature, which feeds segmentation and must be stable
   *  lap to lap rather than responsive. */
  sgWindowCurvature: 101,

  /**
   * Median-filter width for the slip channel, in samples.
   *
   * velocityBody.y carries isolated INS dropouts reaching tens of degrees. At
   * 100 Hz, 9 samples is 90 ms — long enough to erase a spike, far shorter than
   * any real slide, which develops over tens of metres.
   */
  slipMedianWindow: 9,

  /**
   * Longest stretch a single flag may bill for, in metres.
   *
   * A deficit that is never recovered would otherwise let one flag charge for
   * the rest of the lap. Beyond this the loss is real but no longer safely
   * attributable to that one moment, so it is left unexplained rather than
   * pinned on the wrong place.
   */
  maxFlagWindowM: 220,

  // --- track --------------------------------------------------------------
  /** Distance-grid resolution for all lap comparison, in metres. */
  gridSpacingM: 1,
  /**
   * Start/finish line geometry. `lapLineGateM` is how far either side of the
   * reference point still counts as crossing the line; the result is
   * insensitive to it anywhere from 10 m to 25 m. `lapMinDistanceM` debounces a
   * car wobbling across the line — expressed as distance rather than time so it
   * carries no assumption about how long a lap takes. `lapHeadingBaselineM` is
   * how far the car must travel before its heading — and therefore the line's
   * orientation — is trustworthy.
   */
  lapLineGateM: 20,
  lapMinDistanceM: 200,
  lapHeadingBaselineM: 4,
  /** Search span for cross-correlation drift alignment between laps, in grid
   *  steps either way. */
  driftAlignSpanM: 12,

  // --- segmentation -------------------------------------------------------
  /** Histogram bins for the Otsu split of the curvature distribution. */
  curvatureHistogramBins: 128,
  /** Hysteresis band around the Otsu threshold, as a fraction of it, so a
   *  sample hovering at the boundary does not chatter between states. */
  curvatureHysteresis: 0.25,
  /**
   * Shortest run that may stand as its own segment, in metres. Two values,
   * because the two types fail differently.
   *
   * A short STRAIGHT between two corners is usually a brief straightening in
   * the middle of one corner, and splitting there gives three segments on one
   * lap and one on the next — so it is absorbed and the corners merge.
   *
   * A short CORNER is a real corner. An earlier single limit of 15 m applied to
   * both, with a merge rule that took the longer neighbour's type, DELETED
   * every corner under 15 m by turning it into straight: this course has ~9
   * corners per lap and only 3 survived.
   *
   * These are resolution parameters, not judgements about driving.
   */
  minCornerLengthM: 8,
  minStraightLengthM: 15,

  // --- envelope -----------------------------------------------------------
  speedBins: 8,
  directionBins: 32,
  /**
   * Percentile of |a| taken as the envelope in each cell.
   *
   * The maximum is unusable — it is a kerb strike or an IMU spike. The 95th is
   * high enough to represent genuine capability while discarding the outlier
   * tail, and is the value a race engineer would reach for. Exposed here
   * precisely so it can be argued with.
   */
  envelopePercentile: 0.95,
  /** A cell below this many samples is a record of what the driver happened to
   *  do, not a capability estimate, and may not drive a suggestion. */
  envelopeMinCellSamples: 40,

  // --- lap validity -------------------------------------------------------
  /** Clean-lap band: median lap time plus this many MADs. Robust to the two
   *  or three ruined laps a session usually contains. */
  lapTimeMadMultiplier: 3,
  /** A lap containing a dwell below this fraction of its own median speed,
   *  for longer than the dwell time, is traffic-affected or an excursion. */
  dwellSpeedFraction: 0.35,
  dwellSecondsMax: 2.0,

  // --- health checks ------------------------------------------------------
  /** Below this correlation between derived a_y and the measured lateral
   *  accelerometer, the frame convention is wrong and the engine must fail
   *  loudly rather than produce confident nonsense. */
  minKinematicCorrelation: 0.9,
}

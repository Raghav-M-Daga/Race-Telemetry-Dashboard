/**
 * Single place to tune everything about the dashboard.
 * Change SERVER_PORT here and the whole app follows.
 */

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export const SERVER_HOST = 'localhost'
export const SERVER_PORT = 8081

// The PER replay server streams over Server-Sent Events (`GET /stream`), not a
// raw WebSocket, so the URL scheme is http:// and the client is `EventSource`.
// See README "Transport" for why.
export const SERVER_ENDPOINT = `http://${SERVER_HOST}:${SERVER_PORT}/stream`

// The server emits a tick every 50 ms, but pauses ~10 s when the replay loops
// back to the start. Anything past this without a tick is shown as "awaiting
// data" rather than a hard disconnect, so a normal loop restart doesn't panic.
export const STALE_AFTER_MS = 2500

// ---------------------------------------------------------------------------
// Sensor IDs (from the challenge README's sensor table)
// ---------------------------------------------------------------------------

export const SENSOR_IDS = {
  // ludwig.steeringWheel.angle — degrees, negative = left, positive = right
  steeringAngle: 21,
  // pcm.vnav.compensatedAccel.y — lateral acceleration (AY) in m/s^2
  lateralAcceleration: 10,
  // pcm.vnav.compensatedAngularRate.z — yaw rate, RADIANS/s on the wire
  yawRate: 12,
  // pcm.vnav.yawPitchRoll.yaw — heading in degrees, arrives as -180..+180
  globalHeading: 11,
  // pcm.vnav.velocityBody.x — forward speed in m/s. Needed by the handling
  // model: the reference yaw rate a steering angle commands scales with speed.
  speed: 8,
  // pcm.vnav.velocityBody.y — lateral (sideways) speed in m/s. With speed above
  // this gives the body slip angle: how far the car is travelling sideways
  // relative to where it is pointing. That is "slip" in the literal sense.
  lateralVelocity: 9,
  // pcm.vnav.posLla.latitude / .longitude — position, for the track map.
  latitude: 6,
  longitude: 7,
  // pcm.pedals.accel — throttle, 0..1. Separates "coasting" from "already flat
  // out on corner exit", which look identical if you only watch grip usage.
  throttle: 1,
}

/**
 * Fields that must NOT be exponentially smoothed.
 *
 * Position is smoothed by the VectorNav's own INS already; an extra 150 ms EMA
 * would drag every map point ~2 m behind the car at racing speed, which is
 * enough to smear a hotspot across the track. Heading is excluded for a
 * different reason — see the hook: averaging across the 0/360 seam is nonsense.
 */
export const UNSMOOTHED_FIELDS = new Set(['latitude', 'longitude'])

/**
 * Shock pot / corner-load channels.
 *
 * `data_replay.h5` has no shock pod channels (IDs 0-53 are wheel speed, pedals,
 * thermals, VectorNav, pack telemetry, steering and tire temps only), so these
 * are null and CarView falls back to the modelled corner loads in lib/vehicle.js.
 * Drop the real IDs in here and the fallback switches itself off — no other
 * change needed.
 */
export const SHOCK_SENSOR_IDS = {
  shock_fl: null,
  shock_fr: null,
  shock_rl: null,
  shock_rr: null,
}

// ---------------------------------------------------------------------------
// Display scales
// ---------------------------------------------------------------------------

// Steering gauge sweeps -STEERING_RANGE_DEG .. +STEERING_RANGE_DEG.
// The logged data only reaches about +/-88 deg, so the needle uses roughly half
// the dial; drop this to 90 for a punchier sweep on this particular replay.
export const STEERING_RANGE_DEG = 180

// AY bar saturates here. Logged data sits inside +/-16 m/s^2 for 98% of samples.
export const LATERAL_ACCEL_FULL_SCALE = 20

// Yaw rate colour thresholds, in deg/s (after the rad/s -> deg/s conversion).
export const YAW_RATE_MODERATE_DEG_S = 30
export const YAW_RATE_HIGH_DEG_S = 60
export const YAW_RATE_FULL_SCALE_DEG_S = 120

// ---------------------------------------------------------------------------
// Handling balance (understeer / oversteer)
// ---------------------------------------------------------------------------

/**
 * Steering wheel zero offset, in degrees, subtracted before the handling maths.
 *
 * Two independent checks on this log agree the sensor zero is off:
 *   - regressing steering against yaw rate over 8,107 steady-state cornering
 *     samples puts the intercept at +1.24 deg;
 *   - over 1,948 samples where the car is provably straight (>10 m/s, yaw rate
 *     under 0.02 rad/s, |AY| under 0.5), the wheel still reads +3.07 deg median.
 *
 * Left uncorrected this alone fakes an 11.7 deg/s left-vs-right balance split.
 * Applied only to the handling model — the steering gauge still shows the raw
 * sensor, because that is genuinely what the car is reporting.
 */
export const STEERING_ZERO_OFFSET_DEG = 1.24

/**
 * Combined wheelbase x steering ratio (L * SR), in metres, for the reference
 * yaw rate: r_ref = steer_rad * speed / YAW_GAIN_LSR_M.
 *
 * Fitted from the log rather than assumed, so no separate wheelbase or steering
 * ratio guess is needed — only their product matters here. The bicycle-model fit
 * gives 6.99 m (R^2 = 0.93), stable at 6.99-7.13 across steady-state gates, and
 * reproduces actual yaw rate at r = 0.96 in corners. For reference, that implies
 * roughly a 4.6:1 steering ratio on a 1.53 m wheelbase.
 */
export const YAW_GAIN_LSR_M = 6.99

/**
 * Wheelbase, in metres — a DISPLAY-ONLY assumption.
 *
 * The handling model needs only the product (wheelbase x steering ratio), which
 * is fitted above. Splitting it is required for exactly one thing: drawing the
 * front wheels at a believable angle on the car model. A typical FSAE car is
 * around 1.53 m, which makes the steering ratio about 4.6:1. Nothing numeric
 * depends on this being exactly right.
 */
export const ASSUMED_WHEELBASE_M = 1.53
export const STEERING_RATIO = YAW_GAIN_LSR_M / ASSUMED_WHEELBASE_M

// Balance is only meaningful when the car is actually cornering at speed;
// outside this the panel reads "not cornering" rather than inventing a number.
export const BALANCE_MIN_SPEED_MS = 8
export const BALANCE_MIN_AY = 2

// Deadband, in deg/s, inside which the car is called neutral.
export const BALANCE_NEUTRAL_DEG_S = 5
// Full-scale deflection of the balance meter, in deg/s.
export const BALANCE_FULL_SCALE_DEG_S = 25

// |AY| bands the handling signature is accumulated into, in m/s^2. These are the
// bins the offline analysis used, where the understeer-to-oversteer crossover
// showed up between the first and second band.
export const AY_BINS = [
  { label: '2-5', min: 2, max: 5 },
  { label: '5-8', min: 5, max: 8 },
  { label: '8-11', min: 8, max: 11 },
  { label: '11-14', min: 11, max: 14 },
  { label: '14+', min: 14, max: Infinity },
]

/**
 * Steady-state gate for the signature, in deg/s^2 of yaw acceleration.
 *
 * The balance model is a STEADY-STATE model: it compares the yaw rate a
 * steering angle commands with the yaw rate the car settles at. During turn-in
 * and corner exit the car is still building yaw, so it legitimately lags the
 * steering and reads as false understeer/oversteer. The offline analysis gated
 * these out at |d(yaw rate)/dt| < 0.15 rad/s^2; without the same gate the live
 * signature exaggerated the top band to -16 deg/s against -7 offline.
 */
export const STEADY_STATE_MAX_YAW_ACCEL_DEG_S2 = 0.15 * (180 / Math.PI)

// Samples retained per bin for the running median (bounded, so memory is flat).
export const SIGNATURE_WINDOW = 600
// The signature is a slow aggregate; recomputing it at the 20 Hz tick rate is
// wasted work, so the chart refreshes on this interval instead.
export const SIGNATURE_REFRESH_MS = 500

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

// The VectorNav channels are noisy at 190 Hz; without smoothing the bars strobe.
// Exponential moving average weight applied per tick (20 ticks/s):
// alpha 0.3 => ~150 ms time constant. 1.0 disables smoothing entirely.
export const SMOOTHING_ALPHA = 0.3

// ---------------------------------------------------------------------------
// Track map
// ---------------------------------------------------------------------------

// Track map spatial grid, in metres. The map aggregates into square cells
// rather than storing every point: memory stays flat however long the session
// runs, and repeated laps stack into the same cells.
export const TRACK_CELL_SIZE_M = 5

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const COLORS = {
  background: '#08090b',
  panel: '#101216',
  panelEdge: '#1e222b',
  text: '#f2f4f8',
  textDim: '#7a828f',
  pennRed: '#990000',
  pennRedBright: '#d81212',
  electricBlue: '#2ea8ff',
  amber: '#f5a623',
  green: '#31d07a',

  // Diverging pair for handling balance. Deliberately not blue or amber — those
  // already mean "left" and "right" elsewhere on this dashboard. Validated on
  // the panel surface (#101216): CVD separation dE 26.0 deutan, 27.0 normal
  // vision, both inside the lightness band and above the contrast floor.
  understeer: '#9085e9',
  oversteer: '#d95926',
  neutralBalance: '#7a828f',
}

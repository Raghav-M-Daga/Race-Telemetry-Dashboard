# PER Vehicle Dynamics Dashboard

A single-page React widget that visualises the **vehicle dynamics & handling** system of the
Penn Electric Racing car, fusing steering, lateral acceleration, yaw rate, corner load and
global heading into one pit-wall view - then uses the disagreement between those channels to
measure **understeer and oversteer**, and puts the result on a **GPS track map** that shows
where the driver pushed too hard, steered too sharply, or left time on the table.

Four views, with driver coaching as the landing page: **Driver Coaching** (the track map plus a
live car model), **Instruments** (the gauges), **Car Setup** (understeer/oversteer analysis),
**Data Guide** (what every number means and where it comes from).

It connects to the PER replay server (`server/` in this repository) and updates 20× per second.

```
┌─────────────────────────────────────────────────────────────┐
│  PER Vehicle Dynamics Dashboard      [compass]      ● Live   │
├───────────────┬─────────────────────┬───────────────────────┤
│ Steering      │   Top-down car      │   AY (m/s²)           │
│ angle gauge   │   + corner loads    │   bi-directional bar  │
├───────────────┼─────────────────────┴───────────────────────┤
│ Handling      │  Handling signature — balance by load band   │
│ balance meter │  +5.7  0.0  -0.8  -1.4  -7.3                 │
│ UNDERSTEER    │  "trends toward oversteer as load builds"    │
├───────────────┴─────────────────────────────────────────────┤
│  Yaw Rate    ──────────●──────────      +12.4    STABLE     │
└─────────────────────────────────────────────────────────────┘

  Track & Coaching view
┌─────────────────────────────────────────────────────────────┐
│ ● Sliding  ● Jerky  ● Coasting  ● At the limit  ● Working    │
├──────────────────────────────┬──────────────────────────────┤
│        ╭──────╮              │  Top problem areas           │
│      ╭─╯  ②   ╰─╮            │  ① Sliding — past the grip   │
│     ╱   ●●●     ╲            │     limit, fired 14×         │
│    │  ①●    ●③   │           │  ② Jerky steering — 210°/s   │
│     ╲           ╱            │  ③ Coasting — 31% grip,      │
│      ╰─────────╯   ├─ 50 m   │     +2.4 m/s available       │
└──────────────────────────────┴──────────────────────────────┘
```

---

## Setup

Everything runs on `localhost`. **Start the Python server first, then the widget.**

### 1. Start the PER server

From the repository root (the folder containing `server/` and `widget/`):

```shell
# Create and activate the virtual environment (first time only)
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

# Install Python dependencies (first time only)
pip install -r requirements.txt

# Run the server — leave this terminal open
uvicorn server.server:app --host 0.0.0.0 --port 8081
```

The server loads `data_replay.h5` and streams a tick every 50 ms. When it reaches the end of
the log it pauses ~10 s and loops.

### 2. Start the widget

In a **second terminal**:

```shell
cd widget
npm install
npm run dev
```

Open the `http://localhost:5173` link Vite prints. You should see the needles and bars moving
within a second or two.

`npm run build` produces a static bundle in `dist/`, and `npm run preview` serves it.

### Changing the port

The server port lives in one place — [`src/config.js`](src/config.js):

```js
export const SERVER_HOST = 'localhost'
export const SERVER_PORT = 8081
```

Change `SERVER_PORT` to match whatever `--port` you passed to `uvicorn` and the whole app
follows.

---

## Transport: SSE, not WebSocket

The PER server exposes **Server-Sent Events** at `GET /stream` — there is no WebSocket
endpoint in `server/server.py`. This widget therefore uses the browser's built-in
`EventSource` against `http://localhost:8081/stream` rather than `ws://localhost:8081`.

The two are a close match for this job: one long-lived connection, server pushes only, and
`EventSource` reconnects automatically after an outage. The connection lives in a single hook,
[`src/hooks/useCarData.js`](src/hooks/useCarData.js), so swapping in a real WebSocket later
means changing that one file.

---

## Data mapping

Each tick is a JSON object of three parallel arrays — `ts` (µs), `id` (sensor), `v` (value).
The widget picks out nine channels:

| Dashboard field | Sensor ID | Channel | On the wire | Displayed as |
|---|---|---|---|---|
| `steeringAngle` | 21 | `ludwig.steeringWheel.angle` | deg, −/+ | deg (− left, + right) |
| `lateralAcceleration` | 10 | `pcm.vnav.compensatedAccel.y` | m/s² | m/s² (+ g readout) |
| `yawRate` | 12 | `pcm.vnav.compensatedAngularRate.z` | **rad/s** | **deg/s** (×180/π) |
| `globalHeading` | 11 | `pcm.vnav.yawPitchRoll.yaw` | deg, **−180…+180** | deg, **0…360** |
| `speed` | 8 | `pcm.vnav.velocityBody.x` | m/s | handling model, corner radius |
| `lateralVelocity` | 9 | `pcm.vnav.velocityBody.y` | m/s | body slip angle (the "is it sliding?" test) |
| `latitude` / `longitude` | 6 / 7 | `pcm.vnav.posLla` | degrees | the track map |
| `throttle` | 1 | `pcm.pedals.accel` | 0-1 | separates coasting from corner exit |
| `shock_fl/fr/rl/rr` | — | *not present in this log* | — | modelled, see below |

### Three things that differ from the raw stream

**1. Yaw rate arrives in radians per second.** The `compensatedAngularRate.z` channel peaks at
about ±2.3 in the log. Read as deg/s that would be a car travelling in essentially a straight
line, which contradicts the ±16 m/s² of lateral acceleration recorded at the same moments — and
the two channels correlate at **+0.96**, so they are describing the same corners. Read as rad/s
it becomes ±135 deg/s, a believable FSAE yaw rate. The widget converts to deg/s, which also puts
the 60 deg/s "high" threshold in a sensible place.

**2. Heading arrives as ±180.** `yawPitchRoll.yaw` is signed; the compass wants a 0–360 bearing,
so the negative half is folded over.

**3. There are no shock pod channels.** IDs 0–53 cover wheel speed, pedals, thermals, the
VectorNav, pack telemetry, steering and tyre temperatures — no suspension travel. Rather than
leave the car view dead, it shows the thing shock pots would reveal: **lateral weight transfer**,
modelled from AY in [`src/lib/vehicle.js`](src/lib/vehicle.js).

- Each corner sits at 50% static load.
- Load transfers linearly with AY, up to ±42% at full scale.
- The front axle takes 55% of the transfer (a roll-stiffness split), so the axles differ.
- Sign convention, confirmed against the log: **positive AY = right-hand turn = load onto the
  left tyres.** Steering and AY correlate at +0.78, steering and yaw rate at +0.87, so the
  polarities agree.

The panel is labelled `modelled %` and carries a footnote so this is never mistaken for
measured data. If real shock pots ever appear on the stream, add their IDs to
`SHOCK_SENSOR_IDS` in `src/config.js` — the app detects them, uses them, and drops the model
and the footnote automatically. No other change needed.

Longitudinal transfer (dive under braking, squat under power) is deliberately **not** modelled:
there is no AX channel, and differentiating `velocityBody.x` gives ±35 m/s² of noise even after
smoothing — over 3 g, which is not real.

---

## Handling balance: the useful part

Steering angle, lateral acceleration and yaw rate are three descriptions of the same corner.
When they disagree, the disagreement has a name - **understeer** or **oversteer** - and it is
the most actionable thing in the log. Two relationships tie them together.

### 1. The kinematic check (no vehicle parameters)

A car in steady-state cornering satisfies `a_y = r * v_x` - lateral acceleration equals yaw
rate times forward speed. On this log that holds at **r = 0.973, slope 0.962**, which is a
strong independent confirmation that yaw rate really is radians/s.

What is left over, `a_y - r*v_x`, is the rate the car is building or shedding sideslip. It
correlates at **0.89** with the measured `d(sideslip)/dt` from `velocityBody.y`, so it is
genuinely the "it's letting go" term and not just noise.

### 2. The bicycle model (one fitted constant)

`r_ref = steer * V / (L * SR)` gives the yaw rate a steering angle *commands* at a given speed.
Comparing that with measured yaw rate is the balance:

```
balance = r_ref - r_actual
balance > 0  ->  turning LESS than commanded  ->  understeer
balance < 0  ->  turning MORE than commanded  ->  oversteer
```

Only the **product** `L * SR` matters, so no separate wheelbase or steering-ratio guess is
needed - it is fitted from the log at **6.99 m** (R-squared 0.93), stable at 6.99-7.13 across
different steady-state gates, and it reproduces measured yaw rate at **r = 0.96** in corners.
For scale, that implies roughly a 4.6:1 steering ratio on a 1.53 m wheelbase.

### What the log actually says

**The steering sensor zero is off.** Two independent checks agree:

- regressing steering against yaw rate over 8,107 steady-state cornering samples puts the
  intercept at **+1.24 deg**;
- over 1,948 samples where the car is *provably* straight (>10 m/s, yaw rate under 0.02 rad/s,
  lateral acceleration under 0.5), the wheel still reads **+3.07 deg** median.

Left uncorrected this alone manufactures an **11.7 deg/s left-versus-right balance split** -
the car would look like it understeers in right-handers and oversteers in left-handers when it
does nothing of the sort. Correcting it halves the split to 6.1 deg/s. `STEERING_ZERO_OFFSET_DEG`
in `config.js` applies the correction to the handling model only; the steering gauge still shows
the raw sensor, because that is genuinely what the car is reporting. **Worth checking on the
real car** - this is a calibration finding, not a driving one.

**The car trends from understeer toward oversteer as lateral load builds.** Median balance by
lateral-load band, after the zero correction, on steady-state cornering only:

| abs(AY) band (m/s2) | 2-5 | 5-8 | 8-11 | 11-14 | 14+ |
|---|---|---|---|---|---|
| median balance (deg/s) | **+5.7** | 0.0 | -0.8 | -1.4 | **-7.3** |

Positive is understeer. The car is mildly stable at low load and goes progressively loose as
lateral load builds. This is a genuine setup characteristic, not noise: the trend survives three
independent steady-state gates (with `L*SR` refitted on each subset, so it cannot be an artefact
of one global fit), and the top band's interquartile range is entirely negative.

**This is what the Handling Signature panel plots, live.**

### Why the steady-state gate matters

The balance model is a *steady-state* model. During turn-in and corner exit the car is still
building yaw, so it legitimately lags the steering and reads as understeer that is not there.
The signature therefore only accumulates samples where the yaw acceleration is under
0.15 rad/s2, matching the offline analysis. That rejects about 83% of cornering samples - the
panel shows the running count so you can see it working. Without the gate the top band
exaggerated to -16 deg/s against -7; with it, the live model reproduces the offline medians
closely (+5.9 vs +5.7, -0.7 vs -0.8).

### Honest limits

- **`L * SR` is fitted from this log.** On a different car, or after a steering-rack change,
  refit it. It is one constant in `config.js`.
- **A band needs n >= 40** before it draws a bar. The 14+ band fills slowly - it is a small
  fraction of any lap - so give it time or it stays empty.
- **The residual 6.1 deg/s left/right split** after zero correction is not explained. It could
  be a remaining offset, genuine car asymmetry, or simply that the track's left and right
  corners are taken at different speeds. Worth a look before reading too much into it.
- **The understeer gradient itself is small** (about -0.2 deg/g from the full regression) and
  its sign is within noise. The *trend across load bands* is the robust finding, not the single
  gradient number.

---

## Track map and driver coaching

The **Track & Coaching** view draws the circuit from GPS and colours every part of it by the
most serious thing that happened there.

### Where the map comes from

`pcm.vnav.posLla` gives latitude and longitude at 190 Hz from the VectorNav's fused GPS+INS
solution — 146,000 fixes with no dropouts, and the speed implied by consecutive fixes agrees
with `velocityBody.x` to within 0.3%. (The log is from Michigan, and the trace covers about
150 x 458 m over 11 km of running: an FSAE endurance run of roughly 11 laps.)

Degrees are useless for drawing, because a degree of longitude is a different number of metres
at every latitude — plotting lon/lat directly squashes the track sideways. So positions are
projected to metres east/north about the first fix, with the longitude scale multiplied by
cos(latitude). Over a few hundred metres the flat-Earth error is millimetres, far below GPS
noise. The map preserves aspect ratio, which is not cosmetic: stretching 150 x 458 m to fill a
wide panel would make a hairpin look like a sweeper.

Position is the one channel deliberately **not** smoothed. The INS has already filtered it, and
another 150 ms of lag would drag every map point about 2 m behind the car — enough to smear a
hotspot across the track.

### How a point gets its colour

Each sample is tested in this order, and the **first match wins**, so the map shows the most
serious thing happening at a point:

| Colour | Category | Fires when | Meaning |
|---|---|---|---|
| red | **Sliding** | \|slip angle\| > 4° **and** grip use > 60% | Past the grip limit and moving sideways. |
| yellow | **Jerky steering** | \|steering rate\| > 135 °/s | The wheel moved faster than the tyres can respond to. |
| blue | **Coasting** | grip use < 50% **and** radius < 40 m **and** throttle < 20% | Tight corner, little grip used, off the power. Time is being left here. |
| aqua | **At the limit** | grip use ≥ 85% | Using most of the available grip, smoothly. This is the target. |
| grey | Working | anything else while cornering | Nothing to flag. |

Nothing is judged below 8 m/s or under 8.6 °/s of yaw rate: **a straight line at low lateral g
is correct driving, not a mistake.**

The four category colours were validated as a set on both surfaces the map uses — worst-pair
separation ΔE 9.9 under deuteranopia, 16.9 for normal vision. Red-and-green was the obvious
choice for good/bad and it **failed at ΔE 4.1**, which is why the "good" end is aqua. Marker
size also grows with how often a flag fired, so the map still reads in greyscale.

### The three judgements, and why each one is honest

**"Sliding" uses measured sideslip, not a model.** Body slip angle is `atan2(lateralVelocity,
speed)` — the angle between where the car is *pointing* and where it is actually *going*, from
two real IMU channels. A few degrees is normal and necessary, because tyres must deform to
generate grip at all; past 4° (just beyond the log's own 95th percentile) the car is genuinely
travelling sideways.

**"Jerky" is a rate, not a position.** `d(steeringAngle)/dt`, thresholded at 135 °/s — the 95th
percentile of this log's own distribution (p90 = 100, p99 = 196). Frequent enough to be useful,
rare enough to mean something.

**"Coasting" is the one that needed real care.** The naive test — low lateral g in a corner —
flags 39% of all cornering, which is nonsense. The reason is the friction circle: when a car is
using all its grip laterally, there is none left for acceleration, so **at the limit the driver
is off the throttle**. The data says exactly that: median throttle is **23% in high-grip
corners** and **63% in low-grip corners**. Low grip usually means a car accelerating off a
corner, which is correct driving.

So coasting requires all three: low grip use, a genuinely tight corner (under 40 m radius), and
the driver off the power. That fires on **6.8%** of tight-corner samples instead of 39% — rare
enough to be worth looking at.

### The car model: where it's pointed vs. where it's going

Beside the map is a live top-down car projecting **two arcs the same distance ahead**:

- **dashed blue** — the path the steering is asking for, from the fitted bicycle model
- **solid, coloured by the current verdict** — the path the car is actually taking, from yaw
  rate and speed

When they overlap, the car is doing what it is told. When the actual arc bows *wider* than the
commanded one, the car is understeering — running wide of the line the driver asked for.
Tighter, and it is oversteering. Both are drawn over the same distance, so the gap between them
is purely the difference in curvature.

This is deliberately built on the **bicycle model** (fitted at R² 0.93, reproducing measured yaw
at r = 0.96) rather than on the body-slip channel, which is noisy enough to need a grip gate
before it can be trusted at all. On this log the median actual radius is 23.4 m against 25.0 m
commanded, with a 90th-percentile gap of 17.8 deg/s — a visible difference to draw.

The front wheels are drawn at `steeringAngle ÷ steering ratio`. Splitting the fitted `L × SR`
into a wheelbase and a ratio is needed for *only* this drawing; nothing numeric depends on it.

### Exactly what goes into "jerky" and "sliding"

These are the two flags that judge technique, so it is worth being precise about
what each one can and cannot see.

**Jerky steering — one channel and a clock.**

```
steeringRate = (steeringAngle_now - steeringAngle_previous) / dt
flag when |steeringRate| > 135 deg/s
```

- Input: `ludwig.steeringWheel.angle` (ID 21) only. Not speed, not lateral g, not yaw.
- It is differentiated from the **smoothed** angle (EMA, alpha 0.3), so sensor noise is not
  read as violent steering.
- `dt` is guarded to 5-1000 ms. A stalled or duplicated tick would otherwise divide by nearly
  zero and manufacture a spike that looks like a huge steering input.
- The 135 deg/s threshold is the **95th percentile of this log's own distribution**
  (p90 = 100, p95 = 135, p99 = 196, max 782). Nothing about it is a guess.
- What it measures is *rate*, not *position*: half a turn of lock applied smoothly does not
  flag, and a small stab does.

**Sliding — two channels, plus a grip gate.**

```
slipAngle = atan2(lateralVelocity, speed)          both from the VectorNav
gripUse   = |lateralAcceleration| / gripLimit
flag when |slipAngle| > 4 deg  AND  gripUse > 60%
```

- Inputs: `velocityBody.y` (ID 9) over `velocityBody.x` (ID 8) for the angle, and
  `compensatedAccel.y` (ID 10) for the gate. **The steering angle is deliberately not
  involved** — this measures what the car did, not what the driver asked for.
- Slip angle is the angle between where the car is *pointing* and where it is actually
  *travelling*. A few degrees is normal and necessary: tyres must deform to generate grip.
- The 4 degree threshold sits just past this log's 95th percentile (p90 = 2.54, p95 = 3.68,
  p99 = 12.24).
- The grip gate is doing real work. See below.

### Why "sliding" needed a grip gate

The first version flagged on slip angle alone and was wrong often enough to matter. Of the
samples on this log with more than 4 degrees of slip, **27% happened at under 30% grip usage** —
and a car using a third of its grip is not sliding. Those are INS dropouts in `velocityBody.y`,
which has a known ~4% bad tail.

The physics says slip should scale with how hard the tyres are working, and the data agrees:
median |slip| is **1.92 deg above 85% grip** against **0.38 deg below 30%**. So sliding now
requires both a big slip angle *and* grip usage over 60%. That cut the flag from 5.44% of moving
time to 2.94%, and what is left is far more likely to be the car actually letting go.

### Lap detection and the lap menu

Laps are detected by **start/finish line crossing**, the method real timing systems use. With a
reference point `p0` and the unit heading `h` the car had there:

```
s = (p - p0) · h    distance along the direction of travel
L = (p - p0) · n    lateral offset from the line centre   (n perpendicular to h)
```

A lap closes when `s` crosses zero upward — the car has just passed through the plane of the
line, travelling the way it was at the start. `L` is gated to ±20 m so crossing that infinite
plane elsewhere on the circuit does not count, and a 20 s debounce stops a wobble over the line
racking up laps.

The line is placed on the car's first genuinely flying moment (over 10 m/s, after 4 m of travel
so the heading is trustworthy), which is why the first lap always takes a full circuit.

**The obvious alternative does not work.** Counting a lap whenever the car came within N metres
of its start point was tried first: it missed crossings whenever the line varied, merging pairs
of laps into single 136 s and 143 s "laps". Line crossing found **10 clean laps** on the same
log, every one between 993 m and 1006 m — within 1.3% of each other, so each really is a full
lap — running 64.4 s to 75.9 s. The result is identical for gate widths anywhere from 10 m to
25 m, which is what a robust detector looks like.

The lap menu beside the map lists every completed lap with its time, the fastest one marked, a
four-column sparkline of how that lap's cornering time was spent, and average speed. Selecting a
lap redraws the map with **that lap's own verdicts**; "All laps" uses the most recent lap for the
shape but colours it from the session-wide aggregate.

### How the map is drawn

Two structures are kept, for two different jobs.

**A 5 m cell grid**, aggregated across the session. Storing every sample would grow without
bound and draw ~15,000 SVG nodes; a grid is bounded by the size of the track, not the length of
the session.

The more useful consequence is that **repeated laps land in the same cells**. A corner the
driver gets wrong every lap accumulates far more evidence than a one-off mistake. Hotspots are
ranked by severity first, then by how often the flag fired.

**An ordered path per lap**, decimated to one point every 2 m. A grid has no traversal order, so
it can only ever be drawn as dots — the path is what makes a continuous line possible. It is
decimated by *distance* rather than time on purpose: time-based sampling crowds points wherever
the car is slow, which is exactly the tight corners where the line matters most.

The line is drawn as one polyline per run of consecutive same-category points, with runs
overlapping by a point so there is no gap where the colour changes, over a dark "road" polyline
that keeps the circuit readable where nothing is flagged. A light moving average smooths GPS
jitter, with the two endpoints pinned so a lap still starts and finishes exactly where the car
did.

Problem markers are **pinned out to the side** with a leader line back to the exact spot, then
pushed apart by a short relaxation pass. Sitting them on the track hid the very line they were
pointing at, on a course this tight.

### The grip limit is learned, not assumed

"Grip utilisation" is `|AY| ÷ grip limit`, and that denominator starts at 15.03 m/s² — the 99th
percentile of |AY| over the whole log, 1.53 g. The p99 rather than the max, because the max
(23.7) is a kerb strike or an IMU spike, not a sustainable cornering limit.

Once 600 cornering samples have been seen the widget **re-derives the limit from the live
data**, so "using 90% of grip" means 90% of what *this* car has actually demonstrated on *this*
surface — not 90% of a number hard-coded by me. The header shows whether the figure is still
the seed or has been learned. The circular limitation is worth stating: if the driver never
reaches the real limit, the limit looks lower and less gets flagged.

### "Speed available"

For a coasting cell the detail panel estimates how much faster the corner could have been
taken, from `v = √(a·R)` — the maximum speed on a circle of radius R at lateral acceleration a,
where R comes from `speed ÷ yawRate`. It assumes the driver holds the **same line**, which is
why it is a coaching hint rather than a lap-time prediction: a quicker driver would usually take
a different, wider line entirely.

### What it cannot tell you

- **No longitudinal channel exists.** Differentiating speed gives over 3 g of noise, which is
  not real, so braking and traction limits are invisible. All coaching here is about the
  **lateral** axis only — a driver braking far too early will not be flagged.
- **Nothing knows the track layout.** No racing line, no corner numbers, no reference lap.
  Hotspots are locations, not turns.
- **No lap splitting.** Simple start/finish proximity detection missed crossings on this log
  (merging pairs of laps into 136 s and 143 s "laps"), so rather than ship something fragile the
  map accumulates across the whole session. Lap-relative comparison would be the natural next
  step, and needs a proper start/finish *line* crossing test.

### Two sensor findings worth taking to the team

- **The rear-right tyre temperature channels (IDs 38-53) are dead.** One zero sample each,
  against 16 working channels on the rear left that show a clean tread profile (36 °C at the
  edge rising to 76 °C in the middle, peaking at 113 °C). That is a broken sensor or loom.
- **The steering sensor zero is off** by 1.24-3.07° — see the handling section above.

---

## Running the tests

Two suites. The unit suite needs nothing; the live suite talks to the real server.

```shell
cd widget

npm test          # unit tests, then live tests if the server is reachable
npm run test:unit # unit tests only — never needs the server
npm run test:live # live tests only — requires the PER server on :8081
```

`npm test` skips the live suite with a note if the server is not up, so it always works.
`npm run test:live` fails with instructions instead, because you asked for it explicitly.

**What the unit suite covers (142 checks).** Unit conversions and the compass seam; the corner
load model's sign convention and clamping; yaw severity bands; the whole handling-balance model
including the left/right mirror property; every coaching formula; the GPS projection; and every
component server-rendered across its edge cases — full steering lock, past-full-scale AY, an
empty track map, every link state — asserting no `NaN`, `undefined` or `Infinity` reaches the
markup.

**What the live suite covers (~17 checks).** It opens a real SSE connection, pulls 3,000 ticks
(~150 s of replay) and pushes them through *the same functions the browser runs*: decoding,
per-tick decimation, smoothing, the handling model, the coaching classifier and the map grid.
Then it asserts the results are physically sane — top speed 15-40 m/s, learned grip limit
0.8-2.5 g, slip angle p95 under 15°, zero compass unwrap jumps, over 90% valid GPS fixes, more
than 50 distinct track cells, and a coaching mix where flags fire but don't fire constantly.
It prints the category breakdown and the handling signature so you can eyeball them.

Set `TICKS=8000 npm run test:live` for a longer sample.

A note on one deliberately loose assertion: the live suite sees only a ~150 s window starting
wherever the replay happens to be, and different parts of the lap have a genuinely different
corner mix. Comparing per-band medians against the full-log figures tightly made the test
**flaky** — it failed roughly one run in three on honest variation. The per-band numbers are
therefore printed for inspection and asserted only within ±15 deg/s, which still catches a unit
or sign error instantly. The claim actually asserted is the robust one: **balance drifts toward
oversteer as load builds**, which held on every window tried.

Both suites are bundled through esbuild on the fly (Node cannot import `.jsx`), so there is no
build step and no test framework to install.

---

## Reading the dashboard

**Steering gauge** (left) — half-circle dial, −180° to +180°, needle **blue for left**, **amber
for right**, grey within 1.5° of centre. The coloured arc traces travel from centre.
*The logged data only reaches about ±88°, so the needle uses roughly half the dial. Set
`STEERING_RANGE_DEG = 90` in `src/config.js` for a punchier sweep on this particular replay.*

**Car view** (centre) — top-down chassis. Each corner shows load as a colour ramp
(green → yellow → red) plus a fill level and a slight tyre-size change, so it still reads
correctly in greyscale or with colour-blindness. The front tyres steer with the wheel. Turn
right and you'll watch the left side go red.

**AY bar** (right) — zero-centred, filling left (blue) for negative and right (amber) for
positive. A thin decaying tick marks the recent peak, since the raw IMU spikes are brief and
would otherwise be smoothed away. Shows m/s² and g.

**Compass** (top) — the rose rotates so the car's heading sits under the fixed blue index. North
is Penn red.

**Handling balance** (Car Setup tab) - live understeer/oversteer. The bar grows toward
OVERSTEER (orange-red) on the left and UNDERSTEER (violet) on the right from a shaded neutral
deadband, and the state word is always shown, so the reading never depends on colour alone.
Underneath it shows the two numbers the balance is the difference between: what the steering is
asking for, and what the car is doing. Reads "NOT CORNERING" below 8 m/s or 2 m/s2 rather than
inventing a number.

**Handling signature** (Car Setup tab) - median balance in each lateral-load band,
accumulated over the session. Diverging bars from a zero baseline; hover a bar to isolate it;
Reset clears the accumulation. This is the panel that turns the live numbers into something
actionable - a single balance reading describes one moment, this describes the car.

**Yaw rate** (bottom) — number, severity word, and a zero-centred strip with threshold marks.
Green below 30 deg/s, amber to 60, red beyond.

---

## How it works

```
src/
  config.js                  every tunable: port, sensor IDs, scales, thresholds, palette
  main.jsx                   React entry point
  App.jsx                    layout; chooses real vs modelled corner loads
  styles.css                 dark theme, CSS custom properties
  hooks/
    useCarData.js            EventSource connection, decimation, smoothing, link state
  lib/
    vehicle.js               pure functions: conversions, corner-load model, colour ramps
    handling.js              the understeer/oversteer model
    coaching.js              driver coaching: slip, corner radius, grip use, classification
    geo.js                   GPS -> metres projection, the map grid, aspect-correct fitting
  components/
    CarView.jsx              top-down car + corner load indicators
    SteeringGauge.jsx        half-circle dial with needle
    LateralAccelBar.jsx      bi-directional AY bar with peak hold
    Compass.jsx              rotating compass rose
    YawRateBar.jsx           bottom status bar
    StatusBanner.jsx         connection pill + disconnection banner
    BalanceMeter.jsx         live understeer/oversteer meter
    HandlingSignature.jsx    balance-by-lateral-load chart
    TrackMap.jsx             GPS track map, hotspots, per-cell diagnosis
    DataGuide.jsx            in-app explanation of every channel and formula
test/
  harness.mjs                tiny dependency-free assertion harness
  unit.test.mjs              142 checks, no server needed
  live.test.mjs              integration checks against the real stream
scripts/
  run-tests.mjs              bundles the suites with esbuild and runs them
```

`hooks/useHandlingSignature.js` bins balance by lateral load behind the steady-state gate. It
keeps a bounded ring buffer per band (600 samples), so memory stays flat over a long session and
the chart reflects recent running. Medians are recomputed every 500 ms rather than every tick -
it is a slow aggregate, and re-sorting five buffers at 20 Hz is waste.

**Decimation before smoothing.** A tick carries ~108 samples, roughly 9 per channel. Calling
`setState` per sample would mean ~2000 renders per second. Instead each tick is reduced to one
mean value per channel and committed as a **single** state update — which is both a proper
decimation and a free first pass of noise rejection.

**Smoothing.** The VectorNav channels are noisy at 190 Hz, and unsmoothed bars strobe. An
exponential moving average (`SMOOTHING_ALPHA = 0.3`, about a 150 ms time constant) is applied
per tick. Set it to `1.0` to see the raw signal.

**Heading is unwrapped.** A CSS rotation interpolates the raw number, so going 359° → 1° would
spin the compass 358° backwards. The hook tracks a continuous unwrapped heading alongside the
0–360 bearing, so every step takes the short arc while the transition still animates. The EMA
is deliberately skipped for heading — averaging across the 0/360 seam is meaningless.

**Connection states.** Four, not two:

| State | Meaning |
|---|---|
| `Connecting…` | Opening, or `EventSource` is retrying |
| `Live` | Ticks arriving |
| `Awaiting data` | Socket open, no ticks for 2.5 s — normally the replay looping |
| `Disconnected` | Connection closed; last known values stay on screen |

The `Awaiting data` state matters: the server pauses ~10 s each time the replay loops, and
`EventSource` never fires `onerror` for that. Without the watchdog the dashboard would silently
show a frozen car and claim it was live. Disconnection is never destructive — the last known
values remain, and a banner explains what happened.

---

## Requirements

- **Node.js 18+** (`npm install`, `npm run dev`)
- **Python 3.11+** with the repository's `requirements.txt`, for the server

Dependencies are `react`, `react-dom`, and `vite` only. Every visual is hand-written SVG and
CSS — no charting or UI library.

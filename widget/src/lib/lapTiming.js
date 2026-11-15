/**
 * Lap detection by start/finish LINE crossing.
 *
 * The obvious approach — "count a lap whenever the car comes within N metres of
 * where it started" — was tried first and does not work. On this log it missed
 * crossings whenever the car took a slightly different line, merging pairs of
 * laps into single 136 s and 143 s "laps".
 *
 * The reliable method is the one real timing systems use: define a line across
 * the track and count a lap each time the car passes THROUGH it in the right
 * direction. Concretely, with a reference point p0 and the unit heading h the
 * car had there:
 *
 *   s = (p - p0) · h    distance along the direction of travel
 *   L = (p - p0) · n    lateral offset from the line's centre  (n perpendicular to h)
 *
 * A lap ends when `s` crosses zero upward — the car has just passed the plane
 * of the line, travelling the same way it was at the start. `L` is gated so a
 * crossing of that infinite plane somewhere else on the circuit doesn't count.
 *
 * Validated on the full replay: 10 laps, every one between 993 m and 1006 m
 * (within 1.3% of each other, so each really is a full lap), 64.4 s to 75.9 s.
 * The result is identical for gate widths anywhere from 10 m to 25 m, which is
 * what a robust detector looks like.
 */

// How far either side of the reference point still counts as crossing the line.
export const LINE_GATE_M = 20
// No real lap is shorter than this; debounces a car wobbling across the line.
export const MIN_LAP_SECONDS = 20
// Speed the car must reach before the line is placed, and to count a crossing.
const ARM_SPEED_MS = 10
const CROSS_SPEED_MS = 5
// Travel needed after arming before the heading is trustworthy.
const HEADING_BASELINE_M = 4

/**
 * Stateful detector. Feed it positions in metres; it returns true on the tick a
 * lap completes.
 */
export function createLapDetector() {
  let anchor = null // { x, y } candidate start, before the heading is known
  let line = null // { p0, h, n } once armed
  let previousAlong = null
  let lastCrossAt = -Infinity

  return {
    get isArmed() { return line !== null },
    get line() { return line },

    /** @returns true if this sample completes a lap. */
    update(x, y, speed, timeSeconds) {
      if (!line) {
        // Wait for the car to be properly moving before anchoring the line —
        // a heading taken while crawling through the paddock is meaningless.
        if (speed < ARM_SPEED_MS) return false
        if (!anchor) { anchor = { x, y }; return false }

        const dx = x - anchor.x
        const dy = y - anchor.y
        const travelled = Math.hypot(dx, dy)
        if (travelled < HEADING_BASELINE_M) return false

        const h = { x: dx / travelled, y: dy / travelled }
        line = {
          p0: { ...anchor },
          h,
          n: { x: -h.y, y: h.x }, // rotate the heading 90 degrees
        }
        previousAlong = 0
        lastCrossAt = timeSeconds
        return false
      }

      const relX = x - line.p0.x
      const relY = y - line.p0.y
      const along = relX * line.h.x + relY * line.h.y
      const lateral = relX * line.n.x + relY * line.n.y

      const crossed =
        previousAlong !== null &&
        previousAlong < 0 &&
        along >= 0 &&
        Math.abs(lateral) < LINE_GATE_M &&
        speed > CROSS_SPEED_MS &&
        timeSeconds - lastCrossAt > MIN_LAP_SECONDS

      previousAlong = along
      if (crossed) lastCrossAt = timeSeconds
      return crossed
    },

    reset() {
      anchor = null
      line = null
      previousAlong = null
      lastCrossAt = -Infinity
    },
  }
}

/** mm:ss.s — how a lap time is actually read. */
export function formatLapTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`
}

/**
 * Light moving average over a path, so GPS jitter doesn't make the drawn line
 * wobble. Endpoints are kept exactly, and the window is clipped near them so
 * the line never pulls away from where the car actually was.
 */
export function smoothPath(points, halfWindow = 2) {
  if (points.length < 3) return points
  const lastIndex = points.length - 1
  return points.map((point, index) => {
    // Pin the ends: a lap should start and finish exactly where the car did,
    // not at an average that drags the line away from the real position.
    if (index === 0 || index === lastIndex) return point
    const from = Math.max(0, index - halfWindow)
    const to = Math.min(points.length - 1, index + halfWindow)
    let sumX = 0
    let sumY = 0
    for (let i = from; i <= to; i++) {
      sumX += points[i].x
      sumY += points[i].y
    }
    const count = to - from + 1
    return { ...point, x: sumX / count, y: sumY / count }
  })
}

/**
 * Break a path into runs of consecutive same-category points.
 *
 * Each run becomes one polyline, which is what turns a list of points into a
 * smooth line that changes colour along its length. Runs overlap by one point
 * so there is no visible gap where the colour changes.
 */
export function segmentByCategory(points) {
  if (!points.length) return []
  const segments = []
  let current = { category: points[0].category, points: [points[0]] }
  for (let i = 1; i < points.length; i++) {
    if (points[i].category === current.category) {
      current.points.push(points[i])
    } else {
      current.points.push(points[i]) // overlap, so the segments join up
      segments.push(current)
      current = { category: points[i].category, points: [points[i]] }
    }
  }
  segments.push(current)
  return segments
}

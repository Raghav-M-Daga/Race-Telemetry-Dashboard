/**
 * A clock that never goes backwards, across a stream that does.
 *
 * The replay server restarts from the beginning of the log when it reaches the
 * end, and its timestamps reset to zero with it. Everything downstream — the
 * ingest buffer, lap detection, the distance grid — assumes time increases, so
 * the reset has to be absorbed exactly once, here.
 *
 * TWO BUGS THIS EXISTS TO PREVENT, both of which were live:
 *
 *  1. No rebase at all. The ingest buffer rejects out-of-order samples, so from
 *     the first restart onward EVERY sample was dropped and the session froze
 *     where it stood. Nothing crashed; laps simply stopped appearing.
 *
 *  2. Rebasing against the MAXIMUM timestamp seen. After a restart the maximum
 *     stays at the end of the log forever, so every subsequent frame looks like
 *     another restart. The offset then grew once per frame: 15,000 "restarts"
 *     and a buffer claiming to span 5.8 million seconds, which trimmed away
 *     every real lap.
 *
 * The fix for the second is that `lastSeen` is the LAST timestamp, not the
 * largest. Within a replay those are the same; across a restart they are not,
 * and that difference is the entire bug.
 */

/**
 * @param backwardJumpSeconds how far back counts as a restart rather than
 *   ordinary interleaving within a frame. Frames carry samples a few tens of
 *   milliseconds apart, so anything beyond a second or two is unambiguous.
 */
export function createReplayClock({ backwardJumpSeconds = 5 } = {}) {
  let offset = 0
  let lastSeen = null
  let restarts = 0

  return {
    get restarts() { return restarts },
    get offset() { return offset },

    /**
     * Feed one frame's raw timestamps, in seconds. Returns the offset to add to
     * every timestamp in this frame.
     */
    accept(firstRaw, lastRaw) {
      if (lastSeen !== null && firstRaw < lastSeen - backwardJumpSeconds) {
        // Continue just past where the previous replay ended, so the virtual
        // timeline is contiguous rather than overlapping.
        offset += lastSeen - firstRaw + 0.05
        restarts++
      }
      lastSeen = lastRaw
      return offset
    },

    reset() {
      offset = 0
      lastSeen = null
      restarts = 0
    },
  }
}

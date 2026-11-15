import { useEffect, useRef, useState } from 'react'
import {
  AY_BINS,
  SIGNATURE_REFRESH_MS,
  SIGNATURE_WINDOW,
  SMOOTHING_ALPHA,
  STEADY_STATE_MAX_YAW_ACCEL_DEG_S2,
} from '../config.js'
import { ayBinIndex, median } from '../lib/handling.js'

/**
 * Accumulate handling balance into |AY| bins over the session.
 *
 * A single instant of balance is noisy and not very informative. The useful
 * thing is how balance *trends* with lateral load: a car that is neutral at
 * 3 m/s² but loose at 15 m/s² has a specific, fixable setup characteristic, and
 * that only shows up once you have a few hundred samples per band.
 *
 * Samples land in a bounded ring buffer per bin, so memory stays flat over a
 * long session and the signature reflects recent running rather than the whole
 * history. The chart reads medians, recomputed on an interval rather than every
 * tick — this is a slow aggregate and re-sorting five buffers at 20 Hz is waste.
 */
export function useHandlingSignature(balance, lateralAcceleration, yawRate, isLive) {
  // One ring buffer per bin: { values, nextIndex, total }.
  const binsRef = useRef(
    AY_BINS.map(() => ({ values: [], nextIndex: 0, total: 0 })),
  )
  const [signature, setSignature] = useState(
    AY_BINS.map((bin) => ({ ...bin, median: null, count: 0 })),
  )
  // Previous yaw rate + wall clock, for the steady-state gate below.
  const previousYawRef = useRef({ yawRate: null, at: 0, yawAccel: 0 })
  const [rejectedTransients, setRejectedTransients] = useState(0)

  // Push the current sample into its bin. Only steady cornering counts: the
  // balance model is a steady-state model, so feeding it turn-in transients
  // would smear the very trend we're trying to see.
  useEffect(() => {
    if (!isLive) return

    // Yaw acceleration, smoothed with the same weight as everything else — the
    // raw tick-to-tick difference at 20 Hz is far too jumpy to threshold on.
    const now = Date.now()
    const previous = previousYawRef.current
    if (previous.yawRate !== null) {
      const dt = (now - previous.at) / 1000
      if (dt > 0) {
        const instantAccel = (yawRate - previous.yawRate) / dt
        previous.yawAccel += SMOOTHING_ALPHA * (instantAccel - previous.yawAccel)
      }
    }
    previous.yawRate = yawRate
    previous.at = now

    if (!balance.isCornering) return

    // Reject turn-in and corner exit: mid-transition the car is still building
    // yaw, so it lags the steering and reads as understeer that isn't there.
    if (Math.abs(previous.yawAccel) > STEADY_STATE_MAX_YAW_ACCEL_DEG_S2) {
      setRejectedTransients((count) => count + 1)
      return
    }

    const index = ayBinIndex(lateralAcceleration)
    if (index < 0) return

    const bin = binsRef.current[index]
    if (bin.values.length < SIGNATURE_WINDOW) {
      bin.values.push(balance.signedBalance)
    } else {
      bin.values[bin.nextIndex] = balance.signedBalance
      bin.nextIndex = (bin.nextIndex + 1) % SIGNATURE_WINDOW
    }
    bin.total++
  }, [balance, lateralAcceleration, yawRate, isLive])

  useEffect(() => {
    const recompute = () =>
      setSignature(
        AY_BINS.map((bin, index) => {
          const { values, total } = binsRef.current[index]
          return { ...bin, median: median(values), count: total }
        }),
      )
    const timer = setInterval(recompute, SIGNATURE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  const reset = () => {
    binsRef.current = AY_BINS.map(() => ({ values: [], nextIndex: 0, total: 0 }))
    setSignature(AY_BINS.map((bin) => ({ ...bin, median: null, count: 0 })))
    setRejectedTransients(0)
  }

  return { signature, reset, rejectedTransients }
}

import { useEffect, useRef, useState } from 'react'
import { COLORS, LATERAL_ACCEL_FULL_SCALE } from '../config.js'
import { clamp, formatSigned } from '../lib/vehicle.js'

const PEAK_DECAY_PER_TICK = 0.985 // peak marker bleeds back toward zero slowly

/**
 * Bi-directional lateral acceleration bar, zero-centred.
 * Left half fills for negative AY (left-hand load), right half for positive.
 */
export default function LateralAccelBar({ lateralAcceleration }) {
  const [peak, setPeak] = useState(0)
  const peakRef = useRef(0)

  // Peak hold: the raw IMU spikes hard and briefly, and a decaying high-water
  // mark is the only way those peaks stay readable on a smoothed bar.
  useEffect(() => {
    const magnitude = Math.abs(lateralAcceleration)
    peakRef.current =
      magnitude > Math.abs(peakRef.current)
        ? lateralAcceleration
        : peakRef.current * PEAK_DECAY_PER_TICK
    setPeak(peakRef.current)
  }, [lateralAcceleration])

  const fraction = clamp(lateralAcceleration / LATERAL_ACCEL_FULL_SCALE, -1, 1)
  const fillPct = Math.abs(fraction) * 50 // each half of the bar is 50% wide
  const isRight = fraction >= 0
  const fillColor = isRight ? COLORS.amber : COLORS.electricBlue

  const peakFraction = clamp(peak / LATERAL_ACCEL_FULL_SCALE, -1, 1)
  const peakLeftPct = 50 + peakFraction * 50

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">AY (m/s²)</h2>
        <span className="panel__unit">lateral</span>
      </header>

      <div className="ay">
        <div className="ay__scale">
          <span>−{LATERAL_ACCEL_FULL_SCALE}</span>
          <span>0</span>
          <span>+{LATERAL_ACCEL_FULL_SCALE}</span>
        </div>

        <div className="ay__track">
          <div className="ay__centerline" />
          <div
            className="ay__fill"
            style={{
              background: fillColor,
              // Anchor at the midpoint and grow outward in the sign's direction.
              left: isRight ? '50%' : `${50 - fillPct}%`,
              width: `${fillPct}%`,
            }}
          />
          <div
            className="ay__peak"
            style={{ left: `${peakLeftPct}%`, background: fillColor }}
            title={`Peak ${formatSigned(peak, 1)} m/s²`}
          />
        </div>

        <div className="ay__legend">
          <span style={{ color: COLORS.electricBlue }}>◀ LEFT</span>
          <span style={{ color: COLORS.amber }}>RIGHT ▶</span>
        </div>
      </div>

      <div className="readout" style={{ color: fillColor }}>
        {formatSigned(lateralAcceleration, 2)}
        <span className="readout__unit">m/s²</span>
      </div>

      <div className="ay__sub">
        <span className="panel__unit">peak {formatSigned(peak, 1)}</span>
        <span className="panel__unit">
          {Math.abs(lateralAcceleration / 9.81).toFixed(2)} g
        </span>
      </div>
    </section>
  )
}

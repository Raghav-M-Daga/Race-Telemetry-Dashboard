import {
  COLORS,
  YAW_RATE_FULL_SCALE_DEG_S,
  YAW_RATE_HIGH_DEG_S,
  YAW_RATE_MODERATE_DEG_S,
} from '../config.js'
import { clamp, formatSigned, yawRateSeverity } from '../lib/vehicle.js'

/**
 * Bottom status bar: yaw rate as a number, a severity word, and a zero-centred
 * magnitude strip. Green near zero, amber past MODERATE, red past HIGH.
 */
export default function YawRateBar({ yawRate }) {
  const severity = yawRateSeverity(yawRate, YAW_RATE_MODERATE_DEG_S, YAW_RATE_HIGH_DEG_S)
  const fraction = clamp(yawRate / YAW_RATE_FULL_SCALE_DEG_S, -1, 1)
  const fillPct = Math.abs(fraction) * 50
  const isRight = fraction >= 0

  // Threshold ticks, mirrored on both sides of centre.
  const thresholds = [YAW_RATE_MODERATE_DEG_S, YAW_RATE_HIGH_DEG_S].flatMap((value) => [
    { value, color: value >= YAW_RATE_HIGH_DEG_S ? COLORS.pennRedBright : COLORS.amber },
    { value: -value, color: value >= YAW_RATE_HIGH_DEG_S ? COLORS.pennRedBright : COLORS.amber },
  ])

  return (
    <section className="panel yaw">
      <div className="yaw__label">
        <h2 className="panel__title">Yaw Rate</h2>
        <span className="panel__unit">deg/s</span>
      </div>

      <div className="yaw__track">
        <div className="ay__centerline" />
        {thresholds.map(({ value, color }) => (
          <div
            key={value}
            className="yaw__threshold"
            style={{ left: `${50 + (value / YAW_RATE_FULL_SCALE_DEG_S) * 50}%`, background: color }}
          />
        ))}
        <div
          className="yaw__fill"
          style={{
            background: severity.color,
            boxShadow: `0 0 18px ${severity.color}66`,
            left: isRight ? '50%' : `${50 - fillPct}%`,
            width: `${fillPct}%`,
          }}
        />
      </div>

      <div className="yaw__values">
        <span className="yaw__number" style={{ color: severity.color }}>
          {formatSigned(yawRate, 1)}
        </span>
        <span className="yaw__severity" style={{ color: severity.color, borderColor: severity.color }}>
          {severity.label}
        </span>
      </div>
    </section>
  )
}

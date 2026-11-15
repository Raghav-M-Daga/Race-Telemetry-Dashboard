import { COLORS, STEERING_RANGE_DEG } from '../config.js'
import { clamp, formatSigned } from '../lib/vehicle.js'

const CX = 130
const CY = 132
const R = 104

/**
 * Map a steering angle to a bearing in degrees clockwise from straight-up.
 * Full lock either way lands on the horizontal, so the dial is a half circle:
 * -RANGE -> -90 (pointing left), 0 -> 0 (up), +RANGE -> +90 (pointing right).
 */
const angleToBearing = (deg) =>
  (clamp(deg, -STEERING_RANGE_DEG, STEERING_RANGE_DEG) / STEERING_RANGE_DEG) * 90

/** Point on the dial at `bearing` degrees and `radius` from the centre. */
function polar(bearing, radius) {
  const rad = (bearing * Math.PI) / 180
  return { x: CX + radius * Math.sin(rad), y: CY - radius * Math.cos(rad) }
}

/** Arc path from one bearing to another; always the minor arc on a half dial. */
function arcPath(fromBearing, toBearing, radius) {
  const start = polar(fromBearing, radius)
  const end = polar(toBearing, radius)
  const sweep = toBearing > fromBearing ? 1 : 0
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 ${sweep} ${end.x} ${end.y}`
}

// Ticks every quarter of full lock, plus centre.
const TICKS = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
  fraction,
  bearing: fraction * 90,
  labelled: Math.abs(fraction * 2) % 1 === 0, // label full and half lock only
}))

export default function SteeringGauge({ angle }) {
  const bearing = angleToBearing(angle)
  const needleTip = polar(bearing, R - 16)
  const needleTail = polar(bearing + 180, 18)

  // Blue for a left turn, orange for a right turn, neutral grey near centre.
  const isCentred = Math.abs(angle) < 1.5
  const needleColor = isCentred
    ? COLORS.textDim
    : angle < 0
      ? COLORS.electricBlue
      : COLORS.amber

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">Steering Angle</h2>
        <span className="panel__unit">deg</span>
      </header>

      <svg viewBox="0 0 260 170" className="gauge" role="img"
           aria-label={`Steering angle ${angle.toFixed(0)} degrees`}>
        {/* dial track */}
        <path d={arcPath(-90, 90, R)} fill="none" stroke="#1a1e26" strokeWidth="16"
              strokeLinecap="round" />

        {/* travel from centre to the current angle, coloured by turn direction */}
        {!isCentred && (
          <path d={arcPath(0, bearing, R)} fill="none" stroke={needleColor}
                strokeWidth="16" strokeLinecap="butt" opacity="0.85" />
        )}

        {/* ticks */}
        {TICKS.map(({ fraction, bearing: tickBearing, labelled }) => {
          const outer = polar(tickBearing, R - 11)
          const inner = polar(tickBearing, labelled ? R - 26 : R - 20)
          const label = polar(tickBearing, R - 42)
          return (
            <g key={fraction}>
              <line x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y}
                    stroke={fraction === 0 ? COLORS.text : COLORS.textDim}
                    strokeWidth={fraction === 0 ? 2.5 : 1.5} />
              {labelled && (
                <text x={label.x} y={label.y + 4} textAnchor="middle" className="gauge__tick-label">
                  {fraction === 0 ? '0' : formatSigned(fraction * STEERING_RANGE_DEG, 0)}
                </text>
              )}
            </g>
          )
        })}

        {/* direction cues at each end of the dial */}
        <text x="14" y="150" className="gauge__end-label" fill={COLORS.electricBlue}>LEFT −</text>
        <text x="246" y="150" textAnchor="end" className="gauge__end-label" fill={COLORS.amber}>
          + RIGHT
        </text>

        {/* needle */}
        <line x1={needleTail.x} y1={needleTail.y} x2={needleTip.x} y2={needleTip.y}
              stroke={needleColor} strokeWidth="5" strokeLinecap="round" />
        <circle cx={CX} cy={CY} r="9" fill={COLORS.panel} stroke={needleColor} strokeWidth="3" />
      </svg>

      <div className="readout" style={{ color: needleColor }}>
        {formatSigned(angle, 1)}
        <span className="readout__unit">°</span>
      </div>
    </section>
  )
}

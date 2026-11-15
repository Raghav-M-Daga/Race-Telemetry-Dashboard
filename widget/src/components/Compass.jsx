import { COLORS } from '../config.js'
import { cardinalFor, toCompassBearing } from '../lib/vehicle.js'

const SIZE = 150
const C = SIZE / 2
const R = 62

const CARDINALS = [
  { label: 'N', bearing: 0 },
  { label: 'E', bearing: 90 },
  { label: 'S', bearing: 180 },
  { label: 'W', bearing: 270 },
]

// Minor ticks every 15 degrees; the cardinal spokes get a longer mark.
const TICKS = Array.from({ length: 24 }, (_, i) => i * 15)

/**
 * Compass rose showing where the car is pointed.
 *
 * The rose rotates by -heading so the car's direction always sits under the
 * fixed index mark at the top. `headingUnwrapped` is used for the rotation
 * (not the 0-360 bearing) so the CSS transition never spins the long way round
 * when the heading crosses north — see unwrapHeading in lib/vehicle.js.
 */
export default function Compass({ heading, headingUnwrapped }) {
  const bearing = toCompassBearing(heading)

  return (
    <div className="compass">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="compass__svg" role="img"
           aria-label={`Heading ${bearing.toFixed(0)} degrees, ${cardinalFor(bearing)}`}>
        <circle cx={C} cy={C} r={R + 8} fill="#0c0e12" stroke={COLORS.panelEdge} strokeWidth="1.5" />

        <g
          className="compass__rose"
          style={{ transform: `rotate(${-headingUnwrapped}deg)`, transformOrigin: '50% 50%' }}
        >
          {TICKS.map((tickBearing) => {
            const isCardinal = tickBearing % 90 === 0
            const rad = (tickBearing * Math.PI) / 180
            const outer = R
            const inner = R - (isCardinal ? 12 : 6)
            return (
              <line
                key={tickBearing}
                x1={C + outer * Math.sin(rad)} y1={C - outer * Math.cos(rad)}
                x2={C + inner * Math.sin(rad)} y2={C - inner * Math.cos(rad)}
                stroke={isCardinal ? COLORS.text : COLORS.textDim}
                strokeWidth={isCardinal ? 2 : 1}
              />
            )
          })}

          {CARDINALS.map(({ label, bearing: cardinalBearing }) => {
            const rad = (cardinalBearing * Math.PI) / 180
            const radius = R - 26
            return (
              <text
                key={label}
                x={C + radius * Math.sin(rad)}
                y={C - radius * Math.cos(rad) + 5}
                textAnchor="middle"
                className="compass__cardinal"
                fill={label === 'N' ? COLORS.pennRedBright : COLORS.textDim}
              >
                {label}
              </text>
            )
          })}
        </g>

        {/* Fixed index: the car always points at this mark. */}
        <path d={`M ${C} 14 l 7 13 h -14 z`} fill={COLORS.electricBlue} />
        <circle cx={C} cy={C} r="4" fill={COLORS.electricBlue} />
      </svg>

      <div className="compass__readout">
        <span className="compass__degrees">{bearing.toFixed(0).padStart(3, '0')}°</span>
        <span className="compass__cardinal-label">{cardinalFor(bearing)}</span>
      </div>
    </div>
  )
}

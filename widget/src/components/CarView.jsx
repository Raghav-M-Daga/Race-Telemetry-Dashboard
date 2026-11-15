import { COLORS } from '../config.js'
import { loadColor } from '../lib/vehicle.js'

// SVG canvas is 220 x 340 user units; every coordinate below is in that space.
const VIEW_W = 220
const VIEW_H = 340

// Corner marker positions, matched to the wheel rectangles in the body outline.
const CORNERS = [
  { key: 'shock_fl', label: 'FL', x: 48, y: 92, labelAnchor: 'end', labelDx: -26 },
  { key: 'shock_fr', label: 'FR', x: 172, y: 92, labelAnchor: 'start', labelDx: 26 },
  { key: 'shock_rl', label: 'RL', x: 48, y: 250, labelAnchor: 'end', labelDx: -26 },
  { key: 'shock_rr', label: 'RR', x: 172, y: 250, labelAnchor: 'start', labelDx: 26 },
]

/**
 * Top-down car with a load indicator at each corner.
 *
 * `loads` is a map of corner key -> 0-100% compression. `isEstimated` flips the
 * caption when the values come from the weight-transfer model rather than real
 * shock pots (see lib/vehicle.js).
 */
export default function CarView({ loads, steeringAngle, isEstimated }) {
  // Front wheels visibly steer. Real steering racks are geared down from the
  // wheel, so scale the wheel angle to a plausible road-wheel angle.
  const roadWheelAngle = Math.max(-28, Math.min(28, steeringAngle / 3))

  return (
    <section className="panel panel--car">
      <header className="panel__header">
        <h2 className="panel__title">Corner Load</h2>
        <span className="panel__unit">{isEstimated ? 'modelled %' : 'shock %'}</span>
      </header>

      <div className="car-view">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="car-view__svg" role="img"
             aria-label="Top-down view of the car showing load at each corner">
          <defs>
            {/* Soft halo behind each corner marker, tinted by that corner's colour. */}
            {CORNERS.map(({ key }) => (
              <radialGradient key={key} id={`halo-${key}`}>
                <stop offset="0%" stopColor={loadColor(loads[key])} stopOpacity="0.55" />
                <stop offset="100%" stopColor={loadColor(loads[key])} stopOpacity="0" />
              </radialGradient>
            ))}
          </defs>

          {/* ---- chassis ---- */}
          {/* nose cone */}
          <path
            d="M110 18 C 94 34, 86 54, 84 74 L 136 74 C 134 54, 126 34, 110 18 Z"
            fill="#181c23" stroke={COLORS.panelEdge} strokeWidth="2"
          />
          {/* main tub */}
          <rect x="84" y="74" width="52" height="188" rx="10"
                fill="#181c23" stroke={COLORS.panelEdge} strokeWidth="2" />
          {/* sidepods */}
          <rect x="66" y="140" width="18" height="72" rx="6" fill="#14171d"
                stroke={COLORS.panelEdge} strokeWidth="1.5" />
          <rect x="136" y="140" width="18" height="72" rx="6" fill="#14171d"
                stroke={COLORS.panelEdge} strokeWidth="1.5" />
          {/* rear wing */}
          <rect x="72" y="266" width="76" height="9" rx="4" fill="#14171d"
                stroke={COLORS.panelEdge} strokeWidth="1.5" />
          {/* cockpit opening */}
          <ellipse cx="110" cy="150" rx="17" ry="26" fill="#0c0e12"
                   stroke={COLORS.panelEdge} strokeWidth="1.5" />
          {/* halo hoop, drawn as the PER accent so the car reads as ours */}
          <path d="M96 128 Q110 116 124 128" fill="none" stroke={COLORS.pennRed} strokeWidth="3"
                strokeLinecap="round" />

          {/* axle lines, so the corner markers read as connected to the chassis */}
          <line x1="48" y1="92" x2="172" y2="92" stroke={COLORS.panelEdge} strokeWidth="2" />
          <line x1="48" y1="250" x2="172" y2="250" stroke={COLORS.panelEdge} strokeWidth="2" />

          {/* ---- corners ---- */}
          {CORNERS.map(({ key, label, x, y, labelAnchor, labelDx }) => {
            const load = loads[key]
            const color = loadColor(load)
            const isFront = y < VIEW_H / 2
            // Tyre grows slightly with load — a second, redundant cue so the
            // panel still reads correctly in greyscale or for colour-blind users.
            const tyreHeight = 30 + (load / 100) * 8

            return (
              <g key={key}>
                <circle cx={x} cy={y} r="34" fill={`url(#halo-${key})`} />
                <g transform={isFront ? `rotate(${roadWheelAngle} ${x} ${y})` : undefined}>
                  <rect
                    x={x - 9} y={y - tyreHeight / 2} width="18" height={tyreHeight} rx="5"
                    fill="#0c0e12" stroke={color} strokeWidth="3"
                  />
                  <rect
                    x={x - 6} y={y - tyreHeight / 2 + 3} width="12"
                    height={(tyreHeight - 6) * (load / 100)} rx="3" fill={color} opacity="0.85"
                    // load bar fills from the bottom of the tyre upward
                    transform={`translate(0 ${(tyreHeight - 6) * (1 - load / 100)})`}
                  />
                </g>
                <text
                  x={x + labelDx} y={y - 6} textAnchor={labelAnchor}
                  className="car-view__corner-label"
                >
                  {label}
                </text>
                <text
                  x={x + labelDx} y={y + 12} textAnchor={labelAnchor}
                  className="car-view__corner-value" fill={color}
                >
                  {load.toFixed(0)}%
                </text>
              </g>
            )
          })}

          <text x={VIEW_W / 2} y={330} textAnchor="middle" className="car-view__hint">
            FRONT ↑
          </text>
        </svg>
      </div>

      {isEstimated && (
        <p className="panel__note">
          No shock pot channels in this replay — corner loads are modelled from
          lateral acceleration.
        </p>
      )}
    </section>
  )
}

import { useState } from 'react'
import { BALANCE_FULL_SCALE_DEG_S, COLORS } from '../config.js'
import { clamp } from '../lib/vehicle.js'

// Plot geometry, in SVG user units.
const W = 460
const H = 190
const PAD = { top: 14, right: 14, bottom: 34, left: 42 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom
const ZERO_Y = PAD.top + PLOT_H / 2

// Bars are diverging from a zero baseline, so the y scale is symmetric.
const Y_MAX = BALANCE_FULL_SCALE_DEG_S / 2
const yFor = (value) => ZERO_Y - (clamp(value, -Y_MAX, Y_MAX) / Y_MAX) * (PLOT_H / 2)

const GRID_VALUES = [-10, -5, 0, 5, 10]
const MIN_SAMPLES = 40 // below this a bin is too thin to read anything into

/**
 * Handling signature: median balance in each lateral-load band.
 *
 * This is the panel that turns the live numbers into something actionable. A
 * single balance reading tells you about one moment; this tells you what the
 * car does as lateral load builds — whether it stays put, pushes wide, or goes
 * loose at the limit. Diverging bars from a zero baseline, one band per bar,
 * because the reading that matters is sign-and-magnitude against neutral.
 */
export default function HandlingSignature({ signature, rejectedTransients, onReset }) {
  const [hoveredIndex, setHoveredIndex] = useState(null)

  const bandWidth = PLOT_W / signature.length
  const barWidth = bandWidth - 14 // 2px surface gap either side, plus breathing room
  const populated = signature.filter((bin) => bin.count >= MIN_SAMPLES)

  // Read the trend off the populated bands: is the car losing the rear as load
  // builds? Comparing the lowest and highest populated band is enough to say.
  let verdict = 'Gathering data…'
  if (populated.length >= 2) {
    const first = populated[0]
    const last = populated[populated.length - 1]
    const drift = last.median - first.median
    if (drift < -3) verdict = 'Trends toward oversteer as load builds'
    else if (drift > 3) verdict = 'Trends toward understeer as load builds'
    else verdict = 'Balance holds steady across the load range'
  }

  return (
    <section className="panel signature">
      <header className="panel__header">
        <h2 className="panel__title">Handling Signature</h2>
        <div className="signature__header-right">
          <span className="panel__unit">median balance by lateral load</span>
          <button type="button" className="signature__reset" onClick={onReset}>
            Reset
          </button>
        </div>
      </header>

      <div className="signature__legend">
        <span><i style={{ background: COLORS.understeer }} /> Understeer</span>
        <span><i style={{ background: COLORS.oversteer }} /> Oversteer</span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="signature__svg" role="img"
           aria-label="Median handling balance in each lateral acceleration band">
        {/* recessive gridlines */}
        {GRID_VALUES.map((value) => (
          <g key={value}>
            <line
              x1={PAD.left} x2={W - PAD.right} y1={yFor(value)} y2={yFor(value)}
              stroke={value === 0 ? COLORS.textDim : COLORS.panelEdge}
              strokeWidth={value === 0 ? 1.5 : 1}
            />
            <text x={PAD.left - 8} y={yFor(value) + 3.5} textAnchor="end"
                  className="signature__axis-label">
              {value > 0 ? `+${value}` : value}
            </text>
          </g>
        ))}

        {signature.map((bin, index) => {
          const x = PAD.left + index * bandWidth + (bandWidth - barWidth) / 2
          const thin = bin.count < MIN_SAMPLES
          const value = bin.median
          const hasValue = value !== null && !thin

          const top = hasValue ? Math.min(yFor(value), ZERO_Y) : ZERO_Y
          const height = hasValue ? Math.abs(yFor(value) - ZERO_Y) : 0
          const color = !hasValue
            ? COLORS.panelEdge
            : value > 0 ? COLORS.understeer : COLORS.oversteer

          return (
            <g key={bin.label}
               onMouseEnter={() => setHoveredIndex(index)}
               onMouseLeave={() => setHoveredIndex(null)}>
              {/* hit target, larger than the mark itself */}
              <rect x={PAD.left + index * bandWidth} y={PAD.top}
                    width={bandWidth} height={PLOT_H} fill="transparent" />

              {hasValue ? (
                <rect x={x} y={top} width={barWidth} height={Math.max(height, 2)}
                      rx="4" fill={color}
                      opacity={hoveredIndex === null || hoveredIndex === index ? 1 : 0.45} />
              ) : (
                // Placeholder so an unfilled band reads as "no data yet", not zero.
                <rect x={x} y={ZERO_Y - 1.5} width={barWidth} height="3" rx="1.5"
                      fill={COLORS.panelEdge} />
              )}

              {/* direct label — only five bars, so every one is labelled */}
              {hasValue && (
                <text x={x + barWidth / 2}
                      y={value > 0 ? top - 6 : top + height + 13}
                      textAnchor="middle" className="signature__value">
                  {value > 0 ? '+' : ''}{value.toFixed(1)}
                </text>
              )}

              <text x={x + barWidth / 2} y={H - 14} textAnchor="middle"
                    className="signature__axis-label">
                {bin.label}
              </text>
              <text x={x + barWidth / 2} y={H - 3} textAnchor="middle"
                    className="signature__count">
                {thin ? `${bin.count}` : `n=${bin.count}`}
              </text>
            </g>
          )
        })}

        <text x={PAD.left + PLOT_W / 2} y={H - 24} textAnchor="middle"
              className="signature__axis-title" opacity="0">
          |AY| m/s²
        </text>
      </svg>

      <p className="signature__verdict">
        <strong>{verdict}</strong>
        <span>
          |AY| bands in m/s² · bars need n≥{MIN_SAMPLES} · {rejectedTransients} turn-in/exit
          samples rejected as non-steady-state
        </span>
      </p>
    </section>
  )
}

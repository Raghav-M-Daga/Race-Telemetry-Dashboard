import { useMemo, useState } from 'react'
import { COLORS } from '../config.js'
import { EVENT_INFO, EVENT_TYPES } from '../engine/events.js'
import { fitBounds } from '../lib/geo.js'

const VIEW_W = 470
const VIEW_H = 620

/**
 * The coaching view.
 *
 * The track is drawn as a single thin neutral line. It is deliberately NOT
 * coloured: painting it says "you were slow along here", which the lap time
 * already said. Every lap instead gets a handful of flags at the POINTS where
 * it began losing time, coloured and shaped by what kind of mistake it was.
 *
 * Shape carries the type as well as colour, because five distinguishable
 * colours are not achievable — blue against violet measures dE 1.9 under
 * protanopia — so the fifth type takes a grey and the shapes do the work.
 */
export default function CoachingView({ analysis, status, onReset }) {
  const [selectedLap, setSelectedLap] = useState(null)
  const [selectedFlag, setSelectedFlag] = useState(null)

  // EVERY lap, including the ones excluded from the reference. A lap with a
  // spin or a traffic hold is still a lap the driver drove, and hiding it makes
  // the session look like it had two laps in it. Unclean laps simply do not
  // contribute to the benchmark — that is a separate matter from whether they
  // are worth looking at.
  const laps = analysis?.lapReports ?? []
  const activeLap = laps.find((lap) => lap.lapNumber === selectedLap) ?? laps[0] ?? null
  const flags = activeLap?.flags ?? []

  const path = analysis?.trackPath ?? []
  const bounds = useMemo(
    () => (path.length > 10 ? fitBounds(path, VIEW_W, VIEW_H) : null),
    [path],
  )
  const trackLine = useMemo(() => {
    if (!bounds || !path.length) return null
    return path.map((point) => {
      const { px, py } = bounds.project(point.x, point.y)
      return `${px.toFixed(1)},${py.toFixed(1)}`
    }).join(' ')
  }, [bounds, path])

  const active = flags.find((flag) => flagKey(flag) === selectedFlag) ?? null

  // Only a true blank state hides the lap list. Once ANY lap exists it is
  // shown, even if there is not yet a reference to measure it against —
  // "3 laps, no benchmark yet" is information; a spinner is not.
  if (!analysis || !laps.length) {
    return (
      <section className="panel">
        <header className="panel__header">
          <h2 className="panel__title">Driver Coaching</h2>
          <span className="panel__unit">
            {status.seconds > 0 ? `${status.seconds.toFixed(0)}s of data` : 'waiting'}
          </span>
        </header>
        <p className="panel__note">
          {analysis?.warnings?.[0]
            ?? 'Collecting data. Two clean laps are needed before there is anything to compare against — until then the engine says nothing rather than inventing a reference.'}
        </p>
        {analysis?.calibration && <CalibrationBlock calibration={analysis.calibration} />}
      </section>
    )
  }

  return (
    <section className="panel coaching">
      <header className="panel__header">
        <h2 className="panel__title">Driver Coaching</h2>
        <div className="signature__header-right">
          <span className="panel__unit">
            {analysis.actionReferenceLapNumber
              ? `${laps.length} laps · vs lap ${analysis.actionReferenceLapNumber} (your best)`
              : `${laps.length} laps · no benchmark yet`}
          </span>
          <button type="button" className="signature__reset" onClick={onReset}>Reset</button>
        </div>
      </header>

      {analysis.warmup && (
        <p className="coaching__excluded">
          <strong>No benchmark yet.</strong> Two clean laps are needed before one can be the
          reference, so no flags are shown. The laps below are recorded and will be analysed as
          soon as there is something to compare them against.
        </p>
      )}

      <div className="coaching__status">
        <span className={`coaching__pulse ${status.running ? 'coaching__pulse--busy' : ''}`} />
        <span>
          Recording <strong>lap {status.laps + 1}</strong>
        </span>
        <span>
          <strong>{laps.length}</strong> analysed
          {status.trimmedLaps > 0 && ` (${status.trimmedLaps} older scrolled out)`}
        </span>
        <span>{Math.floor(status.seconds / 60)}m {Math.round(status.seconds % 60)}s of data</span>
        {status.replayLoops > 0 && <span>{status.replayLoops} replay restart{status.replayLoops === 1 ? '' : 's'}</span>}
        <span className="coaching__status-right">
          {status.running
            ? 'analysing…'
            : status.analysedAt
              ? `updated ${Math.max(0, Math.round((Date.now() - status.analysedAt) / 1000))}s ago`
              : 'waiting for the next lap'}
        </span>
      </div>

      <div className="coaching__laps">
        {laps.map((lap) => (
          <button
            key={lap.lapNumber}
            type="button"
            className={`coaching__lap ${activeLap?.lapNumber === lap.lapNumber ? 'coaching__lap--active' : ''}`
              + `${lap.clean ? '' : ' coaching__lap--unclean'}`}
            title={lap.clean ? undefined : lap.uncleanReasons?.join('; ')}
            onClick={() => { setSelectedLap(lap.lapNumber); setSelectedFlag(null) }}
          >
            <span className="coaching__lap-n">Lap {lap.lapNumber}</span>
            <span className="coaching__lap-t">{lap.lapTime.toFixed(2)}s</span>
            <span className="coaching__lap-d">
              {lap.lapNumber === analysis.actionReferenceLapNumber
                ? 'best'
                : `+${lap.deltaToReference.toFixed(2)}s`}
            </span>
            <span className="coaching__lap-f">
              {lap.flags.length
                ? `${lap.flags.length} flag${lap.flags.length === 1 ? '' : 's'}`
                : 'no flags'}
              {!lap.clean && <em className="coaching__lap-warn"> ⚠</em>}
            </span>
          </button>
        ))}
      </div>

      <div className="coaching__body">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="coaching__svg"
             preserveAspectRatio="xMidYMid meet" role="img"
             aria-label="Track outline with coaching flags">
          {/* The track: one thin neutral line. Never coloured by performance. */}
          {trackLine && (
            <polyline points={trackLine} fill="none" stroke="#2a2f39" strokeWidth="6"
                      strokeLinejoin="round" strokeLinecap="round" />
          )}
          {trackLine && (
            <polyline points={trackLine} fill="none" stroke="#3a414d" strokeWidth="1.5"
                      strokeLinejoin="round" strokeLinecap="round" strokeDasharray="2 6" />
          )}

          {bounds && flags.map((flag, index) => {
            const { px, py } = bounds.project(flag.east, flag.north)
            const info = EVENT_INFO[flag.type] ?? EVENT_INFO[EVENT_TYPES.INHERITED]
            const isActive = flagKey(flag) === selectedFlag
            return (
              <g key={flagKey(flag)} className="coaching__flag"
                 onClick={() => setSelectedFlag(isActive ? null : flagKey(flag))}>
                <circle cx={px} cy={py} r="18" fill="transparent" />
                {isActive && <circle cx={px} cy={py} r="15" fill={info.color} opacity="0.18" />}
                <FlagShape shape={info.shape} x={px} y={py} color={info.color} active={isActive} />
                <text x={px} y={py - 15} textAnchor="middle" className="coaching__flag-n">
                  {index + 1}
                </text>
              </g>
            )
          })}
        </svg>

        <div className="coaching__side">
          <div className="coaching__legend">
            {Object.values(EVENT_TYPES).map((type) => {
              const info = EVENT_INFO[type]
              const count = flags.filter((f) => f.type === type).length
              return (
                <span key={type} className={count ? '' : 'coaching__legend--dim'}>
                  <svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">
                    <FlagShape shape={info.shape} x={0} y={0} color={info.color} small />
                  </svg>
                  {info.label}{count ? ` (${count})` : ''}
                </span>
              )
            })}
          </div>

          {activeLap && !activeLap.clean && (
            <p className="coaching__excluded">
              <strong>Something happened on this lap.</strong>{' '}
              {activeLap.uncleanReasons?.join('; ')}. It is shown in full and flagged like any
              other — it just cannot serve as the benchmark, because a lap with an off in it is
              not a fair target for anyone.
            </p>
          )}

          {active ? (
            <FlagDetail flag={active} onClear={() => setSelectedFlag(null)} />
          ) : flags.length === 0 ? (
            <p className="panel__note">
              {activeLap?.lapNumber === analysis.actionReferenceLapNumber
                ? 'This is your reference lap — the one everything else is measured against, so it has nothing to compare itself with.'
                : 'No flags on this lap: nothing on it lost enough time to be worth pointing at. That is a correct answer, not an empty one.'}
            </p>
          ) : (
            <ol className="coaching__list">
              {flags.map((flag, index) => {
                const info = EVENT_INFO[flag.type]
                return (
                  <li key={flagKey(flag)}>
                    <button type="button" className="coaching__item"
                            onClick={() => setSelectedFlag(flagKey(flag))}>
                      <span className="coaching__item-n"
                            style={{ borderColor: info.color, color: info.color }}>
                        {index + 1}
                      </span>
                      <span className="coaching__item-text">
                        <strong style={{ color: info.color }}>{info.label}</strong>
                        <span>{flag.headline}</span>
                        <span className="hotspots__meta">
                          {flag.segmentLabel} · {flag.onsetS.toFixed(0)} m · {flag.secondsLost.toFixed(2)}s
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </div>

      <p className="panel__note">
        Flags sit where each loss BEGAN, not where it showed up. Click one for every physical
        value measured there against your best lap. The track itself is left uncoloured on
        purpose — where you were slow is already in the lap time; what matters is what changed.
      </p>
    </section>
  )
}

const flagKey = (flag) => `${flag.onsetIndex}-${flag.type}`

/** Shape as a second channel alongside colour. */
function FlagShape({ shape, x, y, color, active, small }) {
  const r = small ? 5 : active ? 8 : 6.5
  const stroke = small ? 'none' : '#0c0e12'
  const width = small ? 0 : 2
  const common = { fill: color, stroke, strokeWidth: width }
  switch (shape) {
    case 'triangle':
      return <path d={`M ${x} ${y - r} L ${x + r} ${y + r * 0.8} L ${x - r} ${y + r * 0.8} Z`} {...common} />
    case 'square':
      return <rect x={x - r * 0.85} y={y - r * 0.85} width={r * 1.7} height={r * 1.7} rx="1.5" {...common} />
    case 'diamond':
      return <path d={`M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`} {...common} />
    case 'chevron':
      return <path d={`M ${x - r} ${y + r * 0.6} L ${x} ${y - r * 0.6} L ${x + r} ${y + r * 0.6} L ${x} ${y} Z`} {...common} />
    case 'hollow':
      // Outline only: visually "we don't know", not a verdict.
      return <circle cx={x} cy={y} r={r} fill="none" stroke={color}
                     strokeWidth={small ? 2 : 2.5} strokeDasharray="3 2.5" />
    case 'star': {
      // Five-pointed: unmistakable at a glance, which is the whole job.
      const points = []
      for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? r * 1.25 : r * 0.5
        const angle = (Math.PI / 5) * i - Math.PI / 2
        points.push(`${(x + radius * Math.cos(angle)).toFixed(2)},${(y + radius * Math.sin(angle)).toFixed(2)}`)
      }
      return <polygon points={points.join(' ')} {...common} stroke="#d03b3b" strokeWidth={small ? 0 : 1.5} />
    }
    default:
      return <circle cx={x} cy={y} r={r} {...common} />
  }
}

/** Every physical value measured at a flag, against the reference lap. */
function FlagDetail({ flag, onClear }) {
  const info = EVENT_INFO[flag.type]
  const rows = Object.entries(flag.measured ?? {})

  return (
    <div className="cell-detail">
      <div className="cell-detail__head" style={{ borderColor: info.color }}>
        <strong style={{ color: info.color }}>{info.label}</strong>
        <button type="button" className="signature__reset" onClick={onClear}>Close</button>
      </div>

      <p className="cell-detail__line">{flag.headline}</p>
      <p className="cell-detail__line">
        <strong>Why: </strong>{flag.reasons.join('; ')}.
      </p>
      <p className="cell-detail__advice">{flag.action}</p>

      <table className="factors">
        <thead>
          <tr><th>Measured</th><th>This lap</th><th>Your best</th><th>Δ</th></tr>
        </thead>
        <tbody>
          {rows.map(([key, m]) => {
            if (!Number.isFinite(m.observed) || !Number.isFinite(m.reference)) return null
            const scale = m.inG ? 1 / 9.81 : m.asPercent ? 100 : 1
            const units = m.inG ? 'g' : m.asPercent ? '%' : m.units
            const delta = m.delta * scale
            // Slip is shown even when untrustworthy, but labelled — the channel
            // has a known dropout tail and a silent number would mislead.
            const suspect = key === 'peakSlip' && m.trustworthy === false
            return (
              <tr key={key} className={suspect ? 'factors__suspect' : ''}>
                <td>
                  {m.label}
                  {suspect && <em title="Slip channel not trustworthy at this grip level"> (unreliable)</em>}
                </td>
                <td>{(m.observed * scale).toFixed(2)} {units}</td>
                <td>{(m.reference * scale).toFixed(2)} {units}</td>
                <td style={{ color: deltaColour(key, delta) }}>
                  {delta >= 0 ? '+' : ''}{delta.toFixed(2)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <dl className="cell-detail__stats">
        <div><dt>Time lost</dt><dd>{flag.secondsLost.toFixed(2)} s</dd></div>
        <div><dt>Where</dt><dd>{flag.onsetS.toFixed(0)} m ({flag.segmentLabel})</dd></div>
        <div><dt>Over</dt><dd>{flag.lengthM.toFixed(0)} m</dd></div>
        <div><dt>Speed given up</dt><dd>{flag.deficitGained.toFixed(1)} m/s</dd></div>
        <div><dt>Confidence</dt><dd>{(flag.confidence * 100).toFixed(0)}%</dd></div>
        <div>
          <dt>Your scatter here</dt>
          <dd>{flag.noiseFloor !== null ? `±${flag.noiseFloor.toFixed(2)} s` : 'n/a'}</dd>
        </div>
      </dl>
    </div>
  )
}

/** Green where a difference is in the driver's favour, red where it is not. */
function deltaColour(key, delta) {
  if (Math.abs(delta) < 0.005) return COLORS.textDim
  // For these, more is better.
  const higherIsBetter = ['entrySpeed', 'speedAtFlag', 'minSpeed', 'exitSpeed', 'meanThrottle', 'peakLateral']
  if (higherIsBetter.includes(key)) return delta > 0 ? '#1baf7a' : '#d03b3b'
  // For slip and steering rate, more is worse.
  if (key === 'peakSlip' || key === 'peakSteerRate') return delta > 0 ? '#d03b3b' : '#1baf7a'
  return COLORS.textDim
}

/** The learned quantities, so nothing in the view is a black box. */
function CalibrationBlock({ calibration }) {
  return (
    <div className="calibration">
      <h3 className="trackmap__side-title">What the engine has learned so far</h3>
      <dl className="calibration__list">
        {calibration.lines.map((line) => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      {calibration.warnings.length > 0 && (
        <ul className="guide__limits">
          {calibration.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
    </div>
  )
}

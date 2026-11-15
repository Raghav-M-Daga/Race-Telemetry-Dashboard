import { LINK_STATE } from '../hooks/useCarData.js'
import { SERVER_ENDPOINT } from '../config.js'

// Copy and colour for each link state. `banner: false` means the state is
// healthy enough that only the small header pill is shown.
const PRESENTATION = {
  [LINK_STATE.LIVE]: { text: 'Live', className: 'status--live', banner: false },
  [LINK_STATE.CONNECTING]: { text: 'Connecting…', className: 'status--connecting', banner: false },
  [LINK_STATE.STALE]: {
    text: 'Awaiting data',
    className: 'status--stale',
    banner: true,
    detail: 'Connected, but no ticks are arriving — the replay pauses briefly each time it loops.',
  },
  [LINK_STATE.DISCONNECTED]: {
    text: 'Disconnected',
    className: 'status--down',
    banner: true,
    detail: `No connection to ${SERVER_ENDPOINT} — showing last known values. Retrying automatically.`,
  },
}

export function StatusPill({ linkState, tickCount }) {
  const { text, className } = PRESENTATION[linkState] ?? PRESENTATION[LINK_STATE.CONNECTING]
  return (
    <div className={`status ${className}`}>
      <span className="status__dot" />
      <span>{text}</span>
      {tickCount > 0 && <span className="status__ticks">{tickCount} ticks</span>}
    </div>
  )
}

export function StatusBanner({ linkState }) {
  const presentation = PRESENTATION[linkState] ?? PRESENTATION[LINK_STATE.CONNECTING]
  if (!presentation.banner) return null

  return (
    <div className={`banner ${presentation.className}`} role="status">
      <strong>{presentation.text}</strong>
      <span>{presentation.detail}</span>
    </div>
  )
}

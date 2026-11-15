import { BALANCE_FULL_SCALE_DEG_S, BALANCE_NEUTRAL_DEG_S, COLORS } from '../config.js'
import { balancePresentation } from '../lib/handling.js'
import { clamp, formatSigned } from '../lib/vehicle.js'

/**
 * Live understeer / oversteer meter.
 *
 * Zero-centred: the bar grows toward OVERSTEER on the left and UNDERSTEER on
 * the right, from a shaded neutral deadband in the middle. The state word is
 * always shown next to the colour, so the reading never depends on hue alone.
 */
export default function BalanceMeter({ balance, yawRate }) {
  const { isCornering, signedBalance, state, refYawRate } = balance
  const { color, label } = balancePresentation(state)

  const fraction = clamp(signedBalance / BALANCE_FULL_SCALE_DEG_S, -1, 1)
  const fillPct = Math.abs(fraction) * 50
  const growsRight = fraction >= 0 // understeer is the positive/right direction

  // Width of the neutral deadband as a percentage of the whole track.
  const deadbandPct = (BALANCE_NEUTRAL_DEG_S / BALANCE_FULL_SCALE_DEG_S) * 50

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">Handling Balance</h2>
        <span className="panel__unit">deg/s</span>
      </header>

      <div className="balance__poles">
        <span style={{ color: COLORS.oversteer }}>◀ OVERSTEER</span>
        <span style={{ color: COLORS.understeer }}>UNDERSTEER ▶</span>
      </div>

      <div className="balance__track">
        {/* neutral deadband, straddling zero */}
        <div
          className="balance__deadband"
          style={{ left: `${50 - deadbandPct}%`, width: `${deadbandPct * 2}%` }}
        />
        <div className="ay__centerline" />
        {isCornering && (
          <div
            className="balance__fill"
            style={{
              background: color,
              boxShadow: `0 0 18px ${color}55`,
              left: growsRight ? '50%' : `${50 - fillPct}%`,
              width: `${fillPct}%`,
            }}
          />
        )}
      </div>

      <div className="balance__state" style={{ color, borderColor: color }}>
        {isCornering ? label : 'NOT CORNERING'}
      </div>

      <div className="readout" style={{ color: isCornering ? color : COLORS.textDim }}>
        {isCornering ? formatSigned(signedBalance, 1) : '—'}
        <span className="readout__unit">deg/s</span>
      </div>

      {/* The two yaw rates the balance is the difference between, so the reading
          can always be traced back to what the car actually did. */}
      <div className="balance__detail">
        <span className="panel__unit">
          steering wants {isCornering ? formatSigned(refYawRate, 0) : '—'}
        </span>
        <span className="panel__unit">
          car is doing {isCornering ? formatSigned(yawRate, 0) : '—'}
        </span>
      </div>
    </section>
  )
}

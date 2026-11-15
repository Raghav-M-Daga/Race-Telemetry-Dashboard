import { useState } from 'react'
import BalanceMeter from './components/BalanceMeter.jsx'
import CarView from './components/CarView.jsx'
import CoachingView from './components/CoachingView.jsx'
import Compass from './components/Compass.jsx'
import DataGuide from './components/DataGuide.jsx'
import HandlingSignature from './components/HandlingSignature.jsx'
import LateralAccelBar from './components/LateralAccelBar.jsx'
import SteeringGauge from './components/SteeringGauge.jsx'
import YawRateBar from './components/YawRateBar.jsx'
import { StatusBanner, StatusPill } from './components/StatusBanner.jsx'
import { useCarData, LINK_STATE } from './hooks/useCarData.js'
import { useHandlingSignature } from './hooks/useHandlingSignature.js'
import { useCoachingEngine } from './hooks/useCoachingEngine.js'
import { handlingBalance } from './lib/handling.js'
import { estimateCornerLoads } from './lib/vehicle.js'
import './styles.css'

const CORNER_KEYS = ['shock_fl', 'shock_fr', 'shock_rl', 'shock_rr']

/**
 * Three views, and only three.
 *
 * An earlier build shipped a second track map, a corner table, an incident list
 * and a tuning panel. All four were driven by a first-generation analysis that
 * compared the driver against fixed thresholds — 4 degrees of slip is sliding,
 * 135 deg/s is jerky steering — and `engine/` replaced that wholesale with a
 * comparison against the driver's own measured lap-to-lap scatter.
 *
 * Keeping them on screen would have offered the user a choice between one right
 * answer and four wrong ones, so they were removed along with the modules that
 * fed them. The alternative — leaving them in place, unreachable, still
 * recomputing every frame — is worse than either shipping or deleting them.
 */
const VIEWS = [
  { id: 'flags', label: 'Coaching' },
  { id: 'instruments', label: 'Instruments' },
  { id: 'setup', label: 'Car Setup' },
  { id: 'guide', label: 'Data Guide' },
]

export default function App() {
  const [view, setView] = useState('flags')

  const { readings, linkState, tickCount, rawTick } = useCarData()
  const isLive = linkState === LINK_STATE.LIVE

  const balance = handlingBalance(readings)
  const { signature, reset: resetSignature, rejectedTransients } = useHandlingSignature(
    balance, readings.lateralAcceleration, readings.yawRate, isLive,
  )
  const coaching = useCoachingEngine(rawTick, isLive)

  // Real shock channels do not exist in this log (there are no suspension
  // sensor IDs in the stream), so corner load is modelled from lateral
  // acceleration instead — and the view is told it is looking at an estimate.
  const hasRealShockData = CORNER_KEYS.every((key) => readings[key] !== null)
  const cornerLoads = hasRealShockData
    ? Object.fromEntries(CORNER_KEYS.map((key) => [key, readings[key]]))
    : estimateCornerLoads(readings.lateralAcceleration)

  return (
    <div className="app">
      <header className="app__header app__header--slim">
        <div className="app__brand">
          <span className="app__mark" aria-hidden="true" />
          <h1 className="app__title">PER Vehicle Dynamics</h1>
        </div>

        <nav className="tabs" role="tablist">
          {VIEWS.map(({ id, label }) => (
            <button key={id} type="button" role="tab" aria-selected={view === id}
                    className={`tabs__tab ${view === id ? 'tabs__tab--active' : ''}`}
                    onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </nav>

        <StatusPill linkState={linkState} tickCount={tickCount} />
      </header>

      <StatusBanner linkState={linkState} />

      {view === 'flags' && (
        <CoachingView
          analysis={coaching.analysis}
          status={coaching.status}
          onReset={coaching.reset}
        />
      )}

      {view === 'instruments' && (
        <>
          <div className="instruments__compass">
            <Compass heading={readings.globalHeading} headingUnwrapped={readings.headingUnwrapped} />
          </div>
          <main className="app__grid">
            <SteeringGauge angle={readings.steeringAngle} />
            <CarView loads={cornerLoads} steeringAngle={readings.steeringAngle}
                     isEstimated={!hasRealShockData} />
            <LateralAccelBar lateralAcceleration={readings.lateralAcceleration} />
          </main>
          <footer className="app__footer">
            <YawRateBar yawRate={readings.yawRate} />
          </footer>
        </>
      )}

      {view === 'setup' && (
        <section className="app__grid app__grid--handling">
          <BalanceMeter balance={balance} yawRate={readings.yawRate} />
          <HandlingSignature signature={signature} rejectedTransients={rejectedTransients}
                             onReset={resetSignature} />
        </section>
      )}

      {view === 'guide' && <DataGuide />}
    </div>
  )
}

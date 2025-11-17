import React, { useEffect, useRef, useState, Suspense } from 'react'

/*
  Redesigned front-end: Minimal, responsive dashboard shell.
*/

const SmallEMAChart = React.lazy(() => import('./SmallEMAChart'))

function Hero({ title, subtitle }) {
  return (
    <header className="hero">
      <div>
        <h1 className="hero-title">{title}</h1>
        <p className="hero-sub">{subtitle}</p>
      </div>
      {/* Auto-connect enabled; no manual Connect button */}
    </header>
  )
}



function StatCard({ label, value, hint }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}

export default function App() {
  const [connected, setConnected] = useState(false)
  const [lastPrice, setLastPrice] = useState(null)
  const [alerts, setAlerts] = useState([])
  const [emaShort, setEmaShort] = useState(26)
  const [emaLong, setEmaLong] = useState(200)
  const [minutes, setMinutes] = useState(1)
  const price = lastPrice == null ? '' : Number(lastPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })
  const change = ''
  const candles = 0

  const wsRef = useRef(null)
  const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade'
  // App no longer opens a dedicated trade websocket; SmallEMAChart will provide live trade
  // callbacks via the `onTrade` prop so we can update `lastPrice`.

  return (
    <div className="container body-root">
      <Hero title="Binance BTC/USDT" subtitle="1m candles · EMA26 / EMA200" />

      <main className="main-grid">
        <section className="main-chart card">
          <div className="dashboard">
            <div className="price-row">
              <div>
                <div className="price">{price}</div>
                <div className="chg">{change}</div>
              </div>
            </div>

            {/* small EMA chart under the price
                Render behind a user toggle and React.Suspense so we can
                enable it step-by-step and capture any initialization errors. */}
            <div style={{marginTop: 8}}>
              <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:8}}>
                <label style={{fontSize:13,color:'var(--muted)'}}>EMA1:</label>
                <input type="number" min={1} value={emaShort} onChange={e=>setEmaShort(Number(e.target.value)||1)} style={{width:72,padding:6,borderRadius:6,border:'1px solid rgba(255,255,255,0.04)'}} />
                <label style={{fontSize:13,color:'var(--muted)'}}>EMA2:</label>
                <input type="number" min={1} value={emaLong} onChange={e=>setEmaLong(Number(e.target.value)||1)} style={{width:72,padding:6,borderRadius:6,border:'1px solid rgba(255,255,255,0.04)'}} />
                <label style={{fontSize:13,color:'var(--muted)'}}>Minutes:</label>
                <input type="number" min={1} value={minutes} onChange={e=>setMinutes(Number(e.target.value)||1)} style={{width:72,padding:6,borderRadius:6,border:'1px solid rgba(255,255,255,0.04)'}} />
              </div>
              <ChartToggle
                livePrice={lastPrice}
                onTrade={setLastPrice}
                onCross={(c) => setAlerts(prev => [{ id: Date.now(), ...c }, ...prev].slice(0, 50))}
                emaShort={emaShort}
                emaLong={emaLong}
                minutes={minutes}
              />
            </div>
          </div>
        </section>

        <aside className="sidebar card">
          <div className="sidebar-inner">
            <h3 style={{marginTop:0}}>Cross Alerts</h3>
            <div className="meta">
              {alerts && alerts.length > 0 ? (
                <ul className="alerts">
                  {alerts.map(a => (
                    <li key={a.id} className="alert-item">
                      <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
                        <div>
                          <strong className={a.type === 'bull' ? 'bull' : 'bear'}>
                            {a.type === 'bull' ? 'Bull' : 'Bear'} Cross
                          </strong>
                          <div style={{fontSize:12,color:'var(--muted)'}}>
                            {new Date(a.time).toLocaleString()} — {Number(a.price).toLocaleString(undefined,{maximumFractionDigits:2})}
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                'No alerts yet.'
              )}
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}

function ChartToggle({ livePrice, onTrade, onCross, emaShort = 26, emaLong = 200, minutes = 1 }) {
  const interval = `${Math.max(1, Number(minutes||1))}m`
  return (
    <Suspense fallback={<div className="meta">Loading chart...</div>}>
      <SmallEMAChart
        interval={interval}
        limit={300}
        livePrice={livePrice}
        onTrade={onTrade}
        onCross={onCross}
        emaShort={Number(emaShort)||26}
        emaLong={Number(emaLong)||200}
      />
    </Suspense>
  )
}


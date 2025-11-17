import React, { useEffect, useRef, useState } from 'react'
// Charting removed by user request — no external chart library imported

const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade'

function formatNumber(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function DashboardCard({ candles = [], displayPrice, lastPrice, ema26, ema200, connected, startWs, stopWs }) {
  const items = (candles || []).slice(-60).map(d => d.close).filter(v => typeof v === 'number')
  const points = []
  const w = 320, h = 72, pad = 6
  if (items.length > 0) {
    const min = Math.min(...items)
    const max = Math.max(...items)
    const range = Math.max(1e-6, max - min)
    items.forEach((v, i) => {
      const x = pad + (i / Math.max(1, items.length - 1)) * (w - pad * 2)
      const y = pad + (1 - (v - min) / range) * (h - pad * 2)
      points.push([x, y])
    })
  }
  const last = items.length ? items[items.length - 1] : (displayPrice ?? lastPrice)
  const first = items.length ? items[0] : last
  const changePct = (first && last) ? ((last - first) / first * 100) : 0
  const up = changePct >= 0

  return (
    <div className="dashboard">
      <div className="price-row">
        <div>
          <div className="price">{(displayPrice == null && lastPrice == null) ? '—' : formatNumber(displayPrice ?? lastPrice)}</div>
          <div className="chg">{up ? '▲' : '▼'} {changePct ? Math.abs(changePct).toFixed(2) + '%' : '—'}</div>
        </div>
        <div style={{marginLeft:16}}>
          <div className="small">EMA26: {ema26 == null ? '—' : formatNumber(ema26)}</div>
          <div className="small">EMA200: {ema200 == null ? '—' : formatNumber(ema200)}</div>
        </div>
        <div style={{marginLeft:'auto', textAlign:'right'}}>
          <div className="small">Status:</div>
          <div style={{marginTop:6}}><span className="status" style={{background: connected ? 'var(--success)' : '#3b1b1b'}}>{connected ? 'Connected' : 'Disconnected'}</span></div>
        </div>
      </div>

      <div className="sparkline" aria-hidden>
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          <rect x={0} y={0} width={w} height={h} fill="transparent" />
          {points.length > 0 && (
            <polyline
              points={points.map(p => p.join(',')).join(' ')}
              fill="none"
              stroke={up ? 'var(--success)' : 'var(--danger)'}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="label">Latest</div>
          <div className="value">{(displayPrice == null && lastPrice == null) ? '—' : formatNumber(displayPrice ?? lastPrice)}</div>
        </div>
        <div className="stat">
          <div className="label">Change (span)</div>
          <div className="value" style={{color: up ? 'var(--success)' : 'var(--danger)'}}>{up ? '+' : '-'}{Math.abs(changePct).toFixed(2)}%</div>
        </div>
        <div className="stat">
          <div className="label">Candles</div>
          <div className="value">{candles.length}</div>
        </div>
        <div style={{marginLeft:12}}>
          <button className="btn" onClick={() => connected ? stopWs() : startWs()}>{connected ? 'Stop' : 'Start'}</button>
        </div>
      </div>
    </div>
  )
}

function TopBar({ title, subtitle, displayPrice, lastPrice, ema26, ema200, connected, startWs, stopWs }) {
  return (
    <div className="header">
      <div>
        <div className="title">{title}</div>
        <div className="top-meta">{subtitle}</div>
        <div style={{marginTop:6}}>
          <span className="meta" style={{marginRight:12}}>EMA26: {ema26 == null ? '—' : formatNumber(ema26)}</span>
          <span className="meta" style={{marginRight:12}}>EMA200: {ema200 == null ? '—' : formatNumber(ema200)}</span>
        </div>
      </div>
      <div style={{textAlign:'right'}}>
        <div className="price">{(displayPrice == null && lastPrice == null) ? '—' : formatNumber(displayPrice ?? lastPrice)}</div>
        <div style={{marginTop:8}}>
          <span className="meta">Status: <span className="status" style={{background: connected ? 'var(--success)' : '#3b1b1b'}}>{connected ? 'Connected' : 'Disconnected'}</span></span>
        </div>
        <div style={{marginTop:8}}>
          <button className="btn" onClick={() => connected ? stopWs() : startWs()}>{connected ? 'Stop' : 'Start'}</button>
        </div>
      </div>
    </div>
  )
}

function AlertsList({ alerts = [] }) {
  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center', marginBottom:8}}>
        <div><strong>Cross Alerts (5m)</strong></div>
        <div className="meta">Latest first (keeps 50)</div>
      </div>
      <ul className="alerts">
        {alerts.length === 0 && <li className="alert-item meta">No crosses detected yet.</li>}
        {alerts.map((a, i) => (
          <li key={i} className="alert-item">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <span className={a.type === 'bull' ? 'bull' : 'bear'}>{a.type === 'bull' ? 'Bull Cross ▲' : 'Bear Cross ▼'}</span>
                &nbsp; @ {a.price ? formatNumber(a.price) : '—'}
                <div className="meta">{new Date(a.time).toLocaleString()}</div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// floor ms timestamp to 5-minute bucket start (in seconds)
function floorTo5MinSec(ms) {
  return Math.floor(ms / 1000 / 300) * 300
}

export default function App() {
  // Use internal chart renderer (Lightweight) by default
  const [connected, setConnected] = useState(false)
  const [lastPrice, setLastPrice] = useState(null)
  const [displayPrice, setDisplayPrice] = useState(null)
  const [alerts, setAlerts] = useState([])

  // candles = array of { time: unixSeconds, open, high, low, close }
  const [candles, setCandles] = useState([])
  const candlesRef = useRef([])

  // EMA values (based on closed 5-min candle closes)
  const [ema26, setEma26] = useState(null)
  const [ema200, setEma200] = useState(null)
  const prevDiffRef = useRef(null)
  const ema26Ref = useRef(null)
  const ema200Ref = useRef(null)
  // live (tick-based) EMA values for immediate visual feedback
  const [liveEma26, setLiveEma26] = useState(null)
  const [liveEma200, setLiveEma200] = useState(null)
  const liveEma26Ref = useRef(null)
  const liveEma200Ref = useRef(null)

  const wsRef = useRef(null)
  const currentCandleRef = useRef(null)
  // batch updates to UI per animation frame to avoid excessive re-renders
  const pendingFrameRef = useRef(null)
  const latestTempRef = useRef(null)

  // No external TradingView widget used; we render charts locally

  // EMA smoothing factors for period counts (periods are number of 5-min candles)
  const alpha26 = 2 / (26 + 1)
  const alpha200 = 2 / (200 + 1)
  // live (tick) EMA smoothing factors (higher alpha => more responsive)
  // you can tune these for faster (larger) or smoother (smaller) live EMA behavior
  // make live EMA a bit smoother to avoid jagged lines in the chart
  const alphaLive26 = 0.12 // smoother live-reacting EMA for 26
  const alphaLive200 = 0.02 // smoother live EMA for 200

  useEffect(() => { candlesRef.current = candles }, [candles])

  useEffect(() => {
    startWs()
    return () => stopWs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function startWs() {
    if (wsRef.current) return
    const ws = new WebSocket(BINANCE_WS)
    wsRef.current = ws
    ws.onopen = () => setConnected(true)
    ws.onclose = () => { setConnected(false); wsRef.current = null }
    ws.onerror = (e) => console.error('ws err', e)
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data)
        const price = parseFloat(d.p)
        const ts = d.T || Date.now()
        if (!isFinite(price)) return
        setLastPrice(price)

        // schedule a fast UI update (batched via rAF) to reflect live trades
        function scheduleRenderUpdate(tempCandle) {
          // always keep the latest temp in ref for the rAF update
          latestTempRef.current = tempCandle

          // Batch price + live EMA + last-candle update together in rAF
          // so displayed price and chart move in lock-step.
          if (pendingFrameRef.current) return
          pendingFrameRef.current = window.requestAnimationFrame(() => {
            pendingFrameRef.current = null
            import React from 'react'

            /*
              Redesigned front-end: Minimal, responsive dashboard shell.
              - Removed real-time websocket and heavy charting logic per request.
              - This app provides a clean, mobile-first layout that you can iterate on.
            */

            function Hero({ title, subtitle }) {
              return (
                <header className="hero">
                  <div>
                    <h1 className="hero-title">{title}</h1>
                    <p className="hero-sub">{subtitle}</p>
                  </div>
                  <nav className="hero-actions">
                    <button className="btn secondary">Connect</button>
                  </nav>
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
              // Placeholder data for the redesigned shell
              const price = '—'
              const change = '—'
              const candles = 0

              return (
                <div className="container body-root">
                  <Hero title="Binance BTC/USDT" subtitle="5m candles · EMA26 / EMA200" />

                  <main className="main-grid">
                    <section className="main-chart card">
                      <div className="dashboard">
                        <div className="price-row">
                          <div>
                            <div className="price">{price}</div>
                            <div className="chg">{change}</div>
                          </div>
                        </div>

                        <div className="dashboard-body">
                          <div className="stats">
                            <StatCard label="Latest" value={price} />
                            <StatCard label="Change" value={change} />
                            <StatCard label="Candles" value={candles} />
                          </div>
                          <div style={{marginTop:12}} className="small meta">This is a redesigned front-end shell. Connect live data or add features as needed.</div>
                        </div>
                      </div>
                    </section>

                    <aside className="sidebar card">
                      <div className="sidebar-inner">
                        <h3 style={{marginTop:0}}>Cross Alerts</h3>
                        <div className="meta">No alerts yet.</div>
                      </div>
                    </aside>
                  </main>
                </div>
              )
            }
              if (prevDiff <= 0 && diff > 0) {

                const item = { type: 'bull', price: close, time: new Date(closed.time * 1000).toISOString() }

import React, { useEffect, useRef, useState } from 'react'

/*
  Redesigned front-end: Minimal, responsive dashboard shell.
  - No websocket or charting logic included here.
  - Edit this file to reintroduce data sources or features.
*/

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
  const price = lastPrice == null ? '—' : Number(lastPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })
  const change = '—'
  const candles = 0

  const wsRef = useRef(null)
  const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade'

  useEffect(() => {
    // auto-start websocket on mount
    startWs()
    return () => stopWs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function startWs() {
    if (wsRef.current) return
    try {
      const ws = new WebSocket(BINANCE_WS)
      wsRef.current = ws
      ws.onopen = () => setConnected(true)
      ws.onclose = () => { setConnected(false); wsRef.current = null }
      ws.onerror = (e) => console.warn('ws err', e)
      ws.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data)
          const price = parseFloat(d.p)
          if (isFinite(price)) setLastPrice(price)
        } catch (err) {
          // ignore parse errors
        }
      }
    } catch (err) {
      console.warn('ws start failed', err)
    }
  }

  function stopWs() {
    if (wsRef.current) {
      try { wsRef.current.close() } catch (e) {}
      wsRef.current = null
    }
    setConnected(false)
  }

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

            {/* dashboard-body removed per user request */}
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


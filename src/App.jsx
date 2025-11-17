import React, { useEffect, useRef, useState } from 'react'

const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade'

function formatNumber(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export default function App() {
  const [connected, setConnected] = useState(false)
  const [price, setPrice] = useState(null)
  const [ema26, setEma26] = useState(null)
  const [ema200, setEma200] = useState(null)
  const [alerts, setAlerts] = useState([])

  const wsRef = useRef(null)
  const prevDiffRef = useRef(null)

  // EMA smoothing factors
  const alpha26 = 2 / (26 + 1)
  const alpha200 = 2 / (200 + 1)

  useEffect(() => {
    startWs()
    return () => stopWs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function startWs() {
    if (wsRef.current) return
    const ws = new WebSocket(BINANCE_WS)
    wsRef.current = ws
    ws.onopen = () => {
      setConnected(true)
    }
    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
    }
    ws.onerror = (e) => {
      console.error('WebSocket error', e)
    }
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data)
        // trade stream: price field 'p'
        const p = parseFloat(d.p)
        if (!isFinite(p)) return
        setPrice(p)

        // update EMA
        setEma26(prev => {
          const next = prev == null ? p : alpha26 * p + (1 - alpha26) * prev
          return next
        })
        setEma200(prev => {
          const next = prev == null ? p : alpha200 * p + (1 - alpha200) * prev
          return next
        })

        // handle cross detection after both EMAs updated; use refs to read previous values
        // We can't read updated state immediately here; instead compute locally
        // Use previous EMA refs stored in prevEmaRef
        // We'll maintain previous EMA values via a small local ref
        // For simplicity, compute predicted next values based on last known state
        // Read last known EMA values from refs via closure
      } catch (err) {
        console.error('parse', err)
      }
    }
  }

  // Keep refs in sync with state and detect crosses
  const ema26Ref = useRef(ema26)
  const ema200Ref = useRef(ema200)
  useEffect(() => { ema26Ref.current = ema26 }, [ema26])
  useEffect(() => { ema200Ref.current = ema200 }, [ema200])

  // detect crosses whenever either EMA changes
  useEffect(() => {
    const e26 = ema26Ref.current
    const e200 = ema200Ref.current
    if (e26 == null || e200 == null) return
    const diff = e26 - e200
    const prevDiff = prevDiffRef.current
    if (prevDiff == null) {
      prevDiffRef.current = diff
      return
    }
    if (prevDiff <= 0 && diff > 0) {
      // bull cross
      const item = { type: 'bull', price, time: new Date().toISOString() }
      setAlerts(a => [item, ...a].slice(0, 50))
    } else if (prevDiff >= 0 && diff < 0) {
      // bear cross
      const item = { type: 'bear', price, time: new Date().toISOString() }
      setAlerts(a => [item, ...a].slice(0, 50))
    }
    prevDiffRef.current = diff
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ema26, ema200, price])

  function stopWs() {
    if (wsRef.current) {
      try { wsRef.current.close() } catch (e) {}
      wsRef.current = null
    }
    setConnected(false)
  }

  return (
    <div className="container">
      <h2>Binance BTC/USDT — Live + EMA26/200</h2>

      <div className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div className="price">{price == null ? '—' : `$ ${formatNumber(price)}`}</div>
            <div className="meta">Real-time trade price from Binance</div>
          </div>
          <div style={{textAlign:'right'}}>
            <div>Status: <span className="status" style={{background: connected ? '#063f19' : '#3b1b1b'}}>{connected ? 'Connected' : 'Disconnected'}</span></div>
            <div style={{marginTop:8}}>
              <button className="btn" onClick={() => connected ? stopWs() : startWs()}>{connected ? 'Stop' : 'Start'}</button>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div><strong>EMA(26):</strong> {ema26 == null ? '—' : `$ ${formatNumber(ema26)}`}</div>
        <div><strong>EMA(200):</strong> {ema200 == null ? '—' : `$ ${formatNumber(ema200)}`}</div>
        <div style={{marginTop:8}} className="meta">EMA smoothing: 26 & 200 periods (computed per incoming tick)</div>
      </div>

      <div className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div><strong>Cross Alerts</strong></div>
          <div className="meta">Latest first (keeps 50)</div>
        </div>
        <ul className="alerts">
          {alerts.length === 0 && <li className="alert-item meta">No crosses detected yet.</li>}
          {alerts.map((a, i) => (
            <li key={i} className="alert-item">
              <span className={a.type === 'bull' ? 'bull' : 'bear'}>{a.type === 'bull' ? 'Bull Cross ▲' : 'Bear Cross ▼'}</span>
              &nbsp; @ {a.price ? `$ ${formatNumber(a.price)}` : '—'}
              <div className="meta">{new Date(a.time).toLocaleString()}</div>
            </li>
          ))}
        </ul>
      </div>

      <div className="card meta">
        Note: This demo uses each incoming trade tick as one sample. For production use, consider aggregating by interval (1m/5m), initializing EMA with SMA, and storing history.
      </div>
    </div>
  )
}

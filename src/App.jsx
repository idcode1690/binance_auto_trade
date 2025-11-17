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
            const temp = latestTempRef.current
            if (!temp) return

            // update last candle in state without re-computing full history
            setCandles(prev => {
              const base = prev.slice()
              if (base.length === 0 || base[base.length - 1].time !== temp.time) {
                base.push(temp)
              } else {
                base[base.length - 1] = temp
              }
              return base
            })

            // update displayed price and live EMA values together (keeps them identical)
            try {
              setDisplayPrice(temp.close)
              if (temp._liveEma26 != null) {
                liveEma26Ref.current = temp._liveEma26
                setLiveEma26(temp._liveEma26)
              }
              if (temp._liveEma200 != null) {
                liveEma200Ref.current = temp._liveEma200
                setLiveEma200(temp._liveEma200)
              }

            } catch (e) {
              // ignore
            }
          })
        }

        // update current 5-min candle
        const bucket = floorTo5MinSec(ts)
        const prev = currentCandleRef.current
        if (!prev || prev.time !== bucket) {
          // close previous candle (if exists)
          if (prev) {
            // push closed candle
            const closed = { ...prev }
            // compute EMAs on closed candle close using refs (deterministic)
            const close = closed.close
            const prevE26 = ema26Ref.current
            const prevE200 = ema200Ref.current
            const nextE26 = prevE26 == null ? close : alpha26 * close + (1 - alpha26) * prevE26
            const nextE200 = prevE200 == null ? close : alpha200 * close + (1 - alpha200) * prevE200

            // update refs and state
            ema26Ref.current = nextE26
            ema200Ref.current = nextE200
            setEma26(nextE26)
            setEma200(nextE200)

            // attach EMA values to closed candle and replace last entry
            // (if it already represents the same time) or push otherwise.
            // This prevents duplicating a closed candle and ensures the
            // live/current candle remains at the right-most position.
            closed.ema26 = nextE26
            closed.ema200 = nextE200
            setCandles(cs => {
              const out = cs.slice()
              if (out.length > 0 && out[out.length - 1].time === closed.time) {
                out[out.length - 1] = closed
              } else {
                out.push(closed)
              }
              return out
            })

            // detect cross right here based on closed candle EMAs
            if (prevE26 != null && prevE200 != null) {
              const prevDiff = prevE26 - prevE200
              const diff = nextE26 - nextE200
              if (prevDiff <= 0 && diff > 0) {
                const item = { type: 'bull', price: close, time: new Date(closed.time * 1000).toISOString() }
                setAlerts(a => [item, ...a].slice(0, 50))
              } else if (prevDiff >= 0 && diff < 0) {
                const item = { type: 'bear', price: close, time: new Date(closed.time * 1000).toISOString() }
                setAlerts(a => [item, ...a].slice(0, 50))
              }
            }
          }
          // start new candle
          currentCandleRef.current = { time: bucket, open: price, high: price, low: price, close: price }
          // compute live EMAs (tick-based) using latest live refs
          const prevLive26 = liveEma26Ref.current
          const prevLive200 = liveEma200Ref.current
          const liveNext26 = prevLive26 == null ? price : alphaLive26 * price + (1 - alphaLive26) * prevLive26
          const liveNext200 = prevLive200 == null ? price : alphaLive200 * price + (1 - alphaLive200) * prevLive200
          liveEma26Ref.current = liveNext26
          liveEma200Ref.current = liveNext200
          setLiveEma26(liveNext26)
          setLiveEma200(liveNext200)
          // also schedule immediate UI update for new candle (include live EMA)
          // compute intra-bar progress [0..1] for smoother live EMA interpolation
          const progress = Math.min(1, Math.max(0, (ts / 1000 - bucket) / 300))
          scheduleRenderUpdate({ ...currentCandleRef.current, ema26: ema26, ema200: ema200, _liveEma26: liveNext26, _liveEma200: liveNext200, _progress: progress })
        } else {
          // update existing candle
          const c = { ...currentCandleRef.current }
          c.close = price
          c.high = Math.max(c.high, price)
          c.low = Math.min(c.low, price)
          currentCandleRef.current = c
          // update live EMAs with this tick price
          const prevLive26 = liveEma26Ref.current
          const prevLive200 = liveEma200Ref.current
          const liveNext26 = prevLive26 == null ? price : alphaLive26 * price + (1 - alphaLive26) * prevLive26
          const liveNext200 = prevLive200 == null ? price : alphaLive200 * price + (1 - alphaLive200) * prevLive200
          liveEma26Ref.current = liveNext26
          liveEma200Ref.current = liveNext200
          setLiveEma26(liveNext26)
          setLiveEma200(liveNext200)
          // schedule immediate UI update for the updated candle (include live EMA)
          const progress = Math.min(1, Math.max(0, (ts / 1000 - bucket) / 300))
          scheduleRenderUpdate({ ...c, ema26: ema26, ema200: ema200, _liveEma26: liveNext26, _liveEma200: liveNext200, _progress: progress })
        }
      } catch (err) { console.error('parse', err) }
    }
  }

  // Previously we attached EMAs in an effect; EMAs and crosses are now computed synchronously
  // when a 5-minute candle closes to ensure crosses are based on closed candles only.

  function stopWs() {
    if (wsRef.current) {
      try { wsRef.current.close() } catch (e) {}
      wsRef.current = null
    }
    setConnected(false)
  }

  // The UI now updates via the WebSocket -> scheduleRenderUpdate rAF batch.
  // Removed the separate 250ms interval sync so price and chart are updated
  // together in the same animation frame for identical timing.

  // No TradingView auto-load: we always use local LightweightChart

  // TradingView removed: charting is handled entirely by LightweightChart component

  // Load recent historical 5m candles from Binance REST API on mount
  useEffect(() => {
    let cancelled = false
    async function fetchHistory() {
      try {
        const resp = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=200')
        if (!resp.ok) throw new Error(`klines fetch failed: ${resp.status}`)
        const data = await resp.json()
        // data format: [ [ openTime, open, high, low, close, ... ], ... ]
        const parsed = data.map(item => {
          const openTimeMs = item[0]
          return {
            time: Math.floor(openTimeMs / 1000),
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
            // ema placeholders
            ema26: null,
            ema200: null,
          }
        })

        // compute EMA series over closes
        let prev26 = null
        let prev200 = null
        const alpha26Local = 2 / (26 + 1)
        const alpha200Local = 2 / (200 + 1)
        for (let i = 0; i < parsed.length; i++) {
          const close = parsed[i].close
          prev26 = prev26 == null ? close : alpha26Local * close + (1 - alpha26Local) * prev26
          prev200 = prev200 == null ? close : alpha200Local * close + (1 - alpha200Local) * prev200
          parsed[i].ema26 = prev26
          parsed[i].ema200 = prev200
        }

        if (cancelled) return
        // set refs and state
        ema26Ref.current = prev26
        ema200Ref.current = prev200
        setEma26(prev26)
        setEma200(prev200)
        setCandles(parsed)
        // initialize displayed price to the most recent close so price and chart start synced
        try {
          const last = parsed[parsed.length - 1]
          if (last && last.close != null) {
            setDisplayPrice(last.close)
            setLastPrice(last.close)
          }

          // Create an in-progress (live) candle from the most recent closed candle
          // so the chart immediately shows the current bar (rather than waiting
          // for the first incoming websocket tick after load).
          try {
            const now = Date.now()
            const currentBucket = floorTo5MinSec(now)
            if (last && last.time < currentBucket) {
              const temp = { time: currentBucket, open: last.close, high: last.close, low: last.close, close: last.close }
              // initialize live EMA refs based on closed EMAs so live lines start coherent
              const prevLive26 = ema26Ref.current
              const prevLive200 = ema200Ref.current
              const liveNext26 = prevLive26 == null ? temp.close : alphaLive26 * temp.close + (1 - alphaLive26) * prevLive26
              const liveNext200 = prevLive200 == null ? temp.close : alphaLive200 * temp.close + (1 - alphaLive200) * prevLive200
              liveEma26Ref.current = liveNext26
              liveEma200Ref.current = liveNext200
              setLiveEma26(liveNext26)
              setLiveEma200(liveNext200)

              // push temp candle onto the existing parsed history so chart renders it
              setCandles(cs => {
                const out = cs.slice()
                if (out.length === 0 || out[out.length - 1].time !== temp.time) out.push(temp)
                else out[out.length - 1] = temp
                return out
              })
              // set ref so subsequent websocket logic will update/close it properly
              currentCandleRef.current = temp
            }
          } catch (e) { /* ignore */ }
        } catch (e) {}
      } catch (err) {
        console.warn('failed to fetch klines', err)
      }
    }
    fetchHistory()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="container body-root">
      <TopBar
        title={"Binance BTC/USDT — 5m Candles + EMA26/200"}
        subtitle={"Real-time trade price from Binance (aggregated to 5m candles)"}
        displayPrice={displayPrice}
        lastPrice={lastPrice}
        ema26={ema26}
        ema200={ema200}
        connected={connected}
        startWs={startWs}
        stopWs={stopWs}
      />

      <div className="main-grid">
          <div className="main-chart card no-frame">
            <DashboardCard
              candles={candles}
              displayPrice={displayPrice}
              lastPrice={lastPrice}
              ema26={ema26}
              ema200={ema200}
              connected={connected}
              startWs={startWs}
              stopWs={stopWs}
            />
          </div>

        <aside className="sidebar">
          <AlertsList alerts={alerts} />
        </aside>
      </div>
    </div>
  )
}


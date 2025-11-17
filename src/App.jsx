import React, { useEffect, useRef, useState } from 'react'

const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade'

function formatNumber(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

// floor ms timestamp to 5-minute bucket start (in seconds)
function floorTo5MinSec(ms) {
  return Math.floor(ms / 1000 / 300) * 300
}

export default function App() {
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

  const wsRef = useRef(null)
  const currentCandleRef = useRef(null)

  // TradingView diagnostics state (visible fallback if script blocked)
  const [tvLoaded, setTvLoaded] = useState(false)
  const [tvError, setTvError] = useState(null)
  const [tvLoading, setTvLoading] = useState(false)

  // EMA smoothing factors for period counts (periods are number of 5-min candles)
  const alpha26 = 2 / (26 + 1)
  const alpha200 = 2 / (200 + 1)

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

            // attach EMA values to closed candle and push
            closed.ema26 = nextE26
            closed.ema200 = nextE200
            setCandles(cs => {
              const withEMA = [...cs, closed]
              return withEMA
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
        } else {
          // update existing candle
          const c = { ...currentCandleRef.current }
          c.close = price
          c.high = Math.max(c.high, price)
          c.low = Math.min(c.low, price)
          currentCandleRef.current = c
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

  // expose latest in-chart current candle (not yet closed)
  useEffect(() => {
    const interval = setInterval(() => {
      const cur = currentCandleRef.current
      if (!cur) return
      // reflect the current open/high/low/close as the last candle on chart (don't commit to state)
      const combined = [...candlesRef.current]
        if (combined.length === 0 || combined[combined.length - 1].time !== cur.time) {
        // push-temporary
        const temp = { ...cur }
        // attach ema placeholders if available
        temp.ema26 = ema26
        temp.ema200 = ema200
        const data = [...combined, temp]
        setCandles(data)
          // keep displayed price in sync with the in-chart current candle
          setDisplayPrice(temp.close)
      } else {
        const last = { ...combined[combined.length - 1], ...cur }
        last.ema26 = ema26
        last.ema200 = ema200
        const data = [...combined.slice(0, -1), last]
        setCandles(data)
          // keep displayed price in sync with the in-chart current candle
          setDisplayPrice(last.close)
      }
    }, 1000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ema26, ema200])

  // TradingView load effect: initialize widget or fall back to internal chart
  useEffect(() => {
    // Try to auto-load TradingView script once on mount, but do it safely.
    // If the load fails (CSP/blocked/parentNode issues), we fall back to the internal SVG chart.
    let cancelled = false
    async function tryAutoLoad() {
      // small delay to let the DOM settle
      await new Promise(r => setTimeout(r, 250))
      if (cancelled) return
      attemptLoadTradingView().catch(err => {
        if (cancelled) return
        console.warn('TradingView auto-load failed', err)
        setTvError(err && err.message ? err.message : String(err))
        setTvLoaded(false)
      })
    }
    tryAutoLoad()
    return () => { cancelled = true }
  }, [])

  // load script helper: tries local first, then CDN; resolves when script loaded
  async function loadTvScript() {
    if (window.TradingView) return // already present
    const trySrcs = [
      // local copy (relative path) - may not be available on GitHub Pages if publishing mismatch
      './tv.js',
      // official CDN fallback
      'https://s3.tradingview.com/tv.js',
      'https://s.tradingview.com/tv.js'
    ]
    for (const src of trySrcs) {
      try {
        await new Promise((resolve, reject) => {
          const existing = Array.from(document.getElementsByTagName('script')).find(s => s.src && s.src.indexOf(src) !== -1)
          if (existing) {
            existing.addEventListener('load', () => resolve())
            existing.addEventListener('error', () => reject(new Error('script load error')))
            // if it's already complete, resolve
            if ((existing.readyState && /loaded|complete/.test(existing.readyState)) || existing.dataset.loaded === '1') return resolve()
            return
          }
          const s = document.createElement('script')
          s.type = 'text/javascript'
          s.src = src
          s.async = true
          s.crossOrigin = 'anonymous'
          s.onload = () => { s.dataset.loaded = '1'; resolve() }
          s.onerror = () => reject(new Error('failed to load ' + src))
          document.head.appendChild(s)
        })
        // loaded, ensure TradingView exists
        if (window.TradingView) return
      } catch (err) {
        console.warn('tv script load failed for', src, err)
        // try next source
      }
    }
    throw new Error('tvjs-not-found')
  }

  // Wait for the chart container to have a parentNode and be attached
  function waitForContainer(maxRetries = 10, delayMs = 200) {
    return new Promise((resolve, reject) => {
      let attempts = 0
      function check() {
        const el = document.getElementById('tradingview_chart')
        if (el && el.parentNode) return resolve(el)
        attempts++
        if (attempts >= maxRetries) return reject(new Error('container-missing'))
        setTimeout(check, delayMs)
      }
      check()
    })
  }

  async function initTradingViewWidget() {
    // Ensure global TradingView is available and container exists
    await waitForContainer()
    if (!window.TradingView || !window.TradingView.widget) throw new Error('tradingview-api-missing')
    try {
      // create a lightweight widget; options are intentionally conservative
      new window.TradingView.widget({
        container_id: 'tradingview_chart',
        autosize: true,
        symbol: 'BINANCE:BTCUSDT',
        interval: '5',
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        toolbar_bg: '#0b2033',
        hide_side_toolbar: false,
        allow_symbol_change: false,
        studies: [],
      })
      setTvLoaded(true)
      setTvError(null)
    } catch (err) {
      throw err
    }
  }

  async function attemptLoadTradingView() {
    if (tvLoaded) return
    setTvLoading(true)
    setTvError(null)
    try {
      await loadTvScript()
      await initTradingViewWidget()
    } finally {
      setTvLoading(false)
    }
  }

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
      } catch (err) {
        console.warn('failed to fetch klines', err)
      }
    }
    fetchHistory()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="container body-root">
      <h2>Binance BTC/USDT — 5m Candles + EMA26/200</h2>

      <div className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div className="price">{(displayPrice == null && lastPrice == null) ? '—' : formatNumber(displayPrice ?? lastPrice)}</div>
            <div className="meta">Real-time trade price from Binance (aggregated to 5m candles)</div>
          </div>
          <div style={{textAlign:'right'}}>
            <div>Status: <span className="status" style={{background: connected ? '#063f19' : '#3b1b1b'}}>{connected ? 'Connected' : 'Disconnected'}</span></div>
            <div style={{marginTop:8}}>
              <button className="btn" onClick={() => connected ? stopWs() : startWs()}>{connected ? 'Stop' : 'Start'}</button>
            </div>
          </div>
        </div>
      </div>

      <div className="card no-frame">
        {/* Always render the TradingView container so the tv.js script can find it when it runs. */}
        <div id="tradingview_chart" style={{width:'100%', height:'100%', display: tvLoaded && !tvError ? 'block' : 'none'}} />

        {/* Show fallback chart and diagnostics when TradingView isn't initialized */}
        {(!tvLoaded || tvError) && (
          <div>
            <div style={{marginBottom:8}}>
              <strong>Chart:</strong>
              {tvLoaded ? (
                <span style={{marginLeft:8, color:'#9ca3af'}}>TradingView initialized</span>
              ) : tvError ? (
                <span style={{marginLeft:8, color:'#f87171'}}>TradingView failed: {tvError}</span>
              ) : tvLoading ? (
                <span style={{marginLeft:8, color:'#fbbf24'}}>Loading TradingView...</span>
              ) : (
                <span style={{marginLeft:8, color:'#fbbf24'}}>Loading TradingView...</span>
              )}

              {/* Allow user to attempt to load TradingView if automatic load failed */}
              {!tvLoaded && (
                <div style={{display:'inline-block', marginLeft:12}}>
                  <button className="btn" onClick={() => attemptLoadTradingView()} disabled={tvLoading}>
                    {tvLoading ? 'Loading...' : (tvError ? 'Try TradingView' : 'Load TradingView')}
                  </button>
                </div>
              )}
            </div>
            <CandlestickChart data={candles} height={Math.max(300, (typeof window !== 'undefined' ? window.innerHeight - 220 : 360))} />
            <div style={{marginTop:8, fontSize:12, color:'#9ca3af'}}>
              If the chart is blank, open DevTools → Console/Network to check for errors or blocked
              external scripts (TradingView). This page will show a fallback candlestick chart.
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div><strong>Cross Alerts (5m)</strong></div>
          <div className="meta">Latest first (keeps 50)</div>
        </div>
        <ul className="alerts">
          {alerts.length === 0 && <li className="alert-item meta">No crosses detected yet.</li>}
          {alerts.map((a, i) => (
            <li key={i} className="alert-item">
              <span className={a.type === 'bull' ? 'bull' : 'bear'}>{a.type === 'bull' ? 'Bull Cross ▲' : 'Bear Cross ▼'}</span>
              &nbsp; @ {a.price ? formatNumber(a.price) : '—'}
              <div className="meta">{new Date(a.time).toLocaleString()}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function CandlestickChart({ data = [], height = 360 }) {
  const ref = useRef(null)
  const [width, setWidth] = useState(800)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pad = 10
  const w = Math.max(300, width)
  const h = height

  if (!data || data.length === 0) {
    return <div ref={ref} style={{height}} className="meta">No 5m candle data yet.</div>
  }

  // compute bounds
  const prices = []
  data.forEach(d => { prices.push(d.high); prices.push(d.low) })
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const range = max - min || 1

  const barWidth = Math.max(2, Math.floor((w - pad * 2) / data.length * 0.8))
  const gap = Math.max(1, Math.floor((w - pad * 2) / data.length) - barWidth)

  const yFor = v => {
    const p = (v - min) / range
    return h - pad - p * (h - pad * 2)
  }

  // EMA polylines
  const ema26Points = []
  const ema200Points = []

  return (
    <div ref={ref} style={{width:'100%'}}>
      <svg width={w} height={h}>
        <rect x={0} y={0} width={w} height={h} fill="#071126" />
        {data.map((d, i) => {
          const x = pad + i * (barWidth + gap)
          const openY = yFor(d.open)
          const closeY = yFor(d.close)
          const highY = yFor(d.high)
          const lowY = yFor(d.low)
          const bodyTop = Math.min(openY, closeY)
          const bodyHeight = Math.max(1, Math.abs(closeY - openY))
          const up = d.close >= d.open
          const color = up ? '#16a34a' : '#dc2626'
          // wick
          return (
            <g key={d.time}>
              <line x1={x + Math.floor(barWidth/2)} x2={x + Math.floor(barWidth/2)} y1={highY} y2={lowY} stroke={color} strokeWidth={1} />
              <rect x={x} y={bodyTop} width={barWidth} height={bodyHeight} fill={color} />
            </g>
          )
        })}

        {/* EMA lines */}
        {(() => {
          const points26 = []
          const points200 = []
          data.forEach((d, i) => {
            const x = pad + i * (barWidth + gap) + Math.floor(barWidth/2)
            if (d.ema26 != null) points26.push([x, yFor(d.ema26)])
            if (d.ema200 != null) points200.push([x, yFor(d.ema200)])
          })
          const path26 = points26.map(p => p.join(',')).join(' ')
          const path200 = points200.map(p => p.join(',')).join(' ')
          return (
            <g>
              {points26.length > 0 && <polyline points={path26} fill="none" stroke="#60a5fa" strokeWidth={2} />}
              {points200.length > 0 && <polyline points={path200} fill="none" stroke="#f97316" strokeWidth={2} />}
            </g>
          )
        })()}

      </svg>
    </div>
  )
}

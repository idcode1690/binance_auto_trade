import React, { useEffect, useRef, useState } from 'react'
import { createChart } from 'lightweight-charts'

// TradingView loader component: inserts external script and initializes widget on demand
function TradingViewLoader() {
  const [state, setState] = useState('idle') // idle | loading | loaded | failed
  const [error, setError] = useState(null)

  useEffect(() => {
    return () => {
      // cleanup: nothing to remove (widget remains if loaded)
    }
  }, [])

  const initWidget = () => {
    try {
      if (!document.getElementById('tradingview_chart')) return
      // show container
      const el = document.getElementById('tradingview_chart')
      el.style.display = 'block'

      // if TradingView already present, initialize immediately
      if (window.TradingView) {
        try {
          new window.TradingView.widget({
            container_id: 'tradingview_chart',
            width: '100%',
            height: 360,
            symbol: 'BINANCE:BTCUSDT',
            interval: '5',
            timezone: 'Etc/UTC',
            theme: 'dark',
            style: '1',
            locale: 'en',
            toolbar_bg: '#111827',
            enable_publishing: false,
            allow_symbol_change: true
          })
          setState('loaded')
        } catch (e) {
          setState('failed')
          setError(String(e))
        }
        return
      }

      // otherwise inject script
      setState('loading')
      const s = document.createElement('script')
      s.src = 'https://s3.tradingview.com/tv.js'
      s.type = 'text/javascript'
      s.async = true
      s.crossOrigin = 'anonymous'
      s.onload = () => {
        try {
          new window.TradingView.widget({
            container_id: 'tradingview_chart',
            width: '100%',
            height: 360,
            symbol: 'BINANCE:BTCUSDT',
            interval: '5',
            timezone: 'Etc/UTC',
            theme: 'dark',
            style: '1',
            locale: 'en',
            toolbar_bg: '#111827',
            enable_publishing: false,
            allow_symbol_change: true
          })
          setState('loaded')
        } catch (e) {
          setState('failed')
          setError(String(e))
        }
      }
      s.onerror = (e) => {
        setState('failed')
        setError('script-load-failed')
      }
      document.head.appendChild(s)
    } catch (err) {
      setState('failed')
      setError(String(err))
    }
  }

  return (
    <div style={{display:'inline-block'}}>
      {state === 'idle' && <button className="btn" onClick={initWidget}>Load TradingView</button>}
      {state === 'loading' && <button className="btn" disabled>Loading...</button>}
      {state === 'loaded' && <span className="meta">TradingView loaded</span>}
      {state === 'failed' && <span className="meta" style={{color:'#f87171'}}>Failed: {error}</span>}
    </div>
  )
}

const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade'

function formatNumber(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })
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
      <div className="header">
        <div>
          <div className="title">Binance BTC/USDT — 5m Candles + EMA26/200</div>
          <div className="top-meta">Real-time trade price from Binance (aggregated to 5m candles)</div>
          <div style={{marginTop:6}}>
            <span className="meta" style={{marginRight:12}}>EMA26 (closed): {ema26 == null ? '—' : formatNumber(ema26)}</span>
            <span className="meta" style={{marginRight:12}}>EMA26 (live): {liveEma26 == null ? '—' : formatNumber(liveEma26)}</span>
            <span className="meta" style={{marginRight:12}}>EMA200 (closed): {ema200 == null ? '—' : formatNumber(ema200)}</span>
            <span className="meta" style={{marginRight:12}}>EMA200 (live): {liveEma200 == null ? '—' : formatNumber(liveEma200)}</span>
            <span style={{fontWeight:700, marginLeft:6}} className={ema26 != null && ema200 != null ? (ema26 > ema200 ? 'bull' : (ema26 < ema200 ? 'bear' : 'meta')) : 'meta'}>
              {ema26 == null || ema200 == null ? 'EMA: —' : (ema26 > ema200 ? 'Bull Cross ▲' : (ema26 < ema200 ? 'Bear Cross ▼' : 'Neutral'))}
            </span>
          </div>
        </div>
        <div style={{textAlign:'right'}}>
          <div className="price">{(displayPrice == null && lastPrice == null) ? '—' : formatNumber(displayPrice ?? lastPrice)}</div>
          <div style={{marginTop:8}}>
            <span>Status: <span className="status" style={{background: connected ? 'var(--success)' : '#3b1b1b'}}>{connected ? 'Connected' : 'Disconnected'}</span></span>
          </div>
          <div style={{marginTop:8}}>
            <button className="btn" onClick={() => connected ? stopWs() : startWs()}>{connected ? 'Stop' : 'Start'}</button>
          </div>
          <div style={{marginTop:8}}>
            {/* TradingView lazy-load toggle: user clicks to load external widget */}
            <TradingViewLoader />
          </div>
        </div>
      </div>

      <div className="main-grid">
          <div className="main-chart card no-frame">
            {/* Render internal SVG candlestick chart by default to avoid TradingView auto-load */}
            <div style={{width:'100%', height: Math.max(300, (typeof window !== 'undefined' ? window.innerHeight - 220 : 360))}}>
              <CandlestickChart data={candles} />
              {/* Hidden TradingView container — shown only after user triggers load */}
              <div id="tradingview_chart" style={{width:'100%',height:360, display:'none', marginTop:12}}></div>
            </div>
          </div>

        <aside className="sidebar">
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
        </aside>
      </div>
    </div>
  )
}

function CandlestickChart({ data = [], height = 360 }) {
  const ref = useRef(null)
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

  // Use a fixed logical grid so rendering is deterministic across page sizes/refreshes.
  // Each candle occupies `unit` logical units; use fixed `barUnit` and `gapUnit`.
  const pad = 10
  const barUnit = 3
  const gapUnit = 1
  const unit = barUnit + gapUnit
  const logicalWidth = pad * 2 + data.length * unit

  const yFor = v => {
    const p = (v - min) / range
    return h - pad - p * (h - pad * 2)
  }

  // Build shapes using logical coordinates and let the SVG scale to container via viewBox.
  const points26 = []
  const points200 = []

  return (
    <div ref={ref} style={{width:'100%'}}>
      <svg width="100%" height={h} viewBox={`0 0 ${logicalWidth} ${h}`} preserveAspectRatio="none">
        <rect x={0} y={0} width={logicalWidth} height={h} fill="#071126" />
        {data.map((d, i) => {
          const x = pad + i * unit
          const openY = yFor(d.open)
          const closeY = yFor(d.close)
          const highY = yFor(d.high)
          const lowY = yFor(d.low)
          const bodyTop = Math.min(openY, closeY)
          const bodyHeight = Math.max(0.5, Math.abs(closeY - openY))
          const up = d.close >= d.open
          const color = up ? '#16a34a' : '#dc2626'
          // wick x center
          const centerX = x + barUnit / 2
          // collect EMA polyline points
          if (d.ema26 != null) points26.push([centerX, yFor(d.ema26)])
          if (d.ema200 != null) points200.push([centerX, yFor(d.ema200)])
          return (
            <g key={d.time}>
              <line x1={centerX} x2={centerX} y1={highY} y2={lowY} stroke={color} strokeWidth={0.5} />
              <rect x={x} y={bodyTop} width={barUnit} height={bodyHeight} fill={color} />
            </g>
          )
        })}

        {points26.length > 0 && <polyline points={points26.map(p => p.join(',')).join(' ')} fill="none" stroke="#60a5fa" strokeWidth={0.9} strokeLinecap="round" />}
        {points200.length > 0 && <polyline points={points200.map(p => p.join(',')).join(' ')} fill="none" stroke="#f97316" strokeWidth={0.9} strokeLinecap="round" />}
      </svg>
    </div>
  )
}

function LightweightChart({ data = [] }) {
  const ref = useRef(null)
  const [useFallback, setUseFallback] = useState(false)
  const chartRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const ema26RefSeries = useRef(null)
  const ema200RefSeries = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // create chart safely; if the library returns an unexpected value, fall back
    try {
      const chart = createChart(el, {
        width: el.clientWidth,
        height: el.clientHeight,
        layout: { background: { color: '#071126' }, textColor: '#d1d5db' },
        grid: { vertLines: { color: '#0b1220' }, horzLines: { color: '#0b1220' } },
        rightPriceScale: { borderColor: '#0b1220' },
        timeScale: { borderColor: '#0b1220' }
      })

      // defensive: ensure returned object is a lightweight-charts chart
      if (!chart || typeof chart.addCandlestickSeries !== 'function') {
        console.warn('lightweight-charts createChart did not return a chart instance, using SVG fallback')
        setUseFallback(true)
        return
      }

      chartRef.current = chart

      const candleSeries = chart.addCandlestickSeries({
        upColor: '#16a34a', downColor: '#dc2626', wickUpColor: '#16a34a', wickDownColor: '#dc2626'
      })
      candleSeriesRef.current = candleSeries

      const e26 = chart.addLineSeries({ color: '#60a5fa', lineWidth: 2 })
      const e200 = chart.addLineSeries({ color: '#f97316', lineWidth: 2 })
      ema26RefSeries.current = e26
      ema200RefSeries.current = e200

      // resize observer
      const ro = new ResizeObserver(() => {
        if (!el) return
        chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
      })
      ro.observe(el)

      return () => {
        try { ro.disconnect() } catch (e) {}
        try { chart.remove() } catch (e) {}
        chartRef.current = null
        candleSeriesRef.current = null
        ema26RefSeries.current = null
        ema200RefSeries.current = null
      }
    } catch (err) {
      console.warn('failed to initialize lightweight-charts, using SVG fallback', err)
      setUseFallback(true)
      return
    }
  }, [])

  // update series when data changes
  useEffect(() => {
    // if we decided to use the fallback, skip chart updates
    if (useFallback) return

    const series = candleSeriesRef.current
    const e26 = ema26RefSeries.current
    const e200 = ema200RefSeries.current
    if (!series) return

    // map candles to lightweight format (time in seconds or {time: 'YYYY-MM-DD'})
    const mapped = data.map(d => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close }))

    if (mapped.length === 0) return
    try {
      // if many points, setData once; otherwise update incremental
      if (mapped.length > 200) {
        series.setData(mapped)
      } else {
        // update: set all for simplicity to keep EMA overlays in sync
        series.setData(mapped)
      }

      // build EMA series points from data (prefer closed ema fields)
      const points26 = []
      const points200 = []
      mapped.forEach((d, i) => {
        const src = data[i]
        const v26 = src && src.ema26 != null ? src.ema26 : null
        const v200 = src && src.ema200 != null ? src.ema200 : null
        if (v26 != null) points26.push({ time: d.time, value: v26 })
        if (v200 != null) points200.push({ time: d.time, value: v200 })
      })
      if (e26) e26.setData(points26)
      if (e200) e200.setData(points200)
    } catch (err) {
      console.warn('lightweight update failed', err)
    }
  }, [data])

  return <div ref={ref} style={{width:'100%', height: '100%'}} />
}

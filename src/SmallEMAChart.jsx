import React, { useEffect, useRef, useState, useCallback } from 'react'

function computeEMA(values, period) {
  const k = 2 / (period + 1)
  const out = []
  let prev = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v == null) {
      out.push(null)
      continue
    }
    if (prev == null) {
      prev = v
    } else {
      prev = v * k + prev * (1 - k)
    }
    out.push(prev)
  }
  return out
}

export default function SmallEMAChart({ interval = '1m', limit = 200, livePrice = null, onTrade = null, onCross = null, emaShort = 26, emaLong = 200, symbol = 'BTCUSDT' }) {
  const [klines, setKlines] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [emaShortArr, setEmaShortArr] = useState([])
  const [emaLongArr, setEmaLongArr] = useState([])
  const emaShortRef = useRef(null)
  const emaLongRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    let ws = null

    async function load() {
      setIsLoading(true)
      try {
        // Try localStorage cache first to avoid repeat REST calls for the same
        // symbol/interval/limit. Cache key includes limit so different views don't clash.
        const cacheKey = `klines:${String(symbol).toUpperCase()}:${interval}:L${limit}`
        const TTL_MS = 1000 * 60 * 5 // 5 minutes
        try {
          const raw = localStorage.getItem(cacheKey)
          if (raw) {
            const parsedCache = JSON.parse(raw)
            if (parsedCache && Array.isArray(parsedCache.data) && parsedCache.ts && (Date.now() - parsedCache.ts) < TTL_MS) {
              setKlines(parsedCache.data)
              setIsLoading(false)
              return
            }
          }
        } catch (e) {
          // ignore localStorage parse errors
        }

        const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
        const res = await fetch(url)
        const data = await res.json()
        const parsed = data.map(r => ({
          open: parseFloat(r[1]),
          high: parseFloat(r[2]),
          low: parseFloat(r[3]),
          close: parseFloat(r[4]),
          closed: true,
          time: r[0]
        }))
        if (cancelled) return
        setKlines(parsed)
        // store to cache for subsequent mounts
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: parsed }))
        } catch (e) {}
        setIsLoading(false)
      } catch (err) {
        console.warn('fetch klines failed', err)
        setKlines([])
        setIsLoading(false)
      }
    }

    try {
      const symLower = String(symbol || 'BTCUSDT').toLowerCase()
      const streamName = `${symLower}@kline_${interval}/${symLower}@trade`
      const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streamName}`
      ws = new WebSocket(wsUrl)
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          const data = msg.data || msg
          if (data && data.k) {
            const k = data.k
            const candle = {
              open: parseFloat(k.o),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              close: parseFloat(k.c),
              time: k.t,
              closed: !!k.x // k.x is true when the kline is closed
            }
            setKlines(prev => {
              if (!prev || prev.length === 0) return [candle]
              const last = prev[prev.length - 1]
              if (last.time === candle.time) {
                const copy = prev.slice(0, prev.length - 1)
                copy.push(candle)
                return copy
              } else {
                const out = prev.concat([candle])
                if (out.length > limit) out.shift()
                return out
              }
            })
            return
          }
          if (data && (data.p || data.price)) {
            const price = parseFloat(data.p || data.price || data.P)
            if (onTrade && isFinite(price)) {
              try { onTrade(price) } catch (e) { /* ignore */ }
            }
          }
        } catch (e) {}
      }
      ws.onerror = (e) => console.warn('combined ws error', e)
    } catch (e) {
      console.warn('failed to open combined websocket', e)
    }

    load()
    return () => { cancelled = true; try { if (ws) ws.close() } catch {} }
  }, [interval, limit, symbol, onTrade])

  useEffect(() => {
    if (!klines || klines.length === 0) return
    const closes = klines.map(p => p.close)
    const fullShort = computeEMA(closes, emaShort)
    const fullLong = computeEMA(closes, emaLong)
    setEmaShortArr(fullShort)
    setEmaLongArr(fullLong)
    emaShortRef.current = fullShort.length ? fullShort[fullShort.length - 1] : null
    emaLongRef.current = fullLong.length ? fullLong[fullLong.length - 1] : null
  }, [klines, emaShort, emaLong])

  const pendingPriceRef = useRef(null)
  const rafRef = useRef(null)

  useEffect(() => {
    if (livePrice == null) return
    const p = Number(livePrice)
    if (!isFinite(p)) return
    pendingPriceRef.current = p
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        const priceToApply = pendingPriceRef.current
        pendingPriceRef.current = null
        rafRef.current = null

        setKlines(prev => {
          if (!prev || prev.length === 0) return prev
          const copy = prev.slice()
          const last = copy[copy.length - 1]
          if (!last) return prev
          const updated = {
            ...last,
            close: priceToApply,
            high: Math.max(last.high, priceToApply),
            low: Math.min(last.low, priceToApply)
          }
          copy[copy.length - 1] = updated
          return copy
        })

        try {
          if (emaShortRef.current != null && emaLongRef.current != null) {
            const kShort = 2 / (emaShort + 1)
            const kLong = 2 / (emaLong + 1)
            const newShort = priceToApply * kShort + emaShortRef.current * (1 - kShort)
            const newLong = priceToApply * kLong + emaLongRef.current * (1 - kLong)
            emaShortRef.current = newShort
            emaLongRef.current = newLong
            setEmaShortArr(prev => {
              if (!prev || prev.length === 0) return prev
              const copy = prev.slice()
              copy[copy.length - 1] = newShort
              return copy
            })
            setEmaLongArr(prev => {
              if (!prev || prev.length === 0) return prev
              const copy = prev.slice()
              copy[copy.length - 1] = newLong
              return copy
            })
          }
        } catch (e) {}
      })
    }
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [livePrice])
  const width = 600
  // default height increased for better visibility; zoom toggles larger view
  // start expanded so the initial chart loads in a zoomed-in state
  const [expanded, setExpanded] = useState(true)
  const height = expanded ? 380 : 220
  const padding = 2
  const points = klines.length
  // viewCount: number of candles visible (user-controlled via mouse wheel)
  // default fewer visible candles to present a more-zoomed initial view
  const [viewCount, setViewCount] = useState(80)
  const minView = 10
  const maxView = Math.max(minView, limit)

  const viewN = Math.min(points, viewCount)
  const slice = klines.slice(-viewN)
  const eShorts = emaShortArr.slice(-viewN)
  const eLongs = emaLongArr.slice(-viewN)
  // Wheel handler: zoom in/out by changing visible candle count.
  const handleWheel = useCallback((e) => {
    try { e.preventDefault() } catch (er) {}
    const delta = e.deltaY
    const step = Math.max(1, Math.round(viewCount * 0.12))
    let next = viewCount
    if (delta < 0) {
      next = Math.max(minView, viewCount - step)
    } else if (delta > 0) {
      const upper = Math.min(Math.max(minView, points || 0), maxView)
      next = Math.min(upper, viewCount + step)
    }
    if (next !== viewCount) setViewCount(next)
  }, [viewCount, minView, maxView, points])

  const canZoomIn = viewN > minView
  const canZoomOut = viewN < Math.min(points, maxView)

  // adjust viewCount when expanded toggles to provide a zoomed-in view
  useEffect(() => {
    if (!points) return
    if (expanded) {
      // reduce visible candles to give zoomed feel
      setViewCount(vc => Math.max(minView, Math.round(vc * 0.6)))
    } else {
      // expand visible candles back
      setViewCount(vc => Math.min(Math.max(minView, points || 0, maxView), Math.round(vc / 0.6)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])

  // notifiedRef + onCross effect must be declared before any early returns
  const notifiedRef = useRef(new Set())
  useEffect(() => {
    if (!onCross) return
    if (!emaShortArr || !emaLongArr) return
    // only detect crosses when the latest candle is closed
    const lastK = klines && klines.length > 0 ? klines[klines.length - 1] : null
    if (!lastK || !lastK.closed) return
    const n = Math.min(emaShortArr.length, emaLongArr.length)
    if (n < 2) return
    const i = n - 1
    const aPrev = emaShortArr[i - 1]
    const bPrev = emaLongArr[i - 1]
    const a = emaShortArr[i]
    const b = emaLongArr[i]
    if (a == null || b == null || aPrev == null || bPrev == null) return
    const prevDiff = aPrev - bPrev
    const currDiff = a - b
    let type = null
    if (prevDiff <= 0 && currDiff > 0) type = 'bull'
    else if (prevDiff >= 0 && currDiff < 0) type = 'bear'
    if (type) {
      const time = klines && klines.length > 0 ? klines[klines.length - 1].time : Date.now()
      const key = `${time}:${type}`
      if (!notifiedRef.current.has(key)) {
        notifiedRef.current.add(key)
        try { onCross({ type, time, price: klines[klines.length - 1].close }) } catch (e) {}
      }
    }
  }, [emaShortArr, emaLongArr, onCross, klines])

  // ensure numeric highs/lows exist
  const highs = slice.map(s => Number(s.high)).filter(v => isFinite(v))
  const lows = slice.map(s => Number(s.low)).filter(v => isFinite(v))
  if (highs.length === 0 || lows.length === 0) {
    if (isLoading) return <div className="meta">Loading chart...</div>
    return <div className="meta">No data for {String(symbol)}</div>
  }
  const max = Math.max(...highs)
  const min = Math.min(...lows)
  // compute xStep and bar width, then ensure there is extra right padding
  // so the rightmost candle body isn't clipped by the SVG edge.
  let xStep = (width - padding * 2) / (viewN - 1 || 1)
  let barW = Math.max(1, xStep * 0.6)
  const padLeft = padding
  const padRight = Math.max(padding, Math.ceil(barW / 2) + 1)
  xStep = (width - padLeft - padRight) / (viewN - 1 || 1)
  barW = Math.max(1, xStep * 0.6)

  const yFor = v => padding + (1 - (v - min) / (max - min || 1)) * (height - padding * 2)

  const makePath = arr => {
    let d = ''
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      if (v == null) continue
      const x = padding + i * xStep
      const y = yFor(v)
      d += (d === '' ? `M ${x} ${y}` : ` L ${x} ${y}`)
    }
    return d
  }

  const pathShort = makePath(eShorts)
  const pathLong = makePath(eLongs)

  const crosses = []
  for (let i = 1; i < viewN; i++) {
    const aPrev = eShorts[i - 1]
    const bPrev = eLongs[i - 1]
    const a = eShorts[i]
    const b = eLongs[i]
    if (a == null || b == null || aPrev == null || bPrev == null) continue
    const prevDiff = aPrev - bPrev
    const currDiff = a - b
    if (prevDiff <= 0 && currDiff > 0) {
      const x = padding + i * xStep
      const y = yFor((a + b) / 2)
      crosses.push({ x, y, type: 'bull', idx: i })
    } else if (prevDiff >= 0 && currDiff < 0) {
      const x = padding + i * xStep
      const y = yFor((a + b) / 2)
      crosses.push({ x, y, type: 'bear', idx: i })
    }
  }


  if (points === 0) return <div className="meta">Loading chart...</div>

  return (
    <div onWheel={handleWheel} style={{width: '100%', overflow: 'hidden', cursor: canZoomIn ? 'zoom-in' : (canZoomOut ? 'zoom-out' : 'default')}}>
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style={{width: '100%', height: 'auto', display: 'block'}}>
          {slice.map((c, i) => {
          // skip invalid candle data
          if (![c.open, c.high, c.low, c.close].every(x => isFinite(Number(x)))) return null
            const x = padLeft + i * xStep
          const highY = yFor(c.high)
          const lowY = yFor(c.low)
          const openY = yFor(c.open)
          const closeY = yFor(c.close)
          const isUp = c.close >= c.open
          const color = isUp ? '#0f9d58' : '#d93025'
          const bodyY = Math.min(openY, closeY)
          const bodyH = Math.max(1, Math.abs(closeY - openY))
          return (
            <g key={c.time}>
              <line x1={x} x2={x} y1={highY} y2={lowY} stroke={color} strokeWidth={1} />
              <rect x={x - barW / 2} y={bodyY} width={barW} height={bodyH} fill={color} />
            </g>
          )
        })}

        {pathLong && <path className="ema200" d={pathLong} fill="none" stroke="#888" strokeWidth={1.2} />}
        {pathShort && <path className="ema26" d={pathShort} fill="none" stroke="#ff9900" strokeWidth={1.6} />}

        {crosses.map((c, idx) => (
          <circle key={idx} className={"cross-marker " + (c.type === 'bull' ? 'bull' : 'bear')} cx={c.x} cy={c.y} r={4} />
        ))}
      </svg>
      <div className="chart-legend">
        <span className="legend-item"><span className="swatch ema26"/>{`EMA${emaShort}`}</span>
        <span className="legend-item"><span className="swatch ema200"/>{`EMA${emaLong}`}</span>
        <span className="legend-item"><span className="swatch bull"/>Bull Cross</span>
        <span className="legend-item"><span className="swatch bear"/>Bear Cross</span>
      </div>
    </div>
  )
}

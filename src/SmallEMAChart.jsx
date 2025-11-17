import React, { useEffect, useRef, useState } from 'react'

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

export default function SmallEMAChart({ interval = '1m', limit = 200, livePrice = null, onTrade = null, onCross = null }) {
  const [klines, setKlines] = useState([])
  const [ema26, setEma26] = useState([])
  const [ema200, setEma200] = useState([])
  const ema26Ref = useRef(null)
  const ema200Ref = useRef(null)

  useEffect(() => {
    let cancelled = false
    let ws = null

    async function load() {
      try {
        const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`
        const res = await fetch(url)
        const data = await res.json()
        const parsed = data.map(r => ({
          open: parseFloat(r[1]),
          high: parseFloat(r[2]),
          low: parseFloat(r[3]),
          close: parseFloat(r[4]),
          time: r[0]
        }))
        if (cancelled) return
        setKlines(parsed)
      } catch (err) {
        console.warn('fetch klines failed', err)
      }
    }

    try {
      const streamName = `btcusdt@kline_${interval}/btcusdt@trade`
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
              time: k.t
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
  }, [interval, limit])

  useEffect(() => {
    if (!klines || klines.length === 0) return
    const closes = klines.map(p => p.close)
    const full26 = computeEMA(closes, 26)
    const full200 = computeEMA(closes, 200)
    setEma26(full26)
    setEma200(full200)
    ema26Ref.current = full26.length ? full26[full26.length - 1] : null
    ema200Ref.current = full200.length ? full200[full200.length - 1] : null
  }, [klines])

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
          if (ema26Ref.current != null && ema200Ref.current != null) {
            const k26 = 2 / (26 + 1)
            const k200 = 2 / (200 + 1)
            const new26 = priceToApply * k26 + ema26Ref.current * (1 - k26)
            const new200 = priceToApply * k200 + ema200Ref.current * (1 - k200)
            ema26Ref.current = new26
            ema200Ref.current = new200
            setEma26(prev => {
              if (!prev || prev.length === 0) return prev
              const copy = prev.slice()
              copy[copy.length - 1] = new26
              return copy
            })
            setEma200(prev => {
              if (!prev || prev.length === 0) return prev
              const copy = prev.slice()
              copy[copy.length - 1] = new200
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
  const height = 160
  const padding = 2
  const points = klines.length
  if (points === 0) return <div className="meta">Loading chart...</div>

  const viewN = Math.min(points, 120)
  const slice = klines.slice(-viewN)
  const e26s = ema26.slice(-viewN)
  const e200s = ema200.slice(-viewN)

  const highs = slice.map(s => s.high)
  const lows = slice.map(s => s.low)
  const max = Math.max(...highs)
  const min = Math.min(...lows)
  const xStep = (width - padding * 2) / (viewN - 1 || 1)
  const barW = Math.max(1, xStep * 0.6)

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

  const path26 = makePath(e26s)
  const path200 = makePath(e200s)

  const crosses = []
  for (let i = 1; i < viewN; i++) {
    const aPrev = e26s[i - 1]
    const bPrev = e200s[i - 1]
    const a = e26s[i]
    const b = e200s[i]
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

  const notifiedRef = useRef(new Set())
  useEffect(() => {
    if (!onCross) return
    if (!e26s || !e200s) return
    const n = Math.min(e26s.length, e200s.length)
    if (n < 2) return
    const i = n - 1
    const aPrev = e26s[i - 1]
    const bPrev = e200s[i - 1]
    const a = e26s[i]
    const b = e200s[i]
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
  }, [e26s, e200s])

  return (
    <div style={{width: '100%', overflow: 'hidden'}}>
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{width: '100%', height: height}}>
        {slice.map((c, i) => {
          const x = padding + i * xStep
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

        {path200 && <path className="ema200" d={path200} fill="none" stroke="#888" strokeWidth={1.2} />}
        {path26 && <path className="ema26" d={path26} fill="none" stroke="#ff9900" strokeWidth={1.6} />}

        {crosses.map((c, idx) => (
          <circle key={idx} className={"cross-marker " + (c.type === 'bull' ? 'bull' : 'bear')} cx={c.x} cy={c.y} r={4} />
        ))}
      </svg>
      <div className="chart-legend">
        <span className="legend-item"><span className="swatch ema26"/>EMA26</span>
        <span className="legend-item"><span className="swatch ema200"/>EMA200</span>
        <span className="legend-item"><span className="swatch bull"/>Bull Cross</span>
        <span className="legend-item"><span className="swatch bear"/>Bear Cross</span>
      </div>
    </div>
  )
}

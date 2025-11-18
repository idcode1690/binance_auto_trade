import React, { useEffect, useRef, useState, Suspense, useMemo } from 'react'

/*
  Redesigned front-end: Minimal, responsive dashboard shell.
*/

const SmallEMAChart = React.lazy(() => import('./SmallEMAChart'))

function Hero({ title, subtitle, statusNode }) {
  return (
    <header className="hero" style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
      <div>
        <h1 className="hero-title">{title}</h1>
        <p className="hero-sub">{subtitle}</p>
      </div>
      <div>
        {statusNode}
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
  const [autoOrderEnabled, setAutoOrderEnabled] = useState(() => {
    try { return localStorage.getItem('autoOrderEnabled') === 'true' } catch (e) { return false }
  })
  // Test order UI removed per request
    const [orders, setOrders] = useState(() => {
      try { const raw = localStorage.getItem('orders'); return raw ? JSON.parse(raw) : [] } catch (e) { return [] }
    })
    const [activeTab, setActiveTab] = useState('alerts') // kept for compatibility but unused
  const [holdingsStr, setHoldingsStr] = useState(() => {
    try { return localStorage.getItem('holdings') || '0' } catch (e) { return '0' }
  })
  const [futuresBalanceStr, setFuturesBalanceStr] = useState(() => {
    try { return localStorage.getItem('futuresBalance') || '0' } catch (e) { return '0' }
  })
  const [account, setAccount] = useState(null)
  const [seedLoading, setSeedLoading] = useState(false)
  const [wsStatus, setWsStatus] = useState('disconnected')
  const [lastWsAt, setLastWsAt] = useState(null)
  const [emaShortStr, setEmaShortStr] = useState(() => {
    try { return localStorage.getItem('emaShort') || '26' } catch (e) { return '26' }
  })
  const [emaLongStr, setEmaLongStr] = useState(() => {
    try { return localStorage.getItem('emaLong') || '200' } catch (e) { return '200' }
  })
  const [minutesStr, setMinutesStr] = useState(() => {
    try { return localStorage.getItem('minutes') || '1' } catch (e) { return '1' }
  })
  const [symbolStr, setSymbolStr] = useState(() => {
    try { return localStorage.getItem('symbol') || 'BTCUSDT' } catch (e) { return 'BTCUSDT' }
  })
  const emaShort = Math.max(1, parseInt(emaShortStr, 10) || 26)
  const emaLong = Math.max(1, parseInt(emaLongStr, 10) || 200)
  const minutes = Math.max(1, parseInt(minutesStr, 10) || 1)
  const symbol = (symbolStr && symbolStr.trim().toUpperCase()) || 'BTCUSDT'
  const formatPrice = (val) => {
    if (val == null) return ''
    const n = Number(val)
    if (!isFinite(n)) return ''
    const abs = Math.abs(n)
    let maxDigits = 2
    if (abs === 0) return '0'
    // choose precision based on magnitude to avoid hiding small prices
    if (abs < 0.0001) maxDigits = 8
    else if (abs < 0.01) maxDigits = 8
    else if (abs < 1) maxDigits = 6
    else if (abs < 1000) maxDigits = 2
    else maxDigits = 2
    return n.toLocaleString(undefined, { maximumFractionDigits: maxDigits })
  }
  const normalizeSym = (s) => {
    try { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '') } catch (e) { return String(s || '').toUpperCase() }
  }
  const price = formatPrice(lastPrice)
  const holdings = Number(holdingsStr) || 0
  const value = isFinite(Number(lastPrice)) ? holdings * Number(lastPrice) : null
  const change = ''
  const candles = 0

  // derive a quick client-side account snapshot using live price for snappy PNL updates
  // Important: do NOT mutate server-provided totals (totalUnrealizedProfit / totalWalletBalance)
  // to avoid diverging from Binance. Instead compute per-position display UPL when lastPrice is available.
  const derivedAccount = useMemo(() => {
    if (!account) return null
    // shallow clone of account but keep authoritative totals intact
    const acc = { ...account }
    if (Array.isArray(account.positions) && lastPrice != null && isFinite(Number(lastPrice))) {
      acc.positions = account.positions.map(p => {
        try {
          if (!p || !p.symbol) return p
          if (normalizeSym(p.symbol) === normalizeSym(symbol)) {
            const amt = Number(p.positionAmt) || 0
            if (Math.abs(amt) === 0) return { ...p, displayUnrealizedProfit: Number(p.unrealizedProfit) || 0 }
            const entry = Number(p.entryPrice) || 0
            const newUpl = (Number(lastPrice) - entry) * amt
            // attach a display-only field so totals remain the server's values
            return { ...p, displayUnrealizedProfit: newUpl }
          }
        } catch (e) {}
        return { ...p, displayUnrealizedProfit: Number(p.unrealizedProfit) || 0 }
      })
    } else {
      acc.positions = account.positions ? account.positions.map(p => ({ ...p, displayUnrealizedProfit: Number(p.unrealizedProfit) || 0 })) : []
    }
    // keep authoritative totals as received from server to match Binance
    acc.totalUnrealizedProfit = Number(account.totalUnrealizedProfit) || 0
    acc.totalWalletBalance = Number(account.totalWalletBalance) || 0
    return acc
  }, [account, lastPrice, symbol])

  // Removed SSE and polling: rely on WebSocket `/ws/account` for all account snapshots and deltas

    // expose WS status in the UI (simple indicator)
    const SseIndicator = () => (
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: 8 }}>
        <ConnectionBadge label="WS" status={wsStatus} ts={lastWsAt} />
      </div>
    )

  function ConnectionBadge({ label, status, ts }) {
      const color = status === 'connected' ? '#16a34a' : status === 'error' ? '#dc2626' : '#666'
      return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, minWidth: 0 }}>
          <span style={{ opacity: 0.7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}:</span>
          <span style={{ fontWeight: 700, color }}>{status}</span>
        </div>
      )
  }

  function AccountSummary({ account }) {
    const bal = account && typeof account.totalWalletBalance !== 'undefined' ? Number(account.totalWalletBalance) : Number(futuresBalanceStr || 0)
    const upl = account && typeof account.totalUnrealizedProfit !== 'undefined' ? Number(account.totalUnrealizedProfit) : 0
    const uplPos = upl >= 0
    return (
      <div className="account-card">
        <div className="account-row account-top">
           <div className="account-title">USDT Balance</div>
          <div className="account-balance">{formatPrice(bal)}</div>
        </div>
        <div className="account-row account-bottom">
          <div className="account-sub">Futures wallet</div>
          <div className="account-upl">
            <div className={"upl-amount " + (uplPos ? 'pos' : 'neg')}>{upl >= 0 ? '+' : ''}{formatPrice(upl)} USDT</div>
            <div className="upl-label">Unrealized P/L</div>
          </div>
        </div>
          <div className="account-row account-bottom">
            <div className="account-sub">Margin Balance</div>
            <div className="account-balance">
              {(() => {
                // prefer explicit top-level field
                if (account && typeof account.totalMarginBalance !== 'undefined' && account.totalMarginBalance !== null) {
                  return formatPrice(Number(account.totalMarginBalance))
                }
                if (account && typeof account.availableBalance !== 'undefined' && account.availableBalance !== null) {
                  return formatPrice(Number(account.availableBalance))
                }
                // next fallback: use totalWalletBalance (user deposit/wallet) if present
                if (account && typeof account.totalWalletBalance !== 'undefined' && account.totalWalletBalance !== null) {
                  return formatPrice(Number(account.totalWalletBalance))
                }
                // fallback to local stored futures balance (from earlier successful fetches)
                try {
                  const stored = Number(futuresBalanceStr || 0)
                  if (stored && stored > 0) return formatPrice(stored)
                } catch (e) {}
                // final attempt: estimate margin balance from positions
                try {
                  if (account && Array.isArray(account.positions) && account.positions.length) {
                    let sum = 0
                    for (const p of account.positions) {
                      if (!p) continue
                      const init = Number(p.positionInitialMargin || 0) || 0
                      if (init && init > 0) { sum += init; continue }
                      // isolatedWallet if present
                      if (typeof p.isolatedWallet !== 'undefined' && p.isolatedWallet !== null) {
                        const iso = Number(p.isolatedWallet) || 0
                        if (iso && iso > 0) { sum += iso; continue }
                      }
                      // last resort: estimate from notional / leverage
                      const amt = Math.abs(Number(p.positionAmt) || 0)
                      const price = Number(p.markPrice || p.entryPrice || 0) || 0
                      const lev = p.leverage ? Number(p.leverage) : 0
                      if (amt > 0 && price > 0 && lev > 0) {
                        const notional = amt * price
                        const used = notional / lev
                        if (isFinite(used)) sum += used
                      }
                    }
                    if (sum > 0) return formatPrice(sum)
                  }
                } catch (e) {}
                return '—'
              })()}
            </div>
          </div>
      </div>
    )
  }

  const wsRef = useRef(null)
  const [initialLoaded, setInitialLoaded] = useState(false)
  const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade'
  // App no longer opens a dedicated trade websocket; SmallEMAChart will provide live trade
  // callbacks via the `onTrade` prop so we can update `lastPrice`.

  // WebSocket consumer for low-latency account/position deltas from server
  // Only connect after we have attempted an initial load/seed to avoid
  // racing with the initial snapshot. This ensures UI shows initial data
  // then switches to socket for realtime deltas.
  useEffect(() => {
    if (!initialLoaded) return
    let mounted = true
    let ws = null
    let reconnectTimer = null
    let backoffMs = 500
    const MAX_BACKOFF = 30000

    const wsUrls = [
      'ws://127.0.0.1:3000/ws/account',
      `ws://${window.location.host}/ws/account`,
      '/ws/account'
    ]

    const connect = (idx = 0) => {
      if (!mounted) return
      const url = wsUrls[idx]
      try {
        setWsStatus('connecting')
        // prefer absolute then relative
        ws = new WebSocket(url)
        wsRef.current = ws
      } catch (e) {
        scheduleReconnect()
        return
      }

      ws.onopen = () => {
        backoffMs = 500
        setWsStatus('connected')
        setLastWsAt(new Date().toISOString())
        console.info('Account WS connected', url)
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (!mounted) return
          setLastWsAt(new Date().toISOString())
          // debug: log incoming message type and any symbol it carries
          try { console.debug('[WS] recv', msg && msg.type, (msg && (msg.position || msg.pos || msg.data || {}).symbol) || msg && msg.markPrice || null) } catch(e){}
          if (!msg) return
          // handle positional delta
          if (msg.type === 'pos_delta') {
            const pos = msg.position || msg.pos || msg.data || (msg.symbol ? {
              symbol: msg.symbol,
              positionAmt: msg.positionAmt,
              entryPrice: msg.entryPrice,
              markPrice: msg.markPrice,
              unrealizedProfit: msg.unrealizedProfit,
              leverage: msg.leverage,
              positionInitialMargin: msg.positionInitialMargin,
              marginType: msg.marginType,
              isolatedWallet: msg.isolatedWallet
            } : null)
            if (!pos || !pos.symbol) return
            // if the delta includes a markPrice, update live lastPrice for UI
            if (typeof pos.markPrice !== 'undefined' && pos.markPrice !== null) {
              try { setLastPrice(Number(pos.markPrice)) } catch (e) {}
            } else if (typeof msg.markPrice !== 'undefined' && msg.markPrice !== null) {
              try { setLastPrice(Number(msg.markPrice)) } catch (e) {}
            }
            setAccount(prev => {
              const acc = prev ? { ...prev } : { positions: [] }
              const sym = normalizeSym(pos.symbol)
              acc.positions = Array.isArray(acc.positions) ? acc.positions.slice() : []
              const idx = acc.positions.findIndex(p => normalizeSym(p.symbol) === sym)
              const amtNum = Number(pos.positionAmt) || 0
              if (idx >= 0) {
                if (Math.abs(amtNum) === 0) {
                  // position closed/flattened -> remove it immediately
                  acc.positions.splice(idx, 1)
                } else {
                  acc.positions[idx] = { ...acc.positions[idx], ...pos }
                }
              } else {
                if (Math.abs(amtNum) !== 0) {
                  acc.positions.push({ ...pos })
                }
              }
              // if this is the currently selected symbol, persist holdings (store '0' when closed)
              if (sym === normalizeSym(symbol)) {
                try { const amt = String(amtNum || 0); localStorage.setItem('holdings', amt); setHoldingsStr(amt) } catch (e) {}
              }
              return acc
            })
          } else if (msg.type === 'acct_delta') {
            const totals = msg.totals || msg.data || {}
            // if acct_delta carries a markPrice for our symbol, update lastPrice
            if (typeof msg.markPrice !== 'undefined' && msg.markPrice !== null) {
              try { setLastPrice(Number(msg.markPrice)) } catch (e) {}
            }
            setAccount(prev => {
              const acc = prev ? { ...prev } : { positions: [] }
              if (typeof totals.totalUnrealizedProfit !== 'undefined') acc.totalUnrealizedProfit = totals.totalUnrealizedProfit
              if (typeof totals.totalWalletBalance !== 'undefined') acc.totalWalletBalance = totals.totalWalletBalance
              return acc
            })
            if (typeof totals.totalWalletBalance !== 'undefined') {
              try { localStorage.setItem('futuresBalance', String(totals.totalWalletBalance)); setFuturesBalanceStr(String(totals.totalWalletBalance)) } catch (e) {}
            }
          } else if (msg.type === 'snapshot' || msg.type === 'full_snapshot' || msg.type === 'account_snapshot') {
            // server may send full snapshot occasionally
            const snap = msg.snapshot || msg.data || msg.account
            if (snap) setAccount(snap)
          }
        } catch (e) {
          // ignore parse errors
        }
      }

      ws.onclose = (e) => {
        setWsStatus('disconnected')
        wsRef.current = null
        if (!mounted) return
        scheduleReconnect()
      }

      ws.onerror = (err) => {
        console.warn('Account WS error', err)
        setWsStatus('error')
        try { ws.close() } catch (e) {}
        wsRef.current = null
        scheduleReconnect()
      }
    }

    const scheduleReconnect = () => {
      if (!mounted) return
      setWsStatus('reconnecting')
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => {
        try {
          const next = Math.floor(Math.random() * wsUrls.length)
          connect(next)
        } finally {
          backoffMs = Math.min(MAX_BACKOFF, backoffMs * 1.6)
        }
      }, backoffMs)
    }

    connect(0)

    return () => {
      mounted = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { if (ws) ws.close() } catch (e) {}
      wsRef.current = null
    }
  }, [symbol, initialLoaded])

  // On mount: attempt a single REST GET to `/api/futures/account` to seed initial data
  // If no cached snapshot is available, request the manual seed endpoint once.
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const resp = await fetch('/api/futures/account')
        if (!mounted) return
        if (resp.status === 202) {
          // no snapshot yet — try a one-time seed (server-side protects against rate limits)
          try {
            const seedResp = await fetch('/api/futures/account/seed', { method: 'POST' })
            if (!mounted) return
            if (seedResp.ok) {
              const j = await seedResp.json()
              if (j && j.snapshot) {
                try { setAccount(j.snapshot); if (j.snapshot.totalWalletBalance) { localStorage.setItem('futuresBalance', String(j.snapshot.totalWalletBalance)); setFuturesBalanceStr(String(j.snapshot.totalWalletBalance)) } } catch (e) {}
              }
            }
          } catch (e) {
            // ignore seed errors — server may be rate-limited or keys may be missing
            console.warn('seed attempt failed', e && e.message)
          }
        } else if (resp.ok) {
          try {
            const j = await resp.json()
            if (!mounted) return
            if (j) {
              setAccount(j)
              if (j.totalWalletBalance) { try { localStorage.setItem('futuresBalance', String(j.totalWalletBalance)); setFuturesBalanceStr(String(j.totalWalletBalance)) } catch (e) {} }
            }
          } catch (e) {}
        }
        // mark initial load attempt complete so WS can connect
        try { setInitialLoaded(true) } catch (e) {}
      } catch (e) {
        console.warn('initial account fetch failed', e && e.message)
        try { setInitialLoaded(true) } catch (e2) {}
      }
    })()
    return () => { mounted = false }
  }, [])

  // REST polling removed: client will now rely exclusively on WebSocket
  // account/pos deltas and server-sent 'snapshot' messages. This avoids
  // triggering Binance REST rate limits and IP bans. If a fresh full
  // snapshot is required, the server should emit a 'snapshot' message
  // over the existing WebSocket stream.

  return (
    <div className="container body-root">
      <Hero title="Binance Auto Trading System" statusNode={<SseIndicator />} />

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
                <label style={{fontSize:13,color:'var(--muted)'}}>Symbol:</label>
                <input className="theme-input" type="text" value={symbolStr} onChange={e=>setSymbolStr(e.target.value)} onBlur={() => { const s = (symbolStr||'BTCUSDT').trim().toUpperCase(); setSymbolStr(s); try{ localStorage.setItem('symbol', s) } catch(e){} }} style={{width:120,padding:6,borderRadius:6}} />
                <label style={{fontSize:13,color:'var(--muted)'}}>EMA1:</label>
                <input className="theme-input" type="number" min={1} value={emaShortStr} onChange={e=>setEmaShortStr(e.target.value)} onBlur={() => { const v = String(Math.max(1, parseInt(emaShortStr,10) || 26)); setEmaShortStr(v); try{ localStorage.setItem('emaShort', v) } catch(e){} }} style={{width:72,padding:6,borderRadius:6}} />
                <label style={{fontSize:13,color:'var(--muted)'}}>EMA2:</label>
                <input className="theme-input" type="number" min={1} value={emaLongStr} onChange={e=>setEmaLongStr(e.target.value)} onBlur={() => { const v = String(Math.max(1, parseInt(emaLongStr,10) || 200)); setEmaLongStr(v); try{ localStorage.setItem('emaLong', v) } catch(e){} }} style={{width:72,padding:6,borderRadius:6}} />
                <label style={{fontSize:13,color:'var(--muted)'}}>Minutes:</label>
                <input className="theme-input" type="number" min={1} value={minutesStr} onChange={e=>setMinutesStr(e.target.value)} onBlur={() => { const v = String(Math.max(1, parseInt(minutesStr,10) || 1)); setMinutesStr(v); try{ localStorage.setItem('minutes', v) } catch(e){} }} style={{width:72,padding:6,borderRadius:6}} />
              </div>
              <ChartToggle
                livePrice={lastPrice}
                onTrade={setLastPrice}
                onCross={(c) => {
                  // add cross alert
                  setAlerts(prev => [{ id: Date.now(), ...c }, ...prev].slice(0, 200))
                  try {
                    // create a simulated order entry on cross so right column shows it
                    const side = c.type === 'bull' ? 'BUY' : 'SELL'
                    const usdt = 100 // default simulated USDT allocation
                    const priceNum = Number(c.price) || Number(lastPrice) || 0
                    let qty = 0
                    if (priceNum > 0) qty = Math.floor((usdt / priceNum) * 1e6) / 1e6
                    const orderEntry = {
                      id: Date.now(),
                      symbol: String(symbol || 'BTCUSDT'),
                      side,
                      quantity: qty > 0 ? String(qty) : '0',
                      usdt,
                      time: c.time || Date.now(),
                      status: 'simulated',
                      source: 'cross'
                    }
                    setOrders(prev => { const next = [orderEntry, ...prev].slice(0, 200); try{ localStorage.setItem('orders', JSON.stringify(next)) }catch{}; return next })
                  } catch (e) {}
                }}
                emaShort={emaShort}
                emaLong={emaLong}
                minutes={minutes}
                symbol={symbol}
              />
              {/* Positions table under chart */}
              <div style={{marginTop:12}}>
                <div style={{fontSize:14,fontWeight:700,marginBottom:8}}>Open Positions</div>
                {derivedAccount && Array.isArray(derivedAccount.positions) ? (
                  (() => {
                    const open = derivedAccount.positions.filter(p => Math.abs(Number(p.positionAmt) || 0) > 0)
                    if (!open.length) return (<div style={{fontSize:12,color:'var(--muted)'}}>No open positions</div>)
                    return (
                      <div className="positions-table" style={{border:'1px solid rgba(0,0,0,0.06)',borderRadius:6,overflow:'hidden'}}>
                        <div style={{display:'flex',gap:12,padding:'8px 6px',background:'rgba(0,0,0,0.02)',fontSize:12,fontWeight:700}}>
                          <div style={{flex:1.2}}>Symbol</div>
                          <div style={{flex:1,textAlign:'right'}}>Lev</div>
                          <div style={{flex:1,textAlign:'right'}}>Size</div>
                          <div style={{flex:1,textAlign:'right'}}>Entry Price</div>
                          <div style={{flex:1.2,textAlign:'right'}}>Margin</div>
                          <div style={{flex:1,textAlign:'right'}}>PNL (ROI %)</div>
                          <div style={{flex:1,textAlign:'right'}}>Margin Type</div>
                        </div>
                        {open.map(p => {
                          const amt = Number(p.positionAmt) || 0
                          const entry = Number(p.entryPrice) || 0
                          // prefer server-provided markPrice, then lastPrice, then entry
                          const mark = Number(p.markPrice) || Number(lastPrice) || entry || 0

                          // compute unrealized PnL using mark price (more consistent with Binance)
                          const computedUpl = (mark - entry) * amt
                          // also consider index price if Binance provides it (sometimes used for PNL/liq)
                          const indexPrice = Number(p.indexPrice) || 0
                          const indexUsed = indexPrice || mark
                          const computedUplIndex = (indexUsed - entry) * amt
                          // prefer authoritative server-provided unrealizedProfit, then client-side
                          // display-only value (`displayUnrealizedProfit`) for snappy updates,
                          // finally fall back to locally computed upl using mark/entry.
                          const upl = (typeof p.unrealizedProfit !== 'undefined' && p.unrealizedProfit !== null)
                            ? Number(p.unrealizedProfit)
                            : (typeof p.displayUnrealizedProfit !== 'undefined' && p.displayUnrealizedProfit !== null)
                              ? Number(p.displayUnrealizedProfit)
                              : computedUpl

                          // prefer explicit initial margin fields when available
                          const initMargin = Number(p.positionInitialMargin || p.initialMargin || 0) || 0
                          const lev = p.leverage ? Number(p.leverage) : undefined
                          // compute notional using mark price (closer to Binance's view)
                          const notional = (Math.abs(amt) * mark) || 0

                          let roiPct = null
                          let roiIndexPct = null
                          if (initMargin && initMargin > 0) {
                            roiPct = (upl / initMargin) * 100
                            roiIndexPct = ( (typeof p.unrealizedProfit !== 'undefined' && p.unrealizedProfit !== null) ? (Number(p.unrealizedProfit) / initMargin) * 100 : (computedUplIndex / initMargin) * 100 )
                          } else if (lev && notional > 0) {
                            const usedMargin = notional / lev
                            if (usedMargin > 0) {
                              roiPct = (upl / usedMargin) * 100
                              roiIndexPct = (computedUplIndex / usedMargin) * 100
                            }
                          } else if (lev && entry && Math.abs(amt) > 0) {
                            // last resort: estimate used margin from entry price if mark not available
                            const fallbackNotional = Math.abs(amt) * entry
                            const used = fallbackNotional / (lev || 1)
                            if (used > 0) {
                              roiPct = (upl / used) * 100
                              roiIndexPct = (computedUplIndex / used) * 100
                            }
                          }

                          const isPos = upl >= 0
                          const pnlClass = isPos ? 'pnl-pos' : 'pnl-neg'
                          // display values: show markPrice for live consistency
                          return (
                            <div key={p.symbol + String(p.positionAmt) + String(p.entryPrice)} style={{display:'flex',gap:12,padding:'8px 6px',alignItems:'center',fontSize:13,borderTop:'1px solid rgba(0,0,0,0.04)'}}>
                              <div style={{flex:1.2}}>{p.symbol}</div>
                              <div style={{flex:1,textAlign:'right'}}>{lev || '—'}</div>
                              <div style={{flex:1,textAlign:'right'}}>{Math.abs(amt)} {String(p.symbol).replace(/USDT$/,'')}</div>
                              <div style={{flex:1,textAlign:'right'}}>{entry ? entry.toLocaleString(undefined,{maximumFractionDigits:2}) : '—'}</div>
                              <div style={{flex:1.2,textAlign:'right'}}>
                                {initMargin ? (
                                  <div>
                                    <div style={{fontWeight:400}}>{initMargin.toFixed(4)} USDT</div>
                                    <div style={{fontSize:12,color:'var(--muted)'}}>{notional ? `(${((initMargin / notional)*100).toFixed(2)}%)` : '(—)'}</div>
                                  </div>
                                ) : '—'}
                              </div>
                              <div className={"pnl-cell " + pnlClass} style={{flex:1,textAlign:'right'}}>
                                <div className="pnl-amount">{upl >= 0 ? '+' : ''}{Number(upl || 0).toFixed(4)} USDT</div>
                                <div className="pnl-percent">{roiPct != null ? `(${roiPct >= 0 ? '+' : ''}${Number(roiPct).toFixed(2)}%)` : '(—)'}</div>
                              </div>
                              <div style={{flex:1,textAlign:'right'}}>{p.marginType ? (p.marginType.toUpperCase() === 'ISOLATED' ? '(Isolated)' : '(Cross)') : '(Cross)'}</div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()
                ) : (
                  <div style={{fontSize:12,color:'var(--muted)'}}>Positions not available</div>
                )}
              </div>
            </div>
          </div>
        </section>

        <aside className="sidebar card">
          <div className="sidebar-inner">
            {/* Full-width rectangular toggle above Futures Account */}
            <div style={{marginBottom:12}}>
              <div className={"wide-toggle " + (autoOrderEnabled ? 'on' : 'off')} onClick={() => { const v = !autoOrderEnabled; setAutoOrderEnabled(v); try{ localStorage.setItem('autoOrderEnabled', v ? 'true' : 'false') } catch{} }}>
                <div className="wide-thumb" />
                <div className="side left">Auto Orders Off</div>
                <div className="side right">Auto Orders On</div>
              </div>
            </div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
              <h3 style={{marginTop:0, marginBottom:0}}>Futures Account</h3>
            </div>
            <div className="meta">
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                <AccountSummary account={derivedAccount || account} />
                <div style={{marginLeft:8}}>
                  <button className="theme-btn" onClick={async () => {
                    try {
                      setSeedLoading(true)
                      const resp = await fetch('/api/futures/account/seed', { method: 'POST' })
                      if (resp.ok) {
                        const j = await resp.json()
                        const snap = j && (j.snapshot || j.account || j)
                        if (snap) {
                          try { setAccount(snap); if (snap.totalWalletBalance) { localStorage.setItem('futuresBalance', String(snap.totalWalletBalance)); setFuturesBalanceStr(String(snap.totalWalletBalance)) } } catch (e) {}
                        }
                      } else {
                        try { const txt = await resp.text(); console.warn('seed failed', resp.status, txt) } catch (e) {}
                      }
                    } catch (e) {
                      console.warn('seed request failed', e && e.message)
                    } finally { setSeedLoading(false) }
                  }} disabled={seedLoading} title="서버에서 계정 스냅샷을 한 번 가져옵니다">
                    {seedLoading ? '가져오는 중…' : '계정 가져오기'}
                  </button>
                </div>
              </div>
            </div>
            

            <div style={{marginTop:12}}>
              {/* Combined Cross (left) / Orders (right) view */}
              <div className="tabbed">
                <div className="tabs-row" style={{display:'flex',gap:8,marginBottom:8}}>
                  <button className={"tab" + (activeTab === 'alerts' ? ' active' : '')} onClick={() => setActiveTab('alerts')}>Cross Alerts</button>
                  <button className={"tab" + (activeTab === 'orders' ? ' active' : '')} onClick={() => setActiveTab('orders')}>Orders / Results</button>
                </div>

                <div className="tab-content meta">
                  {activeTab === 'alerts' ? (
                    (alerts && alerts.length > 0) ? (
                      <ul className="alerts">
                        {alerts.map(a => (
                          <li key={a.id} className="alert-item">
                            <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
                              <div>
                                <strong className={a.type === 'bull' ? 'bull' : (a.type === 'bear' ? 'bear' : '')}>
                                  {a.type === 'bull' ? 'Bull' : (a.type === 'bear' ? 'Bear' : 'Info')}
                                </strong>
                                <div style={{fontSize:12,color:'var(--muted)'}}>
                                  {new Date(a.time).toLocaleString()} — {a.price ? Number(a.price).toLocaleString(undefined,{maximumFractionDigits:2}) : ''}
                                  <div style={{fontSize:11,color:'var(--muted)'}}>{a.msg}</div>
                                </div>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : ('No alerts yet.')
                  ) : (
                    (orders && orders.length > 0) ? (
                      <ul className="orders-list">
                        {orders.map(o => (
                          <li key={o.id} className="alert-item">
                            <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
                              <div>
                                <strong className={o.side === 'BUY' ? 'bull' : 'bear'}>{o.side} {o.symbol}</strong>
                                <div style={{fontSize:12,color:'var(--muted)'}}>
                                  {new Date(o.time).toLocaleString()} — qty: {o.quantity} — usdt: {o.usdt}
                                  {o.response ? <div style={{fontSize:11,color:'var(--muted)'}}>resp: {JSON.stringify(o.response)}</div> : null}
                                </div>
                              </div>
                              <div style={{textAlign:'right'}}>
                                <div style={{fontSize:13,fontWeight:700}}>{o.status}</div>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : ('No orders yet.')
                  )}
                </div>
              </div>
              {/* (removed) sidebar positions — moved under chart */}
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}

function ChartToggle({ livePrice, onTrade, onCross, emaShort = 26, emaLong = 200, minutes = 1, symbol = 'BTCUSDT' }) {
  const toBinanceInterval = (m) => {
    const n = Math.max(1, Number(m || 1))
    const map = {
      1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m',
      60: '1h', 120: '2h', 240: '4h', 360: '6h', 480: '8h', 720: '12h',
      1440: '1d', 4320: '3d', 10080: '1w'
    }
    if (map[n]) return map[n]
    // fallback: if divisible by 1440 use days, else if divisible by 60 use hours
    if (n % 1440 === 0) return `${n / 1440}d`
    if (n % 60 === 0) return `${n / 60}h`
    // last resort: minutes string (Binance may reject unknown intervals)
    return `${n}m`
  }
  const interval = toBinanceInterval(minutes)
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
        symbol={String(symbol || 'BTCUSDT')}
      />
    </Suspense>
  )
}


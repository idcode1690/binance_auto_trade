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
  const [autoOrderEnabled, setAutoOrderEnabled] = useState(() => {
    try { return localStorage.getItem('autoOrderEnabled') === 'true' } catch (e) { return false }
  })
  const [testOrderSizeStr, setTestOrderSizeStr] = useState(() => {
    try { return localStorage.getItem('testOrderSize') || '10' } catch (e) { return '10' }
  })
  const [testFeedback, setTestFeedback] = useState(null)
  const [sendLive, setSendLive] = useState(() => { try { return localStorage.getItem('sendLive') === 'true' } catch (e) { return false } })
  const [orders, setOrders] = useState(() => {
    try { const raw = localStorage.getItem('orders'); return raw ? JSON.parse(raw) : [] } catch (e) { return [] }
  })
  const [activeTab, setActiveTab] = useState('alerts') // 'alerts' or 'orders'
  const [holdingsStr, setHoldingsStr] = useState(() => {
    try { return localStorage.getItem('holdings') || '0' } catch (e) { return '0' }
  })
  const [futuresBalanceStr, setFuturesBalanceStr] = useState(() => {
    try { return localStorage.getItem('futuresBalance') || '0' } catch (e) { return '0' }
  })
  const [account, setAccount] = useState(null)
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
  const price = formatPrice(lastPrice)
  const holdings = Number(holdingsStr) || 0
  const value = isFinite(Number(lastPrice)) ? holdings * Number(lastPrice) : null
  const change = ''
  const candles = 0

  // Poll backend for Binance Futures account info (requires server running and .env set)
  useEffect(() => {
    let mounted = true
    const backendUrls = [
      'http://127.0.0.1:3000/api/futures/account',
      '/api/futures/account'
    ]
    const fetchAccount = async () => {
      for (const url of backendUrls) {
        try {
          const resp = await fetch(url)
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const data = await resp.json()
          if (!mounted) return
                if (data) {
                  setAccount(data)
                  if (typeof data.totalWalletBalance !== 'undefined' && data.totalWalletBalance !== null) {
                    try { localStorage.setItem('futuresBalance', String(data.totalWalletBalance)) } catch (e) {}
                    setFuturesBalanceStr(String(data.totalWalletBalance))
                  }
                  if (Array.isArray(data.positions) && symbol) {
                    const p = data.positions.find(x => x.symbol === String(symbol).toUpperCase())
                    if (p) {
                      const amt = Number(p.positionAmt) || 0
                      try { localStorage.setItem('holdings', String(amt)) } catch (e) {}
                      setHoldingsStr(String(amt))
                    }
                  }
                }
          // success — stop trying other urls
          return
        } catch (err) {
          // try next url
        }
      }
      // all attempts failed — ignore and keep local values
    }
    fetchAccount()
    const id = setInterval(fetchAccount, 10000)
    return () => { mounted = false; clearInterval(id) }
  }, [symbol])

  const wsRef = useRef(null)
  const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade'
  // App no longer opens a dedicated trade websocket; SmallEMAChart will provide live trade
  // callbacks via the `onTrade` prop so we can update `lastPrice`.

  return (
    <div className="container body-root">
      <Hero title="Binance Auto Trading System" />

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
                onCross={(c) => setAlerts(prev => [{ id: Date.now(), ...c }, ...prev].slice(0, 50))}
                emaShort={emaShort}
                emaLong={emaLong}
                minutes={minutes}
                symbol={symbol}
              />
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
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:600}}>Futures USDT Balance</div>
                    <div style={{fontSize:12,color:'var(--muted)'}}>{account && typeof account.totalWalletBalance !== 'undefined' ? 'Binance Futures wallet (from API)' : 'Binance Futures wallet (not connected)'}</div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div style={{fontSize:16,fontWeight:600}}>{account && typeof account.totalWalletBalance !== 'undefined' ? formatPrice(Number(account.totalWalletBalance)) : formatPrice(Number(futuresBalanceStr || 0))}</div>
                    <div style={{fontSize:13}}>{account && typeof account.totalUnrealizedProfit !== 'undefined' ? `Unrealized P/L: ${formatPrice(Number(account.totalUnrealizedProfit))} USDT` : ''}</div>
                  </div>
                </div>
              </div>
              {/* Test Order controls */}
              <div style={{marginTop:10,display:'flex',gap:8,alignItems:'center'}}>
                <input className="theme-input" type="number" min={0.1} step={0.1} value={testOrderSizeStr} onChange={e=>setTestOrderSizeStr(e.target.value)} onBlur={() => { const v = String(Math.max(0.0001, Number(testOrderSizeStr) || 10)); setTestOrderSizeStr(v); try{ localStorage.setItem('testOrderSize', v) } catch(e){} }} style={{width:120,padding:6,borderRadius:6}} />
                <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:'var(--muted)'}}>
                  <input type="checkbox" checked={sendLive} onChange={e=>{ const v = !!e.target.checked; setSendLive(v); try{ localStorage.setItem('sendLive', v ? 'true' : 'false') }catch{} }} />
                  Send Live
                </label>
                <button className="btn" onClick={async () => {
                  const usdt = Number(testOrderSizeStr) || 0
                  if (!(usdt > 0)) {
                    const msg = 'Invalid USDT size'
                    setAlerts(prev => [{ id: Date.now(), type: 'error', time: Date.now(), price: lastPrice, msg }, ...prev].slice(0,50))
                    setTestFeedback({ type: 'error', msg })
                    setTimeout(() => setTestFeedback(null), 8000)
                    return
                  }
                  const priceNum = Number(lastPrice)
                  if (!isFinite(priceNum) || priceNum <= 0) {
                    const msg = 'No valid live price available'
                    setAlerts(prev => [{ id: Date.now(), type: 'error', time: Date.now(), price: lastPrice, msg }, ...prev].slice(0,50))
                    setTestFeedback({ type: 'error', msg })
                    setTimeout(() => setTestFeedback(null), 8000)
                    return
                  }
                  
                  // Fetch exchangeInfo for symbol to determine stepSize and minNotional
                  let decimals = 6 // fallback
                  let minQty = 0
                  let minNotional = 0
                  try {
                    const s = String(symbol || 'BTCUSDT').toUpperCase()
                    const resp = await fetch(`https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=${s}`)
                    if (resp && resp.ok) {
                      const j = await resp.json()
                      const info = j && j.symbols && j.symbols[0]
                      if (info && Array.isArray(info.filters)) {
                        const lot = info.filters.find(f => f.filterType === 'LOT_SIZE')
                        const minNot = info.filters.find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL')
                        if (lot && lot.stepSize) {
                          // compute decimals from stepSize, e.g. 0.001 -> 3
                          const step = String(lot.stepSize)
                          if (step.indexOf('.') >= 0) {
                            const dec = step.split('.')[1].replace(/0+$/,'')
                            decimals = dec.length
                          } else decimals = 0
                        }
                        if (lot && lot.minQty) minQty = Number(lot.minQty)
                        if (minNot && (minNot.notional || minNot.minNotional)) minNotional = Number(minNot.notional || minNot.minNotional || 0)
                      }
                    }
                  } catch (err) {
                    // ignore — we'll still perform a best-effort rounding
                  }

                  // compute quantity from USDT and price, then floor to allowed decimals
                  let rawQty = (usdt / priceNum)
                  const factor = Math.pow(10, decimals)
                  let qty = Math.floor(rawQty * factor) / factor
                  if (qty <= 0) {
                    const msg = 'Computed quantity is zero'
                    setAlerts(prev => [{ id: Date.now(), type: 'error', time: Date.now(), price: lastPrice, msg }, ...prev].slice(0,50))
                    setTestFeedback({ type: 'error', msg })
                    setTimeout(() => setTestFeedback(null), 8000)
                    return
                  }

                  // validate minQty
                  if (minQty && qty < minQty) {
                    const msg = `Quantity ${qty} smaller than symbol minQty ${minQty}`
                    setAlerts(prev => [{ id: Date.now(), type: 'error', time: Date.now(), price: lastPrice, msg }, ...prev].slice(0,50))
                    setTestFeedback({ type: 'error', msg })
                    setTimeout(() => setTestFeedback(null), 8000)
                    return
                  }

                  // validate minNotional (requires price)
                  if (minNotional && isFinite(priceNum)) {
                    const notional = qty * priceNum
                    if (notional < minNotional) {
                      const msg = `Notional ${notional.toFixed(2)} < minNotional ${minNotional}`
                      setAlerts(prev => [{ id: Date.now(), type: 'error', time: Date.now(), price: lastPrice, msg }, ...prev].slice(0,50))
                      setTestFeedback({ type: 'error', msg })
                      setTimeout(() => setTestFeedback(null), 8000)
                      return
                    }
                  }

                  const body = { symbol: String(symbol || 'BTCUSDT'), side: 'BUY', type: 'MARKET', quantity: String(qty) }
                  if (sendLive) {
                    // attempt to POST to backend endpoints
                    const backendUrls = ['http://127.0.0.1:3000/api/futures/order', '/api/futures/order']
                    let sent = false
                    for (const url of backendUrls) {
                      try {
                        const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                        const data = await resp.json()
                        const msg = `Backend response: ${resp.status} ${JSON.stringify(data)}`
                        setAlerts(prev => [{ id: Date.now(), type: resp.ok ? 'order' : 'error', time: Date.now(), price: lastPrice, msg }, ...prev].slice(0,50))
                        setTestFeedback({ type: resp.ok ? 'success' : 'error', msg })
                        const orderEntry = { id: Date.now(), symbol: body.symbol, side: body.side, quantity: body.quantity, usdt: usdt, time: Date.now(), status: resp.ok ? 'sent' : 'error', response: data }
                        setOrders(prev => { const next = [orderEntry, ...prev].slice(0,200); try{ localStorage.setItem('orders', JSON.stringify(next)) }catch{}; return next })
                        setTimeout(() => setTestFeedback(null), 8000)
                        sent = true
                        break
                      } catch (err) {
                        // try next
                      }
                    }
                    if (!sent) {
                      const msg = 'Failed to reach backend. Order not sent.'
                      setAlerts(prev => [{ id: Date.now(), type: 'error', time: Date.now(), price: lastPrice, msg }, ...prev].slice(0,50))
                      setTestFeedback({ type: 'error', msg })
                      const orderEntry = { id: Date.now(), symbol: body.symbol, side: body.side, quantity: body.quantity, usdt: usdt, time: Date.now(), status: 'error' }
                      setOrders(prev => { const next = [orderEntry, ...prev].slice(0,200); try{ localStorage.setItem('orders', JSON.stringify(next)) }catch{}; return next })
                      setTimeout(() => setTestFeedback(null), 8000)
                    }
                  } else {
                    // simulate only
                    const msg = `Simulated order: ${body.side} ${body.quantity} ${body.symbol}`
                    setAlerts(prev => [{ id: Date.now(), type: 'sim', time: Date.now(), price: lastPrice, msg }, ...prev].slice(0,50))
                    const orderEntry = { id: Date.now(), symbol: body.symbol, side: body.side, quantity: body.quantity, usdt: usdt, time: Date.now(), status: 'simulated' }
                    setOrders(prev => { const next = [orderEntry, ...prev].slice(0,200); try{ localStorage.setItem('orders', JSON.stringify(next)) }catch{}; return next })
                    setTestFeedback({ type: 'info', msg })
                    setTimeout(() => setTestFeedback(null), 8000)
                  }
                }}>Test Order</button>
                {/* feedback message shown under the button */}
              </div>
              {testFeedback ? (
                <div style={{marginTop:8}}>
                  <div className={"test-feedback " + (testFeedback.type === 'success' ? 'test-success' : (testFeedback.type === 'error' ? 'test-error' : 'test-info'))}>{testFeedback.msg}</div>
                </div>
              ) : null}
            </div>

            <div style={{marginTop:12}}>
              <div style={{display:'flex',gap:8,marginBottom:8}}>
                <button className={"tab " + (activeTab === 'alerts' ? 'active' : '')} onClick={() => setActiveTab('alerts')}>Cross Alerts</button>
                <button className={"tab " + (activeTab === 'orders' ? 'active' : '')} onClick={() => setActiveTab('orders')}>Orders</button>
              </div>
              <div className="meta">
                {activeTab === 'alerts' ? (
                  (alerts && alerts.length > 0) ? (
                    <ul className="alerts">
                      {alerts.map(a => (
                        <li key={a.id} className="alert-item">
                          <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
                            <div>
                              <strong className={a.type === 'bull' ? 'bull' : (a.type === 'bear' ? 'bear' : '')}>
                                {a.type === 'bull' ? 'Bull' : (a.type === 'bear' ? 'Bear' : (a.type === 'order' ? 'Order' : (a.type === 'sim' ? 'Sim' : 'Info')))}
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
                  // orders tab
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


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
                {account && Array.isArray(account.positions) ? (
                  (() => {
                    const open = account.positions.filter(p => Math.abs(Number(p.positionAmt) || 0) > 0)
                    if (!open.length) return (<div style={{fontSize:12,color:'var(--muted)'}}>No open positions</div>)
                    return (
                      <div className="positions-table" style={{border:'1px solid rgba(0,0,0,0.06)',borderRadius:6,overflow:'hidden'}}>
                        <div style={{display:'flex',padding:'8px 10px',background:'rgba(0,0,0,0.02)',fontSize:12,fontWeight:700}}>
                          <div style={{flex:2}}>Symbol</div>
                          <div style={{flex:1,textAlign:'right'}}>Side</div>
                          <div style={{flex:1,textAlign:'right'}}>Qty</div>
                          <div style={{flex:1,textAlign:'right'}}>Entry</div>
                          <div style={{flex:1,textAlign:'right'}}>Notional</div>
                          <div style={{flex:1,textAlign:'right'}}>PNL (USDT)</div>
                          <div style={{flex:1,textAlign:'right'}}>ROI %</div>
                          <div style={{flex:1,textAlign:'right'}}>Lev</div>
                        </div>
                        {open.map(p => {
                          const amt = Number(p.positionAmt) || 0
                          const entry = Number(p.entryPrice) || 0
                          const upl = Number(p.unrealizedProfit) || 0
                          const initMargin = Number(p.positionInitialMargin || 0) || 0
                          const lev = p.leverage ? Number(p.leverage) : undefined
                          const side = amt > 0 ? 'LONG' : 'SHORT'
                          const notional = (Math.abs(amt) * entry) || 0
                          let roiPct = null
                          if (initMargin && initMargin > 0) {
                            roiPct = (upl / initMargin) * 100
                          } else if (lev && entry && Math.abs(amt) > 0) {
                            const usedMargin = notional / lev
                            if (usedMargin > 0) roiPct = (upl / usedMargin) * 100
                          }
                          return (
                            <div key={p.symbol} style={{display:'flex',padding:'8px 10px',alignItems:'center',fontSize:13,borderTop:'1px solid rgba(0,0,0,0.04)'}}>
                              <div style={{flex:2}}>{p.symbol}</div>
                              <div style={{flex:1,textAlign:'right'}}>{side}</div>
                              <div style={{flex:1,textAlign:'right'}}>{amt}</div>
                              <div style={{flex:1,textAlign:'right'}}>{entry ? entry.toLocaleString(undefined,{maximumFractionDigits:2}) : '—'}</div>
                              <div style={{flex:1,textAlign:'right'}}>{notional ? notional.toFixed(2) : '0.00'}</div>
                              <div style={{flex:1,textAlign:'right'}}>{upl >= 0 ? '+' : ''}{upl.toFixed(4)}</div>
                              <div style={{flex:1,textAlign:'right'}}>{roiPct != null ? `${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(2)}` : '—'}</div>
                              <div style={{flex:1,textAlign:'right'}}>{lev || '—'}</div>
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
              {/* Test Order removed */}
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


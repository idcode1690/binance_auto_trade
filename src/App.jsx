
import React, { useEffect, useRef, useState, Suspense, useMemo } from 'react';

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
    // 추가: 누락된 상태 변수 및 함수 선언
    const [activeTab, setActiveTab] = useState('alerts');
    const [alerts, setAlerts] = useState(() => {
      try { return JSON.parse(localStorage.getItem('alerts')) || [] } catch { return [] }
    });
    const [orders, setOrders] = useState(() => {
      try { return JSON.parse(localStorage.getItem('orders')) || [] } catch { return [] }
    });
    const [autoOrderEnabled, setAutoOrderEnabled] = useState(() => {
      try { return localStorage.getItem('autoOrderEnabled') === 'true' } catch { return false }
    });
    const [futuresBalanceStr, setFuturesBalanceStr] = useState(() => {
      try { return localStorage.getItem('futuresBalance') || '' } catch { return '' }
    });
    const [holdingsStr, setHoldingsStr] = useState(() => {
      try { return localStorage.getItem('holdings') || '' } catch { return '' }
    });

    // 심볼 표준화 함수 (Binance 심볼 대문자 변환)
    function normalizeSym(sym) {
      return String(sym || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    }
  const [lastWsAt, setLastWsAt] = useState(null);
  const [lastWsMsg, setLastWsMsg] = useState(null);
  const [lastPrice, setLastPrice] = useState(null);
  const [account, setAccount] = useState(null);
  const [positions, setPositions] = useState([]);
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [emaShortStr, setEmaShortStr] = useState(() => {
    try { return localStorage.getItem('emaShort') || '26' } catch (e) { return '26' }
  });
  const [emaLongStr, setEmaLongStr] = useState(() => {
    try { return localStorage.getItem('emaLong') || '200' } catch (e) { return '200' }
  });
  const [minutesStr, setMinutesStr] = useState(() => {
    try { return localStorage.getItem('minutes') || '1' } catch (e) { return '1' }
  });
  const [symbolStr, setSymbolStr] = useState(() => {
    try { return localStorage.getItem('symbol') || 'BTCUSDT' } catch (e) { return 'BTCUSDT' }
  });
  const [showSymbolList, setShowSymbolList] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [symbolsList, setSymbolsList] = useState([]);
  const [symbolsLoading, setSymbolsLoading] = useState(false);
  const emaShort = Math.max(1, parseInt(emaShortStr, 10) || 26);
  const emaLong = Math.max(1, parseInt(emaLongStr, 10) || 200);
  const minutes = Math.max(1, parseInt(minutesStr, 10) || 1);
  const symbol = (symbolStr && symbolStr.trim().toUpperCase()) || 'BTCUSDT';
  const formatPrice = (val) => {
    if (val == null) return '';
    const n = Number(val);
    if (!isFinite(n)) return '';
    const abs = Math.abs(n);
    let maxDigits = 2;
    if (abs === 0) return '0';
    if (abs < 0.0001) maxDigits = 8;
    else if (abs < 0.01) maxDigits = 8;
    else if (abs < 1) maxDigits = 6;
    else if (abs < 1000) maxDigits = 2;
    else maxDigits = 2;
    return n.toLocaleString(undefined, { maximumFractionDigits: maxDigits });
  };
  const price = formatPrice(lastPrice);
  const change = '';

  // derivedAccount는 account와 positions을 합쳐서 만듭니다.
  const derivedAccount = useMemo(() => {
    if (!account) return null;
    const acc = { ...account };
    acc.positions = Array.isArray(positions) ? positions : [];
    return acc;
  }, [account, positions]);

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
    // prefer display totals when available so totals move in sync with price ticks
    const bal = account && typeof account.displayTotalWalletBalance !== 'undefined' ? Number(account.displayTotalWalletBalance) : (account && typeof account.totalWalletBalance !== 'undefined' ? Number(account.totalWalletBalance) : Number(futuresBalanceStr || 0))
    const upl = account && typeof account.displayTotalUnrealizedProfit !== 'undefined' ? Number(account.displayTotalUnrealizedProfit) : (account && typeof account.totalUnrealizedProfit !== 'undefined' ? Number(account.totalUnrealizedProfit) : 0)
    const uplPos = upl >= 0
    // Margin Balance = 증거금 + 미실현수익
    const margin = (
      (account && typeof account.totalMarginBalance !== 'undefined' && account.totalMarginBalance !== null
        ? Number(account.totalMarginBalance)
        : account && typeof account.totalWalletBalance !== 'undefined' && account.totalWalletBalance !== null
          ? Number(account.totalWalletBalance)
          : 0)
      + (account && typeof account.totalUnrealizedProfit !== 'undefined' ? Number(account.totalUnrealizedProfit) : 0)
    );
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
          <div className="account-balance">{formatPrice(margin)}</div>
        </div>
      </div>
    )
  }

  const wsRef = useRef(null)
  const currentSymbolRef = useRef(symbol)
  useEffect(() => { currentSymbolRef.current = symbol }, [symbol])

  // Centralized lastPrice setter that validates source symbol and logs updates
  const updateLastPrice = (val, src = 'unknown', srcSym = null) => {
    try {
      if (val === null || typeof val === 'undefined') {
        setLastPrice(null)
        return
      }
      const cur = currentSymbolRef.current || ''
      if (srcSym) {
        if (normalizeSym(srcSym) !== normalizeSym(cur)) {
          // ignore price update for non-current symbol
          return
        }
      }
      // accept update
      setLastPrice(Number(val))
      try { console.debug('[lastPrice] set', { val: Number(val), src, srcSym, cur, ts: new Date().toISOString() }) } catch (e) {}
    } catch (e) {}
  }
  // attempt an initial REST load once, then open WS for realtime deltas
  const [initialLoaded, setInitialLoaded] = useState(false)
  // Cloudflare Worker에서 계정/포지션 정보 fetch (최초 1회 + 10초마다)
  useEffect(() => {
    let mounted = true;
    const fetchAccountAndPositions = async () => {
      try {
        const accountRes = await fetch('/account');
        if (accountRes.ok) {
          const accountData = await accountRes.json();
          if (mounted) setAccount(accountData);
        }
        const positionsRes = await fetch('/positions');
        if (positionsRes.ok) {
          const positionsData = await positionsRes.json();
          if (mounted) setPositions(positionsData);
        }
        if (mounted) setInitialLoaded(true);
      } catch (e) {
        console.error('Cloudflare Worker fetch error:', e);
        if (mounted) setInitialLoaded(true);
      }
    };
    fetchAccountAndPositions();
    const interval = setInterval(fetchAccountAndPositions, 10000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  // Prefetch full symbols list on app load so the picker is always populated
  useEffect(() => {
    let mounted = true;
    const prefetch = async () => {
      await loadSymbols();
    };
    prefetch();
    return () => { mounted = false };
  }, []);

  // fetch full symbol list from server when the picker opens
  useEffect(() => {
    let mounted = true;
    if (showSymbolList) {
      // always refresh symbols when opening picker to ensure full list
      loadSymbols();
    }
    return () => { mounted = false };
  }, [showSymbolList]);

  // allow closing the symbol picker with the Escape key when it's open
  useEffect(() => {
    if (!showSymbolList) return;
    const onKey = (e) => {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) {
        setShowSymbolList(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSymbolList]);

  // loadSymbols: reusable fetch function to populate symbolsList
  async function loadSymbols() {
    try {
      setSymbolsLoading(true);
      const res = await fetch('/symbols?quote=USDT&contractType=PERPETUAL&status=TRADING');
      if (!res || !res.ok) {
        return;
      }
      const data = await res.json();
      const raw = Array.isArray(data && data.symbols) ? data.symbols : (Array.isArray(data) ? data : []);
      const arr = raw.map(s => (typeof s === 'string' ? { symbol: s } : { ...s, symbol: String(s.symbol).toUpperCase() }));
      arr.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
      setSymbolsList(arr);
    } catch (e) {
      console.warn('loadSymbols error', e);
    } finally {
      setSymbolsLoading(false);
    }
  }
  
  // Send a test on-cross alert to the server
  // Determine backend base URL.
  // Priority:
  // 1. Vite env var `VITE_API_BASE` (set at build time for GitHub Pages / production)
  // 2. During local dev (vite dev server on :5173) -> http://localhost:3000
  // 3. Fallback: '' (same origin)
  function apiBase() {
    try {
      // Vite provides import.meta.env for static build-time vars
      try {
        if (import.meta && import.meta.env && import.meta.env.VITE_API_BASE) {
          const v = String(import.meta.env.VITE_API_BASE || '').trim();
          if (v) return v.replace(/\/$/, '');
        }
      } catch (e) {}
    } catch (e) {}
    try {
      if (typeof window !== 'undefined' && window.location && window.location.port === '5173') return 'http://localhost:3000';
    } catch (e) {}
    return '';
  }

  async function sendOnCrossTest() {
    try {
      // Respect auto-order toggle: only allow test when auto-ordering is enabled
      if (!autoOrderEnabled) {
        try {
          setAlerts(prev => [{ id: Date.now(), time: Date.now(), type: 'info', price: null, msg: 'Send Cross Test blocked: Auto Orders disabled' }, ...prev].slice(0, 200));
        } catch (e) {}
        return;
      }
      const payload = { symbol, type: 'bull', price: Number(lastPrice) || null, time: Date.now(), msg: `EMA Cross Test from client for ${symbol}` };
      // Immediately simulate the cross locally so the UI updates without waiting for server
      try { handleOnCross({ type: 'bull', price: payload.price, time: payload.time, msg: payload.msg }, { forward: false }); } catch (e) {}
      const base = apiBase();
      // send to server but do not show browser alert — UI already updated
      fetch(base + '/webhook/oncross', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(e => console.error('sendOnCrossTest POST failed', e));
    } catch (e) {
      console.error('sendOnCrossTest error', e)
    }
  }

  // Reusable onCross handler — can suppress server forwarding via opts.forward = false
  function handleOnCross(c, opts = { forward: true, allowWhenDisabled: false }) {
    try {
      // If auto-ordering is disabled and caller hasn't requested bypass, ignore cross events
      try {
        if (!autoOrderEnabled && !(opts && opts.allowWhenDisabled)) {
          // intentionally ignore when auto-order is off
          return
        }
      } catch (e) {}
      const crossObj = { id: Date.now(), time: c.time || Date.now(), type: c.type || 'bull', price: (typeof c.price !== 'undefined' ? c.price : lastPrice), msg: c.msg || `Simulated ${c.type || 'bull'} cross` };
      setAlerts(prev => [{ id: Date.now(), ...crossObj }, ...prev].slice(0, 200));
      try {
        const side = crossObj.type === 'bull' ? 'BUY' : 'SELL';
        const usdt = 100;
        const priceNum = Number(crossObj.price) || Number(lastPrice) || 0;
        let qty = 0;
        if (priceNum > 0) qty = Math.floor((usdt / priceNum) * 1e6) / 1e6;
        const orderEntry = { id: Date.now(), symbol: String(symbol || 'BTCUSDT'), side, quantity: qty > 0 ? String(qty) : '0', usdt, time: crossObj.time || Date.now(), status: 'simulated', source: 'cross' };
        setOrders(prev => { const next = [orderEntry, ...prev].slice(0, 200); try{ localStorage.setItem('orders', JSON.stringify(next)) }catch{}; return next });
      } catch (e) {}
      // send to server webhook in background (do not block UI) unless explicitly suppressed
      if (opts && opts.forward !== false) {
        try {
          const base = apiBase();
          fetch(base + '/webhook/oncross', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, type: crossObj.type, price: crossObj.price, time: crossObj.time, msg: crossObj.msg }) }).catch(err => console.error('forward oncross failed', err));
        } catch (e) {}
      }
    } catch (e) { console.error('handleOnCross error', e) }
  }
  const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@trade'
  // App no longer opens a dedicated trade websocket; SmallEMAChart will provide live trade
  // callbacks via the `onTrade` prop so we can update `lastPrice`.

  // WebSocket consumer for low-latency account/position deltas from server
  // Only connect after we have attempted an initial load/seed to avoid
  // racing with the initial snapshot. This ensures UI shows initial data
  // then switches to socket for realtime deltas.
  useEffect(() => {
    // if initial REST load not yet done, don't connect WS
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
        // request an authoritative snapshot from the server on connect
        try { ws.send(JSON.stringify({ type: 'get_snapshot' })) } catch (e) {}
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          // expose last raw message for on-screen debugging
          try { setLastWsMsg(msg) } catch (e) {}
          if (!mounted) return
          setLastWsAt(new Date().toISOString())
          // debug: log incoming message type and any symbol it carries
          try { console.debug('[WS] recv', msg && msg.type, (msg && (msg.position || msg.pos || msg.data || {}).symbol) || msg && msg.markPrice || null) } catch(e){}
          if (!msg) return
          // handle positional delta
          if (msg.type === 'pos_delta') {
            const pos = msg.position || msg.pos || msg.data || msg
            if (!pos || !pos.symbol) return
            // Only update lastPrice when the delta is for the currently selected symbol
            try {
              const posSym = normalizeSym(pos.symbol)
              const curSym = normalizeSym(symbol)
              if (posSym === curSym) {
                if (typeof pos.markPrice !== 'undefined' && pos.markPrice !== null) {
                  updateLastPrice(pos.markPrice, 'pos_delta', pos.symbol)
                } else if (typeof msg.markPrice !== 'undefined' && msg.markPrice !== null) {
                  updateLastPrice(msg.markPrice, 'pos_delta', pos.symbol)
                }
              }
            } catch (e) {
              // ignore
            }
            setAccount(prev => {
              const acc = prev ? { ...prev } : { positions: [] }
              const sym = normalizeSym(pos.symbol)
              acc.positions = Array.isArray(acc.positions) ? acc.positions.slice() : []
              const idx = acc.positions.findIndex(p => normalizeSym(p.symbol) === sym)
              const amtNum = Number(pos.positionAmt) || 0
              if (idx >= 0) {
                if (Math.abs(amtNum) === 0) {
                  acc.positions.splice(idx, 1)
                } else {
                  acc.positions[idx] = { ...acc.positions[idx], ...pos }
                }
              } else {
                if (Math.abs(amtNum) !== 0) {
                  acc.positions.push({ ...pos })
                }
              }
              if (sym === normalizeSym(symbol)) {
                try { const amt = String(amtNum || 0); localStorage.setItem('holdings', amt); setHoldingsStr(amt) } catch (e) {}
              }
              return acc
            })
          } else if (msg.type === 'acct_delta') {
            const totals = msg.totals || msg.data || {}
            // if acct_delta carries a markPrice for our symbol, update lastPrice
            if (typeof msg.markPrice !== 'undefined' && msg.markPrice !== null && msg.symbol) {
              try {
                if (normalizeSym(msg.symbol) === normalizeSym(symbol)) {
                  updateLastPrice(msg.markPrice, 'acct_delta', msg.symbol)
                }
              } catch (e) {}
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
            if (snap) {
              setAccount(snap)
              try {
                // if snapshot contains a position for current symbol, seed lastPrice from it
                const posArr = Array.isArray(snap.positions) ? snap.positions : (Array.isArray(snap) ? snap : [])
                const cur = normalizeSym(symbol)
                const found = posArr.find(p => p && normalizeSym(p.symbol) === cur)
                if (found && (typeof found.markPrice !== 'undefined' && found.markPrice !== null)) {
                  updateLastPrice(found.markPrice, 'snapshot', found.symbol)
                } else if (found && (typeof found.indexPrice !== 'undefined' && found.indexPrice !== null)) {
                  updateLastPrice(found.indexPrice, 'snapshot', found.symbol)
                }
              } catch (e) {}
            }
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


  // No REST initial fetch: client relies solely on server WebSocket messages
  // (`snapshot`, `pos_delta`, `acct_delta`) to populate account data.

  // REST polling removed: client will now rely exclusively on WebSocket
  // account/pos deltas and server-sent 'snapshot' messages. This avoids
  // triggering Binance REST rate limits and IP bans. If a fresh full
  // snapshot is required, the server should emit a 'snapshot' message
  // over the existing WebSocket stream.

  // 실시간 가격 WebSocket(useEffect) 제거됨. SmallEMAChart에서만 관리.

  return (
    <div className="container body-root">
      {/* Debug overlay(WS 상태 토스트) 제거됨 */}
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
                <div style={{position:'relative'}}>
                  <div role="button" tabIndex={0} onClick={async () => { setShowSymbolList(true); setSymbolFilter(''); if (!symbolsLoading) await loadSymbols(); }} onKeyDown={async (e)=>{ if(e.key==='Enter'){ setShowSymbolList(true); setSymbolFilter(''); if (!symbolsLoading) await loadSymbols(); } }} className="theme-input" style={{width:120,padding:6,borderRadius:6,display:'flex',alignItems:'center',justifyContent:'space-between',cursor:'pointer'}}>
                    <span>{(symbolStr||'BTCUSDT').toUpperCase()}</span>
                    <span style={{opacity:0.8,fontSize:12}}>{showSymbolList ? '▴' : '▾'}</span>
                  </div>
                  {showSymbolList && (
                    <div className="symbol-picker" style={{position:'absolute',right:0,top:'42px',zIndex:60}}>
                      <div style={{padding:8,display:'flex',gap:8,alignItems:'center'}}>
                        <input className="theme-input" placeholder="Filter" value={symbolFilter} onChange={e=>setSymbolFilter(e.target.value.toUpperCase())} style={{width:180}} />
                        <button className="picker-close" aria-label="Close symbol list" onClick={() => setShowSymbolList(false)} style={{marginLeft:6}}>&times;</button>
                      </div>
                      <div style={{maxHeight:'72vh',overflow:'auto'}}>
                          {(() => {
                            const fallback = ['BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT','SOLUSDT','ADAUSDT','DOTUSDT','LTCUSDT','LINKUSDT','TRXUSDT'];
                            const opts = (Array.isArray(symbolsList) && symbolsList.length) ? symbolsList.map(s => String(s.symbol).toUpperCase()) : fallback;
                            const filtered = opts.filter(s => s.includes(symbolFilter || ''))
                            if (symbolsLoading) return (<div style={{padding:10,color:'var(--muted)'}}>Loading symbols…</div>)
                            if (!filtered.length) return (<div style={{padding:10,color:'var(--muted)'}}>No symbols</div>)
                            return filtered.map(s => (
                              <div key={s} onClick={() => { const val = String(s||'BTCUSDT').toUpperCase(); setSymbolStr(val); try{ localStorage.setItem('symbol', val) }catch{}; }} style={{padding:'8px 10px',cursor:'pointer',borderBottom:'1px solid rgba(255,255,255,0.02)'}}>
                                {s}
                              </div>
                            ))
                          })()}
                      </div>
                    </div>
                  )}
                {/* debug badge removed */}
                </div>
                <label style={{fontSize:13,color:'var(--muted)'}}>EMA1:</label>
                <input className="theme-input" type="number" min={1} value={emaShortStr} onChange={e=>setEmaShortStr(e.target.value)} onBlur={() => { const v = String(Math.max(1, parseInt(emaShortStr,10) || 26)); setEmaShortStr(v); try{ localStorage.setItem('emaShort', v) } catch(e){} }} style={{width:72,padding:6,borderRadius:6}} />
                <label style={{fontSize:13,color:'var(--muted)'}}>EMA2:</label>
                <input className="theme-input" type="number" min={1} value={emaLongStr} onChange={e=>setEmaLongStr(e.target.value)} onBlur={() => { const v = String(Math.max(1, parseInt(emaLongStr,10) || 200)); setEmaLongStr(v); try{ localStorage.setItem('emaLong', v) } catch(e){} }} style={{width:72,padding:6,borderRadius:6}} />
                <label style={{fontSize:13,color:'var(--muted)'}}>Interval:</label>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  {(() => {
                    const opts = [
                      { label: '1', value: '1' },
                      { label: '5', value: '5' },
                      { label: '30', value: '30' },
                      { label: '4H', value: '240' },
                      { label: '1D', value: '1440' },
                      { label: '1W', value: '10080' }
                    ];
                    return opts.map(o => {
                      const isActive = minutesStr === String(o.value)
                      return (
                        <button
                          key={o.value}
                          onClick={() => { const v = String(o.value); setMinutesStr(v); try { localStorage.setItem('minutes', v) } catch (e) {} }}
                          className={"interval-btn" + (isActive ? ' active' : '')}
                        >
                          {o.label}
                        </button>
                      )
                    })
                  })()}
                  {/* quick test button next to Interval controls */}
                  <button onClick={sendOnCrossTest} style={{marginLeft:8,padding:'6px 10px',borderRadius:6}}>Send Cross Test</button>
                </div>
              </div>
              <ChartToggle
                onCross={(c) => { handleOnCross(c) }}
                onPrice={(p) => updateLastPrice(p, 'chart', symbol)}
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
                          // prefer live `lastPrice` (from chart trades) first so UPL moves with price ticks,
                          // then server-provided `markPrice`, then indexPrice, then entry price
                          const mark = (isFinite(Number(lastPrice)) ? Number(lastPrice) : (typeof p.markPrice !== 'undefined' && p.markPrice !== null ? Number(p.markPrice) : (typeof p.indexPrice !== 'undefined' && p.indexPrice ? Number(p.indexPrice) : (entry || 0))))

                          // compute unrealized PnL using mark price (closer to Binance)
                          const computedUpl = (mark - entry) * amt
                          const indexPrice = (typeof p.indexPrice !== 'undefined' ? Number(p.indexPrice) : 0)
                          const indexUsed = indexPrice || mark
                          const computedUplIndex = (indexUsed - entry) * amt
                          // prefer explicit server-provided unrealizedProfit if present
                          const upl = (typeof p.unrealizedProfit !== 'undefined' && p.unrealizedProfit !== null) ? Number(p.unrealizedProfit) : computedUpl

                          // margin / leverage / notional
                          const initMargin = Number(p.positionInitialMargin || p.initialMargin || 0) || 0
                          const lev = (typeof p.leverage !== 'undefined' && p.leverage !== null) ? Number(p.leverage) : (typeof p.leverageUsed !== 'undefined' ? Number(p.leverageUsed) : undefined)
                          const notional = (Math.abs(amt) * (mark || entry || 0)) || 0

                          // determine used margin: prefer explicit initialMargin, otherwise estimate from notional/leverage
                          let usedMargin = 0
                          if (initMargin > 0) usedMargin = initMargin
                          else if (lev && notional > 0) usedMargin = notional / lev
                          else usedMargin = 0

                          // compute ROI safely
                          let roiPct = null
                          if (usedMargin > 0) {
                            roiPct = (upl / usedMargin) * 100
                          }

                          const isPos = upl >= 0
                          const pnlClass = isPos ? 'pnl-pos' : 'pnl-neg'

                          // display helper values
                          const displayLev = lev || '—'
                          const displaySize = Math.abs(amt) || 0
                          const assetSymbol = String(p.symbol || p._raw && p._raw.symbol || '').replace(/USDT$/,'')
                          const displayEntry = entry ? formatPrice(entry) : '—'
                          const displayMargin = usedMargin > 0 ? `${formatPrice(usedMargin)} USDT` : '—'
                          const displayPnl = `${upl >= 0 ? '+' : ''}${Number(upl || 0).toFixed(4)} USDT`
                          const displayRoi = roiPct != null ? `(${roiPct >= 0 ? '+' : ''}${Number(roiPct).toFixed(2)}%)` : '(—)'
                          const displayMarginType = p.marginType ? (String(p.marginType).toUpperCase() === 'ISOLATED' ? '(Isolated)' : '(Cross)') : '(Cross)'

                          return (
                            <div key={p.symbol + String(p.positionAmt) + String(p.entryPrice)} style={{display:'flex',gap:12,padding:'8px 6px',alignItems:'center',fontSize:13,borderTop:'1px solid rgba(0,0,0,0.04)'}}>
                              <div style={{flex:1.2}}>{p.symbol || '—'}</div>
                              <div style={{flex:1,textAlign:'right'}}>{displayLev}</div>
                              <div style={{flex:1,textAlign:'right'}}>{displaySize} {assetSymbol}</div>
                              <div style={{flex:1,textAlign:'right'}}>{displayEntry}</div>
                              <div style={{flex:1.2,textAlign:'right'}}>
                                {displayMargin
                                }
                              </div>
                              <div className={"pnl-cell " + pnlClass} style={{flex:1,textAlign:'right'}}>
                                <div className="pnl-amount">{displayPnl}</div>
                                <div className="pnl-percent">{displayRoi}</div>
                              </div>
                              <div style={{flex:1,textAlign:'right'}}>{displayMarginType}</div>
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
              <AccountSummary account={derivedAccount || account} />
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
      {/* Full-screen modal to show entire symbol list for easy selection */}
      {/* full-screen modal removed per request; picker itself now expands to viewport height */}
    </div>
  )
}

function ChartToggle({ onCross, onPrice, emaShort = 26, emaLong = 200, minutes = 1, symbol = 'BTCUSDT' }) {
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
  // key를 부여하여 주요 파라미터 변경 시에만 마운트/언마운트
  return (
    <Suspense fallback={<div className="meta">Loading chart...</div>}>
      <SmallEMAChart
        key={`${symbol}-${interval}-${emaShort}-${emaLong}-${minutes}`}
        interval={interval}
        limit={300}
        onCross={onCross}
        onPrice={onPrice}
        emaShort={Number(emaShort)||26}
        emaLong={Number(emaLong)||200}
        symbol={String(symbol || 'BTCUSDT')}
      />
    </Suspense>
  )
}


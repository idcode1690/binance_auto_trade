require('dotenv').config()
const express = require('express')
const axios = require('axios')
const crypto = require('crypto')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000
const API_KEY = process.env.BINANCE_API_KEY
const API_SECRET = process.env.BINANCE_API_SECRET
const USE_TESTNET = String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true'

// Allow overriding the base URLs via env vars for flexibility
const FUTURES_API_BASE = process.env.BINANCE_FUTURES_API_BASE || (USE_TESTNET ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com')
const FUTURES_WS_BASE = process.env.BINANCE_FUTURES_WS_BASE || (USE_TESTNET ? 'wss://stream.binancefuture.com' : 'wss://stream.binance.com:9443')
const WebSocketClient = require('ws')
const { WebSocketServer } = require('ws')

// WS clients (for fast account/position deltas)
let wss = null

// market data WS (markPrice) to provide low-latency price updates for PNL
let marketWs = null
let marketSubscribedSymbols = []

function normalizeSymbolsList(arr) {
  return Array.from(new Set((arr || []).map(s => String(s || '').toUpperCase()).filter(Boolean)))
}

function updateMarketSubscriptionsFromSnapshot(snapshot) {
  try {
    if (!snapshot || !Array.isArray(snapshot.positions)) return
    const symbols = normalizeSymbolsList(snapshot.positions.filter(p => Math.abs(Number(p.positionAmt) || 0) > 0).map(p => p.symbol))
    // if nothing to subscribe, close existing
    if (!symbols.length) {
      if (marketWs) {
        try { marketWs.terminate() } catch (e) {}
        marketWs = null
        marketSubscribedSymbols = []
      }
      return
    }
    // same set -> ignore
    const same = symbols.length === marketSubscribedSymbols.length && symbols.every(s => marketSubscribedSymbols.includes(s))
    if (same) return

    // build stream URL: subscribe to markPrice per symbol
    const streams = symbols.map(s => `${s.toLowerCase()}@markPrice`).join('/')
    const url = `${FUTURES_WS_BASE}/stream?streams=${streams}`

    // close previous
    if (marketWs) {
      try { marketWs.terminate() } catch (e) {}
      marketWs = null
    }

    marketSubscribedSymbols = symbols
    console.info('subscribing markPrice streams ->', streams)
    marketWs = new WebSocketClient(url)

    marketWs.on('open', () => {
      console.log('market markPrice ws open for', symbols.join(', '))
    })

    marketWs.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString())
        // wrapped stream message: { stream, data }
        const data = parsed && (parsed.data || parsed) ? (parsed.data || parsed) : null
        if (!data) return
        const sym = (data.s || data.symbol || '').toUpperCase()
        const markPrice = Number(data.p || data.markPrice || data.price || 0)
        if (!sym || !isFinite(markPrice)) return

        // update latestAccountSnapshot positions for this symbol
        if (!latestAccountSnapshot) return
        let prevTotalUpl = Number(latestAccountSnapshot.totalUnrealizedProfit || 0)
        let newTotalUpl = 0
        latestAccountSnapshot.positions = latestAccountSnapshot.positions.map(p => {
          if (!p || !p.symbol) return p
          if (String(p.symbol).toUpperCase() === sym) {
            const amt = Number(p.positionAmt) || 0
            const entry = Number(p.entryPrice) || 0
            const newUpl = (markPrice - entry) * amt
            const updated = { ...p, markPrice, unrealizedProfit: newUpl }
            // send a lightweight ws delta for this symbol
            try {
              broadcastWs({
                type: 'pos_delta',
                symbol: sym,
                markPrice,
                positionAmt: amt,
                unrealizedProfit: newUpl,
                ts: Date.now()
              })
            } catch (e) {}
            return updated
          }
          return p
        })
        for (const pp of latestAccountSnapshot.positions) {
          newTotalUpl += Number(pp.unrealizedProfit || 0)
        }
        const delta = newTotalUpl - prevTotalUpl
        latestAccountSnapshot.totalUnrealizedProfit = newTotalUpl
        latestAccountSnapshot.totalWalletBalance = Number(latestAccountSnapshot.totalWalletBalance || 0) + delta
        // broadcast updated snapshot to SSE clients and a compact account delta to WS clients
        broadcastAccountUpdate(latestAccountSnapshot)
        try {
          broadcastWs({ type: 'acct_delta', totalUnrealizedProfit: latestAccountSnapshot.totalUnrealizedProfit, totalWalletBalance: latestAccountSnapshot.totalWalletBalance, ts: Date.now() })
        } catch (e) {}
      } catch (e) {
        // ignore parse errors
      }
    })

    marketWs.on('close', (code, reason) => {
      console.warn('market ws closed', code, reason)
      marketWs = null
      marketSubscribedSymbols = []
      // don't aggressively reconnect here; will be re-established when snapshot updates
    })

    marketWs.on('error', (err) => {
      console.warn('market ws error', err && err.message)
      try { if (marketWs) marketWs.terminate() } catch (e) {}
      marketWs = null
      marketSubscribedSymbols = []
    })
  } catch (e) {}
}

// SSE clients and latest account snapshot cache
const sseClients = new Set()
let latestAccountSnapshot = null
let userData = {
  listenKey: null,
  ws: null,
  keepaliveInterval: null,
  reconnectTimer: null,
  reconnectBackoffMs: 1000
}

function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex')
}

async function signedGet(path, params = {}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error('Missing BINANCE_API_KEY or BINANCE_API_SECRET in environment')
  }
  const base = FUTURES_API_BASE
  const ts = Date.now()
  const q = new URLSearchParams({ ...params, timestamp: String(ts) }).toString()
  const signature = sign(q)
  const url = `${base}${path}?${q}&signature=${signature}`
  const res = await axios.get(url, { headers: { 'X-MBX-APIKEY': API_KEY } })
  return res.data
}

// Simple in-memory cache for exchangeInfo per-symbol
const exchangeCache = new Map()
async function getExchangeInfoForSymbol(sym) {
  const s = String(sym || '').toUpperCase()
  if (!s) return null
  const now = Date.now()
  const cached = exchangeCache.get(s)
  if (cached && (now - cached.ts) < 1000 * 60 * 5) { // 5 minutes
    return cached.info
  }
  try {
    const url = `${FUTURES_API_BASE}/fapi/v1/exchangeInfo?symbol=${s}`
    const resp = await axios.get(url)
    const info = resp.data && resp.data.symbols && resp.data.symbols[0] ? resp.data.symbols[0] : null
    if (info) exchangeCache.set(s, { ts: now, info })
    return info
  } catch (err) {
    return null
  }
}

function stepSizeToDecimals(step) {
  // step is a string like '0.00000100' or '1'
  if (!step) return 0
  const s = String(step)
  if (s.indexOf('1') === 0 && s.indexOf('.') === -1) return 0
  // count number of decimals after decimal point where digit is not zero in step
  const parts = s.split('.')
  if (parts.length < 2) return 0
  // e.g. '0.00100000' -> decimals = 3
  const dec = parts[1].replace(/0+$/,'')
  return dec.length
}

app.get('/api/futures/account', async (req, res) => {
  try {
    // If API keys are missing, return a consistent empty snapshot with a warning
    if (!API_KEY || !API_SECRET) {
      return res.json({
        totalWalletBalance: 0,
        totalUnrealizedProfit: 0,
        positions: [],
        warning: 'Missing BINANCE_API_KEY or BINANCE_API_SECRET on server'
      })
    }

    // fetch main account snapshot (includes balances + positions)
    const data = await signedGet('/fapi/v2/account')
    // Return essential fields only and parse numeric fields so frontend can consume reliably
    const out = {
      totalWalletBalance: typeof data.totalWalletBalance !== 'undefined' ? Number(data.totalWalletBalance) : null,
      totalUnrealizedProfit: typeof data.totalUnrealizedProfit !== 'undefined' ? Number(data.totalUnrealizedProfit) : null,
      positions: Array.isArray(data.positions) ? data.positions.map(p => ({
        symbol: p.symbol,
        // parsed numeric values (numbers, not strings)
        positionAmt: Number(p.positionAmt) || 0,
        entryPrice: Number(p.entryPrice) || 0,
        unrealizedProfit: Number(p.unRealizedProfit || p.unrealizedProfit) || 0,
        leverage: p.leverage ? Number(p.leverage) : undefined,
        marginType: p.marginType || p.marginType || undefined,
        positionSide: p.positionSide || undefined,
        // include initial margin and isolated wallet when present so frontend can compute ROI
        positionInitialMargin: Number(p.positionInitialMargin || p.initialMargin || p.initMargin || 0) || 0,
        isolatedWallet: (typeof p.isolatedWallet !== 'undefined') ? Number(p.isolatedWallet) : (typeof p.isIsolatedWallet !== 'undefined' ? Number(p.isIsolatedWallet) : undefined)
      })) : []
    }
    // enrich positions with markPrice and fundingRate where possible
    try {
      const syms = Array.from(new Set(out.positions.map(p => p.symbol).filter(Boolean)))
      if (syms.length) {
        const promises = syms.map(s => axios.get(`${FUTURES_API_BASE}/fapi/v1/premiumIndex?symbol=${s}`).then(r => ({ symbol: s, data: r.data })).catch(() => null))
        const results = await Promise.all(promises)
        const map = new Map()
        for (const r of results) {
          if (r && r.data) map.set(r.symbol, r.data)
        }
        out.positions = out.positions.map(p => {
          const info = map.get(p.symbol)
          if (info) {
            return { ...p, markPrice: Number(info.markPrice || info.price || 0), fundingRate: Number(info.lastFundingRate || 0) }
          }
          return p
        })
      }
    } catch (e) {
      // ignore enrichment errors
    }
    // cache latest snapshot for SSE clients
    latestAccountSnapshot = out
    res.json(out)
  } catch (err) {
    const remote = err && err.response
    console.error('futures/account error', remote ? remote.data : err.message)
    // If Binance returned an auth error (401), return an empty snapshot with a warning
    if (remote && remote.status === 401) {
      return res.json({
        totalWalletBalance: 0,
        totalUnrealizedProfit: 0,
        positions: [],
        warning: 'Binance authentication failed (401). Check API key/secret or testnet setting.'
      })
    }
    res.status(500).json({ error: String(err && err.message) })
  }
})

// expose runtime config (testnet / base urls) for the frontend to adapt
app.get('/api/config', (req, res) => {
  res.json({
    useTestnet: USE_TESTNET,
    futuresApiBase: FUTURES_API_BASE,
    futuresWsBase: FUTURES_WS_BASE
  })
})

// debug endpoint to inspect market ws subscription status
app.get('/api/debug/market', (req, res) => {
  try {
    res.json({
      marketSubscribedSymbols,
      marketWsActive: !!marketWs,
      latestSnapshotExists: !!latestAccountSnapshot,
      latestSnapshotUpdatedAt: latestAccountSnapshot ? new Date().toISOString() : null
    })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message) })
  }
})

// SSE endpoint for pushing account/position updates
app.get('/api/futures/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders && res.flushHeaders()
  const id = Date.now()
  sseClients.add(res)
  // send current snapshot if available
  if (latestAccountSnapshot) {
    try { res.write(`data: ${JSON.stringify(latestAccountSnapshot)}\n\n`) } catch (e) {}
  }
  req.on('close', () => { sseClients.delete(res) })
})

function broadcastAccountUpdate(obj) {
  latestAccountSnapshot = obj
  const payload = `data: ${JSON.stringify(obj)}\n\n`
  for (const client of sseClients) {
    try { client.write(payload) } catch (e) { sseClients.delete(client) }
  }
  // update market subscriptions based on latest positions
  try { updateMarketSubscriptionsFromSnapshot(latestAccountSnapshot) } catch (e) {}
}

// Poll account snapshot periodically as a fallback in case user-data websocket isn't available
let accountPollInterval = null
async function pollAccountSnapshotOnce() {
  if (!API_KEY || !API_SECRET) return
  try {
    const d = await signedGet('/fapi/v2/account')
    const out = {
      totalWalletBalance: typeof d.totalWalletBalance !== 'undefined' ? Number(d.totalWalletBalance) : null,
      totalUnrealizedProfit: typeof d.totalUnrealizedProfit !== 'undefined' ? Number(d.totalUnrealizedProfit) : null,
      positions: Array.isArray(d.positions) ? d.positions.map(p => ({
        symbol: p.symbol,
        positionAmt: Number(p.positionAmt) || 0,
        entryPrice: Number(p.entryPrice) || 0,
        unrealizedProfit: Number(p.unRealizedProfit || p.unrealizedProfit) || 0,
        leverage: p.leverage ? Number(p.leverage) : undefined,
        marginType: p.marginType || undefined,
        positionInitialMargin: Number(p.positionInitialMargin || 0) || 0,
        isolatedWallet: (typeof p.isolatedWallet !== 'undefined') ? Number(p.isolatedWallet) : undefined
      })) : []
    }
    // enrich with premiumIndex where possible (non-blocking)
    try {
      const syms = Array.from(new Set(out.positions.map(p => p.symbol).filter(Boolean)))
      if (syms.length) {
        const promises = syms.map(s => axios.get(`${FUTURES_API_BASE}/fapi/v1/premiumIndex?symbol=${s}`).then(r => ({ symbol: s, data: r.data })).catch(() => null))
        const results = await Promise.all(promises)
        const map = new Map()
        for (const r of results) if (r && r.data) map.set(r.symbol, r.data)
        out.positions = out.positions.map(p => {
          const info = map.get(p.symbol)
          if (info) return { ...p, markPrice: Number(info.markPrice || info.price || 0), fundingRate: Number(info.lastFundingRate || 0) }
          return p
        })
      }
    } catch (e) {}
    // broadcast to any SSE clients
    broadcastAccountUpdate(out)
  } catch (e) {
    // keep quiet — failures are expected if keys are invalid or network issues occur
    // but log minimally for debugging
    // console.warn('pollAccountSnapshotOnce failed', e && e.message)
  }
}

function startAccountPolling() {
  if (accountPollInterval) return
  accountPollInterval = setInterval(() => pollAccountSnapshotOnce(), 3000)
  // run immediately once
  pollAccountSnapshotOnce()
}

function stopAccountPolling() {
  if (!accountPollInterval) return
  clearInterval(accountPollInterval)
  accountPollInterval = null
}

// create and maintain futures user-data stream (listenKey)
async function startUserDataStream() {
  if (!API_KEY) return
  try {
    // create listen key
    const url = `${FUTURES_API_BASE}/fapi/v1/listenKey`
    const resp = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': API_KEY } })
    const listenKey = resp && resp.data && (resp.data.listenKey || resp.data) ? (resp.data.listenKey || resp.data) : null
    if (!listenKey) return
    userData.listenKey = listenKey

    // open websocket to user-data stream
    try { if (userData.ws) { try { userData.ws.close() } catch (e) {} userData.ws = null } } catch (e) {}
    const wsUrl = `${FUTURES_WS_BASE}/ws/${listenKey}`
    const ws = new WebSocketClient(wsUrl)
    userData.ws = ws

    ws.on('open', () => {
      console.log('user-data ws open')
      // reset backoff on successful open
      userData.reconnectBackoffMs = 1000
      // stop account polling while ws is active (ws will drive updates)
      try { stopAccountPolling() } catch (e) {}
      // immediate fetch of account snapshot to seed cache
      signedGet('/fapi/v2/account').then(d => {
        const out = {
          totalWalletBalance: typeof d.totalWalletBalance !== 'undefined' ? Number(d.totalWalletBalance) : null,
          totalUnrealizedProfit: typeof d.totalUnrealizedProfit !== 'undefined' ? Number(d.totalUnrealizedProfit) : null,
          positions: Array.isArray(d.positions) ? d.positions.map(p => ({
            symbol: p.symbol,
            positionAmt: Number(p.positionAmt) || 0,
            entryPrice: Number(p.entryPrice) || 0,
            unrealizedProfit: Number(p.unRealizedProfit || p.unrealizedProfit) || 0,
            leverage: p.leverage ? Number(p.leverage) : undefined,
            marginType: p.marginType || undefined,
            positionInitialMargin: Number(p.positionInitialMargin || 0) || 0,
            isolatedWallet: (typeof p.isolatedWallet !== 'undefined') ? Number(p.isolatedWallet) : undefined
          })) : []
        }
        latestAccountSnapshot = out
        broadcastAccountUpdate(out)
      }).catch(() => {})
    })

    ws.on('message', async (msg) => {
      try {
        const data = JSON.parse(msg.toString())
        // Binance wraps user-data messages directly
        const evt = data.e || (data.data && data.data.e) || null
        // If ACCOUNT_UPDATE or ORDER_TRADE_UPDATE, fetch full account snapshot
        if (evt === 'ACCOUNT_UPDATE' || evt === 'ORDER_TRADE_UPDATE') {
          try {
            const d = await signedGet('/fapi/v2/account')
            const out = {
              totalWalletBalance: typeof d.totalWalletBalance !== 'undefined' ? Number(d.totalWalletBalance) : null,
              totalUnrealizedProfit: typeof d.totalUnrealizedProfit !== 'undefined' ? Number(d.totalUnrealizedProfit) : null,
              positions: Array.isArray(d.positions) ? d.positions.map(p => ({
                symbol: p.symbol,
                positionAmt: Number(p.positionAmt) || 0,
                entryPrice: Number(p.entryPrice) || 0,
                unrealizedProfit: Number(p.unRealizedProfit || p.unrealizedProfit) || 0,
                leverage: p.leverage ? Number(p.leverage) : undefined,
                marginType: p.marginType || undefined,
                positionInitialMargin: Number(p.positionInitialMargin || 0) || 0,
                isolatedWallet: (typeof p.isolatedWallet !== 'undefined') ? Number(p.isolatedWallet) : undefined
              })) : []
            }
            // try to enrich with premiumIndex
            try {
              const syms = Array.from(new Set(out.positions.map(p => p.symbol).filter(Boolean)))
              if (syms.length) {
                const promises = syms.map(s => axios.get(`${FUTURES_API_BASE}/fapi/v1/premiumIndex?symbol=${s}`).then(r => ({ symbol: s, data: r.data })).catch(() => null))
                const results = await Promise.all(promises)
                const map = new Map()
                for (const r of results) if (r && r.data) map.set(r.symbol, r.data)
                out.positions = out.positions.map(p => {
                  const info = map.get(p.symbol)
                  if (info) return { ...p, markPrice: Number(info.markPrice || info.price || 0), fundingRate: Number(info.lastFundingRate || 0) }
                  return p
                })
              }
            } catch (e) {}
            broadcastAccountUpdate(out)
          } catch (e) {
            // ignore
          }
        }
      } catch (e) {}
    })

    ws.on('close', (code, reason) => {
      console.warn('user-data ws closed', code, reason)
      // ensure polling resumes
      try { startAccountPolling() } catch (e) {}
      // reconnect with exponential backoff
      if (userData.reconnectTimer) clearTimeout(userData.reconnectTimer)
      const delay = Math.min(userData.reconnectBackoffMs || 1000, 300000)
      userData.reconnectTimer = setTimeout(() => startUserDataStream(), delay)
      // increase backoff for next time
      userData.reconnectBackoffMs = Math.min((userData.reconnectBackoffMs || 1000) * 2, 300000)
    })

    ws.on('error', (err) => {
      console.warn('user-data ws error', err && err.message)
      try { ws.terminate() } catch (e) {}
      // schedule reconnect with backoff
      if (userData.reconnectTimer) clearTimeout(userData.reconnectTimer)
      const delay = Math.min(userData.reconnectBackoffMs || 1000, 300000)
      userData.reconnectTimer = setTimeout(() => startUserDataStream(), delay)
      userData.reconnectBackoffMs = Math.min((userData.reconnectBackoffMs || 1000) * 2, 300000)
    })

    // start keepalive: PUT every 30 minutes
    if (userData.keepaliveInterval) clearInterval(userData.keepaliveInterval)
    userData.keepaliveInterval = setInterval(async () => {
      try {
        await axios.put(`${FUTURES_API_BASE}/fapi/v1/listenKey`, `listenKey=${userData.listenKey}`, { headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } })
      } catch (e) {
        // if keepalive fails with auth or other errors, recreate the listenKey
        try {
          const status = e && e.response && e.response.status ? e.response.status : null
          console.warn('listenKey keepalive failed', status || e && e.message)
          // clear existing ws and intervals and try to recreate
          try { if (userData.ws) { userData.ws.terminate(); userData.ws = null } } catch (ee) {}
          if (userData.keepaliveInterval) { clearInterval(userData.keepaliveInterval); userData.keepaliveInterval = null }
          if (userData.reconnectTimer) { clearTimeout(userData.reconnectTimer); userData.reconnectTimer = null }
          // small delay then restart stream (with backoff)
          const delay = Math.min(userData.reconnectBackoffMs || 1000, 300000)
          userData.reconnectTimer = setTimeout(() => startUserDataStream(), delay)
          userData.reconnectBackoffMs = Math.min((userData.reconnectBackoffMs || 1000) * 2, 300000)
        } catch (ee) {}
      }
    }, 1000 * 60 * 30)

  } catch (err) {
    console.warn('startUserDataStream failed', err && err.message)
    if (userData.reconnectTimer) clearTimeout(userData.reconnectTimer)
    const delay = Math.min(userData.reconnectBackoffMs || 1000, 300000)
    userData.reconnectTimer = setTimeout(() => startUserDataStream(), delay)
    userData.reconnectBackoffMs = Math.min((userData.reconnectBackoffMs || 1000) * 2, 300000)
  }
}

// start the user-data stream if we have keys
startUserDataStream()
// also start periodic polling to ensure we have a recent snapshot for SSE clients
startAccountPolling()

app.post('/api/futures/order', async (req, res) => {
  try {
    const { symbol, side, type, quantity, price, reduceOnly, positionSide } = req.body || {}
    if (!symbol || !side || !type) return res.status(400).json({ error: 'symbol, side and type required' })
    // If no API keys available, respond with a simulated result
    if (!API_KEY || !API_SECRET) {
      return res.json({ simulated: true, order: { symbol, side, type, quantity, price, reduceOnly, positionSide } })
    }

    // Try to fetch exchange info for symbol to validate/round quantity
    const info = await getExchangeInfoForSymbol(symbol)
    let qQuantity = quantity
    if (info && info.filters && Array.isArray(info.filters)) {
      const lot = info.filters.find(f => f.filterType === 'LOT_SIZE')
      const minNotional = info.filters.find(f => f.filterType === 'MIN_NOTIONAL')
      if (lot) {
        const step = lot.stepSize
        const minQty = parseFloat(lot.minQty || '0')
        const maxQty = parseFloat(lot.maxQty || '0')
        const decimals = stepSizeToDecimals(step)
        // ensure numeric
        let qn = Number(qQuantity)
        if (!isFinite(qn)) return res.status(400).json({ error: 'Invalid quantity' })
        // floor to allowed decimals (downwards to avoid precision error)
        const factor = Math.pow(10, decimals)
        qn = Math.floor(qn * factor) / factor
        if (minQty && qn < minQty) {
          return res.status(400).json({ error: 'Quantity below minQty for symbol', minQty, attempted: qn })
        }
        if (maxQty && maxQty > 0 && qn > maxQty) {
          qn = Math.floor(maxQty * factor) / factor
        }
        qQuantity = String(qn)
      }
      // check notional if price provided or we can use lastPrice if available
      if (minNotional) {
        const minN = parseFloat(minNotional.notional || minNotional.minNotional || '0')
        const pnum = price ? Number(price) : null
        const qn = Number(qQuantity)
        if (pnum && isFinite(pnum) && minN && qn && qn > 0) {
          const notional = pnum * qn
          if (notional < minN) {
            return res.status(400).json({ error: 'Notional too small', minNotional: minN, notional, attemptedQty: qn })
          }
        }
      }
    }

    const base = FUTURES_API_BASE
    const ts = Date.now()
    const params = { symbol: String(symbol).toUpperCase(), side, type, quantity: qQuantity }
    if (typeof price !== 'undefined' && price !== null) params.price = String(price)
    if (typeof reduceOnly !== 'undefined') params.reduceOnly = String(reduceOnly)
    if (typeof positionSide !== 'undefined') params.positionSide = String(positionSide)
    const q = new URLSearchParams({ ...params, timestamp: String(ts) }).toString()
    const signature = sign(q)
    const url = `${base}/fapi/v1/order?${q}&signature=${signature}`
    const resp = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': API_KEY } })
    res.json(resp.data)
  } catch (err) {
    console.error('futures/order error', err && err.response ? err.response.data : err.message)
    res.status(500).json({ error: String(err && err.message), details: err && err.response ? err.response.data : undefined })
  }
})

// create HTTP server so we can attach a websocket server to the same port
const http = require('http')
const server = http.createServer(app)

// create WebSocket server for account deltas
function startWss() {
  if (wss) return
  wss = new WebSocketServer({ server, path: '/ws/account' })
  wss.on('connection', (socket, req) => {
    console.log('ws client connected for account deltas')
    // optional: send current snapshot as authoritative on connect
    try {
      if (latestAccountSnapshot) socket.send(JSON.stringify({ type: 'snapshot', account: latestAccountSnapshot }))
    } catch (e) {}
    socket.on('close', () => { /* client disconnected */ })
  })
}

function broadcastWs(obj) {
  try {
    if (!wss) return
    const payload = JSON.stringify(obj)
    for (const c of wss.clients) {
      try { if (c.readyState === c.OPEN) c.send(payload) } catch (e) {}
    }
  } catch (e) {}
}

server.listen(PORT, () => {
  console.log(`Futures proxy server listening on http://localhost:${PORT}`)
  startWss()
})

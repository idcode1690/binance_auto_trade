require('dotenv').config()
const express = require('express')
const axios = require('axios')
const crypto = require('crypto')
const cors = require('cors')

// Global handlers so the server doesn't exit on unexpected promise rejections or exceptions
process.on('unhandledRejection', (reason, p) => {
  try { console.error('Unhandled Rejection at:', p, 'reason:', reason && (reason.stack || reason)) } catch (e) {}
})
process.on('uncaughtException', (err) => {
  try { console.error('Uncaught Exception:', err && (err.stack || err)) } catch (e) {}
})

const app = express()
app.use(cors())
app.use(express.json())

const path = require('path')
const fs = require('fs')
const PORT = process.env.PORT || 3000
const API_KEY = process.env.BINANCE_API_KEY
const API_SECRET = process.env.BINANCE_API_SECRET
const USE_TESTNET = String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true'

// Allow overriding the base URLs via env vars for flexibility
const FUTURES_API_BASE = process.env.BINANCE_FUTURES_API_BASE || (USE_TESTNET ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com')
// For futures mainnet the websocket base is fstream.binance.com (linear/USDT futures)
// Use stream.binancefuture.com for the official testnet websocket.
const FUTURES_WS_BASE = process.env.BINANCE_FUTURES_WS_BASE || (USE_TESTNET ? 'wss://stream.binancefuture.com' : 'wss://fstream.binance.com')
const WebSocketClient = require('ws')
const { WebSocketServer } = require('ws')

// Rate limiting / polling configuration (tuneable via env)
const BINANCE_MIN_INTERVAL_MS = Number(process.env.BINANCE_MIN_INTERVAL_MS) || 250 // minimum ms between Binance HTTP requests (default 250ms -> ~4 req/s)
const BINANCE_POLL_INTERVAL_MS = Number(process.env.BINANCE_POLL_INTERVAL_MS) || 30000 // account poll interval when WS unavailable (default 30s)

// Simple serialized request pacing to avoid bursts hitting Binance rate limits
let _binanceLastReqTs = 0
async function binanceRequest(url, opts = {}) {
  const now = Date.now()
  const since = now - _binanceLastReqTs
  const wait = Math.max(0, BINANCE_MIN_INTERVAL_MS - since)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  _binanceLastReqTs = Date.now()
  return axios(Object.assign({ url }, opts))
}

// track if Binance has issued an IP ban (418 / -1003). If set, skip polling until ban expires.
let binanceBanUntilMs = 0

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
  // use serverTimeOffsetMs to reduce timestamp errors (recvWindow)
  const ts = Date.now() + (serverTimeOffsetMs || 0)
  const q = new URLSearchParams({ ...params, timestamp: String(ts) }).toString()
  const signature = sign(q)
  const url = `${base}${path}?${q}&signature=${signature}`
  try {
    const res = await binanceRequest(url, { method: 'get', headers: { 'X-MBX-APIKEY': API_KEY } })
    return res.data
  } catch (err) {
    // if Binance complains about timestamp, try syncing server time once and retry
    const remote = err && err.response
    // detect IP-ban message and set banUntil to avoid busy retry loops
    try {
      if (remote && remote.status === 418 && remote.data && typeof remote.data.msg === 'string') {
        const m = String(remote.data.msg).match(/(\d{10,})/)
        if (m && m[1]) {
          const bannedUntil = Number(m[1])
          if (isFinite(bannedUntil) && bannedUntil > Date.now()) {
            binanceBanUntilMs = bannedUntil
            console.warn('Binance reported IP ban until', new Date(binanceBanUntilMs).toISOString())
          }
        }
      }
    } catch (e) {}
    if (remote && remote.data && remote.data.code === -1021) {
      await syncServerTimeOnce()
      try {
        const ts2 = Date.now() + (serverTimeOffsetMs || 0)
        const q2 = new URLSearchParams({ ...params, timestamp: String(ts2) }).toString()
        const signature2 = sign(q2)
        const url2 = `${base}${path}?${q2}&signature=${signature2}`
        const res2 = await binanceRequest(url2, { method: 'get', headers: { 'X-MBX-APIKEY': API_KEY } })
        return res2.data
      } catch (e2) {
        throw e2
      }
    }
    throw err
  }
}

// Simple in-memory cache for exchangeInfo per-symbol
const exchangeCache = new Map()
// Simple in-memory cache for premiumIndex per-symbol to reduce repeated calls
const premiumIndexCache = new Map()
const PREMIUM_INDEX_TTL_MS = Number(process.env.PREMIUM_INDEX_TTL_MS) || 30 * 1000
// server time offset (ms) to correct local clock skew against Binance
let serverTimeOffsetMs = 0
async function syncServerTimeOnce() {
  try {
    const r = await axios.get(`${FUTURES_API_BASE}/fapi/v1/time`)
    const serverTs = r && r.data && r.data.serverTime ? Number(r.data.serverTime) : null
    if (serverTs && isFinite(serverTs)) {
      serverTimeOffsetMs = Number(serverTs) - Date.now()
      console.info('synced server time offset (ms):', serverTimeOffsetMs)
    }
  } catch (e) {
    // ignore
  }
}
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
    const resp = await binanceRequest(url, { method: 'get' })
    const info = resp && resp.data && resp.data.symbols && resp.data.symbols[0] ? resp.data.symbols[0] : null
    if (info) exchangeCache.set(s, { ts: now, info })
    return info
  } catch (err) {
    return null
  }
}

// Fetch premiumIndex for a symbol with short TTL caching to avoid repeated requests
async function getPremiumIndexForSymbol(sym) {
  const s = String(sym || '').toUpperCase()
  if (!s) return null
  const now = Date.now()
  const cached = premiumIndexCache.get(s)
  if (cached && (now - cached.ts) < PREMIUM_INDEX_TTL_MS) return cached.data
  try {
    const url = `${FUTURES_API_BASE}/fapi/v1/premiumIndex?symbol=${s}`
    const resp = await binanceRequest(url, { method: 'get' })
    const data = resp && resp.data ? resp.data : null
    premiumIndexCache.set(s, { ts: now, data })
    return data
  } catch (e) {
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
    // enrich positions with markPrice and fundingRate where possible (cached)
    try {
      const syms = Array.from(new Set(out.positions.map(p => p.symbol).filter(Boolean)))
      if (syms.length) {
        const promises = syms.map(async s => {
          try {
            const data = await getPremiumIndexForSymbol(s)
            return { symbol: s, data }
          } catch (e) { return null }
        })
        const results = await Promise.all(promises)
        const map = new Map()
        for (const r of results) if (r && r.data) map.set(r.symbol, r.data)
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
    // On error, if we have a cached latestAccountSnapshot, return a server-side fallback
    try {
      const remote = err && err.response
      console.error('futures/account error', remote ? remote.data : err.message)
      if (latestAccountSnapshot) {
        const fallback = {
          totalWalletBalance: typeof latestAccountSnapshot.totalWalletBalance !== 'undefined' ? Number(latestAccountSnapshot.totalWalletBalance) : 0,
          totalUnrealizedProfit: typeof latestAccountSnapshot.totalUnrealizedProfit !== 'undefined' ? Number(latestAccountSnapshot.totalUnrealizedProfit) : 0,
          positions: Array.isArray(latestAccountSnapshot.positions) ? latestAccountSnapshot.positions.map(p => ({
            symbol: p.symbol,
            positionAmt: Number(p.positionAmt) || 0,
            entryPrice: Number(p.entryPrice) || 0,
            unrealizedProfit: Number(p.unrealizedProfit || 0) || 0,
            leverage: p.leverage ? Number(p.leverage) : undefined,
            marginType: p.marginType || undefined,
            positionInitialMargin: Number(p.positionInitialMargin || 0) || 0,
            isolatedWallet: (typeof p.isolatedWallet !== 'undefined') ? Number(p.isolatedWallet) : undefined,
            markPrice: p.markPrice ? Number(p.markPrice) : undefined,
            fundingRate: p.fundingRate ? Number(p.fundingRate) : undefined
          })) : []
        }
        fallback.warning = `Returning cached snapshot due to Binance REST error: ${err && (err.message || JSON.stringify(err))}`
        return res.json(fallback)
      }
    } catch (e) {}
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

// NOTE: REST polling removed to avoid triggering Binance REST rate limits
// The server will rely on the user-data websocket ('listenKey') and the
// market markPrice websocket to drive account/position updates. If the
// user-data stream is unavailable the server will attempt to re-establish
// it using the listenKey flow rather than polling aggressively.

// create and maintain futures user-data stream (listenKey)
async function startUserDataStream() {
  if (!API_KEY) return
  try {
    // create listen key
    const url = `${FUTURES_API_BASE}/fapi/v1/listenKey`
    const resp = await binanceRequest(url, { method: 'post', headers: { 'X-MBX-APIKEY': API_KEY } })
    if (!resp) {
      console.warn('listenKey creation returned no response', url)
      return
    }
    const listenKey = resp && resp.data && (resp.data.listenKey || resp.data) ? (resp.data.listenKey || resp.data) : null
    if (!listenKey) {
      console.warn('listenKey creation unexpected response', { status: resp.status, body: resp.data })
      return
    }
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
      // NOTE: we no longer perform an immediate REST fetch to seed the snapshot
      // to avoid triggering Binance REST rate limits. The server will wait for
      // ACCOUNT_UPDATE messages on the user-data websocket to populate the
      // latestAccountSnapshot. Market markPrice updates will be handled by the
      // separate market websocket stream.
    })

    ws.on('message', async (msg) => {
      try {
        const data = JSON.parse(msg.toString())
        // Binance wraps user-data messages directly
        const evt = data.e || (data.data && data.data.e) || null
        // If ACCOUNT_UPDATE arrives from the user-data stream, parse it and
        // update our cached snapshot without issuing a REST call. ORDER_TRADE_UPDATE
        // messages are forwarded to clients.
        if (evt === 'ACCOUNT_UPDATE') {
          try {
            const acct = (data.a || data.data || data) // 'a' contains ACCOUNT_UPDATE payload
            // Extract positions (Binance uses P array for positions)
            const positions = Array.isArray(acct.P) ? acct.P.map(pp => ({
              symbol: pp.s || pp.symbol,
              positionAmt: Number(pp.pa || pp.positionAmt || 0),
              entryPrice: Number(pp.ep || pp.entryPrice || 0),
              unrealizedProfit: Number(pp.up || pp.unrealizedProfit || 0) || 0,
              // leave leverage/margin fields undefined unless provided elsewhere
              leverage: undefined,
              marginType: undefined,
              positionInitialMargin: 0,
              isolatedWallet: undefined
            })) : (latestAccountSnapshot && Array.isArray(latestAccountSnapshot.positions) ? latestAccountSnapshot.positions : [])

            // Try to infer wallet balance from balances array (B) if present
            let totalWalletBalance = (latestAccountSnapshot && Number(latestAccountSnapshot.totalWalletBalance || 0)) || 0
            if (Array.isArray(acct.B)) {
              const b = acct.B.find(x => (x.a || x.asset || '').toUpperCase() === 'USDT')
              if (b) {
                totalWalletBalance = Number(b.wb || b.walletBalance || b.cw || totalWalletBalance) || totalWalletBalance
              }
            }

            const totalUnrealizedProfit = positions.reduce((s, p) => s + (Number(p.unrealizedProfit) || 0), 0)
            const out = { totalWalletBalance, totalUnrealizedProfit, positions }
            latestAccountSnapshot = out
            broadcastAccountUpdate(out)
            try { broadcastWs({ type: 'acct_delta', totalUnrealizedProfit: out.totalUnrealizedProfit, totalWalletBalance: out.totalWalletBalance, ts: Date.now() }) } catch (e) {}
            // broadcast per-position deltas as lightweight messages
            try {
              for (const p of out.positions) {
                broadcastWs({ type: 'pos_delta', position: p, markPrice: p.markPrice, ts: Date.now() })
              }
            } catch (e) {}
          } catch (e) {}
        } else if (evt === 'ORDER_TRADE_UPDATE') {
          try { broadcastWs({ type: 'order_update', data }) } catch (e) {}
        }
      } catch (e) {}
    })

    ws.on('close', (code, reason) => {
      console.warn('user-data ws closed', code, reason)
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
    const remote = err && err.response
    if (remote) {
      try { console.warn('startUserDataStream failed', { status: remote.status, data: remote.data }) } catch (e) { console.warn('startUserDataStream failed', remote.status) }
    } else {
      console.warn('startUserDataStream failed', err && err.message)
    }
    // If Binance indicates an IP ban (418 / -1003), respect the ban-until timestamp if available
    try {
      if (remote && remote.status === 418 && remote.data && typeof remote.data.msg === 'string') {
        const m = String(remote.data.msg).match(/(\d{10,})/)
        if (m && m[1]) {
          const bannedUntil = Number(m[1])
          const banMs = Math.max(0, bannedUntil - Date.now())
          // set backoff to remaining ban duration or at least 60s, cap to 24h
          userData.reconnectBackoffMs = Math.min(Math.max(banMs, 60 * 1000), 24 * 60 * 60 * 1000)
          console.warn('startUserDataStream: IP appears banned, delaying next listenKey attempt for (ms):', userData.reconnectBackoffMs)
        }
      }
    } catch (e) {}

    if (userData.reconnectTimer) clearTimeout(userData.reconnectTimer)
    const delay = userData.reconnectBackoffMs || 1000
    userData.reconnectTimer = setTimeout(() => startUserDataStream(), delay)
    // increase backoff for next time (cap long) — keep exponential growth
    userData.reconnectBackoffMs = Math.min((userData.reconnectBackoffMs || 1000) * 2, 24 * 60 * 60 * 1000)
  }
}

// start the user-data stream if we have keys
startUserDataStream()

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

// If a production build exists, serve it from the backend so the SPA and API share origin.
try {
  const distPath = path.join(__dirname, '..', 'dist')
  console.info('Static distPath ->', distPath)
  try {
    const st = fs.statSync(distPath)
    if (st && st.isDirectory()) {
      app.use(express.static(distPath))
      // fallback to index.html for client-side routing
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'))
      })
      console.info('Serving static SPA from', distPath)
    } else {
      console.warn('Dist path exists but is not a directory:', distPath)
    }
  } catch (e) {
    console.warn('Dist path not found, skipping static serving')
  }
} catch (e) {
  console.warn('Error while attempting to setup static serving', e && e.message)
}

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
  // If a production build exists, serve it from the backend so the SPA and API share origin.
  try {
    const distPath = path.join(__dirname, '..', 'dist')
    // serve static assets (placed after API routes so /api/* remains handled above)
    app.use(express.static(distPath))
    // fallback to index.html for client-side routing
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'))
    })
  } catch (e) {
    // ignore if dist not present
  }

  console.log(`Futures proxy server listening on http://localhost:${PORT}`)
  startWss()
})

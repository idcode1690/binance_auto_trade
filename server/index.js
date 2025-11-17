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
        positionSide: p.positionSide || undefined
      })) : []
    }
    res.json(out)
  } catch (err) {
    console.error('futures/account error', err && err.response ? err.response.data : err.message)
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

// Server-Sent Events endpoint to stream account updates (polled) to the frontend.
// This provides near-real-time updates for positions without requiring the frontend
// to manage Binance user data websockets.
app.get('/api/futures/sse', async (req, res) => {
  if (!API_KEY || !API_SECRET) {
    res.status(400).json({ error: 'Missing API keys on server' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })

  let lastSnapshot = null
  let closed = false

  const send = (evt, data) => {
    try {
      res.write(`event: ${evt}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    } catch (e) {
      // ignore write errors
    }
  }

  const poll = async () => {
    if (closed) return
    try {
      const data = await signedGet('/fapi/v2/account')
      // Create a small payload with parsed numeric fields
      const out = {
        totalWalletBalance: typeof data.totalWalletBalance !== 'undefined' ? Number(data.totalWalletBalance) : null,
        totalUnrealizedProfit: typeof data.totalUnrealizedProfit !== 'undefined' ? Number(data.totalUnrealizedProfit) : null,
        positions: Array.isArray(data.positions) ? data.positions.map(p => ({
          symbol: p.symbol,
          positionAmt: Number(p.positionAmt) || 0,
          entryPrice: Number(p.entryPrice) || 0,
          unrealizedProfit: Number(p.unRealizedProfit || p.unrealizedProfit) || 0,
          leverage: p.leverage ? Number(p.leverage) : undefined,
          marginType: p.marginType || undefined,
          positionSide: p.positionSide || undefined
        })) : []
      }
      const snap = JSON.stringify(out)
      if (snap !== lastSnapshot) {
        lastSnapshot = snap
        send('account', out)
      }
    } catch (err) {
      console.error('sse poll error', err && err.response ? err.response.data : err.message)
    }
  }

  // initial poll
  poll()
  const id = setInterval(poll, 2000)

  req.on('close', () => {
    closed = true
    clearInterval(id)
  })
})

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

app.listen(PORT, () => {
  console.log(`Futures proxy server listening on http://localhost:${PORT}`)
})

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

function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex')
}

async function signedGet(path, params = {}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error('Missing BINANCE_API_KEY or BINANCE_API_SECRET in environment')
  }
  const base = 'https://fapi.binance.com'
  const ts = Date.now()
  const q = new URLSearchParams({ ...params, timestamp: String(ts) }).toString()
  const signature = sign(q)
  const url = `${base}${path}?${q}&signature=${signature}`
  const res = await axios.get(url, { headers: { 'X-MBX-APIKEY': API_KEY } })
  return res.data
}

app.get('/api/futures/account', async (req, res) => {
  try {
    // fetch main account snapshot (includes balances + positions)
    const data = await signedGet('/fapi/v2/account')
    // Return essential fields only
    const out = {
      totalWalletBalance: data.totalWalletBalance || null,
      totalUnrealizedProfit: data.totalUnrealizedProfit || null,
      positions: Array.isArray(data.positions) ? data.positions.map(p => ({
        symbol: p.symbol,
        positionAmt: p.positionAmt,
        entryPrice: p.entryPrice,
        unrealizedProfit: p.unRealizedProfit || p.unrealizedProfit || 0
      })) : []
    }
    res.json(out)
  } catch (err) {
    console.error('futures/account error', err && err.response ? err.response.data : err.message)
    res.status(500).json({ error: String(err && err.message) })
  }
})

app.post('/api/futures/order', async (req, res) => {
  try {
    const { symbol, side, type, quantity, price, reduceOnly, positionSide } = req.body || {}
    if (!symbol || !side || !type) return res.status(400).json({ error: 'symbol, side and type required' })

    // If no API keys available, respond with a simulated result
    if (!API_KEY || !API_SECRET) {
      return res.json({ simulated: true, order: { symbol, side, type, quantity, price, reduceOnly, positionSide } })
    }

    const base = 'https://fapi.binance.com'
    const ts = Date.now()
    const params = { symbol: String(symbol).toUpperCase(), side, type, quantity }
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

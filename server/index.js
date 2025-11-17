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

app.listen(PORT, () => {
  console.log(`Futures proxy server listening on http://localhost:${PORT}`)
})

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

async function forwardToTelegram(text, env) {
  const token = env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return { ok: false, reason: 'missing_telegram_credentials' }
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    })
    return await resp.json()
  } catch (e) {
    return { ok: false, reason: String(e) }
  }
}

// HMAC SHA256 helper using Web Crypto
async function hmacHex(key, data) {
  const enc = new TextEncoder()
  const keyData = enc.encode(key)
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data))
  const arr = Array.from(new Uint8Array(sig))
  return arr.map(b => b.toString(16).padStart(2, '0')).join('')
}

async function placeFuturesMarketOrder(symbol, side, quantity, env) {
  const key = env.BINANCE_API_KEY
  const secret = env.BINANCE_API_SECRET
  if (!key || !secret) throw new Error('missing_binance_credentials')
  const endpoint = 'https://fapi.binance.com/fapi/v1/order'
  const params = new URLSearchParams()
  params.set('symbol', String(symbol).toUpperCase())
  params.set('side', String(side).toUpperCase())
  params.set('type', 'MARKET')
  params.set('quantity', String(quantity))
  params.set('timestamp', String(Date.now()))
  params.set('recvWindow', '60000')
  const qs = params.toString()
  const signature = await hmacHex(secret, qs)
  const url = `${endpoint}?${qs}&signature=${signature}`
  const resp = await fetch(url, { method: 'POST', headers: { 'X-MBX-APIKEY': key } })
  const data = await resp.json().catch(() => ({ ok: false }))
  return data
}

async function fetchMarketPrice(symbol) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${encodeURIComponent(String(symbol).toUpperCase())}`
    const res = await fetch(url)
    if (!res.ok) return null
    const j = await res.json()
    return Number(j.price || j[0] && j[0].price || null)
  } catch (e) { return null }
}

async function handleRequest(req) {
  const url = new URL(req.url)
  const env = GLOBAL_ENV || {}
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-WEBHOOK-SECRET' } })
  }

  if (url.pathname === '/webhook/oncross' && req.method === 'POST') {
    // Basic secret check
    const provided = req.headers.get('x-webhook-secret') || ''
    const expected = env.WEBHOOK_SECRET || ''
    if (expected && provided !== expected) {
      return jsonResponse({ ok: false, error: 'invalid_webhook_secret' }, 401)
    }

    let body
    try { body = await req.json() } catch (e) { body = {} }
    const symbol = String(body.symbol || 'UNKNOWN').toUpperCase()
    const type = String(body.type || 'info')
    const price = (typeof body.price !== 'undefined') ? Number(body.price) : null
    const time = body.time || Date.now()
    const msg = body.msg || `EMA ${type} on ${symbol}`

    // Forward to Telegram
    const tg = await forwardToTelegram(`${type.toUpperCase()} alert for ${symbol}: ${msg} — price: ${price || 'N/A'}`, env)

    // Optionally place order
    let order = null
    let orderError = null
    try {
      const autoOrder = String(env.AUTO_ORDER_ENABLED || '').toLowerCase() === 'true'
      if (autoOrder) {
        let usedPrice = (isFinite(price) && price > 0) ? price : await fetchMarketPrice(symbol)
        if (!usedPrice) throw new Error('could_not_determine_price')
        const usdt = Number(env.ORDER_USDT) || 100
        const qty = Math.floor((usdt / usedPrice) * 1e6) / 1e6
        if (qty <= 0) throw new Error('computed_quantity_zero')
        const side = (type.toLowerCase() === 'bull') ? 'BUY' : (type.toLowerCase() === 'bear' ? 'SELL' : null)
        if (!side) throw new Error('unsupported_cross_type')
        order = await placeFuturesMarketOrder(symbol, side, qty, env)
      }
    } catch (e) {
      orderError = String(e && e.message ? e.message : e)
    }

    const resp = { ok: true, symbol, type, price, time, msg, telegram: tg, order, orderError }
    return new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
  }

  return new Response('Not found', { status: 404 })
}

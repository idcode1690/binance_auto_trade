export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const BINANCE_API_BASE = 'https://fapi.binance.com';
    const path = url.pathname;

    // --- 시그니처가 필요한 엔드포인트 ---
    if (path === '/account' || path === '/positions') {
      // timestamp와 signature 추가
      const timestamp = Date.now();
      let endpoint = '';
      if (path === '/account') endpoint = '/fapi/v2/account';
      if (path === '/positions') endpoint = '/fapi/v2/positionRisk';
      const query = `timestamp=${timestamp}`;
      const signature = await sign(query, env.BINANCE_API_SECRET);
      const apiUrl = `${BINANCE_API_BASE}${endpoint}?${query}&signature=${signature}`;
      return fetchBinanceAPI(apiUrl, env);
    } else if (path === '/chart') {
      const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
      const interval = url.searchParams.get('interval') || '1m';
      const limit = url.searchParams.get('limit') || '100';
      const apiUrl = `${BINANCE_API_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      return fetchBinanceAPI(apiUrl, env);
    } else {
      return new Response('Not Found', { status: 404 });
    }
  },
};

async function fetchBinanceAPI(apiUrl, env) {
  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': env.BINANCE_API_KEY,
      },
    });
    if (!response.ok) {
      return new Response(`Binance API error: ${response.statusText}`, { status: response.status });
    }
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}

// Cloudflare Worker에서 HMAC SHA256 서명 생성
async function sign(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
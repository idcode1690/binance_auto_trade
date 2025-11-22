const fetch = global.fetch || require('node-fetch');

function computeEMA(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out.push(null); continue; }
    if (prev == null) prev = v;
    else prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

async function run({ symbol = 'BTCUSDT', interval = '1m', limit = 300, emaShort = 26, emaLong = 200 } = {}) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const closes = data.map(r => parseFloat(r[4]));
    const short = computeEMA(closes, emaShort);
    const long = computeEMA(closes, emaLong);
    // find last valid indexes
    let i = short.length - 1;
    while (i > 0 && (short[i] == null || long[i] == null)) i--;
    if (i <= 0) {
      console.log('Not enough EMA data to determine cross');
      return;
    }
    const prev = i - 1;
    if (prev < 0 || short[prev] == null || long[prev] == null) {
      console.log('No previous EMA point to compare');
      return;
    }
    const prevDiff = short[prev] - long[prev];
    const currDiff = short[i] - long[i];
    const lastClose = closes[closes.length - 1];
    console.log(`Symbol: ${symbol} interval: ${interval} lastClose: ${lastClose}`);
    console.log(`EMA${emaShort} (prev,curr): ${short[prev].toFixed(6)}, ${short[i].toFixed(6)}`);
    console.log(`EMA${emaLong}  (prev,curr): ${long[prev].toFixed(6)}, ${long[i].toFixed(6)}`);
    if (prevDiff <= 0 && currDiff > 0) {
      console.log('Detected CROSS: BULL (short crossed above long)');
    } else if (prevDiff >= 0 && currDiff < 0) {
      console.log('Detected CROSS: BEAR (short crossed below long)');
    } else {
      console.log('No cross detected (no sign change)');
    }
  } catch (e) {
    console.error('Error checking cross:', e.message || e);
  }
}

const args = process.argv.slice(2);
const opts = {};
for (const a of args) {
  const [k,v] = a.split('='); if (k && v) opts[k] = v;
}
run(opts);

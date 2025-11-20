
import React, { useEffect, useRef, useState, useCallback } from 'react';

function computeEMA(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) {
      out.push(null);
      continue;
    }
    if (prev == null) {
      prev = v;
    } else {
      prev = v * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

export default function SmallEMAChart({ interval = '1m', limit = 200, onCross = null, onPrice = null, emaShort = 26, emaLong = 200, symbol = 'BTCUSDT' }) {
  const [klines, setKlines] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [emaShortArr, setEmaShortArr] = useState([]);
  const [emaLongArr, setEmaLongArr] = useState([]);
  const emaShortRef = useRef(null);
  const emaLongRef = useRef(null);
  const wsRef = useRef(null);
  const tradeWsRef = useRef(null);
  const initializedRef = useRef(false);
  const gapResyncTimerRef = useRef(null);
  const lastAutoResyncRef = useRef(0);
  const wsQueueRef = useRef([]);
  const isLoadingRef = useRef(true);
  const chartDivRef = useRef(null);
  const intervalToMs = (iv) => {
    const map = {
      '1m': 60000,
      '3m': 180000,
      '5m': 300000,
      '15m': 900000,
      '30m': 1800000,
      '1h': 3600000,
      '2h': 7200000,
      '4h': 14400000,
      '6h': 21600000,
      '8h': 28800000,
      '12h': 43200000,
      '1d': 86400000,
      '3d': 259200000,
      '1w': 604800000,
      '1M': 2592000000
    };
    return map[iv] || 60000;
  };
  const intervalMs = intervalToMs(interval);

  useEffect(() => {
    let cancelled = false;
    let ws = null;
    let tradeWs = null;
    let reconnectTimer = null;
    let tradeReconnectTimer = null;

    // 실시간 trade 가격을 마지막 봉 close에 반영 (단, 마지막 봉이 닫히지 않은 경우에만)
    function startTradeWS() {
      try {
        const symLower = String(symbol || 'BTCUSDT').toLowerCase();
        const tradeUrl = `wss://stream.binance.com:9443/ws/${symLower}@trade`;
        tradeWs = new WebSocket(tradeUrl);
        tradeWsRef.current = tradeWs;
        tradeWs.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            const price = parseFloat(msg.p);
            if (!isFinite(price)) return;
            setKlines(prev => {
              if (!prev || prev.length === 0) return prev;
              const arr = prev.slice();
              const last = arr[arr.length - 1];
              // 마지막 봉이 닫히지 않은 경우에만 실시간 가격 반영
              if (last && last.closed === false) {
                arr[arr.length - 1] = { ...last, close: price };
                return arr;
              }
              return prev;
            });
            if (onPrice) {
              try { onPrice(price); } catch (e) {}
            }
          } catch (e) {}
        };
        tradeWs.onclose = () => { if (!cancelled) tradeReconnectTimer = setTimeout(() => startTradeWS(), 3000); };
        tradeWs.onerror = () => {};
      } catch (e) {}
    }

    // REST + gap 보정 + 병합
    async function load() {
      setIsLoading(true);
      isLoadingRef.current = true;
      try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
        const res = await fetch(url);
        const data = await res.json();
        let mappedRaw = Array.isArray(data) ? data : [];
        let mapped = mappedRaw.map(r => {
          const t = Number(r[0]);
          const o = parseFloat(r[1]);
          const h = parseFloat(r[2]);
          const l = parseFloat(r[3]);
          const c = parseFloat(r[4]);
          const closeTime = Number(r[6]);
          return {
            time: t,
            open: isFinite(o) ? o : null,
            high: isFinite(h) ? h : null,
            low: isFinite(l) ? l : null,
            close: isFinite(c) ? c : null,
            closed: isFinite(closeTime) ? (closeTime <= Date.now()) : true,
            closeTime: isFinite(closeTime) ? closeTime : null
          };
        });
        mapped.sort((a, b) => a.time - b.time);
        // gap 보정: 연속되지 않은 봉이 있으면 REST로 추가 fetch
        const gaps = [];
        for (let i = 1; i < mapped.length; i++) {
          const prev = mapped[i - 1];
          const cur = mapped[i];
          if (!isFinite(prev.time) || !isFinite(cur.time)) continue;
          const diff = cur.time - prev.time;
          if (diff > intervalToMs(interval) + 1000) {
            const missingCount = Math.max(1, Math.round(diff / intervalToMs(interval)) - 1);
            gaps.push({ start: prev.time + intervalToMs(interval), end: cur.time - intervalToMs(interval), missingCount });
          }
        }
        if (gaps.length > 0) {
          for (const g of gaps) {
            try {
              const url2 = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${g.start}&endTime=${g.end}&limit=${g.missingCount}`;
              const res2 = await fetch(url2);
              const data2 = await res2.json();
              if (Array.isArray(data2) && data2.length) {
                for (const r of data2) {
                  const t = Number(r[0]);
                  const o = parseFloat(r[1]);
                  const h = parseFloat(r[2]);
                  const l = parseFloat(r[3]);
                  const c = parseFloat(r[4]);
                  const closeTime = Number(r[6]);
                  mapped.push({ time: t, open: isFinite(o) ? o : null, high: isFinite(h) ? h : null, low: isFinite(l) ? l : null, close: isFinite(c) ? c : null, closed: isFinite(closeTime) ? (closeTime <= Date.now()) : true, closeTime: isFinite(closeTime) ? closeTime : null });
                }
              }
            } catch (e) {}
          }
          mapped.sort((a, b) => a.time - b.time);
        }
        // dedupe by time
        const byTime = new Map();
        for (const it of mapped) byTime.set(it.time, it);
        let parsed = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
        if (parsed.length > limit) parsed = parsed.slice(parsed.length - limit);
        setKlines(parsed);
        setIsLoading(false);
        isLoadingRef.current = false;
      } catch (err) {
        setKlines([]);
        setIsLoading(false);
        isLoadingRef.current = false;
      }
    }

    // WebSocket 봉 병합: 봉 닫힘 신호 처리, 중복/누락 보정
    function handleKlineWS(candle) {
      setKlines(prev => {
        let arr = prev && prev.length ? prev.slice() : [];
        if (!prev || prev.length === 0) arr = [candle];
        else {
          const last = arr[arr.length - 1];
          if (candle.time === last.time) {
            // 봉 닫힘 신호가 오면 해당 봉을 고정
            arr[arr.length - 1] = candle;
          } else if (candle.time > last.time) {
            arr.push(candle);
            if (arr.length > limit) arr = arr.slice(arr.length - limit);
          } else {
            const idx = arr.findIndex(x => x.time === candle.time);
            if (idx >= 0) {
              arr[idx] = candle;
            }
          }
        }
        return arr;
      });
    }

    function initSockets() {
      if (initializedRef.current) return;
      initializedRef.current = true;
      try {
        const symLower = String(symbol || 'BTCUSDT').toLowerCase();
        const klineUrl = `wss://stream.binance.com:9443/ws/${symLower}@kline_${interval}`;
        ws = new WebSocket(klineUrl);
        wsRef.current = ws;
        ws.onopen = () => {};
        ws.onclose = () => { if (!cancelled) reconnectTimer = setTimeout(() => initSockets(), 3000); };
        ws.onerror = () => {};
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            const k = msg.k;
            if (k) {
              const candle = {
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
                time: k.t,
                closed: !!k.x
              };
              if (isLoadingRef.current) {
                wsQueueRef.current = wsQueueRef.current || [];
                wsQueueRef.current.push(candle);
                return;
              }
              handleKlineWS(candle);
            }
          } catch (e) {}
        };
      } catch (e) {}
    }

    load().then(() => {
      initSockets();
      startTradeWS();
    });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (tradeReconnectTimer) clearTimeout(tradeReconnectTimer);
      try { if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) wsRef.current.close(); } catch {}
      try { if (tradeWsRef.current && tradeWsRef.current.readyState !== WebSocket.CLOSED) tradeWsRef.current.close(); } catch {}
      initializedRef.current = false;
    };
  }, [interval, limit, symbol]);

  useEffect(() => {
    if (!klines || klines.length === 0) return;
    const closes = klines.map(p => p.close);
    const fullShort = computeEMA(closes, emaShort);
    const fullLong = computeEMA(closes, emaLong);
    setEmaShortArr(fullShort);
    setEmaLongArr(fullLong);
    emaShortRef.current = fullShort.length ? fullShort[fullShort.length - 1] : null;
    emaLongRef.current = fullLong.length ? fullLong[fullLong.length - 1] : null;
    // 실시간 가격 콜백 (마지막 봉의 close)
    if (onPrice && klines.length > 0) {
      const last = klines[klines.length - 1];
      if (last && typeof last.close === 'number' && isFinite(last.close)) {
        try { onPrice(last.close); } catch (e) {}
      }
    }
  }, [klines, emaShort, emaLong, onPrice]);

  const width = 600;
  const [expanded, setExpanded] = useState(true);
  const height = expanded ? 266 : 154;
  const padding = 2;
  const points = klines.length;
  const [viewCount, setViewCount] = useState(80);
  const minView = 10;
  const maxView = Math.max(minView, limit);

  // 봉완성 카운트다운 (더 부드럽게, 0.3초 단위)
  const [countdown, setCountdown] = useState(null);
  useEffect(() => {
    if (!klines || klines.length === 0) return setCountdown(null);
    const last = klines[klines.length - 1];
    if (!last || !last.time) return setCountdown(null);
    const intervalMs = intervalToMs(interval);
    let nextCandleTime = last.time + intervalMs;
    if (last.closed) nextCandleTime = Date.now() + intervalMs; // 이미 닫힌 경우(새 봉 시작 직후)
    function update() {
      const remainMs = nextCandleTime - Date.now();
      setCountdown(remainMs > 0 ? (remainMs / 1000) : 0);
    }
    update();
    const timer = setInterval(update, 300);
    return () => clearInterval(timer);
  }, [klines, interval]);

  const viewN = Math.min(points, viewCount);
  const slice = klines.slice(-viewN);
  const eShorts = emaShortArr.slice(-viewN);
  const eLongs = emaLongArr.slice(-viewN);
  const handleWheel = useCallback((e) => {
    try { e.preventDefault(); } catch (er) {}
    const delta = e.deltaY;
    const step = Math.max(1, Math.round(viewCount * 0.12));
    let next = viewCount;
    if (delta < 0) {
      next = Math.max(minView, viewCount - step);
    } else if (delta > 0) {
      const upper = Math.min(Math.max(minView, points || 0), maxView);
      next = Math.min(upper, viewCount + step);
    }
    if (next !== viewCount) setViewCount(next);
  }, [viewCount, minView, maxView, points]);

  const canZoomIn = viewN > minView;
  const canZoomOut = viewN < Math.min(points, maxView);

  useEffect(() => {
    if (!points) return;
    if (expanded) {
      setViewCount(vc => Math.max(minView, Math.round(vc * 0.6)));
    } else {
      setViewCount(vc => Math.min(Math.max(minView, points || 0, maxView), Math.round(vc / 0.6)));
    }
  }, [expanded]);

  // wheel 이벤트를 passive: false로 등록하여 preventDefault 에러 방지
  useEffect(() => {
    const el = chartDivRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => { el.removeEventListener('wheel', handleWheel, { passive: false }); };
  }, [handleWheel]);

  const highVals = slice.map(s => {
    const cand = [s.high, s.open, s.close, s.low].map(x => Number(x)).filter(v => isFinite(v));
    return cand.length ? Math.max(...cand) : null;
  }).filter(v => v != null);
  const lowVals = slice.map(s => {
    const cand = [s.low, s.open, s.close, s.high].map(x => Number(x)).filter(v => isFinite(v));
    return cand.length ? Math.min(...cand) : null;
  }).filter(v => v != null);
  if (highVals.length === 0 || lowVals.length === 0) {
    if (isLoading) return <div className="meta">Loading chart...</div>;
    return (
      <div className="meta">
        <div>No data for {String(symbol)}</div>
        <details style={{maxHeight: 200, overflow: 'auto'}}>
          <summary>Raw slice (first 20)</summary>
          <pre style={{whiteSpace: 'pre-wrap', fontSize: 12}}>{JSON.stringify(slice.slice(-20), null, 2)}</pre>
        </details>
      </div>
    );
  }
  const max = Math.max(...highVals);
  const min = Math.min(...lowVals);
  let xStep = (width - padding * 2) / (viewN - 1 || 1);
  let barW = Math.max(1, xStep * 0.6);
  const padLeft = padding;
  const padRight = Math.max(padding, Math.ceil(barW / 2) + 1);
  xStep = (width - padLeft - padRight) / (viewN - 1 || 1);
  barW = Math.max(1, xStep * 0.6);

  const yFor = v => padding + (1 - (v - min) / (max - min || 1)) * (height - padding * 2);

  const makePath = arr => {
    let d = '';
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v == null) continue;
      const x = padding + i * xStep;
      const y = yFor(v);
      d += (d === '' ? `M ${x} ${y}` : ` L ${x} ${y}`);
    }
    return d;
  };

  const pathShort = makePath(eShorts);
  const pathLong = makePath(eLongs);

  const crosses = [];
  for (let i = 1; i < viewN; i++) {
    if (i === viewN - 1 && slice.length && !slice[slice.length - 1].closed) break;
    const aPrev = eShorts[i - 1];
    const bPrev = eLongs[i - 1];
    const a = eShorts[i];
    const b = eLongs[i];
    if (a == null || b == null || aPrev == null || bPrev == null) continue;
    const prevDiff = aPrev - bPrev;
    const currDiff = a - b;
    if (prevDiff <= 0 && currDiff > 0) {
      const x = padding + i * xStep;
      const y = yFor((a + b) / 2);
      crosses.push({ x, y, type: 'bull', idx: i });
    } else if (prevDiff >= 0 && currDiff < 0) {
      const x = padding + i * xStep;
      const y = yFor((a + b) / 2);
      crosses.push({ x, y, type: 'bear', idx: i });
    }
  }

  if (points === 0) return <div className="meta">Loading chart...</div>;

  return (
    <div ref={chartDivRef} style={{width: '100%', overflow: 'hidden', cursor: canZoomIn ? 'zoom-in' : (canZoomOut ? 'zoom-out' : 'default')}}>
      {/* 봉완성 카운트다운 표시 */}
      <div style={{fontSize:14, fontWeight:600, color:'#888', marginBottom:4, textAlign:'right'}}>
        {countdown !== null && <span>봉완성까지 {countdown.toFixed(1)}s</span>}
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style={{width: '100%', height: 'auto', display: 'block'}}>
          {slice.map((c, i) => {
          if (![c.open, c.high, c.low, c.close].every(x => isFinite(Number(x)))) return null;
            const x = padLeft + i * xStep;
          const highY = yFor(c.high);
          const lowY = yFor(c.low);
          const openY = yFor(c.open);
          const closeY = yFor(c.close);
          const isUp = c.close >= c.open;
          const color = isUp ? '#0f9d58' : '#d93025';
          const bodyY = Math.min(openY, closeY);
          const bodyH = Math.max(1, Math.abs(closeY - openY));
          return (
            <g key={c.time}>
              <line x1={x} x2={x} y1={highY} y2={lowY} stroke={color} strokeWidth={1} />
              <rect x={x - barW / 2} y={bodyY} width={barW} height={bodyH} fill={color} />
            </g>
          );
        })}

        {pathLong && <path className="ema200" d={pathLong} fill="none" stroke="#888" strokeWidth={1.2} />}
        {pathShort && <path className="ema26" d={pathShort} fill="none" stroke="#ff9900" strokeWidth={1.6} />}

        {crosses.map((c, idx) => (
          <circle key={idx} className={"cross-marker " + (c.type === 'bull' ? 'bull' : 'bear')} cx={c.x} cy={c.y} r={4} />
        ))}
      </svg>
      <div className="chart-legend">
        <span className="legend-item"><span className="swatch ema26"/>{`EMA${emaShort}`}</span>
        <span className="legend-item"><span className="swatch ema200"/>{`EMA${emaLong}`}</span>
        <span className="legend-item"><span className="swatch bull"/>Bull Cross</span>
        <span className="legend-item"><span className="swatch bear"/>Bear Cross</span>
      </div>
    </div>
  );
}

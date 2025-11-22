
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const Binance = require('node-binance-api');
const axios = require('axios');

// Global diagnostic handlers to capture unexpected exits
process.on('uncaughtException', (err) => {
	console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason, p) => {
	console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

process.on('exit', (code) => {
	console.log('Process exit event with code:', code);
});

const app = express();
app.use(express.json());
app.use(cors());


// Binance API 연결
const binance = new Binance().options({
	APIKEY: process.env.BINANCE_API_KEY,
	APISECRET: process.env.BINANCE_API_SECRET,
	useServerTime: true,
	recvWindow: 60000,
	verbose: false
});

// 실시간 계정/포지션 정보 저장
// accountInfo will hold a full account snapshot compatible with the front-end
let accountInfo = { totalWalletBalance: 0, displayTotalWalletBalance: 0, totalUnrealizedProfit: 0, totalMarginBalance: 0, positions: [] };
// previous snapshot used to compute deltas to broadcast over WS
let prevAccountSnapshot = null;

// helper to broadcast a JSON message to all connected ws clients
function broadcastMessage(msg) {
	try {
		if (typeof wss === 'undefined' || !wss || !wss.clients) return;
		const payload = JSON.stringify(msg);
		wss.clients.forEach((client) => {
			try {
				if (client.readyState === WebSocket.OPEN) client.send(payload);
			} catch (e) { /* ignore per-client errors */ }
		});
	} catch (e) {
		console.error('broadcastMessage error', e && e.stack ? e.stack : e);
	}
}

// 계정/포지션 정보 주기적 갱신 (5초마다)
async function updateAccountInfo() {
	try {
		// 선물 계정 정보
		const acc = await binance.futuresAccount();
		// keep numeric conversions and add a few friendly fields the client may expect
		const next = {};
		next.totalWalletBalance = Number(acc.totalWalletBalance) || 0;
		next.displayTotalWalletBalance = next.totalWalletBalance;
		next.totalUnrealizedProfit = Number(acc.totalUnrealizedProfit) || 0;
		next.totalMarginBalance = (typeof acc.totalMarginBalance !== 'undefined' && acc.totalMarginBalance !== null)
			? Number(acc.totalMarginBalance)
			: (next.totalWalletBalance + next.totalUnrealizedProfit);
		next.positions = (Array.isArray(acc.positions) ? acc.positions : []).map(p => {
			// normalize various Binance field names and ensure numeric values where useful
			const symbol = p.symbol || p.symbolName || '';
			const positionAmt = (typeof p.positionAmt !== 'undefined') ? p.positionAmt : (typeof p.positionSize !== 'undefined' ? p.positionSize : '0');
			const entryPrice = (typeof p.entryPrice !== 'undefined') ? Number(p.entryPrice) : (typeof p.avgPrice !== 'undefined' ? Number(p.avgPrice) : 0);
			const markPrice = (typeof p.markPrice !== 'undefined') ? Number(p.markPrice) : (typeof p.lastPrice !== 'undefined' ? Number(p.lastPrice) : null);
			const unrealizedProfit = (typeof p.unrealizedProfit !== 'undefined') ? Number(p.unrealizedProfit) : (typeof p.pnl !== 'undefined' ? Number(p.pnl) : 0);
			const leverage = (typeof p.leverage !== 'undefined') ? Number(p.leverage) : (typeof p.leverageUsed !== 'undefined' ? Number(p.leverageUsed) : undefined);
			const marginType = p.marginType || p.margin || (p.isIsolated ? 'ISOLATED' : 'CROSSED');
			const positionInitialMargin = (typeof p.positionInitialMargin !== 'undefined') ? Number(p.positionInitialMargin) : (typeof p.initialMargin !== 'undefined' ? Number(p.initialMargin) : 0);
			const initialMargin = positionInitialMargin;
			const isolatedWallet = (typeof p.isolatedWallet !== 'undefined') ? Number(p.isolatedWallet) : null;
			const notional = (typeof p.notional !== 'undefined') ? Number(p.notional) : (Math.abs(Number(positionAmt || 0)) * (markPrice || entryPrice || 0));
			const indexPrice = (typeof p.indexPrice !== 'undefined') ? Number(p.indexPrice) : null;

			return {
				symbol,
				positionAmt: String(positionAmt),
				entryPrice,
				markPrice,
				unrealizedProfit,
				leverage,
				marginType,
				positionInitialMargin,
				initialMargin,
				isolatedWallet,
				notional,
				indexPrice,
				// preserve raw object for debugging if needed
				_raw: p
			};
		});

		// compute deltas relative to prevAccountSnapshot and broadcast via WS
		try {
			// account-level changes
			const acctDeltas = {};
			if (!prevAccountSnapshot || prevAccountSnapshot.totalWalletBalance !== next.totalWalletBalance) acctDeltas.totalWalletBalance = next.totalWalletBalance;
			if (!prevAccountSnapshot || prevAccountSnapshot.totalUnrealizedProfit !== next.totalUnrealizedProfit) acctDeltas.totalUnrealizedProfit = next.totalUnrealizedProfit;
			if (!prevAccountSnapshot || prevAccountSnapshot.totalMarginBalance !== next.totalMarginBalance) acctDeltas.totalMarginBalance = next.totalMarginBalance;

			if (Object.keys(acctDeltas).length > 0) {
				broadcastMessage({ type: 'acct_delta', totals: acctDeltas, markPrice: undefined });
			}

			// positions: detect per-symbol added/updated/removed
			const prevPositions = (prevAccountSnapshot && Array.isArray(prevAccountSnapshot.positions)) ? prevAccountSnapshot.positions : [];
			const prevMap = new Map(prevPositions.map(p => [String(p.symbol), p]));
			const nextMap = new Map(next.positions.map(p => [String(p.symbol), p]));

			// check updates and additions
			for (const [sym, np] of nextMap.entries()) {
				const pp = prevMap.get(sym);
				const prevAmt = pp ? String(pp.positionAmt) : '0';
				const nextAmt = String(np.positionAmt || '0');
				// if amount changed or entry/mark/unrealized changed, emit pos_delta
				if (!pp || prevAmt !== nextAmt || pp.entryPrice !== np.entryPrice || pp.markPrice !== np.markPrice || pp.unrealizedProfit !== np.unrealizedProfit) {
					broadcastMessage({ type: 'pos_delta', position: np });
				}
			}

			// check removals (positions present previously but no longer present or zeroed)
			for (const [sym, pp] of prevMap.entries()) {
				if (!nextMap.has(sym)) {
					// signal zeroed/removed position
					broadcastMessage({ type: 'pos_delta', position: { ...pp, positionAmt: '0' } });
				}
			}
		} catch (e) {
			console.error('Delta broadcast error', e && e.stack ? e.stack : e);
		}

		// update stored snapshot
		accountInfo = next;
		prevAccountSnapshot = JSON.parse(JSON.stringify(next));
	} catch (e) {
		console.error('Binance API error:', e.body || e.message || e);
	}
}
// Poll Binance REST as a fallback; keep interval short for more responsive UI when user data stream is not available
// start polling; keep the interval id so we can stop polling when user data stream is active
let accountPollInterval = null;
function startAccountPolling() {
	if (accountPollInterval) clearInterval(accountPollInterval);
	accountPollInterval = setInterval(updateAccountInfo, 2000);
	// run immediately once
	updateAccountInfo();
}
startAccountPolling();

// --- Binance Futures User Data Stream (listenKey) for near-real-time updates ---
let userDataWs = null;
let listenKey = null;
let listenKeyKeepAliveTimer = null;

async function createListenKey() {
	try {
		const headers = { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY };
		const endpoints = [
			'https://fapi.binance.com/fapi/v1/listenKey', // primary futures REST
			'https://fstream.binance.com/fapi/v1/listenKey' // alternative
		];
		for (const url of endpoints) {
			try {
				const res = await axios.post(url, null, { headers, timeout: 10000 });
				if (res && res.data) {
					// res.data may be { listenKey: '...' } or a bare string
					if (typeof res.data === 'object' && res.data.listenKey) return res.data.listenKey;
					if (typeof res.data === 'string') return res.data;
				}
			} catch (err) {
				// surface 4xx/5xx details for debugging but continue to next endpoint
				const body = err && err.response && err.response.data ? err.response.data : err.message;
				console.warn(`createListenKey attempt failed for ${url}:`, body);
			}
		}
	} catch (e) {
		console.error('createListenKey unexpected error', e && e.response ? e.response.data : e.message || e);
	}
	return null;
}

async function keepAliveListenKey() {
	if (!listenKey) return;
	try {
		await axios.put(`https://fstream.binance.com/fapi/v1/listenKey`, null, {
			params: { listenKey },
			headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY }
		});
	} catch (e) {
		console.error('keepAliveListenKey error', e && e.response ? e.response.data : e.message || e);
	}
}

async function startUserDataStream() {
	try {
		listenKey = await createListenKey();
		if (!listenKey) {
			console.warn('Could not obtain listenKey for user data stream (check API key/permissions)');
			return;
		}
		// stop account polling when user data stream is active to avoid duplicate updates
		try { if (accountPollInterval) { clearInterval(accountPollInterval); accountPollInterval = null; console.log('Stopped REST polling; using user data stream'); } } catch (e) {}
		const wsUrl = `wss://fstream.binance.com/ws/${listenKey}`;
		userDataWs = new WebSocket(wsUrl);

		userDataWs.on('open', () => {
			console.log('User data WS connected');
			// keepalive every 30 minutes (Binance requires keepalive within 60 minutes)
			if (listenKeyKeepAliveTimer) clearInterval(listenKeyKeepAliveTimer);
			listenKeyKeepAliveTimer = setInterval(keepAliveListenKey, 30 * 60 * 1000);
		});

		userDataWs.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString());
				// support both 'e' and 'eventType' naming
				const ev = msg.e || msg.eventType || msg.type;
				if (!ev) return;

				// ACCOUNT_UPDATE payload (futures) usually has `a` object with balances and positions
				if (ev === 'ACCOUNT_UPDATE' || ev === 'ACCOUNT') {
					const payload = msg.a || msg.A || msg.account || msg.data || msg;
					// payload may contain positions in different shapes: 'P' or 'positions'
					const positions = payload.P || payload.positions || payload.positions || [];
					const walletBal = (payload.B && payload.B.length) ? payload.B[0].wb : (payload.totalWalletBalance || payload.wallet || undefined);
					// build a normalized account snapshot similar to updateAccountInfo
					const next = {};
					next.totalWalletBalance = typeof walletBal !== 'undefined' ? Number(walletBal) : accountInfo.totalWalletBalance;
					next.displayTotalWalletBalance = next.totalWalletBalance;
					next.totalUnrealizedProfit = typeof payload.u !== 'undefined' ? Number(payload.u) : accountInfo.totalUnrealizedProfit;
					next.totalMarginBalance = (typeof payload.m !== 'undefined') ? Number(payload.m) : (next.totalWalletBalance + next.totalUnrealizedProfit);
					next.positions = (Array.isArray(positions) ? positions : []).map(p => {
						const symbol = p.s || p.symbol || p.symbolName || '';
						const positionAmt = (typeof p.pa !== 'undefined') ? p.pa : (typeof p.positionAmt !== 'undefined' ? p.positionAmt : (typeof p.positionSize !== 'undefined' ? p.positionSize : '0'));
						const entryPrice = (typeof p.ep !== 'undefined') ? Number(p.ep) : (typeof p.entryPrice !== 'undefined' ? Number(p.entryPrice) : 0);
						const markPrice = (typeof p.mp !== 'undefined') ? Number(p.mp) : (typeof p.markPrice !== 'undefined' ? Number(p.markPrice) : null);
						const unrealizedProfit = (typeof p.up !== 'undefined') ? Number(p.up) : (typeof p.unrealizedProfit !== 'undefined' ? Number(p.unrealizedProfit) : 0);
						const leverage = (typeof p.l !== 'undefined') ? Number(p.l) : (typeof p.leverage !== 'undefined' ? Number(p.leverage) : undefined);
						const marginType = p.mt || p.marginType || (p.isIsolated ? 'ISOLATED' : 'CROSSED');
						const positionInitialMargin = (typeof p.im !== 'undefined') ? Number(p.im) : (typeof p.positionInitialMargin !== 'undefined' ? Number(p.positionInitialMargin) : 0);
						const notional = (typeof p.notional !== 'undefined') ? Number(p.notional) : (Math.abs(Number(positionAmt || 0)) * (markPrice || entryPrice || 0));
						return {
							symbol,
							positionAmt: String(positionAmt),
							entryPrice,
							markPrice,
							unrealizedProfit,
							leverage,
							marginType,
							positionInitialMargin,
							initialMargin: positionInitialMargin,
							notional,
							_raw: p
						};
					});

					// apply to accountInfo & broadcast deltas (reuse same logic as updateAccountInfo)
					try {
						const nextSnapshot = next;
						// account deltas
						const acctDeltas = {};
						if (!prevAccountSnapshot || prevAccountSnapshot.totalWalletBalance !== nextSnapshot.totalWalletBalance) acctDeltas.totalWalletBalance = nextSnapshot.totalWalletBalance;
						if (!prevAccountSnapshot || prevAccountSnapshot.totalUnrealizedProfit !== nextSnapshot.totalUnrealizedProfit) acctDeltas.totalUnrealizedProfit = nextSnapshot.totalUnrealizedProfit;
						if (!prevAccountSnapshot || prevAccountSnapshot.totalMarginBalance !== nextSnapshot.totalMarginBalance) acctDeltas.totalMarginBalance = nextSnapshot.totalMarginBalance;
						if (Object.keys(acctDeltas).length > 0) broadcastMessage({ type: 'acct_delta', totals: acctDeltas, markPrice: undefined });

						// positions: map by symbol and broadcast pos_delta for changes
						const prevPositions = (prevAccountSnapshot && Array.isArray(prevAccountSnapshot.positions)) ? prevAccountSnapshot.positions : [];
						const prevMap = new Map(prevPositions.map(p => [String(p.symbol), p]));
						const nextMap = new Map(nextSnapshot.positions.map(p => [String(p.symbol), p]));
						for (const [sym, np] of nextMap.entries()) {
							const pp = prevMap.get(sym);
							const prevAmt = pp ? String(pp.positionAmt) : '0';
							const nextAmt = String(np.positionAmt || '0');
							if (!pp || prevAmt !== nextAmt || pp.entryPrice !== np.entryPrice || pp.markPrice !== np.markPrice || pp.unrealizedProfit !== np.unrealizedProfit) {
								broadcastMessage({ type: 'pos_delta', position: np });
							}
						}
						for (const [sym, pp] of prevMap.entries()) {
							if (!nextMap.has(sym)) broadcastMessage({ type: 'pos_delta', position: { ...pp, positionAmt: '0' } });
						}

						accountInfo = nextSnapshot;
						prevAccountSnapshot = JSON.parse(JSON.stringify(nextSnapshot));
					} catch (e) {
						console.error('userData apply/broadcast error', e && e.stack ? e.stack : e);
					}
				}
			} catch (e) {
				// ignore parse errors
			}
		});

		userDataWs.on('close', () => {
			console.warn('User data WS closed — will attempt reconnect');
			if (listenKeyKeepAliveTimer) { clearInterval(listenKeyKeepAliveTimer); listenKeyKeepAliveTimer = null; }
			userDataWs = null;
			// try reconnect after short delay
			setTimeout(() => startUserDataStream(), 5000);
		});

		userDataWs.on('error', (err) => {
			console.error('User data WS error', err && err.stack ? err.stack : err);
			try { userDataWs.terminate(); } catch (e) {}
		});
	} catch (e) {
		console.error('startUserDataStream error', e && e.stack ? e.stack : e);
		setTimeout(() => startUserDataStream(), 10000);
	}
}

// Start the user data stream in background; it's optional (requires API keys)
if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
	startUserDataStream();
}

// --- Market trade websocket: broadcast markPrice on every trade tick ---
let marketWs = null;
let marketSymbol = (process.env.MARKET_SYMBOL || 'BTCUSDT').toUpperCase();

function startMarketStream(symbol) {
	try {
		if (marketWs) {
			try { marketWs.close(); } catch (e) {}
			marketWs = null;
		}
		marketSymbol = (symbol || marketSymbol || 'BTCUSDT').toUpperCase();
		const wsUrl = `wss://stream.binance.com:9443/ws/${marketSymbol.toLowerCase()}@trade`;
		marketWs = new WebSocket(wsUrl);

		marketWs.on('open', () => {
			console.log('Market trade WS connected for', marketSymbol);
		});

		marketWs.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString());
				// trade message has price in 'p' and symbol in 's'
				const priceStr = msg.p || msg.price;
				const sym = (msg.s || marketSymbol).toUpperCase();
				const price = (typeof priceStr !== 'undefined') ? Number(priceStr) : NaN;
				if (isFinite(price)) {
						// Update in-memory accountInfo quickly so UI can compute PnL at tick speed
						try {
							// find existing position in snapshot
							if (accountInfo && Array.isArray(accountInfo.positions)) {
								const idx = accountInfo.positions.findIndex(p => String(p.symbol).toUpperCase() === String(sym).toUpperCase());
								if (idx >= 0) {
									const pos = accountInfo.positions[idx];
									const amt = Number(pos.positionAmt) || 0;
									// update markPrice
									pos.markPrice = price;
									// try to compute unrealizedProfit from entryPrice if available
									let computedUpl = null;
									const entry = Number(pos.entryPrice) || 0;
									if (entry && amt) {
										computedUpl = (price - entry) * amt;
									} else if (pos._raw && typeof pos._raw.unrealizedProfit !== 'undefined') {
										computedUpl = Number(pos._raw.unrealizedProfit) || 0;
									}
									if (computedUpl !== null) pos.unrealizedProfit = computedUpl;
									// replace position
									accountInfo.positions[idx] = pos;
									// broadcast richer pos_delta so frontend gets both markPrice and upl quickly
									broadcastMessage({ type: 'pos_delta', position: { ...pos, markPrice: price } });

									// recompute account totals (unrealized profit + margin balance) and broadcast acct_delta
									try {
										const totalUpl = accountInfo.positions.reduce((s, p) => s + (Number(p.unrealizedProfit) || 0), 0);
										const totalWallet = typeof accountInfo.totalWalletBalance !== 'undefined' ? Number(accountInfo.totalWalletBalance) : 0;
										const totalMarginBal = (typeof accountInfo.totalMarginBalance !== 'undefined' && accountInfo.totalMarginBalance !== null)
											? Number(accountInfo.totalMarginBalance)
											: (totalWallet + totalUpl);
										// update snapshot values
										accountInfo.totalUnrealizedProfit = totalUpl;
										accountInfo.totalMarginBalance = totalMarginBal;
										// broadcast acct delta so UI totals move at tick speed
										broadcastMessage({ type: 'acct_delta', totals: { totalUnrealizedProfit: totalUpl, totalMarginBalance: totalMarginBal }, markPrice: price });
									} catch (e) {
										// ignore
									}
									return;
								}
							}
							// fallback: broadcast a lightweight pos_delta containing only symbol + markPrice
							broadcastMessage({ type: 'pos_delta', position: { symbol: sym, markPrice: price } });
						} catch (e) {
							// in case of any error, still send lightweight update
							broadcastMessage({ type: 'pos_delta', position: { symbol: sym, markPrice: price } });
						}
				}
			} catch (e) {
				// ignore parse errors
			}
		});

		marketWs.on('close', () => {
			console.warn('Market WS closed — will reconnect in 3s');
			marketWs = null;
			setTimeout(() => startMarketStream(marketSymbol), 3000);
		});

		marketWs.on('error', (err) => {
			console.error('Market WS error', err && err.stack ? err.stack : err);
			try { marketWs.terminate(); } catch (e) {}
		});
	} catch (e) {
		console.error('startMarketStream error', e && e.stack ? e.stack : e);
		setTimeout(() => startMarketStream(marketSymbol), 5000);
	}
}

// Start market stream (no API key required)
startMarketStream(marketSymbol);


app.get('/account', (req, res) => {
	// Return full snapshot so client can consume totals and positions consistently
	res.json(accountInfo);
});

app.get('/positions', (req, res) => {
	res.json(accountInfo.positions);
});

// Provide a simple HTTP health endpoint
app.get('/health', (req, res) => res.send('OK'));

const server = http.createServer(app);

// WebSocket server (for dev only) - exposes a single endpoint at /ws/account
const wss = new WebSocket.Server({ server, path: '/ws/account' });


wss.on('connection', (ws, req) => {
	console.log('WS client connected:', req.socket.remoteAddress);

	// 최초 연결 시 계정 스냅샷 전송
	ws.send(JSON.stringify({ type: 'snapshot', account: accountInfo }));

	// 5초마다 계정/포지션 정보 push
	const interval = setInterval(() => {
		try {
			ws.send(JSON.stringify({ type: 'snapshot', account: accountInfo }));
		} catch (e) {
			// ignore
		}
	}, 5000);

	ws.on('message', (msg) => {
		// Echo for debugging
		try {
			const data = typeof msg === 'string' ? msg : msg.toString();
			console.log('WS msg:', data.substring(0, 200));
		} catch (e) {}
	});

	ws.on('close', () => {
		clearInterval(interval);
		console.log('WS client disconnected');
	});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Dev backend listening on http://localhost:${PORT}`));

// Graceful shutdown (diagnostic-safe)
process.on('SIGINT', () => {
	console.warn('SIGINT received — logging but NOT exiting (diagnostic mode). PID:', process.pid);
});

process.on('SIGTERM', () => {
	console.warn('SIGTERM received — logging but NOT exiting (diagnostic mode). PID:', process.pid);
});

// Heartbeat to show process is alive — logs every 10s
setInterval(() => {
	console.log('Heartbeat: process alive —', new Date().toISOString(), 'PID:', process.pid);
}, 10000);



require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const Binance = require('node-binance-api');

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
let accountInfo = { totalWalletBalance: 0, totalUnrealizedProfit: 0, positions: [] };

// 계정/포지션 정보 주기적 갱신 (5초마다)
async function updateAccountInfo() {
	try {
		// 선물 계정 정보
		const acc = await binance.futuresAccount();
		accountInfo.totalWalletBalance = Number(acc.totalWalletBalance);
		accountInfo.totalUnrealizedProfit = Number(acc.totalUnrealizedProfit);
		accountInfo.positions = acc.positions.map(p => ({
			symbol: p.symbol,
			positionAmt: p.positionAmt,
			entryPrice: p.entryPrice,
			markPrice: p.markPrice,
			unrealizedProfit: p.unrealizedProfit,
			leverage: p.leverage,
			marginType: p.marginType,
			positionInitialMargin: p.positionInitialMargin,
			isolatedWallet: p.isolatedWallet,
			notional: p.notional
		}));
	} catch (e) {
		console.error('Binance API error:', e.body || e.message || e);
	}
}
setInterval(updateAccountInfo, 5000);
updateAccountInfo();


app.get('/account', (req, res) => {
	res.json({
		totalWalletBalance: accountInfo.totalWalletBalance,
		totalUnrealizedProfit: accountInfo.totalUnrealizedProfit
	});
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


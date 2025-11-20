const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

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

// Simple in-memory state for demo
const demoAccount = { totalWalletBalance: 1000, totalUnrealizedProfit: 0, positions: [] };

app.get('/account', (req, res) => {
	res.json({ totalWalletBalance: demoAccount.totalWalletBalance, totalUnrealizedProfit: demoAccount.totalUnrealizedProfit });
});

app.get('/positions', (req, res) => {
	res.json(demoAccount.positions);
});

// Provide a simple HTTP health endpoint
app.get('/health', (req, res) => res.send('OK'));

const server = http.createServer(app);

// WebSocket server (for dev only) - exposes a single endpoint at /ws
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
	console.log('WS client connected:', req.socket.remoteAddress);

	// Send a welcome snapshot
	ws.send(JSON.stringify({ type: 'snapshot', account: demoAccount }));

	// Periodic heartbeat / demo updates
	const interval = setInterval(() => {
		try {
			ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
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


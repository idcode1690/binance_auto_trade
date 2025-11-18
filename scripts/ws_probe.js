const WebSocket = require('ws');
const url = process.argv[2] || 'ws://127.0.0.1:3000/ws/account';
console.log('Connecting to', url);
const ws = new WebSocket(url);
ws.on('open', () => {
  console.log('OPEN');
});
ws.on('message', (msg) => {
  try {
    const text = msg.toString();
    console.log('MSG', new Date().toISOString(), text);
  } catch (e) {
    console.error('MSG_PARSE_ERR', e);
  }
});
ws.on('close', (code, reason) => {
  console.log('CLOSE', code, reason && reason.toString());
  process.exit(0);
});
ws.on('error', (err) => {
  console.error('ERROR', err && err.message);
});
// auto-close after 15s
setTimeout(() => {
  console.log('Auto-closing probe');
  try { ws.close(); } catch (e) {}
}, 15000);

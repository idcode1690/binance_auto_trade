const axios = require('axios');
const WebSocket = require('ws');
const crypto = require('crypto');

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;
const baseUrl = 'https://fapi.binance.com';
const wsBaseUrl = 'wss://fstream.binance.com/ws';

if (!apiKey || !apiSecret) {
  console.error('Missing API key or secret. Please set BINANCE_API_KEY and BINANCE_API_SECRET in the environment variables.');
  process.exit(1);
}

// Function to sign query strings
function sign(query) {
  return crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
}

// Function to fetch account positions
async function fetchPositions() {
  try {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = sign(query);
    const url = `${baseUrl}/fapi/v2/account?${query}&signature=${signature}`;

    const response = await axios.get(url, {
      headers: {
        'X-MBX-APIKEY': apiKey
      }
    });

    const positions = response.data.positions.filter(pos => parseFloat(pos.positionAmt) !== 0);
    console.log('Fetched positions:', positions);
    return positions;
  } catch (error) {
    console.error('Error fetching positions:', error.response ? error.response.data : error.message);
    return [];
  }
}

// Initialize WebSocket connection
function initializeWebSocket() {
  const ws = new WebSocket(wsBaseUrl);

  ws.on('open', () => {
    console.log('WebSocket connection established');
  });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      console.log('Received WebSocket message:', data);
    } catch (e) {
      console.error('Error parsing WebSocket message:', e);
    }
  });

  ws.on('close', (code, reason) => {
    console.log('WebSocket connection closed:', code, reason);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });

  return ws;
}

(async () => {
  console.log('Fetching positions...');
  const positions = await fetchPositions();

  if (positions.length > 0) {
    console.log('Initializing WebSocket for real-time updates...');
    initializeWebSocket();
  } else {
    console.log('No positions found. Exiting.');
  }
})();

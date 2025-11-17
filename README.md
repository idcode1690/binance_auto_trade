# Binance BTC Live Price + EMA26/200 (React)

간단한 리액트 앱입니다. Binance WebSocket을 사용해 BTC/USDT 실시간 가격을 받아오고 EMA(26)과 EMA(200)를 계산해 크로스 알림을 표시합니다.

Quick start (PowerShell):

```powershell
Set-Location -LiteralPath 'c:\Users\e1it3\Desktop\program\binance_auto_trade'
npm install
npm run dev
```

- 웹 앱은 기본적으로 `http://localhost:5173` 에서 실행됩니다 (Vite 기본 포트).
- 실시간 데이터는 Binance 공개 WebSocket `wss://stream.binance.com:9443/ws/btcusdt@trade` 를 사용합니다.

Private Binance Futures account display
--------------------------------------

This project now includes a small backend proxy that can call Binance's signed Futures API to fetch your account and position info safely from the server side (so your API Secret is never exposed to the browser).

Setup (local):

1. Copy `.env.example` to `.env` and fill `BINANCE_API_KEY` and `BINANCE_API_SECRET`.
2. Install dependencies and start the backend server:

```powershell
npm install
npm run server
```

The backend listens on `http://localhost:3000` by default and exposes `GET /api/futures/account` which the front-end polls every 10s.

3. Build and serve the front-end (or run dev):

```powershell
npm run build
npx http-server ./dist -p 4740
```

When the backend is running and `.env` is configured, the `Futures Account` panel in the UI will automatically show your USDT futures wallet balance and your BTC position amount (if any) for the selected symbol.

Security:

- Never commit your `.env` with real API secrets.
- Use GitHub/GitLab secrets or other secret managers for deployed environments.
- This proxy is intentionally minimal — review and harden it before deploying to production.


원하시면 추가 기능(차트, 심볼 선택, 초기 EMA 계산 개선 등)을 더 구현해 드리겠습니다.

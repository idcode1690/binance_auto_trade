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

원하시면 추가 기능(차트, 심볼 선택, 초기 EMA 계산 개선 등)을 더 구현해 드리겠습니다.

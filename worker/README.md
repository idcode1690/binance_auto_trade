# Cloudflare Worker for binance_auto_trade

This Worker provides a simple `/webhook/oncross` endpoint that:

- accepts POST JSON payloads from the frontend
- validates `x-webhook-secret` header against `WEBHOOK_SECRET` secret
- forwards the alert to Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` required)
- optionally places a Binance Futures market order when `AUTO_ORDER_ENABLED=true` and `BINANCE_API_KEY`/`BINANCE_API_SECRET` are set

Deployment
1. Install `wrangler`: `npm install -g wrangler`
2. Login: `wrangler login` (opens Cloudflare auth)
3. Configure `wrangler.toml` (set `account_id`, optionally `route`/`zone_id`)
4. Register secrets:
   - `wrangler secret put WEBHOOK_SECRET`
   - `wrangler secret put TELEGRAM_BOT_TOKEN`
   - `wrangler secret put TELEGRAM_CHAT_ID`
   - if using orders: `wrangler secret put BINANCE_API_KEY` and `wrangler secret put BINANCE_API_SECRET`
   - optional: `wrangler secret put AUTO_ORDER_ENABLED` (true/false) and `wrangler secret put ORDER_USDT`
5. Publish: `wrangler publish` (or `wrangler publish --env production` if using env)

Notes
- Do NOT commit secret values to the repository. Use `wrangler secret` to store them.
- Test with a POST to the Worker URL returned by `wrangler publish`.
- The Worker uses Web Crypto to compute HMAC-SHA256 for Binance signature.
# Cloudflare Worker 설정 및 실행 방법

## 1. 환경 변수 설정
- `worker/.dev.vars` 파일에 실제 Binance API 키와 시크릿을 입력하세요.

```
BINANCE_API_KEY=여기에_실제_API_KEY_입력
BINANCE_API_SECRET=여기에_실제_API_SECRET_입력
```

## 2. Wrangler CLI 설치
```
npm install -g wrangler
```

## 3. 로컬 개발 서버 실행
```
cd worker
wrangler dev
```

## 4. Cloudflare에 배포
```
wrangler publish
```

## 5. 엔드포인트 예시
- `/account` : 계정 정보
- `/positions` : 포지션 정보
- `/chart?symbol=BTCUSDT&interval=1m&limit=100` : 차트 데이터

---

> Cloudflare Worker는 WebSocket 프록시를 지원하지 않으므로, 실시간 가격 정보는 프론트엔드에서 Binance WebSocket을 직접 연결해야 합니다.

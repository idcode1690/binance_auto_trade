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

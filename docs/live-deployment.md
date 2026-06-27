# 실제 자사몰 적용 절차

이 문서는 로컬 데모가 아니라 실제 개인 제작 자사몰에 붙일 때의 순서입니다.

## 필요한 값

- GTM 컨테이너 ID: `GTM-XXXXXXX`
- GA4 측정 ID: `G-XXXXXXXXXX`
- Google Ads 전환 ID와 구매 전환 라벨
- Meta Pixel ID
- CRM/이메일/카카오 발송툴 webhook URL과 API 키
- 자사몰 코드의 공통 레이아웃, 상품 상세, 장바구니, 결제 시작, 결제 성공 페이지 접근 권한

## 코드 적용

적용 전에 사이트 루트를 점검합니다.

```bash
npm run audit:site -- /path/to/your-store
npm run install:sdk -- /path/to/your-store --dry-run
npm run validate:env -- /path/to/your-store
```

1. `src/marketing-automation.js`를 자사몰 정적 파일 경로에 배포합니다.
2. 공통 레이아웃에서 `MarketingAutomation.init()`을 1회 호출합니다.
3. 동의 배너에서 `MarketingAutomation.setConsent()`를 호출합니다.
4. 상품 상세에서 `trackViewItem()`을 호출합니다.
5. 장바구니 담기 성공 콜백에서 `trackAddToCart()`를 호출합니다.
6. 결제 페이지 진입 또는 결제 버튼 클릭 후 `trackBeginCheckout()`을 호출합니다.
7. 결제 성공 페이지에서 서버 주문번호로 `trackPurchase()`를 호출합니다.
8. 회원가입, 로그인, 상담/쿠폰/문의 완료 지점에서 각각 `trackSignUp()`, `trackLogin()`, `trackGenerateLead()`를 호출합니다.

SDK 파일과 설치 안내 문서는 아래 명령으로 자동 배치할 수 있습니다.

```bash
npm run install:sdk -- /path/to/your-store
```

## GTM 적용

`config/gtm-workspace-blueprint.json` 기준으로 다음을 만듭니다.

- Data Layer Variable 10개
- Custom Event Trigger 7개
- GA4 Config 태그 1개
- GA4 Event 태그 7개
- Google Ads 구매 전환 태그 1개
- Meta Pixel 전자상거래 이벤트 태그 3개

가져오기 파일은 아래 명령으로 생성합니다.

```bash
npm run generate:gtm -- --public-id GTM-XXXXXXX
```

생성된 `dist/gtm-container-import.json`을 GTM Admin > Import Container에서 가져옵니다. 가져온 뒤 Constant Variable placeholder를 실제 GA4, Google Ads, Meta 값으로 교체합니다.

GTM Preview에서 모든 이벤트를 본 뒤 게시합니다. 광고 태그는 광고 동의가 있을 때만 실행되게 Consent 설정을 반드시 적용합니다.

## CRM 연결

`server/crm-event-receiver.mjs`는 중간 수신 서버입니다. 운영에서는 아래 환경변수를 설정합니다.

```bash
PORT=8791
CORS_ALLOW_ORIGIN=https://your-store.example
DOWNSTREAM_CRM_WEBHOOK_URL=https://your-crm.example/webhook
DOWNSTREAM_CRM_API_KEY=replace-me
node server/crm-event-receiver.mjs
```

로컬에서는 `npm run start:local`이 downstream CRM 시뮬레이터까지 함께 실행합니다. 이 상태에서 `npm run verify:local`은 CRM 수신 서버가 downstream webhook으로 payload를 전달하고 `202`를 받는지 확인합니다.

수신거부, 마케팅 수신동의, 발송 빈도 제한은 최종 발송툴에서도 한 번 더 검증해야 합니다.

CRM 수신 서버는 이벤트별로 `automation_actions`를 함께 계산합니다.

- `add_to_cart`: 60분 후 장바구니 이탈 메시지, 구매 시 취소, 광고 대상 업데이트
- `begin_checkout`: 30분 후 결제 이탈 메시지, 구매 시 취소, 광고 대상 업데이트
- `purchase`: 7일 후 리뷰 요청, 30일 후 재구매 알림, 광고 제외 대상 업데이트
- `generate_lead`: 즉시 리드 후속 메시지

## 운영 검증

전체 로컬/사이트 검증은 아래 명령으로 먼저 실행합니다.

```bash
npm run full:qa -- --site-root /path/to/your-store --start-local --start-site --site-port 3100
npm run audit:completion -- --site-root /path/to/your-store
```

운영 GTM/GA4/광고/CRM 값까지 반드시 준비됐는지 실패 조건으로 묶으려면 `--require-env-ready`를 추가합니다.

운영 계정값을 채우기 위한 handoff 문서는 아래 명령으로 생성합니다.

```bash
npm run handoff:deployment -- --site-root /path/to/your-store
npm run audit:completion -- --site-root /path/to/your-store
```

운영값을 env 파일로 받은 뒤에는 dry-run으로 확인하고 실제 `.env.local`에 병합합니다.

```bash
npm run go:live -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env --dry-run
npm run go:live -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env
```

`go:live`는 env 반영, `dist/gtm-container-import.production.json` 생성, `full:qa --require-env-ready`, handoff 재생성, 완료 감사를 한 번에 실행합니다. 개별 단계로 나누어 실행해야 할 때는 아래 명령을 사용합니다.

```bash
npm run apply:env -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env --dry-run
npm run apply:env -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env
npm run render:gtm -- --site-root /path/to/your-store
npm run verify:gtm -- --input dist/gtm-container-import.production.json
npm run audit:completion -- --site-root /path/to/your-store --strict
```

1. `npm test`와 `npm run check`를 통과시킵니다.
2. `npm run verify:local`로 로컬 데모, CRM 이벤트 플로우, 자동화 액션, downstream webhook 전달을 확인합니다.
3. `npm run verify:browser`로 headless Chrome에서 dataLayer 이벤트, CRM 플로우, downstream 전달, 구매 중복 방지, 개인정보 제거를 확인합니다.
4. 자사몰 dev/prod 서버를 띄운 뒤 `npm run verify:site -- --site-url http://127.0.0.1:3000`로 SDK, consent UI, CRM route 런타임 동작을 확인합니다.
5. `npm run audit:site -- /path/to/your-store`에서 SDK, Provider, CRM route, 7개 이벤트 지원이 확인됩니다.
6. `npm run validate:env -- /path/to/your-store`에서 `ready: true`가 나옵니다.
7. `npm run go:live -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env`가 통과합니다.
8. `npm run audit:completion -- --site-root /path/to/your-store --strict`에서 완료 판정이 `true`입니다.
9. 운영 배포 후 GTM Preview와 GA4 DebugView에서 이벤트를 확인합니다.
10. 주문 DB 매출과 GA4 매출을 48시간 뒤 export해서 `npm run reconcile:revenue -- --orders exports/orders.csv --ga4 exports/ga4.csv --threshold 0.05`로 비교합니다.
11. Google Ads/Meta 테스트 도구에서 구매 전환 수신을 확인합니다.

## 완료 기준

- GA4 DebugView에 `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, `sign_up`, `login`, `generate_lead`가 보입니다.
- `purchase`에는 실제 주문번호가 `transaction_id`로 들어가며 새로고침 중복이 없습니다.
- GA4 이벤트에는 이메일, 전화번호, 이름, 주소가 없습니다.
- CRM 이벤트는 마케팅 수신동의가 있을 때만 전송됩니다.
- 장바구니/결제 이탈, 구매 후 리뷰, 재구매, 리드 후속 `automation_actions`가 발송툴에 연결되어 있습니다.

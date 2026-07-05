# 커스텀 자사몰 마케팅 자동화 키트

개인이 만든 자사몰에 GA4, Google Tag Manager, 광고 전환, CRM/메시징 자동화를 붙이기 위한 실행 키트입니다. 실제 사이트 코드가 없는 상태에서도 바로 이식할 수 있도록 브라우저 SDK, CRM 이벤트 수신 서버, GTM 이벤트 맵, QA 체크리스트를 포함했습니다.

## 포함 파일

- `src/marketing-automation.js`: 브라우저에서 사용하는 추적 SDK
- `server/crm-event-receiver.mjs`: CRM/이메일/카카오 발송툴로 넘길 이벤트 수신 서버
- `config/gtm-event-map.json`: GTM에서 만들 태그와 트리거 목록
- `dist/gtm-container-import.json`: GTM 가져오기용 컨테이너 JSON
- `config/automation-flows.json`: 자동화 세그먼트와 플로우 정의
- `docs/gtm-setup.md`: GTM/GA4/광고 태그 설정 절차
- `docs/qa-checklist.md`: 게시 전 검증 체크리스트
- `docs/live-deployment.md`: 실제 자사몰 적용 절차
- `docs/execution-status.md`: 이 컴퓨터에서 실행/검증된 상태
- `examples/demo-store.html`: 이벤트 동작 확인용 데모 페이지
- `examples/marketing-production.env.example`: 운영 GTM/GA4/광고/CRM 값 입력용 env 예시
- `scripts/reconcile-revenue.mjs`: 주문 DB와 GA4 매출 CSV 일 단위 대조기
- `scripts/generate-ops-dashboard.mjs`: QA/완료 감사/handoff 결과를 한 화면으로 묶는 운영 대시보드 생성기
- `scripts/refresh-ops-status.mjs`: full QA, handoff, 완료 감사, 운영 대시보드를 한 번에 갱신하는 오케스트레이터

## 1. 사이트 공통 레이아웃에 SDK 추가

로컬에서 먼저 실행하려면 아래 명령을 실행합니다. 데모 서버, CRM 수신 서버, downstream CRM 시뮬레이터가 `tmux` 세션으로 같이 올라갑니다.

```bash
cd marketing-automation-kit
npm run start:local
```

데모 URL:

```text
http://127.0.0.1:8081/marketing-automation-kit/examples/demo-store.html?crm=http://127.0.0.1:8791/crm/events
CRM: http://127.0.0.1:8791
Downstream simulator: http://127.0.0.1:8792
```

서버를 종료하려면:

```bash
cd marketing-automation-kit
npm run stop:local
```

터미널 2개로 직접 실행하려면 아래 명령도 사용할 수 있습니다.

```bash
cd marketing-automation-kit
npm run start:demo
```

```bash
cd marketing-automation-kit
npm run start:crm
```

```bash
cd marketing-automation-kit
npm run start:downstream
```

테스트:

```bash
cd marketing-automation-kit
npm test
npm run check
npm run verify:local
npm run verify:browser
npm run verify:site -- --site-url http://127.0.0.1:3000
npm run verify:site -- --site-url http://127.0.0.1:3000 --event-probe
npm run verify:prod-site -- --site-root /path/to/your-store --build --event-probe
npm run reconcile:revenue -- --orders examples/orders-revenue.csv --ga4 examples/ga4-revenue.csv
```

GitHub Actions의 `CI` 워크플로도 push와 pull request에서 `check`, `test`, GTM import 검증, 예제 매출 대조를 실행합니다.

키트, 로컬 데모, 실제 적용 사이트 검증을 한 번에 묶어 실행하려면 아래 명령을 사용합니다. `--require-env-ready`를 붙이면 운영 도메인/GTM/GA4/광고/CRM 값 미준비도 실패로 처리합니다.

```bash
cd marketing-automation-kit
npm run ops:refresh -- --site-root /path/to/your-store --start-local --start-site --site-port 3100
npm run ops:refresh -- --site-root /path/to/your-store --start-local --start-site --site-port 3100 --site-event-probe
npm run ops:refresh -- --site-root /path/to/your-store --start-local --start-site --site-port 3100 --site-event-probe --site-production-probe
```

수동으로 나누어 실행하려면 아래 명령을 사용합니다.

```bash
cd marketing-automation-kit
npm run full:qa -- --site-root /path/to/your-store --start-local --start-site --site-port 3100
npm run full:qa -- --site-root /path/to/your-store --start-local --start-site --site-port 3100 --site-event-probe
npm run full:qa -- --site-root /path/to/your-store --start-local --start-site --site-port 3100 --site-event-probe --site-production-probe
npm run audit:completion -- --site-root /path/to/your-store
npm run dashboard:ops -- --site-root /path/to/your-store
```

전체 QA 리포트는 기본적으로 `dist/full-qa-report.json`에 저장됩니다. 완료 감사 결과는 `dist/completion-audit.md`와 `dist/completion-audit.json`에 저장되며, 운영 계정값이 없으면 해당 요구사항을 `blocked_external`로 표시합니다. 운영 대시보드는 `dist/growth-ops-dashboard.html`과 `dist/growth-ops-dashboard.json`에 저장됩니다. 외부 계정 실행 체크리스트는 `dist/external-account-setup.md`와 `dist/external-account-setup.json`에 저장됩니다. 전체 갱신 리포트는 `dist/ops-refresh-report.json`에 저장됩니다.

운영 계정값을 입력할 사람에게 넘길 체크리스트와 env 블록은 아래 명령으로 생성합니다.

```bash
cd marketing-automation-kit
npm run handoff:deployment -- --site-root /path/to/your-store
npm run handoff:external -- --site-root /path/to/your-store
npm run audit:completion -- --site-root /path/to/your-store
npm run dashboard:ops -- --site-root /path/to/your-store
```

handoff 문서는 `dist/deployment-handoff.md`, 기계 판독용 JSON은 `dist/deployment-handoff.json`에 저장됩니다. 외부 계정 생성/게시 전 확인 게이트, 수집할 값, 운영 URL 탐색 결과는 `dist/external-account-setup.md`에서 확인합니다.

운영값을 별도 env 파일로 받은 뒤 실제 사이트 `.env.local`에 병합할 때는 먼저 dry-run을 실행합니다. `examples/marketing-production.env.example`을 복사해 placeholder를 실제 값으로 바꾼 파일을 사용합니다. 출력에는 값이 마스킹됩니다.

```bash
cd marketing-automation-kit
cp examples/marketing-production.env.example /path/to/marketing-production.env
npm run go:live -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env --dry-run
npm run go:live -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env
npm run apply:env -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env --dry-run
npm run apply:env -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env
npm run render:gtm -- --site-root /path/to/your-store
npm run verify:gtm -- --input dist/gtm-container-import.production.json
npm run audit:completion -- --site-root /path/to/your-store --strict
```

`go:live`는 env 적용, GTM production import 렌더링, strict full QA, handoff, 완료 감사를 순서대로 실행합니다. 세부 단계만 따로 실행해야 할 때는 아래 개별 명령을 사용합니다.

실제 자사몰 코드 루트를 찾았으면 적용 후보를 먼저 점검합니다.

```bash
cd marketing-automation-kit
npm run find:sites
npm run audit:site -- /path/to/your-store
npm run install:sdk -- /path/to/your-store --dry-run
npm run validate:env -- /path/to/your-store
```

`marketing-automation.js`를 사이트의 정적 파일 경로에 배포한 뒤 모든 페이지의 공통 레이아웃에서 로드합니다.

```html
<script src="/assets/marketing-automation.js"></script>
<script>
  MarketingAutomation.init({
    gtmId: 'GTM-XXXXXXX',
    crmWebhookUrl: '/crm/events',
    defaultCurrency: 'KRW'
  });
</script>
```

GTM 컨테이너는 SDK가 동적으로 로드할 수 있습니다. 서버 렌더링 레이아웃을 직접 수정할 수 있다면 GTM에서 제공하는 표준 `<head>`와 `<body>` 스니펫을 넣어도 됩니다.

## 2. 동의 배너와 연결

사용자가 쿠키/마케팅 수신에 동의했을 때 아래처럼 호출합니다.

```html
<button onclick="MarketingAutomation.setConsent({ analytics: true, ads: true, marketing: true, crm: true })">
  동의
</button>
```

동의하지 않은 기본 상태는 analytics, ads, marketing, crm 모두 거부입니다. CRM 웹훅은 `crm: true`일 때만 전송됩니다.

## 3. 전자상거래 이벤트 호출

상품 상세 페이지:

```js
MarketingAutomation.trackViewItem({
  item_id: 'SKU_001',
  item_name: 'Product name',
  item_category: 'Category',
  price: 129000,
  quantity: 1
});
```

장바구니 담기:

```js
MarketingAutomation.trackAddToCart({
  item_id: 'SKU_001',
  item_name: 'Product name',
  item_category: 'Category',
  price: 129000,
  quantity: 1,
  email: 'buyer@example.com',
  marketing_consent: true
});
```

결제 시작:

```js
MarketingAutomation.trackBeginCheckout({
  cart_id: 'CART-001',
  value: 129000,
  items: [
    {
      item_id: 'SKU_001',
      item_name: 'Product name',
      item_category: 'Category',
      price: 129000,
      quantity: 1
    }
  ],
  email: 'buyer@example.com',
  marketing_consent: true
});
```

결제 완료:

```js
MarketingAutomation.trackPurchase({
  transaction_id: 'ORDER-1001',
  value: 129000,
  shipping: 0,
  coupon: 'WELCOME10',
  items: [
    {
      item_id: 'SKU_001',
      item_name: 'Product name',
      item_category: 'Category',
      price: 129000,
      quantity: 1
    }
  ],
  email: 'buyer@example.com',
  marketing_consent: true
});
```

`purchase`는 `transaction_id` 기준으로 브라우저 저장소에 최근 100개 주문번호를 기록해 새로고침 중복 전송을 막습니다. 서버에서도 주문번호 기준 1회만 렌더링되도록 유지해야 합니다.

회원가입, 로그인, 리드:

```js
MarketingAutomation.trackSignUp({ method: 'email', email: 'buyer@example.com', marketing_consent: true });
MarketingAutomation.trackLogin({ method: 'email' });
MarketingAutomation.trackGenerateLead({ value: 10000, email: 'buyer@example.com', marketing_consent: true });
```

GA4 dataLayer로 나가는 이벤트에서는 `email`, `phone`, `name`, `address` 같은 개인정보 키를 제거합니다. CRM 웹훅에는 별도 페이로드로 전송됩니다.

## 4. CRM 이벤트 수신 서버 실행

개발 환경에서:

```bash
node marketing-automation-kit/server/crm-event-receiver.mjs
```

외부 발송툴로 전달하려면 환경변수를 설정합니다.

```bash
DOWNSTREAM_CRM_WEBHOOK_URL="https://crm.example.com/webhook" \
DOWNSTREAM_CRM_API_KEY="replace-me" \
node marketing-automation-kit/server/crm-event-receiver.mjs
```

수신 엔드포인트:

```text
POST /crm/events
```

CRM 페이로드 계약:

```json
{
  "user_id": "USER-1",
  "email": "buyer@example.com",
  "phone": "01012345678",
  "marketing_consent": true,
  "event_name": "purchase",
  "product_id": "SKU_001",
  "cart_id": "CART-001",
  "order_id": "ORDER-1001",
  "value": 129000,
  "occurred_at": "2026-06-27T00:00:00.000Z",
  "utm_source": "google",
  "utm_medium": "cpc",
  "utm_campaign": "spring"
}
```

CRM 응답에는 기존 `automation_flow`와 함께 발송툴/광고 대상 동기화가 바로 사용할 수 있는 `automation_actions`가 포함됩니다.

```json
{
  "automation_flow": "checkout_abandonment_candidate",
  "automation_actions": [
    {
      "flow": "checkout_abandonment_reminder",
      "channels": ["email", "kakao"],
      "scheduled_at": "2026-06-27T00:30:00.000Z",
      "cancel_on_event": "purchase"
    },
    {
      "flow": "checkout_retargeting_audience",
      "channels": ["ads"],
      "exclude_on_event": "purchase"
    }
  ]
}
```

## 5. GTM에서 만들 태그

`config/gtm-event-map.json`과 `config/gtm-workspace-blueprint.json` 기준으로 다음을 만듭니다.

- GA4 구성 태그: 측정 ID `G-XXXXXXXXXX`
- GA4 이벤트 태그: `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, `sign_up`, `login`, `generate_lead`
- Google Ads 전환 태그: `purchase`를 기본 전환으로 사용
- Meta Pixel 이벤트: `Purchase`, `AddToCart`, `InitiateCheckout`
- Consent Mode: analytics/ad/marketing 동의 상태에 따라 태그 실행 제한

GTM에서 수동 생성 대신 가져오기 파일을 만들 수 있습니다.

```bash
cd marketing-automation-kit
npm run generate:gtm -- --public-id GTM-XXXXXXX
```

생성 파일:

```text
dist/gtm-container-import.json
```

GTM Admin의 Import Container에서 가져온 뒤 아래 placeholder 변수를 실제 운영 값으로 바꿉니다.

- `GA4 Measurement ID`
- `Google Ads Conversion ID`
- `Google Ads Purchase Label`
- `Meta Pixel ID`

운영 env 값 준비 상태는 아래 명령으로 확인합니다.

```bash
npm run validate:env -- /path/to/your-store
```

주문 DB와 GA4 매출은 CSV export 후 아래 명령으로 일 단위 오차를 확인합니다. 운영에서는 GA4 수집 지연을 고려해 결제 발생 48시간 뒤 데이터를 기준으로 판정합니다.

```bash
npm run reconcile:revenue -- --orders exports/orders.csv --ga4 exports/ga4.csv --threshold 0.05
```

기본 컬럼명은 `date`, `order_date`, `event_date`, `revenue`, `order_revenue`, `purchase_revenue` 등을 자동 인식합니다. export 컬럼명이 다르면 `--orders-date-column`, `--orders-revenue-column`, `--ga4-date-column`, `--ga4-revenue-column`을 지정합니다.

## 6. 초기 자동화 플로우

- 웰컴 쿠폰: `sign_up` 후 즉시 이메일/카카오 발송
- 장바구니 리마인드: `add_to_cart` 후 60분 내 `purchase`가 없으면 발송, 광고 대상은 구매 고객 제외
- 결제 이탈 리마인드: `begin_checkout` 후 30분 내 `purchase`가 없으면 발송, 광고 대상은 구매 고객 제외
- 구매 후 리뷰/추천상품: `purchase` 후 7일 뒤 발송
- 재구매 알림: `purchase` 후 30일 이후 발송
- 광고 제외 대상: `purchase` 즉시 구매 고객을 리타겟팅 제외 대상으로 업데이트
- 휴면 복귀: 마지막 구매 60일/90일 경과 고객 대상
- VIP 혜택: 누적 구매액 기준 이상 고객 대상

## 7. 검증

```bash
cd marketing-automation-kit
npm run full:qa -- --site-root /path/to/your-store --start-local --start-site --site-port 3100
npm run verify:prod-site -- --site-root /path/to/your-store --build --event-probe
npm run verify:gtm
npm run handoff:deployment -- --site-root /path/to/your-store
npm run apply:env -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env --dry-run
npm run render:gtm -- --site-root /path/to/your-store --dry-run
npm run go:live -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env --dry-run
npm run audit:completion -- --site-root /path/to/your-store
npm test
npm run check
npm run verify:local
npm run reconcile:revenue -- --orders examples/orders-revenue.csv --ga4 examples/ga4-revenue.csv
```

브라우저에서 `examples/demo-store.html`을 열면 dataLayer에 이벤트가 쌓이는지 확인할 수 있습니다. 상위 폴더에서 정적 서버를 실행했거나 CRM 서버 포트가 다르면 쿼리스트링으로 바꿀 수 있습니다.

```text
http://localhost:8081/marketing-automation-kit/examples/demo-store.html?crm=http://localhost:8791/crm/events
```

실제 GTM 게시 전에는 `docs/qa-checklist.md`를 완료합니다.

Chrome이 설치된 환경에서는 아래 명령으로 데모 페이지를 headless Chrome에서 자동 실행합니다.

```bash
npm run verify:browser
```

이 검증은 동의 허용, 상품 조회, 장바구니, 결제 시작, 구매 완료, 리드 생성, 구매 중복 방지, dataLayer 개인정보 제거, CRM 플로우 매핑을 브라우저 DOM에서 확인합니다.
또한 장바구니/결제 이탈, 구매 후 리뷰, 재구매, 광고 제외, 리드 후속 `automation_actions`가 생성되는지도 확인합니다.
로컬 downstream 시뮬레이터가 실행 중이면 CRM payload가 실제 webhook으로 전달되어 `202`를 받는지도 확인합니다.

실제 자사몰을 로컬에서 띄운 뒤에는 아래 명령으로 설치된 사이트 표면을 확인합니다.

```bash
npm run verify:site -- --site-url http://127.0.0.1:3000
npm run verify:site -- --site-url http://127.0.0.1:3000 --event-probe
npm run verify:prod-site -- --site-root /path/to/your-store --build --event-probe
```

이 검증은 `/assets/marketing-automation.js`, `/api/crm/events`, `/`, `/signup`, `/margin-calculator`에서 SDK, consent UI, CRM 동의/거부 동작을 확인합니다.
`verify:prod-site`는 `npm run build` 후 `npm run start`로 production runtime을 띄우고 같은 SDK/consent/CRM/event probe를 실행합니다.

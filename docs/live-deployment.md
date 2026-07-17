# 실제 자사몰 적용 절차

이 문서는 로컬 데모가 아니라 실제 개인 제작 자사몰에 붙일 때의 순서입니다.

## 필요한 값

- GTM 컨테이너 ID: `GTM-XXXXXXX`
- GA4 측정 ID: `G-XXXXXXXXXX`
- Google Ads 전환 ID와 구매 전환 라벨
- Meta Pixel ID
- CRM/이메일/카카오 발송툴 webhook URL과 API 키
- 운영 자사몰 HTTPS URL: `NEXT_PUBLIC_APP_URL=https://your-store.example`
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

`/api/crm/events`는 이벤트와 자동화 액션을 계산하고 `/api/crm/downstream`으로 전달합니다. 자체 delivery gateway는 Resend 이메일, SOLAPI 카카오 브랜드 메시지, Upstash Redis 예약 취소 인덱스를 사용합니다.

```bash
DOWNSTREAM_CRM_WEBHOOK_URL=https://your-store.example/api/crm/downstream
DOWNSTREAM_CRM_API_KEY=replace-with-at-least-24-random-characters
CRM_DELIVERY_MODE=test
CRM_TEST_RECIPIENTS=test@example.com,01012345678
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=replace-with-upstash-token
RESEND_API_KEY=re_replace-with-resend-key
RESEND_FROM_EMAIL=Store <hello@your-domain.example>
SOLAPI_API_KEY=replace-with-solapi-key
SOLAPI_API_SECRET=replace-with-solapi-secret
SOLAPI_KAKAO_PF_ID=replace-with-kakao-profile-id
SOLAPI_KAKAO_TARGETING=I
```

`DOWNSTREAM_CRM_API_KEY`는 `/api/crm/events`의 전달 토큰이자 `/api/crm/downstream`의 Bearer 검증 값입니다. `CRM_DELIVERY_MODE=test`에서는 `CRM_TEST_RECIPIENTS`에 정확히 일치하는 이메일/전화번호에만 발송됩니다. 공급자 QA와 수신동의 차단 검증이 끝나기 전에는 `live`로 전환하지 않습니다.

Resend 발신 도메인과 SOLAPI 카카오 채널 프로필은 각 공급자에서 먼저 인증해야 합니다. 예약 발송은 공급자 네이티브 예약 기능을 사용하고, Upstash Redis에는 개인정보 원문 대신 해시 인덱스와 공급자 예약 ID만 저장합니다. `purchase`가 수신되면 같은 사용자, 이메일, 전화번호 또는 장바구니에 연결된 이탈 메시지 예약을 취소합니다.

로컬에서는 `npm run start:local`이 downstream CRM 시뮬레이터까지 함께 실행합니다. 이 상태에서 `npm run verify:local`은 CRM 수신 서버가 downstream webhook으로 payload를 전달하고 `202`를 받는지 확인합니다.

수신거부와 발송 빈도 제한은 공급자 계정에서도 한 번 더 설정해야 합니다. 서버는 `marketing_consent === true`, 테스트 허용 목록, 이벤트/채널별 idempotency를 강제합니다.

CRM 수신 서버는 이벤트별로 `automation_actions`를 함께 계산합니다.

- `add_to_cart`: 60분 후 장바구니 이탈 메시지, 구매 시 취소, 광고 대상 업데이트
- `begin_checkout`: 30분 후 결제 이탈 메시지, 구매 시 취소, 광고 대상 업데이트
- `purchase`: 7일 후 리뷰 요청, 30일 후 재구매 알림, 광고 제외 대상 업데이트
- `generate_lead`: 즉시 리드 후속 메시지
- `dormant_60_days`, `dormant_90_days`: 즉시 휴면 복귀 메시지, 구매 시 제외되는 광고 대상 업데이트
- `vip_qualified`: 즉시 VIP 혜택 메시지

휴면/VIP 이벤트에는 `user_id`가 필수입니다. CRM 고객 집계 작업은 사용자별 마일스톤을 한 번만 전송해야 하며, 실제 발송툴은 예약 실행, 구매 발생 시 취소, 수신거부, 빈도 제한, 중복 방지를 최종 집행합니다. `marketing_consent`는 JSON 불리언 `true`일 때만 동의로 처리됩니다.

## 운영 검증

전체 로컬/사이트 검증은 아래 명령으로 먼저 실행합니다.

```bash
npm run ops:refresh -- --site-root /path/to/your-store --start-local --start-site --site-port 3100
npm run ops:refresh -- --site-root /path/to/your-store --start-local --start-site --site-port 3100 --site-event-probe --site-production-probe
```

수동으로 나누어 실행해야 할 때는 아래 명령을 사용합니다.

```bash
npm run full:qa -- --site-root /path/to/your-store --start-local --start-site --site-port 3100
npm run full:qa -- --site-root /path/to/your-store --start-local --start-site --site-port 3100 --site-event-probe
npm run full:qa -- --site-root /path/to/your-store --start-local --start-site --site-port 3100 --site-event-probe --site-production-probe
npm run verify:prod-site -- --site-root /path/to/your-store --build --event-probe
npm run inspect:deployment -- --site-root /path/to/your-store
npm run inspect:deployment -- --site-root /path/to/your-store --vercel-project-url https://vercel.com/team/project
npm run audit:completion -- --site-root /path/to/your-store
npm run dashboard:ops -- --site-root /path/to/your-store
```

운영 도메인/GTM/GA4/광고/CRM 값까지 반드시 준비됐는지 실패 조건으로 묶으려면 `ops:refresh` 또는 `full:qa`에 `--require-env-ready`를 추가합니다.

운영 계정값을 채우기 위한 handoff 문서는 아래 명령으로 생성합니다.

```bash
npm run handoff:deployment -- --site-root /path/to/your-store
npm run handoff:external -- --site-root /path/to/your-store
npm run inspect:deployment -- --site-root /path/to/your-store
npm run inspect:deployment -- --site-root /path/to/your-store --vercel-project-url https://vercel.com/team/project
npm run audit:completion -- --site-root /path/to/your-store
npm run dashboard:ops -- --site-root /path/to/your-store
```

운영 대시보드는 `dist/growth-ops-dashboard.html`에 생성됩니다. 외부 계정 실행 체크리스트는 `dist/external-account-setup.md`에 생성되며, 운영 URL 후보 탐색 결과도 함께 표시합니다. 배포 대상 점검은 `dist/deployment-target-plan.md`에 생성되며, Vercel project link, production env add, production deploy처럼 외부 상태를 바꾸는 명령을 확인 게이트와 함께 표시합니다. 운영값을 env 파일로 받은 뒤에는 dry-run으로 확인하고 실제 `.env.local`에 병합합니다. `examples/marketing-production.env.example`을 복사한 뒤 모든 placeholder를 실제 운영 값으로 교체합니다.

이미 연결할 Vercel 프로젝트 URL이 있다면 `--vercel-project-url`을 같이 사용합니다. 현재 CLI 계정이 해당 team/scope를 조회할 수 없으면 `target_vercel_project_inaccessible` blocker로 남기고, 프로젝트 링크/배포는 진행하지 않습니다.

```bash
cp examples/marketing-production.env.example /path/to/marketing-production.env
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
4. 자사몰 dev 서버를 띄운 뒤 `npm run verify:site -- --site-url http://127.0.0.1:3000 --event-probe`로 SDK, consent UI, CRM route, 실제 dataLayer 이벤트 7개, 구매 중복 방지, 개인정보 제거를 확인합니다.
5. `npm run verify:prod-site -- --site-root /path/to/your-store --build --event-probe`로 `next start` production runtime에서도 같은 검증이 통과하는지 확인합니다.
6. `npm run inspect:deployment -- --site-root /path/to/your-store --vercel-project-url https://vercel.com/team/project`에서 배포 플랫폼 링크, 지정 Vercel 프로젝트 접근권한, 운영 URL, 운영 env 차단점이 확인됩니다.
7. `npm run audit:site -- /path/to/your-store`에서 SDK, Provider, CRM route, 7개 이벤트 지원이 확인됩니다.
8. `npm run validate:env -- /path/to/your-store`에서 `ready: true`가 나옵니다.
9. `npm run go:live -- --site-root /path/to/your-store --env-file /path/to/marketing-production.env`가 통과합니다.
10. `npm run audit:completion -- --site-root /path/to/your-store --strict`에서 완료 판정이 `true`입니다.
11. 운영 배포 후 GTM Preview와 GA4 DebugView에서 이벤트를 확인합니다.
12. 주문 DB 매출과 GA4 매출을 48시간 뒤 export해서 `npm run reconcile:revenue -- --orders exports/orders.csv --ga4 exports/ga4.csv --threshold 0.05`로 비교합니다.
13. Google Ads/Meta 테스트 도구에서 구매 전환 수신을 확인합니다.

## 완료 기준

- GA4 DebugView에 `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, `sign_up`, `login`, `generate_lead`가 보입니다.
- `purchase`에는 실제 주문번호가 `transaction_id`로 들어가며 새로고침 중복이 없습니다.
- GA4 이벤트에는 이메일, 전화번호, 이름, 주소가 없습니다.
- CRM 이벤트는 마케팅 수신동의가 있을 때만 전송됩니다.
- 장바구니/결제 이탈, 구매 후 리뷰, 재구매, 리드 후속, 60/90일 휴면 복귀, VIP 혜택 `automation_actions`가 발송툴에 연결되어 있습니다.

# 게시 전 QA 체크리스트

## 설치

- [ ] 모든 페이지에서 `MarketingAutomation.init()`이 1회 실행된다.
- [ ] `npm run full:qa -- --site-root /path/to/store --start-local --start-site --site-port 3100`가 통과하고 `dist/full-qa-report.json`이 생성된다.
- [ ] `npm run audit:completion -- --site-root /path/to/store`가 `dist/completion-audit.json`을 생성하고 요구사항별 완료/외부 차단 상태를 표시한다.
- [ ] `npm run handoff:deployment -- --site-root /path/to/store`가 통과하고 `dist/deployment-handoff.md`가 생성된다.
- [ ] 운영값을 받은 뒤 `npm run apply:env -- --site-root /path/to/store --env-file /path/to/marketing-production.env --dry-run`에서 raw secret이 출력되지 않고 readiness가 확인된다.
- [ ] 운영값을 받은 뒤 `npm run go:live -- --site-root /path/to/store --env-file /path/to/marketing-production.env --dry-run`이 raw secret 없이 통과한다.
- [ ] 운영값을 받은 뒤 `npm run go:live -- --site-root /path/to/store --env-file /path/to/marketing-production.env`가 strict full QA와 완료 감사까지 통과한다.
- [ ] 운영값을 받은 뒤 `npm run render:gtm -- --site-root /path/to/store`가 `dist/gtm-container-import.production.json`을 생성하고 `npm run verify:gtm -- --input dist/gtm-container-import.production.json`이 통과한다.
- [ ] `npm run audit:site -- /path/to/store`에서 SDK, Provider, CRM route 설치가 확인된다.
- [ ] `npm run validate:env -- /path/to/store`에서 운영 값 readiness가 `true`다.
- [ ] `npm run verify:browser`에서 headless Chrome 데모 QA가 통과한다.
- [ ] `npm run verify:site -- --site-url http://127.0.0.1:3000`에서 실제 사이트 SDK, consent UI, CRM route 런타임 QA가 통과한다.
- [ ] `npm run verify:gtm`에서 GTM import 태그/트리거/변수/동의 조건 검증이 통과한다.
- [ ] GTM 컨테이너 ID가 운영 컨테이너로 설정되어 있다.
- [ ] GA4 측정 ID가 운영 속성으로 설정되어 있다.
- [ ] 동의 전 기본 상태가 analytics/ads/marketing/crm 모두 denied다.
- [ ] 동의 철회 시 광고 태그와 CRM 웹훅이 실행되지 않는다.

## 이벤트

- [ ] 상품 상세 진입 시 `view_item`이 발생한다.
- [ ] 장바구니 담기 시 `add_to_cart`가 발생한다.
- [ ] 결제 시작 시 `begin_checkout`이 발생한다.
- [ ] 결제 완료 시 `purchase`가 발생한다.
- [ ] 회원가입 시 `sign_up`이 발생한다.
- [ ] 로그인 시 `login`이 발생한다.
- [ ] 상담/쿠폰/문의 리드 시 `generate_lead`가 발생한다.

## 데이터 품질

- [ ] GA4 dataLayer 이벤트에 이메일, 전화번호, 이름, 주소가 포함되지 않는다.
- [ ] `purchase`에는 실제 주문번호가 `transaction_id`로 들어간다.
- [ ] 결제 완료 페이지 새로고침 시 같은 주문번호의 `purchase`가 중복 발생하지 않는다.
- [ ] UTM 유입값이 CRM 이벤트의 `utm_source`, `utm_medium`, `utm_campaign`에 보존된다.
- [ ] 주문 DB 매출과 GA4 매출의 48시간 후 오차가 5% 이내다. CSV export 후 `npm run reconcile:revenue -- --orders exports/orders.csv --ga4 exports/ga4.csv --threshold 0.05`가 통과한다.

## CRM/메시징

- [ ] `marketing_consent: true`인 테스트 계정에만 이메일/카카오가 발송된다.
- [ ] 수신거부 계정에는 자동화 메시지가 발송되지 않는다.
- [ ] CRM 응답의 `automation_actions`에 예약 시각, 채널, 취소 조건이 포함된다.
- [ ] CRM 수신 서버가 downstream webhook으로 payload를 전달하고 `202` 응답을 받는다.
- [ ] 장바구니 이탈 플로우는 구매 완료 고객을 제외한다.
- [ ] 결제 이탈 플로우는 구매 완료 고객을 제외한다.
- [ ] 구매 후 리뷰 요청은 구매 후 7일 뒤에만 발송된다.

## 광고

- [ ] `dist/gtm-container-import.json`을 GTM에 가져온 뒤 placeholder Constant Variable을 운영 값으로 교체했다.
- [ ] Google Ads 전환 태그가 `purchase`에서만 기본 전환으로 실행된다.
- [ ] Meta Pixel `Purchase`, `AddToCart`, `InitiateCheckout`가 각각 올바른 이벤트에서 실행된다.
- [ ] 광고 리타겟팅 대상에서 구매 완료 고객이 제외된다.
- [ ] 광고 동의가 없을 때 광고 관련 태그가 실행되지 않는다.

## 모바일/브라우저

- [ ] iOS Safari에서 동의 배너와 이벤트가 정상 동작한다.
- [ ] Android Chrome에서 동의 배너와 이벤트가 정상 동작한다.
- [ ] 모바일 결제 완료 후 `purchase`가 누락되지 않는다.
- [ ] 뒤로가기, 새로고침, 결제 재시도에서 이벤트 중복이 없다.

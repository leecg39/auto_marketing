# 실행 상태

확인일: 2026-07-05

## 이 컴퓨터에서 실행 완료

- 로컬 데모 서버 실행: `http://127.0.0.1:8081`
- 로컬 CRM 이벤트 수신 서버 실행: `http://127.0.0.1:8791`
- 로컬 downstream CRM 시뮬레이터 실행: `http://127.0.0.1:8792`
- 실행 세션:
  - `tmux` 세션 `marketing-automation-demo`
  - `tmux` 세션 `marketing-automation-crm`
  - `tmux` 세션 `marketing-automation-downstream`
- 데모 페이지 접근 확인: `200 OK`
- CRM health 확인: `{"ok":true}`
- 브라우저 데모에서 `purchase` 이벤트 발생 확인
- 브라우저 데모에서 CRM 플로우 `post_purchase_review_and_recommendation` 확인
- Vercel production URL 확인: `https://auto-marketing-sigma.vercel.app/`
- Vercel production demo 확인: `https://auto-marketing-sigma.vercel.app/demo?crm=/api/crm/events&autorun=1`
- Vercel production dashboard 확인: `https://auto-marketing-sigma.vercel.app/dashboard`
- Vercel serverless CRM API 확인: `https://auto-marketing-sigma.vercel.app/api/crm/events`
- 로컬 검증 스크립트에서 아래 CRM 플로우 확인
  - `add_to_cart -> cart_abandonment_candidate`
  - `begin_checkout -> checkout_abandonment_candidate`
  - `purchase -> post_purchase_review_and_recommendation`
  - `generate_lead -> lead_followup`

## 검증 명령

```bash
cd marketing-automation-kit
npm run ops:refresh -- --site-root /path/to/applied-store --start-local --start-site --site-port 3100 --site-event-probe --timeout-ms 240000
npm run ops:refresh -- --site-root /path/to/applied-store --skip-full-qa
npm run full:qa -- --site-root /path/to/applied-store --start-local --start-site --site-port 3100 --timeout-ms 240000
npm run full:qa -- --site-root /path/to/applied-store --start-local --start-site --site-port 3100 --site-event-probe --timeout-ms 240000
npm run full:qa -- --site-root /path/to/applied-store --skip-live --site-port 3101 --site-event-probe --site-production-probe --timeout-ms 240000
npm run handoff:deployment -- --site-root /path/to/applied-store
npm run handoff:external -- --site-root /path/to/applied-store
npm run inspect:deployment -- --site-root /path/to/applied-store
npm run inspect:deployment -- --site-root /path/to/applied-store --vercel-project-url https://vercel.com/team/project
npm run apply:env -- --site-root /path/to/applied-store --env-file /path/to/marketing-production.env --dry-run
npm run render:gtm -- --site-root /path/to/applied-store --dry-run
npm run go:live -- --site-root /path/to/applied-store --dry-run --skip-full-qa
npm run audit:completion -- --site-root /path/to/applied-store
npm run dashboard:ops -- --site-root /path/to/applied-store
npm test
npm run check
npm run verify:local
npm run verify:browser
npm run verify:site -- --site-url http://127.0.0.1:3100
npm run verify:site -- --site-url http://127.0.0.1:3100 --event-probe
npm run verify:prod-site -- --site-root /path/to/applied-store --site-port 3101 --timeout-ms 240000 --build --event-probe
npm run verify:vercel -- --base-url https://auto-marketing-sigma.vercel.app
npm run verify:gtm
npm run reconcile:revenue -- --orders examples/orders-revenue.csv --ga4 examples/ga4-revenue.csv
npm run generate:gtm -- --public-id GTM-XXXXXXX
npm run validate:env -- /path/to/applied-store
```

현재 검증 결과:

- `npm run ops:refresh -- --site-root /path/to/applied-store --start-local --start-site --site-port 3100 --site-event-probe --timeout-ms 240000`: full QA, 실제 사이트 event probe, handoff, 외부 계정 실행 체크리스트, 완료 감사, 운영 대시보드 갱신
  - 리포트: `dist/ops-refresh-report.json`
  - 대시보드: `dist/growth-ops-dashboard.html`
  - 외부 계정 체크리스트: `dist/external-account-setup.md`
  - 요약: `passed=5`, `warning=0`, `skipped=0`, `failed=0`
- `npm run ops:refresh -- --site-root /path/to/applied-store --skip-full-qa`: 최신 산출물 재생성 통과
  - 리포트: `dist/ops-refresh-report.json`
  - 배포 대상 점검: `dist/deployment-target-plan.md`, `dist/deployment-target-plan.json`
  - handoff: `dist/deployment-handoff.md`, `dist/deployment-handoff.json`
  - 대시보드: `dist/growth-ops-dashboard.html`
  - 요약: `passed=5`, `warning=0`, `skipped=1`, `failed=0`
  - 실행 step: `deployment_target`, `handoff`, `external_setup`, `completion_audit`, `ops_dashboard`
- `npm run ops:refresh -- --site-root /path/to/applied-store --skip-full-qa --vercel-project-url https://vercel.com/petasos/auto-marketing`: 지정 Vercel 프로젝트 접근권한 포함 산출물 재생성 통과
  - 리포트: `dist/ops-refresh-report.json`
  - 요약: `passed=5`, `warning=0`, `skipped=1`, `failed=0`
  - 배포 대상 blocker: `target_vercel_project_inaccessible`, `hosting_project_not_linked`, `marketing_env_not_ready`
- Vercel production surface QA: 통과
  - `/`: `200`, title `Marketing Automation Kit`
  - `/demo?crm=/api/crm/events&autorun=1`: `200`, 브라우저 autorun 결과 `ok:true`
  - `/dashboard`: `200`, title `Marketing Automation Dashboard`
  - `/api/crm/events` GET: `{"ok":true,"service":"marketing-automation-crm-events"}`
  - `/api/crm/events` POST purchase: `202`, flow `post_purchase_review_and_recommendation`, actions `first_purchase_thank_you`, `review_request`, `repurchase_due`, `purchase_exclusion`
- `npm run verify:vercel -- --base-url https://auto-marketing-sigma.vercel.app`: Vercel production 자동 검증 통과
  - 리포트: `dist/vercel-production-report.json`
  - 요약: `passed=6`, `failed=0`
  - 체크: root page, dashboard page, API health, purchase flow, consent gate, demo browser autorun
  - browser autorun: `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, `generate_lead`, 구매 중복 방지, dataLayer PII 미포함 확인
- `npm run full:qa -- --site-root /path/to/applied-store --start-local --start-site --site-port 3100 --site-event-probe --timeout-ms 240000`: 통과
  - 리포트: `dist/full-qa-report.json`
  - `local_qa_ok`: `true`
  - `deployment_ready`: `false`
  - 통과: `14`, 경고: `2`, 실패: `0`
  - GTM import 검증: `77/77` 체크 통과, 태그 12개/트리거 7개/변수 14개
  - 경고 항목: 운영 도메인/GTM/GA4/광고/CRM env 값 미준비, 운영값 기반 GTM import 렌더링 대기
- `npm run full:qa -- --site-root /path/to/applied-store --skip-live --site-port 3101 --site-event-probe --site-production-probe --timeout-ms 240000`: 통과
  - 리포트: `dist/full-qa-report.json`
  - `local_qa_ok`: `true`
  - `deployment_ready`: `false`
  - 통과: `10`, 경고: `2`, 실패: `0`
  - 추가 통과 항목: `site_production_runtime`
  - 경고 항목: 운영 도메인/GTM/GA4/광고/CRM env 값 미준비, 운영값 기반 GTM import 렌더링 대기
- `npm run handoff:deployment -- --site-root /path/to/applied-store`: 통과
  - 문서: `dist/deployment-handoff.md`
  - JSON: `dist/deployment-handoff.json`
  - 배포 대상 점검 요약 포함: Vercel 로그인 `true`, Vercel project linked `false`, blocker `hosting_project_not_linked`, `marketing_env_not_ready`
  - 차단 운영값: `NEXT_PUBLIC_GTM_ID`, `DOWNSTREAM_CRM_WEBHOOK_URL`, `NEXT_PUBLIC_GA4_MEASUREMENT_ID`, `NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL`, `NEXT_PUBLIC_META_PIXEL_ID`, `NEXT_PUBLIC_APP_URL`
- `npm run handoff:external -- --site-root /path/to/applied-store`: 통과
  - 문서: `dist/external-account-setup.md`
  - JSON: `dist/external-account-setup.json`
  - 외부 실행 항목: 운영 도메인, GTM 컨테이너, GA4 웹 스트림, Google Ads 구매 전환, Meta 픽셀, CRM webhook
  - 운영 URL 탐색 결과: 후보 사이트 env에서 `http://localhost:3000`만 발견, 운영 HTTPS URL 추천값 없음
  - 모든 계정 리소스 생성/게시/실제 발송은 Computer Use 실행 직전 사용자 확인 게이트 포함
- `npm run inspect:deployment -- --site-root /path/to/applied-store --vercel-project-url https://vercel.com/petasos/auto-marketing`: 배포 대상 점검 통과
  - 문서: `dist/deployment-target-plan.md`
  - JSON: `dist/deployment-target-plan.json`
  - 추천 플랫폼: `vercel`
  - Vercel CLI: 설치됨, 로그인 계정 `leecg39-8923`
  - Vercel 프로젝트 목록: `annatars-projects` scope에서 9개 조회
  - 지정 Vercel 프로젝트: `petasos/auto-marketing`
  - 지정 프로젝트 접근 상태: 현재 CLI 계정에서 `petasos` scope 조회 실패, `Error: The specified scope does not exist`
  - 기존 프로젝트 후보: `shopping-mall` (`prj_jbiz4pdFrJWDmVgFK030WPSzNRYk`, weak ecommerce context, latest production URL `404`)
  - 추천 Vercel 프로젝트: 없음, 이름이 충분히 일치하는 프로젝트가 없어 link 명령은 `<project-name-or-id>` placeholder 유지
  - Vercel project link: `false`
  - production deploy ready: `false`
  - blocker: `target_vercel_project_inaccessible`, `hosting_project_not_linked`, `marketing_env_not_ready`
  - 다음 단계: Vercel CLI 계정에 `petasos` scope 접근 권한을 부여하거나 권한 있는 계정으로 다시 로그인
  - 확인 필요 명령: `vercel link`, Vercel production env add, `vercel deploy --prod`
- `npm run render:gtm -- --site-root /path/to/applied-store --dry-run`: 운영 env 값 미준비로 예상대로 미생성
  - 출력: `ok=false`
  - 파일 쓰기 없음
  - 차단 운영값: `NEXT_PUBLIC_GTM_ID`, `DOWNSTREAM_CRM_WEBHOOK_URL`, `NEXT_PUBLIC_GA4_MEASUREMENT_ID`, `NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL`, `NEXT_PUBLIC_META_PIXEL_ID`, `NEXT_PUBLIC_APP_URL`
- `npm run audit:completion -- --site-root /path/to/applied-store`: 완료 감사 리포트 생성
  - 문서: `dist/completion-audit.md`
  - JSON: `dist/completion-audit.json`
  - 요약: `complete=6`, `blocked_external=2`, `missing_evidence=0`, `failed=0`
  - 현재 판정: 운영 env 값과 운영값 기반 GTM import가 `blocked_external`
- `npm run dashboard:ops -- --site-root /path/to/applied-store`: 운영 대시보드 생성
  - HTML: `dist/growth-ops-dashboard.html`
  - JSON: `dist/growth-ops-dashboard.json`
  - full QA, 완료 감사, handoff, 현재 env 차단값과 다음 외부 계정 액션을 한 화면으로 요약
- `npm run go:live -- --site-root /path/to/applied-store --dry-run --skip-full-qa`: 운영 env 파일 미입력 상태 확인
  - 리포트: `dist/go-live-report.json`
  - 현재 판정: 운영 env 값 미준비로 `ok=false`
- `npm test`: 93개 테스트 통과
- `npm run check`: SDK, 자동화 플로우 엔진, CRM 서버, downstream 시뮬레이터, 사이트 감사, 완료 감사, 마케팅 env 병합기, deployment handoff 생성기, 외부 계정 실행 체크리스트 생성기, GTM import 생성기, 배포 대상 점검기, 운영 GTM import 렌더러, env 검증기, 매출 대조기, full QA 오케스트레이터, 브라우저 QA 스크립트, GTM import 검증기, 실제 사이트 런타임 QA 스크립트, production runtime QA 스크립트 문법 검사 통과
- `npm run verify:local`: 데모 페이지, CRM health, downstream health, CRM 이벤트 플로우, 자동화 액션, downstream 전달 검증 통과
  - downstream 수신 이벤트: `add_to_cart`, `begin_checkout`, `purchase`, `generate_lead`
- `npm run verify:browser`: headless Chrome에서 데모 autorun 통과
  - dataLayer 이벤트: `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, `generate_lead`
  - CRM 플로우: `cart_abandonment_candidate`, `checkout_abandonment_candidate`, `post_purchase_review_and_recommendation`, `lead_followup`
  - 자동화 액션: `cart_abandonment_reminder`, `cart_retargeting_audience`, `checkout_abandonment_reminder`, `checkout_retargeting_audience`, `review_request`, `repurchase_due`, `purchase_exclusion`, `lead_followup`
  - downstream 전달 상태: `202`, `202`, `202`, `202`
  - `duplicate_transaction_id` 중복 구매 방지 확인
  - dataLayer 개인정보 미포함 확인
  - downstream CRM payload의 UTM 보존 확인: `utm_source=browser_qa`, `utm_medium=automated`, `utm_campaign=marketing_automation`
- `npm run verify:site -- --site-url http://127.0.0.1:3100`: 실제 후보 사이트 런타임 QA 통과
  - `/assets/marketing-automation.js`: `200 OK`, SDK global 포함 확인
  - `/api/crm/events`: 동의 계정 `202`, 미동의 연락처 payload `422` 확인
  - `/`, `/signup`, `/margin-calculator`: SDK script, consent banner, 동의/거부 버튼 확인
- `npm run verify:site -- --site-url http://127.0.0.1:3100 --event-probe`: 실제 후보 사이트 브라우저 이벤트 probe 통과
  - dataLayer 이벤트: `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, `sign_up`, `login`, `generate_lead`
  - `duplicate_transaction_id` 중복 구매 방지 확인
  - dataLayer 개인정보 미포함 확인
  - event probe는 CRM consent를 `false`로 고정해 외부 발송 없이 dataLayer만 검증
- `npm run verify:prod-site -- --site-root /path/to/applied-store --site-port 3101 --timeout-ms 240000 --build --event-probe`: 실제 후보 사이트 production runtime QA 통과
  - 리포트: `dist/production-runtime-report.json`
  - 요약: `passed=3`, `failed=0`
  - `npm run build`: 통과
  - `npm run start -- --hostname 127.0.0.1 --port 3101`: 준비 상태 `200 OK`
  - production runtime event probe: `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, `sign_up`, `login`, `generate_lead`
  - 구매 중복 방지와 dataLayer 개인정보 미포함 확인
- `npm run reconcile:revenue -- --orders examples/orders-revenue.csv --ga4 examples/ga4-revenue.csv`: 예제 주문/GA4 매출 대조 통과
  - 전체 주문 매출: `280000`
  - 전체 GA4 매출: `276000`
  - 전체 오차율: `0.0143`
  - 일자별 오차율: `2026-06-25=0.01`, `2026-06-26=0.025`
- `npm run generate:gtm -- --public-id GTM-XXXXXXX`: `dist/gtm-container-import.json` 생성, 태그 12개/트리거 7개/변수 14개
- `npm run verify:gtm`: GTM import 구조 검증 통과
  - 체크: `77/77`
  - GA4 이벤트 7개, Google Ads 구매 전환, Meta Pixel 3개, Custom Event trigger 7개, DLV 10개, Consent Mode 요구사항 확인
  - contact PII 변수/파라미터 미포함 확인
- `npm run validate:env -- /path/to/applied-store`: `.env.local` 로드, 운영 도메인/GTM/GA4/광고/CRM 값 미준비 확인
  - 운영 URL 탐색: `env:NEXT_PUBLIC_APP_URL=http://localhost:3000`만 발견, `suggested_url` 없음

실행 중인 서버를 종료하려면:

```bash
cd marketing-automation-kit
npm run stop:local
```

## 구현 완료된 설계 항목

- GA4/GTM용 `dataLayer` 이벤트 SDK
- Consent Mode와 연결할 동의 상태 저장/업데이트
- UTM first/last touch 저장
- GA4 권장 이벤트 7개
  - `view_item`
  - `add_to_cart`
  - `begin_checkout`
  - `purchase`
  - `sign_up`
  - `login`
  - `generate_lead`
- `transaction_id` 기준 구매 이벤트 중복 방지
- GA4 이벤트에서 개인정보 필드 제거
- CRM webhook 페이로드 분리
- downstream CRM 시뮬레이터와 end-to-end 전달 검증
- 마케팅/CRM 동의 없을 때 CRM 전송 차단
- 장바구니/결제/구매/리드 자동화 플로우 매핑
- 자동화 액션 예약 엔진
  - 장바구니 이탈: 60분 후 메시지, 구매 시 취소, 광고 대상 업데이트
  - 결제 이탈: 30분 후 메시지, 구매 시 취소, 광고 대상 업데이트
  - 구매 후: 리뷰 요청 7일 후, 재구매 알림 30일 후, 광고 제외 대상 업데이트
  - 리드 후속: 즉시 이메일/카카오 후속 액션
- GTM 변수/트리거/태그 작업 블루프린트
- GTM 가져오기용 컨테이너 JSON 생성 명령: `npm run generate:gtm`
- GTM 가져오기용 컨테이너 JSON 구조 검증 명령: `npm run verify:gtm`
- 운영 env 값 기반 GTM import 렌더링 명령: `npm run render:gtm -- --site-root /path/to/store`
- 전체 요구사항 완료 감사 명령: `npm run audit:completion -- --site-root /path/to/store`
- 운영 환경값 readiness 검증 명령: `npm run validate:env -- /path/to/store`
- 전체 로컬/사이트 QA 오케스트레이터 명령: `npm run full:qa -- --site-root /path/to/store --start-local --start-site --site-port 3100`
- production runtime QA 명령: `npm run verify:prod-site -- --site-root /path/to/store --build --event-probe`
- 배포 대상 점검 명령: `npm run inspect:deployment -- --site-root /path/to/store`
- 지정 Vercel 프로젝트 접근권한 점검 명령: `npm run inspect:deployment -- --site-root /path/to/store --vercel-project-url https://vercel.com/team/project`
- 운영 전환 일괄 실행 명령: `npm run go:live -- --site-root /path/to/store --env-file /path/to/marketing-production.env`
- 운영 상태 일괄 갱신 명령: `npm run ops:refresh -- --site-root /path/to/store --start-local --start-site --site-port 3100`
- 운영 계정값 handoff 문서 생성 명령: `npm run handoff:deployment -- --site-root /path/to/store`
- 외부 계정 실행 체크리스트 생성 명령: `npm run handoff:external -- --site-root /path/to/store`
- 운영 대시보드 생성 명령: `npm run dashboard:ops -- --site-root /path/to/store`
- 운영 마케팅 env dry-run/병합 명령: `npm run apply:env -- --site-root /path/to/store --env-file /path/to/marketing-production.env --dry-run`
- headless Chrome 브라우저 QA 명령: `npm run verify:browser`
- 실제 자사몰 런타임 QA 명령: `npm run verify:site -- --site-url http://127.0.0.1:3000`
- 실제 자사몰 dataLayer 이벤트 probe 명령: `npm run verify:site -- --site-url http://127.0.0.1:3000 --event-probe`
- Vercel production 표면 QA 명령: `npm run verify:vercel -- --base-url https://auto-marketing-sigma.vercel.app`
- 주문 DB와 GA4 매출 CSV 대조 명령: `npm run reconcile:revenue -- --orders exports/orders.csv --ga4 exports/ga4.csv --threshold 0.05`
- 실제 자사몰 적용 절차 문서
- 실제 자사몰 후보 탐색 명령: `npm run find:sites`
- 실제 자사몰 루트 감사 명령: `npm run audit:site -- /path/to/store`
- SDK 설치 자동화 명령: `npm run install:sdk -- /path/to/store`

## 최근 추가 검증

- 임시 fixture `/tmp/ma-site-fixture`에 SDK 설치 성공
- 생성 파일 확인
  - `public/assets/marketing-automation.js`
  - `.env.marketing.example`
  - `MARKETING_AUTOMATION_INSTALL.md`
- 후보 자사몰에 `--dry-run` 설치 경로 확인

## 실제 후보 사이트 적용

대상: `/path/to/applied-store`

- SDK 설치 완료
  - `public/assets/marketing-automation.js`
  - `.env.marketing.example`
  - `MARKETING_AUTOMATION_INSTALL.md`
- `.env.local`에 내부 CRM 수신 URL과 기본 통화 반영
  - `NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events`
  - `NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY=KRW`
- Next 앱 공통 레이아웃에 마케팅 자동화 provider 연결
- 동의 배너 추가 및 동의 상태를 SDK Consent Mode 상태와 연결
- 내부 CRM 수신 라우트 추가: `/api/crm/events`
- 로그인/회원가입 이벤트 연결
- 랜딩 CTA/요금제 CTA의 `generate_lead`, `begin_checkout` 이벤트 연결
- 마진 계산기 조회 이벤트를 `view_item`으로 연결
- 프론트 wrapper에서 `add_to_cart` 호출 함수까지 노출
- CRM 이벤트 자동화 플로우 매핑
  - `sign_up -> welcome_coupon`
  - `add_to_cart -> cart_abandonment_candidate`
  - `begin_checkout -> checkout_abandonment_candidate`
  - `purchase -> post_purchase_review_and_recommendation`
  - `generate_lead -> lead_followup`
- 검증 완료
  - `npm run lint`: 통과
  - `npm run build`: 통과
  - `npm test`: 4개 파일, 14개 테스트 통과
  - `npm run audit:site -- /path/to/applied-store`: SDK/Provider/CRM route 설치 및 7개 이벤트 지원 확인
  - `/`, `/signup`, `/margin-calculator`: `200 OK`
  - `/assets/marketing-automation.js`: `200 OK`
  - Headless Chrome 렌더링에서 동의 배너, SDK script, 랜딩 CTA 노출 확인
  - `/api/crm/events` 수신동의 있음: 플로우 매핑 성공
  - `/api/crm/events` 자동화 액션 예약 성공
  - `/api/crm/events` 수신동의 없음 + 이메일 payload: 차단 확인

## 외부 정보가 있어야 완료되는 항목

아래 항목은 로컬 컴퓨터에서 임의로 만들거나 게시하면 실제 계정/사이트에 영향을 주므로, 현재 상태에서는 실행하지 않았습니다.

- 실제 GTM 컨테이너 생성 및 게시
- 실제 GA4 속성/웹 스트림 생성 또는 측정 ID 연결
- Google Ads 구매 전환 ID/라벨 연결
- Meta Pixel ID 연결
- 실제 CRM/카카오/이메일 발송툴 webhook URL 연결
- 운영 자사몰 HTTPS 도메인 확정
- 운영 도메인 CORS 설정
- 실제 운영 주문 DB CSV와 GA4 CSV export 후 48시간 매출 비교 실행

필요한 입력:

- GTM 컨테이너 ID
- GA4 측정 ID
- Google Ads 구매 전환 라벨
- Meta Pixel ID
- CRM/카카오/이메일 발송툴 webhook URL과 API 키
- 운영 자사몰 HTTPS URL (`NEXT_PUBLIC_APP_URL`)

## 이 컴퓨터에서 확인한 외부 계정 상태

확인일: 2026-06-27

- Google 계정: `leecg2908@gmail.com`
- GTM: 계정 생성 폼이 `oliveyoung-shopee`, 국가 `대한민국`, 웹 컨테이너 `oliveyoung-shopee-web`로 준비되어 있으나, 최종 `만들기` 버튼은 누르지 않았습니다.
- GA4: Analytics가 초기 `측정 시작` 화면에 있어 GA4 속성/웹 스트림/측정 ID가 아직 없습니다.
- Google Ads: 계정 `446-442-5600`을 확인했고, 로컬 후보 사이트 env에 `NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-4464425600`를 반영했습니다. 구매 전환 액션 라벨은 아직 없습니다.
- Meta: Business Settings > Data Sources > Data sets and pixels에서 기존 데이터 세트/픽셀이 없습니다.
- 운영 도메인: 후보 사이트 저장소와 배포 설정에서 운영 URL을 찾지 못했습니다. 후보 사이트 `.env.local`의 `NEXT_PUBLIC_APP_URL`은 localhost입니다.

외부 계정 리소스 생성, 전환 액션 생성, 픽셀 생성, GTM 게시, 광고 설정 진행은 실제 계정 상태를 바꾸므로 실행 직전 사용자 확인과 운영 도메인이 필요합니다.

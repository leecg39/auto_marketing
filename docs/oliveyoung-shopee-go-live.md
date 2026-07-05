# oliveyoung-shopee Go-Live Runbook

이 문서는 현재 `auto-marketing-sigma.vercel.app` 배포를 실제 마케팅 자동화 운영 상태로 넘기기 위한 프로젝트 전용 체크리스트입니다.

## 현재 확정값

- Production URL: `https://auto-marketing-sigma.vercel.app`
- GTM account/container: `oliveyoung-shopee` / `oliveyoung-shopee-web`
- GTM container ID: `GTM-NHSTBZ3N`
- GA4 account/property: `oliveyoung-shopee` / `oliveyoung-shopee-web`
- GA4 web stream ID: `15202126894`
- GA4 measurement ID: `G-FECEN229PE`
- Google Ads account: `446-442-5600`
- Google Ads conversion ID: `AW-4464425600`
- Meta Events Manager account: `1326028795156580`
- Candidate env file: `examples/oliveyoung-shopee.production.env.example`

## 준비 완료

- 운영 도메인: `https://auto-marketing-sigma.vercel.app`에서 접근 가능
- GTM 설치 감지: GTM 설치 테스트에서 Google 태그 감지됨
- GA4 스트림: 운영 URL 기준 웹 스트림과 측정 ID 확보됨
- Vercel public runtime config: GTM/GA4/App URL/Google Ads conversion ID 반영됨
- Production QA: Vercel verifier 8/8 통과, demo dataLayer에 PII 없음

## 남은 차단값

- `NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL`
  - Google Ads 계정 `446-442-5600`에서 구매 전환 액션을 생성하거나 기존 구매 전환을 선택해야 합니다.
  - 현재 전환 관리 URL은 스마트 캠페인 온보딩으로 리다이렉트되어 기존 label을 읽지 못했습니다.
  - 생성/저장은 광고 계정 설정 변경이므로 Computer Use action-time 확인 후 진행합니다.
- `NEXT_PUBLIC_META_PIXEL_ID`
  - Meta Events Manager 계정 `1326028795156580`의 데이터 세트 화면이 `데이터 소스 없음` 상태입니다.
  - 새 데이터 세트/Pixel 생성이 필요합니다.
  - 생성/저장은 Meta 계정 상태 변경이므로 Computer Use action-time 확인 후 진행합니다.
- `DOWNSTREAM_CRM_WEBHOOK_URL`
  - 실제 이메일/카카오/CRM 발송툴의 HTTPS webhook endpoint가 필요합니다.
  - API key가 필요한 provider라면 `DOWNSTREAM_CRM_API_KEY`도 private env에만 넣습니다.
  - 실제 고객 연락처 전송 또는 테스트 발송은 테스트 계정과 수신동의 조건을 확인한 뒤 진행합니다.

## 값 확보 후 실행

```bash
cp examples/oliveyoung-shopee.production.env.example /path/to/marketing-production.env
# Fill:
# DOWNSTREAM_CRM_WEBHOOK_URL
# NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL
# NEXT_PUBLIC_META_PIXEL_ID
# Optional: DOWNSTREAM_CRM_API_KEY

npm run validate:env -- . --env-file /path/to/marketing-production.env
npm run handoff:external -- --site-root . --env-file /path/to/marketing-production.env
npm run render:gtm -- --site-root . --env-file /path/to/marketing-production.env
npm run verify:gtm -- --input dist/gtm-container-import.production.json
npm run go:live -- --site-root . --env-file /path/to/marketing-production.env --dry-run
```

그 다음 Vercel production/preview env에 같은 값을 반영하고 production deploy 후 아래를 실행합니다.

```bash
npm run verify:vercel -- --base-url https://auto-marketing-sigma.vercel.app
curl -fsS https://auto-marketing-sigma.vercel.app/api/marketing/env-status
```

## Computer Use 확인 문구

- Google Ads: `Google Ads 계정 446-442-5600에서 구매 전환 액션을 실제 생성하거나 수정합니다. 광고 계정 설정을 바꾸기 위해 저장을 눌러도 될까요?`
- Meta: `Meta Business에서 데이터 세트 또는 Pixel을 실제 생성하거나 도메인 검증 설정을 저장합니다. Meta 계정 상태를 바꾸기 위해 생성/저장을 눌러도 될까요?`
- CRM: `고객 연락처와 마케팅 이벤트를 이메일/카카오/CRM 공급자 webhook으로 전송할 수 있는 설정을 실제 저장하거나 테스트 발송합니다. 테스트 계정으로만 진행해도 될까요?`

## 완료 증거

- Vercel readiness API에서 `ready: true`
- GTM Preview에서 `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, `sign_up`, `login`, `generate_lead` 확인
- GA4 DebugView에서 같은 7개 이벤트와 `purchase.transaction_id`, `value`, `currency=KRW` 확인
- Google Ads 테스트 도구에서 purchase conversion 수신 확인
- Meta 테스트 이벤트 도구에서 `AddToCart`, `InitiateCheckout`, `Purchase` 수신 확인
- CRM provider 테스트 계정에만 장바구니/결제 이탈, 구매 후 리뷰, 재구매, 리드 후속 플로우 발송 확인
- 수신동의 없는 contact payload는 `/api/crm/events`와 provider 양쪽에서 발송 차단

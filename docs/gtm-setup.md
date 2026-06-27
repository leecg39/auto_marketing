# GTM/GA4 설정 절차

## 계정 준비

1. GA4 속성을 만들고 웹 데이터 스트림의 측정 ID를 확보합니다.
2. Google Tag Manager 웹 컨테이너를 만들고 컨테이너 ID를 확보합니다.
3. Google Ads 전환 ID/라벨과 Meta Pixel ID를 준비합니다.
4. 자사몰 공통 레이아웃에 `src/marketing-automation.js`를 배포합니다.

## 가져오기 파일 생성

수동으로 변수/트리거/태그를 만들기 전에 GTM Import Container용 JSON을 생성할 수 있습니다.

```bash
cd marketing-automation-kit
npm run generate:gtm -- --public-id GTM-XXXXXXX
npm run verify:gtm
```

생성 파일:

```text
dist/gtm-container-import.json
```

`verify:gtm`은 생성된 파일에 7개 GA4 이벤트 태그, Google Ads 구매 전환, Meta Pixel 전자상거래 태그, Custom Event trigger, Data Layer Variable, Consent Mode 요구사항, contact PII 미포함 여부가 들어 있는지 검사합니다.

GTM Admin > Import Container에서 가져온 뒤 아래 Constant Variable 값을 실제 운영 값으로 교체합니다.

- `GA4 Measurement ID`
- `Google Ads Conversion ID`
- `Google Ads Purchase Label`
- `Meta Pixel ID`

이 파일에는 GA4 이벤트 7개, Google Ads 구매 전환, Meta Pixel `AddToCart`/`InitiateCheckout`/`Purchase`, Consent Mode 요구사항이 포함됩니다. 가져오기 후에는 반드시 GTM Preview에서 태그 타입과 변수 치환값을 확인한 뒤 게시합니다.

운영 env 값이 준비되어 있으면 placeholder를 수동 교체하기 전에 아래 명령으로 운영용 import 파일을 생성할 수 있습니다. 출력에는 운영값이 마스킹됩니다.

```bash
npm run render:gtm -- --site-root /path/to/store
npm run verify:gtm -- --input dist/gtm-container-import.production.json
```

생성 파일:

```text
dist/gtm-container-import.production.json
```

## 변수 생성

GTM에서 데이터 영역 변수(Data Layer Variable)를 만듭니다.

- `DLV - ecommerce.transaction_id`: `ecommerce.transaction_id`
- `DLV - ecommerce.items`: `ecommerce.items`
- `DLV - ecommerce.currency`: `ecommerce.currency`
- `DLV - ecommerce.value`: `ecommerce.value`
- `DLV - ecommerce.tax`: `ecommerce.tax`
- `DLV - ecommerce.shipping`: `ecommerce.shipping`
- `DLV - ecommerce.coupon`: `ecommerce.coupon`
- `DLV - method`: `method`
- `DLV - currency`: `currency`
- `DLV - value`: `value`

## 트리거 생성

각 이벤트마다 Custom Event 트리거를 만듭니다.

- `CE - view_item`: 이벤트 이름 `view_item`
- `CE - add_to_cart`: 이벤트 이름 `add_to_cart`
- `CE - begin_checkout`: 이벤트 이름 `begin_checkout`
- `CE - purchase`: 이벤트 이름 `purchase`
- `CE - sign_up`: 이벤트 이름 `sign_up`
- `CE - login`: 이벤트 이름 `login`
- `CE - generate_lead`: 이벤트 이름 `generate_lead`

## GA4 태그

1. GA4 구성 태그를 만들고 측정 ID를 입력합니다.
2. GA4 이벤트 태그를 이벤트별로 만듭니다.
3. `purchase` 이벤트에는 `transaction_id`, `value`, `currency`, `tax`, `shipping`, `coupon`, `items`를 매핑합니다.
4. `view_item`, `add_to_cart`, `begin_checkout`에는 `items`, `value`, `currency`, `coupon`을 매핑합니다.
5. `sign_up`, `login`에는 `method`를 매핑합니다.
6. `generate_lead`에는 `value`, `currency`를 매핑합니다.

## 광고 태그

- Google Ads 구매 전환 태그는 `purchase` 트리거에서만 실행합니다.
- Meta Pixel `Purchase`, `AddToCart`, `InitiateCheckout`는 각각 `purchase`, `add_to_cart`, `begin_checkout`에 매핑합니다.
- 광고 리타겟팅 태그는 Consent Mode의 광고 동의가 있을 때만 실행되게 설정합니다.

## Consent Mode

SDK의 기본 동의 상태는 모두 denied입니다.

```js
MarketingAutomation.setConsent({
  analytics: true,
  ads: true,
  marketing: true,
  crm: true
});
```

GTM에서는 태그별 동의 요구사항을 설정합니다.

- GA4 기본 측정: `analytics_storage`
- Google Ads/Meta 전환: `ad_storage`, `ad_user_data`, `ad_personalization`
- CRM/메시징 발송: SDK의 `crm` 동의와 서버의 `marketing_consent` 검증

## 게시 전 확인

GTM Preview에서 아래 순서대로 이벤트를 확인합니다.

1. 동의 거부 상태에서 광고/CRM 관련 태그가 실행되지 않습니다.
2. 동의 허용 후 `view_item`이 GA4 DebugView에 표시됩니다.
3. `add_to_cart`, `begin_checkout`, `purchase`가 ecommerce 파라미터와 함께 표시됩니다.
4. 구매 완료 페이지 새로고침 시 같은 `transaction_id`의 `purchase`가 재전송되지 않습니다.
5. Google Ads와 Meta 테스트 도구에서 전환 이벤트가 수신됩니다.

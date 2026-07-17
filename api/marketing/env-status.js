async function loadEnvValidator() {
  return await import('../../scripts/validate-deployment-env.mjs');
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

function runtimeValues(requirements) {
  return Object.fromEntries(requirements.map((requirement) => [
    requirement.key,
    process.env[requirement.key] || ''
  ]));
}

const ACTION_CATALOG = [
  {
    id: 'gtm_container',
    title: 'GTM 웹 컨테이너 생성',
    service: 'Google Tag Manager',
    keys: ['NEXT_PUBLIC_GTM_ID'],
    action: 'GTM에서 웹 컨테이너를 만들고 GTM-... ID를 Vercel production env에 입력하세요.',
    confirmation_required: true,
    confirmation_reason: 'Google 계정에 새 GTM 계정/컨테이너를 생성합니다.'
  },
  {
    id: 'ga4_stream',
    title: 'GA4 웹 스트림 연결',
    service: 'Google Analytics 4',
    keys: ['NEXT_PUBLIC_GA4_MEASUREMENT_ID'],
    action: 'GA4 웹 데이터 스트림을 만들고 G-... measurement ID를 Vercel production env와 GTM 변수에 반영하세요.',
    confirmation_required: true,
    confirmation_reason: 'Google Analytics 속성 또는 웹 스트림을 생성하거나 수정합니다.'
  },
  {
    id: 'google_ads_purchase',
    title: 'Google Ads 구매 전환 액션 연결',
    service: 'Google Ads',
    keys: ['NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID', 'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL'],
    action: '구매 전환 액션의 conversion ID와 purchase label을 확인해 GTM Google Ads purchase 태그 변수에 반영하세요.',
    confirmation_required: true,
    confirmation_reason: 'Google Ads 계정의 전환 액션을 생성하거나 수정할 수 있습니다.'
  },
  {
    id: 'meta_pixel',
    title: 'Meta Pixel 연결',
    service: 'Meta Events Manager',
    keys: ['NEXT_PUBLIC_META_PIXEL_ID'],
    action: 'Meta Pixel을 만들고 numeric pixel ID를 Vercel production env와 GTM 변수에 반영하세요.',
    confirmation_required: true,
    confirmation_reason: 'Meta Business 데이터 소스 또는 픽셀을 생성하거나 수정합니다.'
  },
  {
    id: 'crm_downstream',
    title: '이메일/카카오 downstream webhook 연결',
    service: 'CRM or messaging provider',
    keys: ['DOWNSTREAM_CRM_WEBHOOK_URL'],
    action: '이메일/카카오 발송툴의 HTTPS webhook endpoint를 DOWNSTREAM_CRM_WEBHOOK_URL에 입력하세요.',
    confirmation_required: true,
    confirmation_reason: '고객 연락처와 마케팅 이벤트를 외부 메시징 공급자로 전송할 수 있습니다.'
  },
  {
    id: 'delivery_gateway',
    title: '이메일/카카오 발송 공급자 연결',
    service: 'Resend, SOLAPI, Upstash Redis',
    keys: [
      'DOWNSTREAM_CRM_API_KEY',
      'CRM_DELIVERY_MODE',
      'CRM_TEST_RECIPIENTS',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'RESEND_API_KEY',
      'RESEND_FROM_EMAIL',
      'SOLAPI_API_KEY',
      'SOLAPI_API_SECRET',
      'SOLAPI_KAKAO_PF_ID'
    ],
    action: 'Resend, SOLAPI, Upstash Redis 자격 증명을 연결하고 테스트 수신자 허용 목록으로 실제 발송을 검증하세요.',
    confirmation_required: true,
    confirmation_reason: '외부 공급자 API 자격 증명을 생성하고 Vercel에 지속 접근 권한으로 저장합니다.'
  },
  {
    id: 'browser_crm_endpoint',
    title: '브라우저 CRM endpoint 연결',
    service: 'Storefront',
    keys: ['NEXT_PUBLIC_CRM_WEBHOOK_URL'],
    action: '브라우저에서 호출할 CRM event endpoint를 /api/crm/events 또는 운영 HTTPS URL로 설정하세요.',
    confirmation_required: false,
    confirmation_reason: ''
  },
  {
    id: 'production_app_url',
    title: '운영 storefront URL 확정',
    service: 'Vercel',
    keys: ['NEXT_PUBLIC_APP_URL'],
    action: 'Vercel production domain을 NEXT_PUBLIC_APP_URL에 입력하고 GA4/광고 landing page 기준 URL로 사용하세요.',
    confirmation_required: false,
    confirmation_reason: ''
  }
];

function buildNextActions(checks) {
  const checkByKey = new Map(checks.map((check) => [check.key, check]));

  return ACTION_CATALOG
    .map((item) => {
      const blocking = item.keys
        .map((key) => checkByKey.get(key))
        .filter((check) => check && !check.ok)
        .map((check) => ({
          key: check.key,
          label: check.label,
          status: check.status,
          required_for: check.required_for
        }));

      if (blocking.length === 0) {
        return null;
      }

      return {
        id: item.id,
        title: item.title,
        service: item.service,
        action: item.action,
        confirmation_required: item.confirmation_required,
        confirmation_reason: item.confirmation_reason,
        blocking_keys: blocking
      };
    })
    .filter(Boolean);
}

async function handler(request, response) {
  if (request.method !== 'GET') {
    sendJson(response, 405, {
      ok: false,
      errors: ['method_not_allowed']
    });
    return;
  }

  const {
    DELIVERY_GATEWAY_REQUIREMENTS,
    REQUIREMENTS,
    classifyRequirement,
    deploymentRequirements,
    summarize
  } = await loadEnvValidator();
  const values = runtimeValues([...REQUIREMENTS, ...DELIVERY_GATEWAY_REQUIREMENTS]);
  const checks = deploymentRequirements(values).map((requirement) => ({
    ...classifyRequirement(requirement, values),
    has_value: Boolean(values[requirement.key])
  }));
  const summary = summarize(checks);
  const nextActions = buildNextActions(checks);

  sendJson(response, 200, {
    ok: true,
    ready: summary.ready,
    summary,
    checks,
    next_actions: nextActions,
    next_step: summary.ready
      ? '운영 GTM/GA4/광고/CRM env 값이 준비되어 있습니다.'
      : 'next_actions 순서대로 외부 계정값을 확보한 뒤 Vercel production environment variables에 실제 운영 값으로 채우세요.'
  });
}

module.exports = handler;
module.exports._internals = {
  buildNextActions,
  runtimeValues
};

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  demoUrl,
  parseArgs,
  titleOf,
  verifyQaResult
} from '../scripts/verify-vercel-production.mjs';

const require = createRequire(import.meta.url);
const crmHandler = require('../api/crm/events.js');
const clientConfigHandler = require('../api/marketing/client-config.js');
const envStatusHandler = require('../api/marketing/env-status.js');
const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_KEYS = [
  'NEXT_PUBLIC_GTM_ID',
  'NEXT_PUBLIC_CRM_WEBHOOK_URL',
  'NEXT_PUBLIC_APP_URL',
  'DOWNSTREAM_CRM_WEBHOOK_URL',
  'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
  'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID',
  'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL',
  'NEXT_PUBLIC_META_PIXEL_ID'
];

class MockRequest extends Readable {
  constructor(method, body = '', headers = {}) {
    super();
    this.method = method;
    this.headers = {
      'content-type': 'application/json',
      ...headers
    };
    this.bodyText = body;
    this.sent = false;
  }

  _read() {
    if (this.sent) {
      this.push(null);
      return;
    }

    this.sent = true;
    this.push(this.bodyText);
    this.push(null);
  }
}

class MockResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = '';
  }

  setHeader(key, value) {
    this.headers[key.toLowerCase()] = value;
  }

  end(body = '') {
    this.body = body;
  }

  json() {
    return this.body ? JSON.parse(this.body) : null;
  }
}

async function invoke(handler, method, payload, headers = {}) {
  const request = new MockRequest(
    method,
    payload === undefined ? '' : JSON.stringify(payload),
    headers
  );
  const response = new MockResponse();

  await handler(request, response);

  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.json()
  };
}

async function invokeRaw(handler, method, payload) {
  const request = new MockRequest(method, payload === undefined ? '' : JSON.stringify(payload));
  const response = new MockResponse();

  await handler(request, response);

  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.body
  };
}

// @TASK CRM-EVENT-INGEST-AUTH - Verify downstream contact forwarding authentication
// @SPEC docs/live-deployment.md#crm-연결
test('Vercel CRM event API preserves unauthenticated demo mode without a downstream', async () => {
  const previousUrl = process.env.DOWNSTREAM_CRM_WEBHOOK_URL;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    delete process.env.DOWNSTREAM_CRM_WEBHOOK_URL;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 202 };
    };

    const result = await invoke(crmHandler, 'POST', {
      event_name: 'purchase',
      occurred_at: '2026-07-05T00:00:00.000Z',
      transaction_id: 'ORDER_VERCEL_001',
      email: 'demo@example.test',
      marketing_consent: true,
      value: 129000,
      metadata: { order_count: 1 }
    });

    assert.equal(result.status, 202);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.automation_flow, 'post_purchase_review_and_recommendation');
    assert.deepEqual(result.body.automation_actions.map((action) => action.flow), [
      'first_purchase_thank_you',
      'review_request',
      'repurchase_due',
      'purchase_exclusion'
    ]);
    assert.equal(result.body.delivery.status, 202);
    assert.equal(result.body.delivery.reason, 'serverless_demo_no_downstream');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.DOWNSTREAM_CRM_WEBHOOK_URL;
    else process.env.DOWNSTREAM_CRM_WEBHOOK_URL = previousUrl;
  }
});

test('Vercel CRM event API authenticates contact forwarding with the ingest key and fallback key', async () => {
  const envKeys = [
    'DOWNSTREAM_CRM_WEBHOOK_URL',
    'CRM_EVENT_INGEST_API_KEY',
    'DOWNSTREAM_CRM_API_KEY'
  ];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const fetchCalls = [];

  try {
    Object.assign(process.env, {
      DOWNSTREAM_CRM_WEBHOOK_URL: 'https://crm.example.test/events',
      CRM_EVENT_INGEST_API_KEY: 'ingest-primary-secret',
      DOWNSTREAM_CRM_API_KEY: 'downstream-fallback-secret'
    });
    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, status: 202 };
    };

    const primaryResult = await invoke(crmHandler, 'POST', {
      event_name: 'generate_lead',
      occurred_at: '2026-07-05T00:00:00.000Z',
      email: 'primary@example.test',
      marketing_consent: true
    }, { authorization: 'Bearer ingest-primary-secret' });

    delete process.env.CRM_EVENT_INGEST_API_KEY;
    const fallbackResult = await invoke(crmHandler, 'POST', {
      event_name: 'generate_lead',
      occurred_at: '2026-07-05T00:00:00.000Z',
      phone: '01012345678',
      marketing_consent: true
    }, { authorization: 'Bearer downstream-fallback-secret' });

    assert.equal(primaryResult.status, 202);
    assert.equal(fallbackResult.status, 202);
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].url, 'https://crm.example.test/events');
    assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer downstream-fallback-secret');
    assert.equal(fetchCalls[1].options.headers.Authorization, 'Bearer downstream-fallback-secret');
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Vercel CRM event API rejects unauthenticated contact forwarding without calling downstream', async () => {
  const envKeys = [
    'DOWNSTREAM_CRM_WEBHOOK_URL',
    'CRM_EVENT_INGEST_API_KEY',
    'DOWNSTREAM_CRM_API_KEY'
  ];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    Object.assign(process.env, {
      DOWNSTREAM_CRM_WEBHOOK_URL: 'https://crm.example.test/events',
      CRM_EVENT_INGEST_API_KEY: 'ingest-primary-secret',
      DOWNSTREAM_CRM_API_KEY: 'downstream-fallback-secret'
    });
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 202 };
    };

    const result = await invoke(crmHandler, 'POST', {
      event_name: 'generate_lead',
      occurred_at: '2026-07-05T00:00:00.000Z',
      email: 'unauthenticated@example.test',
      marketing_consent: true
    });

    assert.equal(result.status, 401);
    assert.deepEqual(result.body.errors, ['unauthorized']);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Vercel CRM event API rejects a mismatched Bearer token without calling downstream', async () => {
  const envKeys = [
    'DOWNSTREAM_CRM_WEBHOOK_URL',
    'CRM_EVENT_INGEST_API_KEY',
    'DOWNSTREAM_CRM_API_KEY'
  ];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    Object.assign(process.env, {
      DOWNSTREAM_CRM_WEBHOOK_URL: 'https://crm.example.test/events',
      CRM_EVENT_INGEST_API_KEY: 'ingest-primary-secret',
      DOWNSTREAM_CRM_API_KEY: 'downstream-fallback-secret'
    });
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 202 };
    };

    const result = await invoke(crmHandler, 'POST', {
      event_name: 'generate_lead',
      occurred_at: '2026-07-05T00:00:00.000Z',
      phone: '01012345678',
      marketing_consent: true
    }, { authorization: 'Bearer downstream-fallback-secret' });

    assert.equal(result.status, 401);
    assert.deepEqual(result.body.errors, ['unauthorized']);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Vercel CRM event API rejects a missing occurred_at value', async () => {
  const previousUrl = process.env.DOWNSTREAM_CRM_WEBHOOK_URL;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    delete process.env.DOWNSTREAM_CRM_WEBHOOK_URL;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 202 };
    };

    const result = await invoke(crmHandler, 'POST', {
      event_name: 'generate_lead',
      email: 'missing-timestamp@example.test',
      marketing_consent: true
    });

    assert.equal(result.status, 422);
    assert.equal(result.body.errors.includes('occurred_at_required'), true);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.DOWNSTREAM_CRM_WEBHOOK_URL;
    else process.env.DOWNSTREAM_CRM_WEBHOOK_URL = previousUrl;
  }
});

test('Vercel CRM event API rejects contact payloads without marketing consent', async () => {
  const result = await invoke(crmHandler, 'POST', {
    event_name: 'generate_lead',
    occurred_at: '2026-07-05T00:00:00.000Z',
    email: 'demo@example.test',
    marketing_consent: false
  });

  assert.equal(result.status, 422);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.errors.includes('marketing_consent_required_for_contact_payload'), true);
});

test('Vercel CRM event API only accepts literal true as marketing consent', async () => {
  const result = await invoke(crmHandler, 'POST', {
    event_name: 'generate_lead',
    occurred_at: '2026-07-05T00:00:00.000Z',
    email: 'demo@example.test',
    marketing_consent: 'false'
  });

  assert.equal(result.status, 422);
  assert.equal(result.body.errors.includes('marketing_consent_required_for_contact_payload'), true);
});

test('Vercel CRM event API validates and creates lifecycle actions', async () => {
  const missingUser = await invoke(crmHandler, 'POST', {
    event_name: 'dormant_60_days',
    occurred_at: '2026-07-05T00:00:00.000Z',
    marketing_consent: true
  });
  const accepted = await invoke(crmHandler, 'POST', {
    event_name: 'vip_qualified',
    occurred_at: '2026-07-05T00:00:00.000Z',
    user_id: 'USER_VIP_001',
    email: 'vip@example.test',
    marketing_consent: true
  });

  assert.equal(missingUser.status, 422);
  assert.equal(missingUser.body.errors.includes('user_id_required_for_lifecycle_event'), true);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.automation_flow, 'vip_benefit');
  assert.deepEqual(accepted.body.automation_actions.map((action) => action.flow), ['vip_benefit']);
  assert.equal(accepted.body.automation_actions[0].status, 'ready');
});

test('Vercel env readiness API reports ready state without exposing raw values', async () => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    Object.assign(process.env, {
      NEXT_PUBLIC_GTM_ID: 'GTM-ABCDE12',
      NEXT_PUBLIC_CRM_WEBHOOK_URL: '/api/crm/events',
      NEXT_PUBLIC_APP_URL: 'https://auto-marketing-sigma.vercel.app',
      DOWNSTREAM_CRM_WEBHOOK_URL: 'https://crm.example.test/webhook',
      NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-ABCDE12345',
      NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID: 'AW-123456789',
      NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL: 'purchaseLabel123',
      NEXT_PUBLIC_META_PIXEL_ID: '123456789'
    });

    const result = await invoke(envStatusHandler, 'GET');
    const serialized = JSON.stringify(result.body);

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.ready, true);
    assert.equal(result.body.summary.ready, true);
    assert.equal(serialized.includes('crm.example.test'), false);
    assert.equal(serialized.includes('purchaseLabel123'), false);
    assert.equal(result.body.checks.every((check) => check.status === 'ready'), true);
    assert.deepEqual(result.body.next_actions, []);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('Vercel env readiness API reports missing runtime values', async () => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }

    const result = await invoke(envStatusHandler, 'GET');

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.ready, false);
    assert.equal(result.body.summary.missing.includes('NEXT_PUBLIC_GTM_ID'), true);
    assert.equal(result.body.summary.missing.includes('DOWNSTREAM_CRM_WEBHOOK_URL'), true);
    assert.deepEqual(result.body.next_actions.map((action) => action.id), [
      'gtm_container',
      'ga4_stream',
      'google_ads_purchase',
      'meta_pixel',
      'crm_downstream',
      'browser_crm_endpoint',
      'production_app_url'
    ]);
    assert.equal(result.body.next_actions[0].blocking_keys[0].key, 'NEXT_PUBLIC_GTM_ID');
    assert.equal(result.body.next_actions[0].confirmation_required, true);
    assert.match(result.body.next_actions[0].confirmation_reason, /GTM/);
    assert.equal(result.body.next_actions.find((action) => action.id === 'production_app_url').confirmation_required, false);
    assert.equal(JSON.stringify(result.body).includes('GTM-ABCDE12'), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('Vercel env readiness includes first-party delivery gateway credentials', async () => {
  const gatewayKeys = [
    'DOWNSTREAM_CRM_API_KEY',
    'CRM_DELIVERY_MODE',
    'CRM_TEST_RECIPIENTS',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'UPSTASH_REDIS_KV_REST_API_URL',
    'UPSTASH_REDIS_KV_REST_API_TOKEN',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
    'SOLAPI_API_KEY',
    'SOLAPI_API_SECRET',
    'SOLAPI_KAKAO_PF_ID'
  ];
  const keys = [...new Set([...ENV_KEYS, ...gatewayKeys])];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    Object.assign(process.env, {
      NEXT_PUBLIC_GTM_ID: 'GTM-ABCDE12',
      NEXT_PUBLIC_CRM_WEBHOOK_URL: '/api/crm/events',
      NEXT_PUBLIC_APP_URL: 'https://auto-marketing-sigma.vercel.app',
      DOWNSTREAM_CRM_WEBHOOK_URL: 'https://auto-marketing-sigma.vercel.app/api/crm/downstream',
      NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-ABCDE12345',
      NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID: 'AW-123456789',
      NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL: 'purchaseLabel123',
      NEXT_PUBLIC_META_PIXEL_ID: '123456789'
    });
    for (const key of gatewayKeys) {
      delete process.env[key];
    }

    const result = await invoke(envStatusHandler, 'GET');

    assert.equal(result.body.ready, false);
    assert.equal(result.body.summary.missing.includes('RESEND_API_KEY'), true);
    assert.equal(result.body.summary.missing.includes('SOLAPI_KAKAO_PF_ID'), true);
    assert.equal(result.body.next_actions.some((action) => action.id === 'delivery_gateway'), true);
    assert.equal(JSON.stringify(result.body).includes('re_secret'), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Vercel env readiness accepts Upstash aliases as canonical Redis credentials', async () => {
  const gatewayKeys = [
    'DOWNSTREAM_CRM_API_KEY',
    'CRM_DELIVERY_MODE',
    'CRM_TEST_RECIPIENTS',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'UPSTASH_REDIS_KV_REST_API_URL',
    'UPSTASH_REDIS_KV_REST_API_TOKEN',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
    'SOLAPI_API_KEY',
    'SOLAPI_API_SECRET',
    'SOLAPI_KAKAO_PF_ID'
  ];
  const keys = [...new Set([...ENV_KEYS, ...gatewayKeys])];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const aliasPairs = [
    {
      UPSTASH_REDIS_KV_REST_API_URL: 'https://vercel-kv.example.test',
      UPSTASH_REDIS_KV_REST_API_TOKEN: 'vercel-kv-token-value'
    },
    {
      KV_REST_API_URL: 'https://kv.example.test',
      KV_REST_API_TOKEN: 'kv-token-value'
    }
  ];

  try {
    for (const key of keys) {
      delete process.env[key];
    }

    Object.assign(process.env, {
      NEXT_PUBLIC_GTM_ID: 'GTM-ABCDE12',
      NEXT_PUBLIC_CRM_WEBHOOK_URL: '/api/crm/events',
      NEXT_PUBLIC_APP_URL: 'https://auto-marketing-sigma.vercel.app',
      DOWNSTREAM_CRM_WEBHOOK_URL: 'https://auto-marketing-sigma.vercel.app/api/crm/downstream',
      NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-ABCDE12345',
      NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID: 'AW-123456789',
      NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL: 'purchaseLabel123',
      NEXT_PUBLIC_META_PIXEL_ID: '123456789',
      DOWNSTREAM_CRM_API_KEY: 'random-token-with-at-least-24-chars',
      CRM_DELIVERY_MODE: 'test',
      CRM_TEST_RECIPIENTS: 'buyer@example.test,01012345678',
      RESEND_API_KEY: 're_example_key',
      RESEND_FROM_EMAIL: 'Store <hello@example.test>',
      SOLAPI_API_KEY: 'solapi-key',
      SOLAPI_API_SECRET: 'solapi-secret-value',
      SOLAPI_KAKAO_PF_ID: 'PF_TEST'
    });

    for (const aliases of aliasPairs) {
      delete process.env.UPSTASH_REDIS_KV_REST_API_URL;
      delete process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
      Object.assign(process.env, aliases);

      const result = await invoke(envStatusHandler, 'GET');
      const redisChecks = result.body.checks.filter((check) => check.key.startsWith('UPSTASH_REDIS_REST_'));

      assert.equal(result.body.ready, true);
      assert.deepEqual(redisChecks.map((check) => check.key), [
        'UPSTASH_REDIS_REST_URL',
        'UPSTASH_REDIS_REST_TOKEN'
      ]);
      assert.equal(redisChecks.every((check) => check.status === 'ready' && check.has_value), true);
      assert.equal(JSON.stringify(result.body).includes(Object.values(aliases)[1]), false);
    }

    for (const partial of [
      {
        UPSTASH_REDIS_KV_REST_API_URL: 'https://mixed.example.test',
        KV_REST_API_TOKEN: 'mixed-token-value'
      },
      {
        UPSTASH_REDIS_REST_URL: 'https://partial.example.test'
      }
    ]) {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_KV_REST_API_URL;
      delete process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
      Object.assign(process.env, partial);

      const result = await invoke(envStatusHandler, 'GET');
      const redisChecks = result.body.checks.filter((check) => check.key.startsWith('UPSTASH_REDIS_REST_'));

      assert.equal(result.body.ready, false);
      assert.equal(redisChecks.every((check) => check.status === 'missing' && !check.has_value), true);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Vercel client config API exposes only browser-safe runtime values', async () => {
  const previous = Object.fromEntries(ENV_KEYS.concat([
    'NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY'
  ]).map((key) => [key, process.env[key]]));

  try {
    Object.assign(process.env, {
      NEXT_PUBLIC_GTM_ID: 'GTM-ABCDE12',
      NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-ABCDE12345',
      NEXT_PUBLIC_CRM_WEBHOOK_URL: '/api/crm/events',
      NEXT_PUBLIC_APP_URL: 'https://auto-marketing-sigma.vercel.app',
      NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY: 'KRW',
      DOWNSTREAM_CRM_WEBHOOK_URL: 'https://crm.example.test/webhook'
    });

    const result = await invokeRaw(clientConfigHandler, 'GET');
    const assignment = result.body.match(/window\.__MARKETING_AUTOMATION_CONFIG__ = (.*);\n$/);
    const config = JSON.parse(assignment[1]);

    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /application\/javascript/);
    assert.equal(config.gtmId, 'GTM-ABCDE12');
    assert.equal(config.ga4MeasurementId, 'G-ABCDE12345');
    assert.equal(config.crmWebhookUrl, '/api/crm/events');
    assert.equal(config.appUrl, 'https://auto-marketing-sigma.vercel.app');
    assert.equal(config.defaultCurrency, 'KRW');
    assert.equal(result.body.includes('crm.example.test'), false);
    assert.equal(result.body.includes('DOWNSTREAM_CRM_WEBHOOK_URL'), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('Vercel static surface exposes the demo and dashboard routes', async () => {
  const vercelConfig = JSON.parse(await readFile(path.join(kitRoot, 'vercel.json'), 'utf8'));
  const index = await readFile(path.join(kitRoot, 'index.html'), 'utf8');
  const demo = await readFile(path.join(kitRoot, 'examples', 'demo-store.html'), 'utf8');
  const dashboard = await readFile(path.join(kitRoot, 'dashboard.html'), 'utf8');
  const externalSetup = await readFile(path.join(kitRoot, 'external-setup.html'), 'utf8');
  const rewrites = new Map(vercelConfig.rewrites.map((rewrite) => [rewrite.source, rewrite.destination]));

  assert.equal(rewrites.get('/demo'), '/examples/demo-store.html');
  assert.equal(rewrites.get('/dashboard'), '/dashboard.html');
  assert.equal(rewrites.get('/external-setup'), '/external-setup.html');
  assert.match(index, /href="\/demo\?crm=\/api\/crm\/events&autorun=1"/);
  assert.match(index, /href="\/external-setup"/);
  assert.match(index, /id="probe" type="button"/);
  assert.match(index, /src="\/api\/marketing\/client-config\.js"/);
  assert.match(index, /src="\/src\/marketing-runtime\.js"/);
  assert.match(demo, /src="\/api\/marketing\/client-config\.js"/);
  assert.match(demo, /runtimeConfig\.gtmId/);
  assert.match(demo, /includeDemoContacts = crmWebhookUrl !== '\/api\/crm\/events'/);
  assert.match(demo, /function demoContactFields\(includePhone\)/);
  assert.match(dashboard, /Marketing Automation Dashboard/);
  assert.match(dashboard, /id="env-next-actions"/);
  assert.match(dashboard, /실행 전 확인 필요/);
  assert.match(dashboard, /src="\/src\/marketing-runtime\.js"/);
  assert.match(externalSetup, /External Account Setup/);
  assert.match(externalSetup, /oliveyoung-shopee-web을 실제 생성합니다/);
  assert.match(externalSetup, /src="\/src\/marketing-runtime\.js"/);
});

test('Vercel production verifier parses arguments and demo URL', () => {
  const parsed = parseArgs([
    '--base-url',
    'https://auto-marketing-sigma.vercel.app/',
    '--skip-browser',
    '--require-env-ready',
    '--timeout-ms',
    '1000',
    '--report',
    '/tmp/vercel-report.json'
  ]);

  assert.equal(parsed.baseUrl, 'https://auto-marketing-sigma.vercel.app');
  assert.equal(parsed.browser, false);
  assert.equal(parsed.requireEnvReady, true);
  assert.equal(parsed.timeoutMs, 1000);
  assert.equal(parsed.report, '/tmp/vercel-report.json');
  assert.equal(
    demoUrl(parsed.baseUrl),
    'https://auto-marketing-sigma.vercel.app/demo?crm=%2Fapi%2Fcrm%2Fevents&autorun=1'
  );
  assert.equal(titleOf('<html><title>Marketing Automation Kit</title></html>'), 'Marketing Automation Kit');
});

test('Vercel production verifier validates browser autorun QA DOM', () => {
  const qa = {
    ok: true,
    events: [
      'view_item',
      'add_to_cart',
      'begin_checkout',
      'purchase',
      'sign_up',
      'login',
      'generate_lead'
    ],
    crm_flows: [
      'welcome_coupon',
      'customer_activity_refresh',
      'cart_abandonment_candidate',
      'checkout_abandonment_candidate',
      'post_purchase_review_and_recommendation',
      'lead_followup'
    ],
    automation_action_flows: [
      'welcome_coupon',
      'customer_activity_refresh',
      'cart_abandonment_reminder',
      'cart_retargeting_audience',
      'checkout_abandonment_reminder',
      'checkout_retargeting_audience',
      'review_request',
      'repurchase_due',
      'purchase_exclusion',
      'lead_followup'
    ],
    delivery_statuses: [202, 202, 202, 202, 202, 202],
    pii_in_data_layer: false,
    duplicate_purchase: {
      skipped: true,
      reason: 'duplicate_transaction_id'
    }
  };
  const dom = `<div id="qa-result" data-ok="true">QA: ${JSON.stringify(qa).replace(/"/g, '&quot;')}</div>`;
  const summary = verifyQaResult(dom);

  assert.deepEqual(summary.delivery_statuses, [202, 202, 202, 202, 202, 202]);
  assert.equal(summary.duplicate_purchase, 'duplicate_transaction_id');
  assert.equal(summary.pii_in_data_layer, false);
});

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
  constructor(method, body = '') {
    super();
    this.method = method;
    this.headers = { 'content-type': 'application/json' };
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

async function invoke(handler, method, payload) {
  const request = new MockRequest(method, payload === undefined ? '' : JSON.stringify(payload));
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

test('Vercel CRM event API returns automation actions for production demo events', async () => {
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

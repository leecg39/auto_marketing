import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  buildResendPayload,
  buildSolapiPayload,
  deliveryReadiness,
  gatewayAuthorized,
  processDelivery,
  solapiAuthorization,
  testRecipientAllowed,
  validateGatewayPayload
} from '../server/delivery-gateway.mjs';

const require = createRequire(import.meta.url);
const downstreamHandler = require('../api/crm/downstream.js');

const NOW = new Date('2026-07-17T00:00:00.000Z');
const READY_ENV = {
  DOWNSTREAM_CRM_API_KEY: 'test-downstream-token-at-least-24-characters',
  CRM_DELIVERY_MODE: 'test',
  CRM_TEST_RECIPIENTS: 'buyer@example.test,01012345678',
  NEXT_PUBLIC_APP_URL: 'https://store.example.test',
  UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'redis-token',
  RESEND_API_KEY: 're_test_key',
  RESEND_FROM_EMAIL: 'Store <hello@example.test>',
  SOLAPI_API_KEY: 'solapi-key',
  SOLAPI_API_SECRET: 'solapi-secret',
  SOLAPI_KAKAO_PF_ID: 'PF_TEST',
  SOLAPI_KAKAO_TARGETING: 'I'
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function createDeliveryFetch() {
  const strings = new Map();
  const sets = new Map();
  const calls = [];
  let emailSequence = 0;

  async function fetchImpl(url, options = {}) {
    calls.push({ url, options });

    if (url === READY_ENV.UPSTASH_REDIS_REST_URL) {
      const [command, key, ...args] = JSON.parse(options.body);
      switch (command) {
        case 'SET': {
          const value = args[0];
          const nx = args.includes('NX');
          if (nx && strings.has(key)) {
            return jsonResponse(200, { result: null });
          }
          strings.set(key, value);
          return jsonResponse(200, { result: 'OK' });
        }
        case 'GET':
          return jsonResponse(200, { result: strings.get(key) ?? null });
        case 'DEL': {
          const removed = Number(strings.delete(key));
          return jsonResponse(200, { result: removed });
        }
        case 'SADD': {
          const set = sets.get(key) || new Set();
          set.add(args[0]);
          sets.set(key, set);
          return jsonResponse(200, { result: 1 });
        }
        case 'SMEMBERS':
          return jsonResponse(200, { result: [...(sets.get(key) || [])] });
        case 'SREM': {
          const removed = Number(sets.get(key)?.delete(args[0]) || false);
          return jsonResponse(200, { result: removed });
        }
        case 'EXPIRE':
          return jsonResponse(200, { result: 1 });
        default:
          throw new Error(`unexpected_redis_command:${command}`);
      }
    }

    if (url === 'https://api.resend.com/emails') {
      emailSequence += 1;
      return jsonResponse(200, { id: `email-${emailSequence}` });
    }
    if (/^https:\/\/api\.resend\.com\/emails\/email-\d+\/cancel$/.test(url)) {
      return jsonResponse(200, { id: url.split('/').at(-2), object: 'email' });
    }
    if (url === 'https://api.solapi.com/messages/v4/send-many/detail') {
      return jsonResponse(200, { groupInfo: { groupId: 'group-1' } });
    }

    throw new Error(`unexpected_url:${url}`);
  }

  return { fetchImpl, calls, strings, sets };
}

function cartPayload() {
  return {
    event_name: 'add_to_cart',
    occurred_at: NOW.toISOString(),
    user_id: 'USER-1',
    email: 'buyer@example.test',
    phone: '',
    cart_id: 'CART-1',
    product_id: 'SKU-1',
    marketing_consent: true,
    automation_actions: [{
      action_type: 'message',
      status: 'ready',
      flow: 'cart_abandonment_reminder',
      channels: ['email', 'kakao'],
      scheduled_at: '2026-07-17T01:00:00.000Z',
      cancel_on_event: 'purchase'
    }]
  };
}

class MockRequest extends Readable {
  constructor(method, body = '', headers = {}) {
    super();
    this.method = method;
    this.bodyText = body;
    this.headers = { 'content-type': 'application/json', ...headers };
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
}

async function invokeDownstream(method, payload, headers = {}) {
  const request = new MockRequest(method, payload === undefined ? '' : JSON.stringify(payload), headers);
  const response = new MockResponse();
  await downstreamHandler(request, response);
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
}

test('validates webhook auth and payload without accepting lookalike tokens', () => {
  assert.equal(gatewayAuthorized(`Bearer ${READY_ENV.DOWNSTREAM_CRM_API_KEY}`, READY_ENV.DOWNSTREAM_CRM_API_KEY), true);
  assert.equal(gatewayAuthorized('Bearer wrong-token', READY_ENV.DOWNSTREAM_CRM_API_KEY), false);
  assert.deepEqual(validateGatewayPayload({}), [
    'event_name_required',
    'occurred_at_required',
    'automation_actions_required'
  ]);
});

test('reports provider readiness without exposing credential values', () => {
  const readiness = deliveryReadiness(READY_ENV);
  const serialized = JSON.stringify(readiness);

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.providers, { email: true, kakao: true, scheduler: true });
  assert.equal(readiness.test_recipient_count, 2);
  assert.equal(serialized.includes(READY_ENV.RESEND_API_KEY), false);
  assert.equal(serialized.includes(READY_ENV.SOLAPI_API_SECRET), false);
});

test('creates deterministic SOLAPI HMAC authorization', () => {
  const date = '2026-07-17T00:00:00.000Z';
  const salt = 'fixed-salt';
  const expected = createHmac('sha256', 'secret').update(`${date}${salt}`).digest('hex');
  const authorization = solapiAuthorization('key', 'secret', { date, salt });

  assert.equal(authorization, `HMAC-SHA256 apiKey=key, date=${date}, salt=${salt}, signature=${expected}`);
});

test('builds provider-native scheduled email and Kakao payloads', () => {
  const action = cartPayload().automation_actions[0];
  const email = buildResendPayload(cartPayload(), action, READY_ENV, NOW);
  const kakao = buildSolapiPayload({ ...cartPayload(), phone: '82-10-1234-5678' }, action, READY_ENV, NOW);

  assert.equal(email.scheduled, true);
  assert.equal(email.request.scheduled_at, '2026-07-17T01:00:00.000Z');
  assert.deepEqual(email.request.to, ['buyer@example.test']);
  assert.equal(email.request.html.includes('buyer@example.test'), false);
  assert.equal(kakao.scheduled, true);
  assert.equal(kakao.request.messages[0].to, '01012345678');
  assert.equal(kakao.request.messages[0].kakaoOptions.bms.targeting, 'I');
});

test('test mode suppresses recipients outside the explicit allowlist', async () => {
  const payload = { ...cartPayload(), email: 'other@example.test' };
  let fetchCalled = false;
  const result = await processDelivery(payload, {
    env: READY_ENV,
    now: NOW,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('should_not_fetch');
    }
  });

  assert.equal(testRecipientAllowed(payload, 'email', READY_ENV), false);
  assert.equal(result.summary.suppressed, 1);
  assert.equal(result.summary.skipped, 1);
  assert.equal(fetchCalled, false);
});

test('schedules once and cancels the pending reminder on purchase', async () => {
  const mock = createDeliveryFetch();
  const first = await processDelivery(cartPayload(), { env: READY_ENV, fetchImpl: mock.fetchImpl, now: NOW });
  const duplicate = await processDelivery(cartPayload(), { env: READY_ENV, fetchImpl: mock.fetchImpl, now: NOW });
  const purchase = await processDelivery({
    event_name: 'purchase',
    occurred_at: '2026-07-17T00:10:00.000Z',
    user_id: 'USER-1',
    email: 'buyer@example.test',
    cart_id: 'CART-1',
    order_id: 'ORDER-1',
    marketing_consent: true,
    automation_actions: []
  }, { env: READY_ENV, fetchImpl: mock.fetchImpl, now: new Date('2026-07-17T00:10:00.000Z') });

  assert.equal(first.summary.scheduled, 1);
  assert.equal(first.summary.skipped, 1);
  assert.equal(duplicate.results.some((result) => result.reason === 'duplicate_delivery'), true);
  assert.equal(purchase.cancellation.cancelled, 1);
  assert.equal(mock.calls.some((call) => /email-1\/cancel$/.test(call.url)), true);
});

test('Vercel downstream route rejects unauthenticated delivery requests', async () => {
  const previous = process.env.DOWNSTREAM_CRM_API_KEY;
  process.env.DOWNSTREAM_CRM_API_KEY = READY_ENV.DOWNSTREAM_CRM_API_KEY;
  try {
    const result = await invokeDownstream('POST', cartPayload());
    assert.equal(result.status, 401);
    assert.deepEqual(result.body.errors, ['unauthorized']);
  } finally {
    if (previous === undefined) delete process.env.DOWNSTREAM_CRM_API_KEY;
    else process.env.DOWNSTREAM_CRM_API_KEY = previous;
  }
});

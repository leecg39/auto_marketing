import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const handler = require('../api/crm/events.js');
const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

async function invoke(method, payload) {
  const request = new MockRequest(method, payload === undefined ? '' : JSON.stringify(payload));
  const response = new MockResponse();

  await handler(request, response);

  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.json()
  };
}

test('Vercel CRM event API returns automation actions for production demo events', async () => {
  const result = await invoke('POST', {
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
  const result = await invoke('POST', {
    event_name: 'generate_lead',
    occurred_at: '2026-07-05T00:00:00.000Z',
    email: 'demo@example.test',
    marketing_consent: false
  });

  assert.equal(result.status, 422);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.errors.includes('marketing_consent_required_for_contact_payload'), true);
});

test('Vercel static surface exposes the demo and dashboard routes', async () => {
  const vercelConfig = JSON.parse(await readFile(path.join(kitRoot, 'vercel.json'), 'utf8'));
  const index = await readFile(path.join(kitRoot, 'index.html'), 'utf8');
  const rewrites = new Map(vercelConfig.rewrites.map((rewrite) => [rewrite.source, rewrite.destination]));

  assert.equal(rewrites.get('/demo'), '/examples/demo-store.html');
  assert.equal(rewrites.get('/dashboard'), '/dashboard.html');
  assert.match(index, /href="\/demo\?crm=\/api\/crm\/events&autorun=1"/);
  assert.match(index, /id="probe" type="button"/);
  assert.match(await readFile(path.join(kitRoot, 'dashboard.html'), 'utf8'), /Marketing Automation Dashboard/);
});

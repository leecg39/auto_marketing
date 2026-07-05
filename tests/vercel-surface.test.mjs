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

test('Vercel production verifier parses arguments and demo URL', () => {
  const parsed = parseArgs([
    '--base-url',
    'https://auto-marketing-sigma.vercel.app/',
    '--skip-browser',
    '--timeout-ms',
    '1000',
    '--report',
    '/tmp/vercel-report.json'
  ]);

  assert.equal(parsed.baseUrl, 'https://auto-marketing-sigma.vercel.app');
  assert.equal(parsed.browser, false);
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
    events: ['view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'generate_lead'],
    crm_flows: [
      'cart_abandonment_candidate',
      'checkout_abandonment_candidate',
      'post_purchase_review_and_recommendation',
      'lead_followup'
    ],
    automation_action_flows: [
      'cart_abandonment_reminder',
      'cart_retargeting_audience',
      'checkout_abandonment_reminder',
      'checkout_retargeting_audience',
      'review_request',
      'repurchase_due',
      'purchase_exclusion',
      'lead_followup'
    ],
    delivery_statuses: [202, 202, 202, 202],
    pii_in_data_layer: false,
    duplicate_purchase: {
      skipped: true,
      reason: 'duplicate_transaction_id'
    }
  };
  const dom = `<div id="qa-result" data-ok="true">QA: ${JSON.stringify(qa).replace(/"/g, '&quot;')}</div>`;
  const summary = verifyQaResult(dom);

  assert.deepEqual(summary.delivery_statuses, [202, 202, 202, 202]);
  assert.equal(summary.duplicate_purchase, 'duplicate_transaction_id');
  assert.equal(summary.pii_in_data_layer, false);
});

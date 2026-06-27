import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  joinUrl,
  normalizeBaseUrl,
  parseArgs,
  verifyPageDom,
  verifySiteRuntime
} from '../scripts/verify-site-runtime.mjs';

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk.toString();
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function withFixtureServer(callback) {
  const server = createServer(async (request, response) => {
    if (request.url === '/assets/marketing-automation.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end('window.MarketingAutomation = { init: function () {} };');
      return;
    }

    if (request.url === '/api/crm/events' && request.method === 'POST') {
      const payload = JSON.parse(await readRequestBody(request));

      if ((payload.email || payload.phone) && payload.marketing_consent !== true) {
        sendJson(response, 422, {
          ok: false,
          errors: ['marketing_consent_required_for_contact_payload']
        });
        return;
      }

      sendJson(response, 202, {
        ok: true,
        automation_flow: 'welcome_coupon',
        automation_actions: [
          {
            flow: 'welcome_coupon',
            status: 'ready'
          }
        ],
        delivery: {
          skipped: true,
          reason: 'test_fixture'
        }
      });
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end([
      '<html>',
      '<body>',
      '<script src="/assets/marketing-automation.js"></script>',
      '<p>마케팅 데이터 사용 동의</p>',
      '<button>거부</button>',
      '<button>동의</button>',
      '</body>',
      '</html>'
    ].join(''));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('normalizes runtime QA URLs and args', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3000/foo/?a=1'), 'http://127.0.0.1:3000/foo');
  assert.equal(joinUrl('http://127.0.0.1:3000/', 'signup'), 'http://127.0.0.1:3000/signup');
  assert.deepEqual(parseArgs(['--site-url', 'http://127.0.0.1:3000', '--path', '/', '--skip-browser']), {
    paths: ['/'],
    siteUrl: 'http://127.0.0.1:3000',
    skipBrowser: true
  });
});

test('detects marketing runtime UI in a rendered page DOM', () => {
  const checks = verifyPageDom([
    '<script src="/assets/marketing-automation.js"></script>',
    '<p>마케팅 데이터 사용 동의</p>',
    '<button>거부</button>',
    '<button>동의</button>'
  ].join(''));

  assert.equal(checks.sdk_script_present, true);
  assert.equal(checks.consent_banner_present, true);
  assert.equal(checks.accept_button_present, true);
  assert.equal(checks.reject_button_present, true);
});

test('verifies site runtime HTTP and CRM surfaces without browser QA', async () => {
  await withFixtureServer(async (baseUrl) => {
    const report = await verifySiteRuntime({
      siteUrl: baseUrl,
      skipBrowser: true
    });

    assert.equal(report.ok, true);
    assert.equal(report.asset.ok, true);
    assert.equal(report.crm.accepted.ok, true);
    assert.equal(report.crm.rejected_contact_without_consent.ok, true);
  });
});

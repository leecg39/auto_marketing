import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = process.env.VERCEL_PRODUCTION_URL || 'https://auto-marketing-sigma.vercel.app';
const DEFAULT_REPORT = path.join(KIT_ROOT, 'dist', 'vercel-production-report.json');
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);
const EXPECTED_EVENTS = [
  'view_item',
  'add_to_cart',
  'begin_checkout',
  'purchase',
  'sign_up',
  'login',
  'generate_lead'
];
const EXPECTED_CRM_FLOWS = [
  'welcome_coupon',
  'customer_activity_refresh',
  'cart_abandonment_candidate',
  'checkout_abandonment_candidate',
  'post_purchase_review_and_recommendation',
  'lead_followup'
];
const EXPECTED_ACTION_FLOWS = [
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
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function joinUrl(baseUrl, pathname) {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}`;
}

function demoUrl(baseUrl) {
  const url = new URL(joinUrl(baseUrl, '/demo'));
  url.searchParams.set('crm', '/api/crm/events');
  url.searchParams.set('autorun', '1');
  return url.toString();
}

function parseArgs(args) {
  const parsed = {
    baseUrl: DEFAULT_BASE_URL,
    report: DEFAULT_REPORT,
    browser: true,
    timeoutMs: 22000,
    requireEnvReady: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith('--')) {
      parsed.baseUrl = arg;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : args[index + 1];

    if (key === 'help') {
      parsed.help = true;
      continue;
    }
    if (key === 'skip-browser') {
      parsed.browser = false;
      continue;
    }
    if (key === 'require-env-ready') {
      parsed.requireEnvReady = true;
      continue;
    }

    if (equalsIndex < 0) {
      index += 1;
    }

    if (key === 'base-url') {
      parsed.baseUrl = value;
    }
    if (key === 'report') {
      parsed.report = path.resolve(value);
    }
    if (key === 'chrome-bin') {
      parsed.chromeBin = value;
    }
    if (key === 'timeout-ms') {
      parsed.timeoutMs = Number(value);
    }
  }

  parsed.baseUrl = normalizeBaseUrl(parsed.baseUrl);

  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }

  return parsed;
}

async function fileExists(file) {
  try {
    const { access } = await import('node:fs/promises');
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChrome(explicitChrome) {
  const candidates = explicitChrome ? [explicitChrome] : CHROME_CANDIDATES;

  for (const candidate of candidates) {
    if (candidate && await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error('Chrome executable not found. Set CHROME_BIN or pass --chrome-bin.');
}

async function fetchBody(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { response, text, json };
}

function titleOf(html) {
  const match = String(html || '').match(/<title[^>]*>(.*?)<\/title>/is);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractQaResult(dom) {
  const match = String(dom || '').match(/<div id="qa-result"[^>]*data-ok="([^"]*)"[^>]*>([\s\S]*?)<\/div>/);
  if (!match) {
    throw new Error('QA result element not found in browser DOM');
  }

  const dataOk = match[1];
  const rawText = decodeHtml(match[2]).replace(/^QA:\s*/, '').trim();
  return {
    dataOk,
    result: JSON.parse(rawText)
  };
}

function verifyQaResult(dom) {
  const { dataOk, result } = extractQaResult(dom);

  assert(dataOk === 'true', `QA data-ok is ${dataOk}`);
  assert(result.ok === true, `QA result is not ok: ${JSON.stringify(result)}`);

  for (const eventName of EXPECTED_EVENTS) {
    assert(result.events.includes(eventName), `Missing browser dataLayer event: ${eventName}`);
  }
  for (const flow of EXPECTED_CRM_FLOWS) {
    assert(result.crm_flows.includes(flow), `Missing browser CRM flow: ${flow}`);
  }
  for (const flow of EXPECTED_ACTION_FLOWS) {
    assert(result.automation_action_flows.includes(flow), `Missing browser automation action flow: ${flow}`);
  }

  assert(result.pii_in_data_layer === false, 'PII was found in browser dataLayer output');
  assert(result.duplicate_purchase?.skipped === true, 'Duplicate purchase was not skipped');
  assert(result.duplicate_purchase.reason === 'duplicate_transaction_id', 'Duplicate purchase skip reason mismatch');
  assert(
    result.delivery_statuses.every((status) => status === 202),
    `Delivery status mismatch: ${JSON.stringify(result.delivery_statuses)}`
  );

  return {
    events: result.events,
    crm_flows: result.crm_flows,
    automation_action_flows: result.automation_action_flows,
    delivery_statuses: result.delivery_statuses,
    duplicate_purchase: result.duplicate_purchase.reason,
    pii_in_data_layer: result.pii_in_data_layer
  };
}

async function runChromeDom(chrome, url, timeoutMs) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'ma-vercel-production-'));

  try {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-component-update',
      `--user-data-dir=${profileDir}`,
      '--virtual-time-budget=12000',
      '--dump-dom',
      url
    ];
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    if (!stdout.includes('id="qa-result"')) {
      throw new Error(`Chrome did not return the QA DOM. exit=${JSON.stringify(exit)} stderr=${stderr.slice(0, 1000)}`);
    }

    return {
      dom: stdout,
      timed_out: timedOut,
      stderr_lines: stderr.split(/\r?\n/).filter(Boolean).length
    };
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

function checkPassed(id, details = {}) {
  return {
    id,
    status: 'passed',
    ok: true,
    ...details
  };
}

function checkFailed(id, error) {
  return {
    id,
    status: 'failed',
    ok: false,
    error: error.message
  };
}

async function runCheck(id, fn) {
  try {
    return checkPassed(id, await fn());
  } catch (error) {
    return checkFailed(id, error);
  }
}

async function verifyVercelProduction(options) {
  const checks = [];

  checks.push(await runCheck('root_page', async () => {
    const url = joinUrl(options.baseUrl, '/');
    const { response, text } = await fetchBody(url);

    assert(response.status === 200, `Root returned ${response.status}`);
    assert(titleOf(text) === 'Marketing Automation Kit', `Root title mismatch: ${titleOf(text)}`);
    assert(text.includes('/api/crm/events'), 'Root page does not link to CRM event API');

    return { url, http_status: response.status, title: titleOf(text) };
  }));

  checks.push(await runCheck('dashboard_page', async () => {
    const url = joinUrl(options.baseUrl, '/dashboard');
    const { response, text } = await fetchBody(url);

    assert(response.status === 200, `Dashboard returned ${response.status}`);
    assert(titleOf(text) === 'Marketing Automation Dashboard', `Dashboard title mismatch: ${titleOf(text)}`);

    return { url, http_status: response.status, title: titleOf(text) };
  }));

  checks.push(await runCheck('external_setup_page', async () => {
    const url = joinUrl(options.baseUrl, '/external-setup');
    const { response, text } = await fetchBody(url);

    assert(response.status === 200, `External setup returned ${response.status}`);
    assert(titleOf(text) === 'External Account Setup', `External setup title mismatch: ${titleOf(text)}`);
    assert(text.includes('oliveyoung-shopee-web을 실제 생성합니다'), 'External setup page is missing GTM action-time prompt');
    assert(text.includes('실행 전 확인 필요'), 'External setup page is missing confirmation gate label');

    return { url, http_status: response.status, title: titleOf(text) };
  }));

  checks.push(await runCheck('api_health', async () => {
    const url = joinUrl(options.baseUrl, '/api/crm/events');
    const { response, json } = await fetchBody(url);

    assert(response.status === 200, `API health returned ${response.status}`);
    assert(json?.ok === true, 'API health body is not ok');
    assert(json?.service === 'marketing-automation-crm-events', 'API service name mismatch');

    return { url, http_status: response.status, service: json.service };
  }));

  checks.push(await runCheck('env_readiness', async () => {
    const url = joinUrl(options.baseUrl, '/api/marketing/env-status');
    const { response, json } = await fetchBody(url);

    assert(response.status === 200, `Env readiness returned ${response.status}`);
    assert(json?.ok === true, 'Env readiness body is not ok');
    assert(Array.isArray(json.checks), 'Env readiness checks are missing');
    assert(json.summary && typeof json.summary.ready === 'boolean', 'Env readiness summary is missing');
    assert(Array.isArray(json.next_actions), 'Env readiness next_actions are missing');

    if (options.requireEnvReady) {
      assert(json.ready === true, `Env readiness failed: ${JSON.stringify(json.summary)}`);
    }

    return {
      url,
      http_status: response.status,
      ready: json.ready,
      summary: json.summary,
      next_actions: json.next_actions.map((action) => action.id)
    };
  }));

  checks.push(await runCheck('api_purchase_flow', async () => {
    const url = joinUrl(options.baseUrl, '/api/crm/events');
    const { response, json } = await fetchBody(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_name: 'purchase',
        occurred_at: '2026-07-05T05:10:00.000Z',
        transaction_id: `ORDER_PROD_VERIFY_${Date.now()}`,
        marketing_consent: false,
        value: 129000,
        metadata: { order_count: 1 }
      })
    });

    assert(response.status === 202, `Purchase API returned ${response.status}`);
    assert(json?.ok === true, 'Purchase API body is not ok');
    assert(json.automation_flow === 'post_purchase_review_and_recommendation', 'Purchase automation flow mismatch');

    const actionFlows = json.automation_actions.map((action) => action.flow);
    for (const flow of ['first_purchase_thank_you', 'review_request', 'repurchase_due', 'purchase_exclusion']) {
      assert(actionFlows.includes(flow), `Missing purchase action flow: ${flow}`);
    }
    assert(json.delivery?.status === 202, 'Purchase delivery status mismatch');

    return {
      url,
      http_status: response.status,
      automation_flow: json.automation_flow,
      action_flows: actionFlows,
      delivery: json.delivery
    };
  }));

  checks.push(await runCheck('api_consent_gate', async () => {
    const url = joinUrl(options.baseUrl, '/api/crm/events');
    const { response, json } = await fetchBody(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_name: 'generate_lead',
        occurred_at: '2026-07-05T05:10:00.000Z',
        email: 'demo@example.test',
        marketing_consent: false
      })
    });

    assert(response.status === 422, `Consent gate returned ${response.status}`);
    assert(json?.errors?.includes('marketing_consent_required_for_contact_payload'), 'Consent gate error mismatch');

    return { url, http_status: response.status, errors: json.errors };
  }));

  checks.push(await runCheck('api_lifecycle_flows', async () => {
    const url = joinUrl(options.baseUrl, '/api/crm/events');
    const expected = {
      dormant_60_days: ['dormant_reactivation_60', 'dormant_retargeting_audience'],
      dormant_90_days: ['dormant_reactivation_90', 'dormant_retargeting_audience'],
      vip_qualified: ['vip_benefit']
    };
    const results = [];

    for (const [eventName, expectedActions] of Object.entries(expected)) {
      const { response, json } = await fetchBody(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_name: eventName,
          occurred_at: '2026-07-05T05:10:00.000Z',
          user_id: `QA_${eventName.toUpperCase()}`,
          marketing_consent: false,
          metadata: { test_mode: true }
        })
      });

      assert(response.status === 202, `${eventName} API returned ${response.status}`);
      assert(json?.ok === true, `${eventName} API body is not ok`);
      const actionFlows = json.automation_actions.map((action) => action.flow);
      assert(
        expectedActions.every((flow) => actionFlows.includes(flow)),
        `${eventName} lifecycle action flows mismatch`
      );
      assert(
        json.automation_actions.filter((action) => action.action_type === 'message')
          .every((action) => action.status === 'suppressed'),
        `${eventName} test message was not suppressed`
      );

      results.push({
        event_name: eventName,
        automation_flow: json.automation_flow,
        action_flows: actionFlows
      });
    }

    return { url, events: results };
  }));

  if (options.browser) {
    checks.push(await runCheck('demo_browser_autorun', async () => {
      const url = demoUrl(options.baseUrl);
      const chrome = await findChrome(options.chromeBin);
      const run = await runChromeDom(chrome, url, options.timeoutMs);
      const summary = verifyQaResult(run.dom);

      return {
        url,
        chrome,
        chrome_timed_out_after_dom: run.timed_out,
        chrome_stderr_lines: run.stderr_lines,
        ...summary
      };
    }));
  }

  const failed = checks.filter((check) => !check.ok);

  return {
    ok: failed.length === 0,
    generated_at: new Date().toISOString(),
    base_url: options.baseUrl,
    browser: options.browser,
    require_env_ready: options.requireEnvReady,
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length
    },
    checks
  };
}

function usage() {
  return [
    'Usage:',
    '  npm run verify:vercel -- --base-url https://your-project.vercel.app',
    '',
    'Options:',
    '  --base-url URL      Production deployment URL. Default: VERCEL_PRODUCTION_URL or auto-marketing-sigma.vercel.app',
    '  --skip-browser      Verify HTTP/API checks only.',
    '  --require-env-ready Fail when production GTM/GA4/ads/CRM env values are not ready.',
    '  --chrome-bin PATH   Chrome executable for browser autorun QA.',
    '  --timeout-ms N      Browser timeout in ms. Default: 22000',
    '  --report FILE       JSON report output. Default: dist/vercel-production-report.json'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }

  const report = await verifyVercelProduction(options);
  await mkdir(path.dirname(options.report), { recursive: true });
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  demoUrl,
  extractQaResult,
  parseArgs,
  titleOf,
  verifyQaResult,
  verifyVercelProduction
};

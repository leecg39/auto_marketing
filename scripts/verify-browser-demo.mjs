import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEMO_URLS = process.env.DEMO_URL
  ? [process.env.DEMO_URL]
  : [
      'http://127.0.0.1:8081/examples/demo-store.html',
      'http://127.0.0.1:8081/marketing-automation-kit/examples/demo-store.html'
    ];
const CRM_URL = process.env.CRM_URL || 'http://127.0.0.1:8791';
const DOWNSTREAM_URL = process.env.DOWNSTREAM_URL || 'http://127.0.0.1:8792';
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

const EXPECTED_EVENTS = ['view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'generate_lead'];
const EXPECTED_CRM_FLOWS = [
  'cart_abandonment_candidate',
  'checkout_abandonment_candidate',
  'post_purchase_review_and_recommendation',
  'lead_followup'
];
const EXPECTED_ACTION_FLOWS = [
  'cart_abandonment_reminder',
  'cart_retargeting_audience',
  'checkout_abandonment_reminder',
  'checkout_retargeting_audience',
  'review_request',
  'repurchase_due',
  'purchase_exclusion',
  'lead_followup'
];
const EXPECTED_UTM = {
  utm_source: 'browser_qa',
  utm_medium: 'automated',
  utm_campaign: 'marketing_automation'
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { response, body };
}

async function resetDownstream() {
  const { response, body } = await fetchJson(`${DOWNSTREAM_URL}/reset`, { method: 'POST' });
  assert(response.ok, `Downstream reset returned ${response.status}`);
  assert(body && body.ok === true, 'Downstream reset body is not ok');
}

async function verifyDownstreamAttribution(expectedCount) {
  const { response, body } = await fetchJson(`${DOWNSTREAM_URL}/events`);

  assert(response.ok, `Downstream events returned ${response.status}`);
  assert(body && body.ok === true, 'Downstream events body is not ok');
  assert(Array.isArray(body.events), 'Downstream events payload is not an array');
  assert(body.events.length === expectedCount, `Downstream received ${body.events.length}, expected ${expectedCount}`);

  const payloads = body.events.map((event) => event.payload);
  payloads.forEach((payload) => {
    assert(payload.utm_source === EXPECTED_UTM.utm_source, `${payload.event_name} utm_source mismatch`);
    assert(payload.utm_medium === EXPECTED_UTM.utm_medium, `${payload.event_name} utm_medium mismatch`);
    assert(payload.utm_campaign === EXPECTED_UTM.utm_campaign, `${payload.event_name} utm_campaign mismatch`);
  });

  return {
    received_count: payloads.length,
    utm_source: EXPECTED_UTM.utm_source,
    event_names: payloads.map((payload) => payload.event_name)
  };
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error('Chrome executable not found. Set CHROME_BIN to run browser QA.');
}

function withQaParams(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set('autorun', '1');
  url.searchParams.set('crm', `${CRM_URL}/crm/events`);
  url.searchParams.set('utm_source', 'browser_qa');
  url.searchParams.set('utm_medium', 'automated');
  url.searchParams.set('utm_campaign', 'marketing_automation');
  return url.toString();
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
  const match = dom.match(/<div id="qa-result"[^>]*data-ok="([^"]*)"[^>]*>([\s\S]*?)<\/div>/);
  if (!match) {
    throw new Error('QA result element not found in browser DOM');
  }

  const dataOk = match[1];
  const rawText = decodeHtml(match[2]).replace(/^QA:\s*/, '').trim();
  const result = JSON.parse(rawText);

  return { dataOk, result };
}

function verifyQaResult(url, dom) {
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
  assert(result.duplicate_purchase && result.duplicate_purchase.skipped === true, 'Duplicate purchase was not skipped');
  assert(result.duplicate_purchase.reason === 'duplicate_transaction_id', 'Duplicate purchase skip reason mismatch');
  assert(
    result.delivery_statuses.every((status) => status === 202),
    `Downstream delivery status mismatch: ${JSON.stringify(result.delivery_statuses)}`
  );

  return {
    url,
    events: result.events,
    crm_flows: result.crm_flows,
    automation_action_flows: result.automation_action_flows,
    delivery_statuses: result.delivery_statuses,
    duplicate_purchase: result.duplicate_purchase.reason,
    pii_in_data_layer: result.pii_in_data_layer
  };
}

async function runChrome(chrome, url) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'ma-browser-qa-'));

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
      }, 22000);

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

async function verifyBrowserDemo() {
  const chrome = await findChrome();
  const attempts = [];

  for (const demoUrl of DEMO_URLS) {
    const url = withQaParams(demoUrl);

    try {
      await resetDownstream();
      const run = await runChrome(chrome, url);
      const summary = verifyQaResult(url, run.dom);
      const downstreamAttribution = await verifyDownstreamAttribution(EXPECTED_CRM_FLOWS.length);
      return {
        ok: true,
        chrome,
        summary: {
          ...summary,
          downstream_attribution: downstreamAttribution,
          chrome_timed_out_after_dom: run.timed_out,
          chrome_stderr_lines: run.stderr_lines
        }
      };
    } catch (error) {
      attempts.push({ url, error: error.message });
    }
  }

  throw new Error(`Browser demo QA failed: ${JSON.stringify(attempts, null, 2)}`);
}

const result = await verifyBrowserDemo();
console.log(JSON.stringify(result, null, 2));

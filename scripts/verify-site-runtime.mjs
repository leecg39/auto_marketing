import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATHS = ['/', '/signup', '/margin-calculator'];
const DEFAULT_EVENT_PROBE_PATH = '/';
const EXPECTED_EVENT_PROBE_EVENTS = [
  'view_item',
  'add_to_cart',
  'begin_checkout',
  'purchase',
  'sign_up',
  'login',
  'generate_lead'
];
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function runChromeDump(chrome, url) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'ma-site-qa-'));

  try {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-component-update',
      `--user-data-dir=${profileDir}`,
      '--virtual-time-budget=8000',
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
      }, 18000);

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    if (!stdout.includes('<html')) {
      throw new Error(`Chrome did not return HTML. exit=${JSON.stringify(exit)} stderr=${stderr.slice(0, 1000)}`);
    }

    return {
      dom: decodeHtml(stdout),
      timed_out: timedOut,
      stderr_lines: stderr.split(/\r?\n/).filter(Boolean).length
    };
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));

  if (!port) {
    throw new Error('Unable to allocate a Chrome debugging port');
  }

  return port;
}

async function waitForChromeVersion(port, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = '';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const json = await response.json();
        if (json.webSocketDebuggerUrl) {
          return json;
        }
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }

    await delay(150);
  }

  throw new Error(`Chrome debugging endpoint did not start: ${lastError || 'timeout'}`);
}

async function waitForPageTarget(port, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = '';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) {
          return page;
        }
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }

    await delay(150);
  }

  throw new Error(`Chrome page target did not start: ${lastError || 'timeout'}`);
}

function connectCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;

    function cleanup(error) {
      for (const { reject: rejectPending } of pending.values()) {
        rejectPending(error);
      }
      pending.clear();
    }

    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          if (socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('CDP socket is not open'));
          }

          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));

          return new Promise((resolveCommand, rejectCommand) => {
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          });
        },
        close() {
          socket.close();
        }
      });
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !pending.has(message.id)) {
        return;
      }

      const command = pending.get(message.id);
      pending.delete(message.id);

      if (message.error) {
        command.reject(new Error(`${message.error.message || 'CDP command failed'} (${message.error.code})`));
        return;
      }

      command.resolve(message.result || {});
    });

    socket.addEventListener('error', () => {
      const error = new Error('CDP socket error');
      cleanup(error);
      reject(error);
    });

    socket.addEventListener('close', () => {
      cleanup(new Error('CDP socket closed'));
    });
  });
}

async function waitForReadyState(cdp, timeoutMs = 12000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true
    });
    if (result.result?.value === 'complete') {
      await delay(500);
      return;
    }
    await delay(150);
  }

  throw new Error('Page did not reach document.readyState=complete');
}

function eventProbeExpression() {
  return `(${async function runMarketingAutomationProbe() {
    function wait(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitForSdk(timeoutMs) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (window.MarketingAutomation) {
          return window.MarketingAutomation;
        }
        await wait(100);
      }
      throw new Error('MarketingAutomation SDK did not load');
    }

    const api = await waitForSdk(8000);
    window.dataLayer = window.dataLayer || [];
    window.localStorage.removeItem('ma_purchase_ids_v1');
    api.init({
      crmWebhookUrl: '/api/crm/events',
      defaultCurrency: 'KRW',
      autoSendCrm: true,
      consent: {
        analytics: true,
        ads: true,
        marketing: true,
        crm: false
      }
    });
    api.setConsent({
      analytics: true,
      ads: true,
      marketing: true,
      crm: false
    });

    const beforeLength = window.dataLayer.length;
    const item = {
      item_id: 'SITE_PROBE_SKU',
      item_name: 'Site probe product',
      item_category: 'Runtime QA',
      price: 129000,
      quantity: 1
    };
    const ecommerce = {
      currency: 'KRW',
      value: 129000,
      items: [item],
      email: 'site-probe@example.com',
      phone: '010-0000-0000',
      marketing_consent: true
    };
    const calls = [];

    function call(name, callback) {
      try {
        const result = callback();
        calls.push({ name, ok: true, result });
        return result;
      } catch (error) {
        calls.push({ name, ok: false, error: error.message });
        return null;
      }
    }

    call('view_item', () => api.trackViewItem(ecommerce));
    call('add_to_cart', () => api.trackAddToCart({ ...ecommerce, cart_id: 'SITE_PROBE_CART' }));
    call('begin_checkout', () => api.trackBeginCheckout({ ...ecommerce, cart_id: 'SITE_PROBE_CART' }));
    call('purchase', () => api.trackPurchase({
      ...ecommerce,
      transaction_id: 'SITE_PROBE_ORDER',
      order_id: 'SITE_PROBE_ORDER'
    }));
    const duplicate = call('purchase_duplicate', () => api.trackPurchase({
      ...ecommerce,
      transaction_id: 'SITE_PROBE_ORDER',
      order_id: 'SITE_PROBE_ORDER'
    }));
    call('sign_up', () => api.trackSignUp({
      method: 'site_probe',
      email: 'site-probe@example.com',
      marketing_consent: true
    }));
    call('login', () => api.trackLogin({ method: 'site_probe' }));
    call('generate_lead', () => api.trackGenerateLead({
      currency: 'KRW',
      value: 129000,
      email: 'site-probe@example.com',
      phone: '010-0000-0000',
      marketing_consent: true
    }));

    await wait(500);

    const dataLayerEvents = window.dataLayer
      .slice(beforeLength)
      .filter((entry) => entry && entry.event)
      .map((entry) => JSON.parse(JSON.stringify(entry)));
    const serialized = JSON.stringify(dataLayerEvents);

    return {
      ok: true,
      href: window.location.href,
      events: dataLayerEvents.map((entry) => entry.event),
      dataLayerEvents,
      calls,
      duplicate_purchase: duplicate,
      pii_in_data_layer: /site-probe@example\\.com|010-0000-0000/.test(serialized),
      crm_consent: api.getConsent().crm
    };
  }.toString()})()`;
}

function verifyEventProbeResult(result) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const missingEvents = EXPECTED_EVENT_PROBE_EVENTS.filter((eventName) => !events.includes(eventName));
  const failedCalls = Array.isArray(result?.calls)
    ? result.calls.filter((call) => call.ok !== true).map((call) => ({
        name: call.name,
        error: call.error || 'unknown_error'
      }))
    : [{ name: 'event_probe', error: 'missing_calls' }];
  const duplicatePurchaseOk = result?.duplicate_purchase?.skipped === true
    && result?.duplicate_purchase?.reason === 'duplicate_transaction_id';
  const ok = Boolean(result?.ok)
    && missingEvents.length === 0
    && failedCalls.length === 0
    && duplicatePurchaseOk
    && result.pii_in_data_layer === false
    && result.crm_consent === false;

  return {
    ok,
    href: result?.href || '',
    events,
    missing_events: missingEvents,
    failed_calls: failedCalls,
    duplicate_purchase_ok: duplicatePurchaseOk,
    pii_in_data_layer: Boolean(result?.pii_in_data_layer),
    crm_consent: result?.crm_consent,
    data_layer_event_count: Array.isArray(result?.dataLayerEvents) ? result.dataLayerEvents.length : 0
  };
}

async function runEventProbe(chrome, siteUrl, options = {}) {
  const port = await findAvailablePort();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'ma-site-probe-'));
  const targetUrl = joinUrl(siteUrl, options.path || DEFAULT_EVENT_PROBE_PATH);
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-background-networking',
    '--disable-component-update',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let cdp = null;

  try {
    await waitForChromeVersion(port);
    const target = await waitForPageTarget(port);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: targetUrl });
    await waitForReadyState(cdp);
    const evaluation = await cdp.send('Runtime.evaluate', {
      expression: eventProbeExpression(),
      awaitPromise: true,
      returnByValue: true,
      timeout: 15000
    });

    if (evaluation.exceptionDetails) {
      throw new Error(evaluation.exceptionDetails.text || 'Event probe evaluation failed');
    }

    return verifyEventProbeResult(evaluation.result?.value);
  } finally {
    if (cdp) {
      cdp.close();
    }
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await rm(profileDir, { recursive: true, force: true });
  }
}

function verifyPageDom(dom) {
  return {
    sdk_script_present: dom.includes('/assets/marketing-automation.js') || dom.includes('marketing-automation.js'),
    consent_banner_present: dom.includes('마케팅 데이터 사용 동의'),
    accept_button_present: dom.includes('동의'),
    reject_button_present: dom.includes('거부')
  };
}

async function verifyAsset(siteUrl) {
  const assetUrl = joinUrl(siteUrl, '/assets/marketing-automation.js');
  const { response, text } = await fetchBody(assetUrl);

  return {
    url: assetUrl,
    status: response.status,
    ok: response.ok && text.includes('MarketingAutomation'),
    contains_sdk_global: text.includes('MarketingAutomation')
  };
}

async function verifyCrm(siteUrl, crmPath = '/api/crm/events') {
  const url = joinUrl(siteUrl, crmPath);
  const occurredAt = new Date('2026-06-27T00:00:00.000Z').toISOString();
  const accepted = await fetchBody(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: 'runtime-qa-user',
      email: 'runtime-qa@example.com',
      marketing_consent: true,
      event_name: 'sign_up',
      occurred_at: occurredAt,
      utm_source: 'runtime_qa',
      utm_medium: 'automated',
      utm_campaign: 'site_runtime'
    })
  });
  const rejected = await fetchBody(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: 'runtime-qa-user',
      email: 'runtime-qa@example.com',
      marketing_consent: false,
      event_name: 'sign_up',
      occurred_at: occurredAt
    })
  });

  const acceptedActions = Array.isArray(accepted.json?.automation_actions)
    ? accepted.json.automation_actions
    : [];
  const rejectedErrors = Array.isArray(rejected.json?.errors) ? rejected.json.errors : [];

  return {
    url,
    accepted: {
      status: accepted.response.status,
      ok: accepted.response.status === 202
        && accepted.json?.ok === true
        && accepted.json?.automation_flow === 'welcome_coupon'
        && acceptedActions.some((action) => action.flow === 'welcome_coupon' && action.status === 'ready')
    },
    rejected_contact_without_consent: {
      status: rejected.response.status,
      ok: rejected.response.status === 422
        && rejectedErrors.includes('marketing_consent_required_for_contact_payload')
    }
  };
}

async function verifyPages(siteUrl, paths, options = {}) {
  const chrome = await findChrome(options.chromeBin);
  const pages = [];

  for (const pathname of paths) {
    const url = joinUrl(siteUrl, pathname);
    const run = await runChromeDump(chrome, url);
    const checks = verifyPageDom(run.dom);
    pages.push({
      path: pathname,
      url,
      ok: Object.values(checks).every(Boolean),
      checks,
      chrome_timed_out_after_dom: run.timed_out,
      chrome_stderr_lines: run.stderr_lines
    });
  }

  return { chrome, pages };
}

async function verifySiteRuntime(options) {
  const siteUrl = normalizeBaseUrl(options.siteUrl);
  const paths = options.paths?.length ? options.paths : DEFAULT_PATHS;
  const chrome = options.skipBrowser && !options.eventProbe ? null : await findChrome(options.chromeBin);
  const [asset, crm, browser] = await Promise.all([
    verifyAsset(siteUrl),
    verifyCrm(siteUrl, options.crmPath),
    options.skipBrowser
      ? Promise.resolve({ chrome: null, pages: [] })
      : verifyPages(siteUrl, paths, { chromeBin: chrome })
  ]);
  const eventProbe = options.eventProbe
    ? await runEventProbe(chrome, siteUrl, { path: options.eventProbePath })
    : { enabled: false };
  const pagesOk = options.skipBrowser ? true : browser.pages.every((page) => page.ok);
  const eventProbeOk = options.eventProbe ? eventProbe.ok : true;
  const ok = asset.ok && crm.accepted.ok && crm.rejected_contact_without_consent.ok && pagesOk && eventProbeOk;

  return {
    ok,
    site_url: siteUrl,
    asset,
    crm,
    browser,
    event_probe: eventProbe,
    next_step: ok
      ? '실제 사이트 런타임에서 SDK, consent UI, CRM 이벤트 API가 확인됐습니다.'
      : '실패한 항목을 수정한 뒤 사이트를 다시 띄우고 verify:site를 재실행하세요.'
  };
}

function parseArgs(args) {
  const parsed = {
    paths: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith('--')) {
      parsed.siteUrl = parsed.siteUrl || arg;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : args[index + 1];

    if (key === 'path') {
      parsed.paths.push(value);
      if (equalsIndex < 0) {
        index += 1;
      }
      continue;
    }

    if (key === 'skip-browser') {
      parsed.skipBrowser = true;
      continue;
    }
    if (key === 'event-probe') {
      parsed.eventProbe = true;
      continue;
    }

    if (key === 'help') {
      parsed.help = true;
      continue;
    }

    if (equalsIndex < 0) {
      index += 1;
    }

    if (key === 'site-url') {
      parsed.siteUrl = value;
    }
    if (key === 'crm-path') {
      parsed.crmPath = value;
    }
    if (key === 'chrome-bin') {
      parsed.chromeBin = value;
    }
    if (key === 'event-probe-path') {
      parsed.eventProbePath = value;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  npm run verify:site -- --site-url http://127.0.0.1:3000',
    '',
    'Options:',
    '  --path /custom-page        Add a page to browser DOM QA. Can be repeated.',
    '  --crm-path /api/crm/events Override CRM endpoint path.',
    '  --skip-browser            Run HTTP and CRM checks only.',
    '  --event-probe             Execute the SDK event probe in headless Chrome.',
    '  --event-probe-path /path  Page path for the SDK event probe. Default: /.'
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.siteUrl) {
    console.error(usage());
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const report = await verifySiteRuntime(args);
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  DEFAULT_PATHS,
  EXPECTED_EVENT_PROBE_EVENTS,
  joinUrl,
  normalizeBaseUrl,
  parseArgs,
  verifyEventProbeResult,
  verifyPageDom,
  verifySiteRuntime
};

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATHS = ['/', '/signup', '/margin-calculator'];
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
  const [asset, crm, browser] = await Promise.all([
    verifyAsset(siteUrl),
    verifyCrm(siteUrl, options.crmPath),
    options.skipBrowser
      ? Promise.resolve({ chrome: null, pages: [] })
      : verifyPages(siteUrl, paths, { chromeBin: options.chromeBin })
  ]);
  const pagesOk = options.skipBrowser ? true : browser.pages.every((page) => page.ok);
  const ok = asset.ok && crm.accepted.ok && crm.rejected_contact_without_consent.ok && pagesOk;

  return {
    ok,
    site_url: siteUrl,
    asset,
    crm,
    browser,
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
    '  --skip-browser            Run HTTP and CRM checks only.'
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
  joinUrl,
  normalizeBaseUrl,
  parseArgs,
  verifyPageDom,
  verifySiteRuntime
};

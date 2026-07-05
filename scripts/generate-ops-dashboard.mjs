import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDeploymentEnv } from './validate-deployment-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FULL_QA_REPORT = path.join(KIT_ROOT, 'dist', 'full-qa-report.json');
const DEFAULT_COMPLETION_AUDIT = path.join(KIT_ROOT, 'dist', 'completion-audit.json');
const DEFAULT_HANDOFF_REPORT = path.join(KIT_ROOT, 'dist', 'deployment-handoff.json');
const DEFAULT_HTML_OUTPUT = path.join(KIT_ROOT, 'dist', 'growth-ops-dashboard.html');
const DEFAULT_JSON_OUTPUT = path.join(KIT_ROOT, 'dist', 'growth-ops-dashboard.json');

const ACTION_BY_KEY = {
  NEXT_PUBLIC_GTM_ID: {
    title: 'GTM 웹 컨테이너 생성',
    detail: 'GTM에서 웹 컨테이너를 만든 뒤 GTM-... ID를 사이트 env에 넣습니다.'
  },
  NEXT_PUBLIC_GA4_MEASUREMENT_ID: {
    title: 'GA4 웹 스트림 생성',
    detail: 'GA4 속성과 웹 데이터 스트림을 만든 뒤 G-... 측정 ID를 GTM 변수로 연결합니다.'
  },
  NEXT_PUBLIC_APP_URL: {
    title: '운영 자사몰 도메인 확정',
    detail: 'GA4 웹 스트림, 광고 랜딩 페이지, Meta 도메인 검증에 사용할 https 운영 URL을 env에 넣습니다.'
  },
  NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL: {
    title: 'Google Ads 구매 전환 액션 생성',
    detail: '구매 전환 액션을 만든 뒤 conversion label을 운영 env에 넣습니다.'
  },
  NEXT_PUBLIC_META_PIXEL_ID: {
    title: 'Meta 데이터 세트/픽셀 생성',
    detail: 'Meta Business Settings에서 데이터 세트 또는 픽셀을 만들고 ID를 운영 env에 넣습니다.'
  },
  DOWNSTREAM_CRM_WEBHOOK_URL: {
    title: '이메일/카카오/CRM webhook 연결',
    detail: '실제 발송툴 webhook URL과 API key를 넣고 테스트 계정으로만 발송 검증합니다.'
  }
};

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseArgs(args) {
  const parsed = {
    fullQaReport: DEFAULT_FULL_QA_REPORT,
    completionAudit: DEFAULT_COMPLETION_AUDIT,
    handoffReport: DEFAULT_HANDOFF_REPORT,
    output: DEFAULT_HTML_OUTPUT,
    jsonOutput: DEFAULT_JSON_OUTPUT
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith('--')) {
      parsed.siteRoot = parsed.siteRoot || arg;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : args[index + 1];

    if (key === 'help') {
      parsed.help = true;
      continue;
    }
    if (equalsIndex < 0) {
      index += 1;
    }

    if (key === 'site-root') {
      parsed.siteRoot = value;
    }
    if (key === 'full-qa-report') {
      parsed.fullQaReport = path.resolve(value);
    }
    if (key === 'completion-audit') {
      parsed.completionAudit = path.resolve(value);
    }
    if (key === 'handoff-report') {
      parsed.handoffReport = path.resolve(value);
    }
    if (key === 'output') {
      parsed.output = path.resolve(value);
    }
    if (key === 'json-output') {
      parsed.jsonOutput = path.resolve(value);
    }
  }

  if (parsed.siteRoot) {
    parsed.siteRoot = path.resolve(parsed.siteRoot);
  }

  return parsed;
}

function blockersFrom(env, audit, handoff) {
  return unique([
    ...(audit?.blocking_inputs || []),
    ...(env?.summary?.missing || []),
    ...(env?.summary?.placeholders || []),
    ...(env?.summary?.invalid || []),
    ...(handoff?.missing || []),
    ...(handoff?.env?.summary?.missing || [])
  ]);
}

function nextActions(blockers) {
  const actions = blockers
    .map((key) => ACTION_BY_KEY[key] ? { key, ...ACTION_BY_KEY[key] } : null)
    .filter(Boolean);

  if (actions.length) {
    return actions;
  }

  return [
    {
      key: 'RUN_GO_LIVE',
      title: '운영 go-live 검증 실행',
      detail: 'env가 준비됐으므로 render:gtm, full:qa --require-env-ready, audit:completion --strict를 실행합니다.'
    }
  ];
}

function requirementRows(audit) {
  return (audit?.requirements || []).map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    next_step: item.next_step
  }));
}

function buildDashboardData({ siteRoot, fullQa, audit, handoff, env, artifacts }) {
  const blockers = blockersFrom(env, audit, handoff);

  return {
    generated_at: new Date().toISOString(),
    site_root: siteRoot || handoff?.site_root || env?.root || '',
    status: {
      local_qa_ok: fullQa?.local_qa_ok ?? null,
      deployment_ready: fullQa?.deployment_ready ?? env?.ready ?? false,
      completion_ready: audit?.completion_ready ?? false,
      env_ready: env?.ready ?? false
    },
    summary: {
      full_qa: fullQa?.summary || null,
      completion: audit?.summary || null,
      blockers
    },
    requirements: requirementRows(audit),
    next_actions: nextActions(blockers),
    artifacts
  };
}

function statusClass(status) {
  if (status === true || status === 'complete' || status === 'passed') {
    return 'ok';
  }
  if (status === 'blocked_external' || status === 'warning' || status === false) {
    return 'warn';
  }
  return 'neutral';
}

function renderList(items, renderItem) {
  if (!items.length) {
    return '<p class="muted">없음</p>';
  }
  return `<ul>${items.map(renderItem).join('')}</ul>`;
}

function renderHtml(data) {
  const blockers = data.summary.blockers;
  const fullQa = data.summary.full_qa || {};
  const completion = data.summary.completion || {};

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Growth Ops Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #6b7280;
      --line: #d8dde6;
      --ok: #0f766e;
      --warn: #b45309;
      --neutral: #475569;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 48px; }
    header { margin-bottom: 24px; }
    h1 { margin: 0 0 8px; font-size: 30px; font-weight: 720; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    p { margin: 0; line-height: 1.55; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
    .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 14px;
    }
    .metric-label { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
    .metric-value { font-size: 24px; font-weight: 700; }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .neutral { color: var(--neutral); }
    ul { margin: 0; padding-left: 20px; }
    li { margin: 8px 0; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-top: 1px solid var(--line); padding: 10px 8px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 650; }
    .status { font-weight: 700; white-space: nowrap; }
    .commands {
      background: #111827;
      color: #f9fafb;
      border-radius: 8px;
      padding: 14px;
      overflow: auto;
      line-height: 1.55;
    }
    @media (max-width: 860px) {
      main { padding: 22px 14px 36px; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Growth Ops Dashboard</h1>
      <p class="muted">생성일 ${escapeHtml(data.generated_at)} · 대상 ${escapeHtml(data.site_root || 'unknown')}</p>
    </header>

    <section class="grid" aria-label="Summary">
      <div class="panel">
        <div class="metric-label">Local QA</div>
        <div class="metric-value ${statusClass(data.status.local_qa_ok)}">${escapeHtml(data.status.local_qa_ok)}</div>
      </div>
      <div class="panel">
        <div class="metric-label">Deployment Ready</div>
        <div class="metric-value ${statusClass(data.status.deployment_ready)}">${escapeHtml(data.status.deployment_ready)}</div>
      </div>
      <div class="panel">
        <div class="metric-label">Completion Ready</div>
        <div class="metric-value ${statusClass(data.status.completion_ready)}">${escapeHtml(data.status.completion_ready)}</div>
      </div>
      <div class="panel">
        <div class="metric-label">Blockers</div>
        <div class="metric-value ${blockers.length ? 'warn' : 'ok'}">${blockers.length}</div>
      </div>
    </section>

    <section class="panel">
      <h2>현재 차단값</h2>
      ${renderList(blockers, (key) => `<li><code>${escapeHtml(key)}</code></li>`)}
    </section>

    <section class="panel">
      <h2>다음 액션</h2>
      ${renderList(data.next_actions, (action) => `<li><strong>${escapeHtml(action.title)}</strong><br><span class="muted"><code>${escapeHtml(action.key)}</code> · ${escapeHtml(action.detail)}</span></li>`)}
    </section>

    <section class="panel">
      <h2>검증 요약</h2>
      <table>
        <tbody>
          <tr><th>full:qa</th><td>passed ${escapeHtml(fullQa.passed ?? 0)}, warning ${escapeHtml(fullQa.warning ?? 0)}, failed ${escapeHtml(fullQa.failed ?? 0)}</td></tr>
          <tr><th>audit:completion</th><td>complete ${escapeHtml(completion.complete ?? 0)}, blocked_external ${escapeHtml(completion.blocked_external ?? 0)}, failed ${escapeHtml(completion.failed ?? 0)}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h2>요구사항별 상태</h2>
      <table>
        <thead>
          <tr><th>ID</th><th>상태</th><th>다음 단계</th></tr>
        </thead>
        <tbody>
          ${data.requirements.map((item) => `<tr><td>${escapeHtml(item.title || item.id)}</td><td class="status ${statusClass(item.status)}">${escapeHtml(item.status)}</td><td>${escapeHtml(item.next_step || '')}</td></tr>`).join('')}
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h2>운영 명령</h2>
      <pre class="commands"><code>npm run validate:env -- ${escapeHtml(data.site_root || '/path/to/store')}
npm run render:gtm -- --site-root ${escapeHtml(data.site_root || '/path/to/store')}
npm run full:qa -- --site-root ${escapeHtml(data.site_root || '/path/to/store')} --start-local --start-site --site-port 3100 --require-env-ready
npm run audit:completion -- --site-root ${escapeHtml(data.site_root || '/path/to/store')} --strict</code></pre>
    </section>
  </main>
</body>
</html>
`;
}

async function generateOpsDashboard(options) {
  const siteRoot = options.siteRoot ? path.resolve(options.siteRoot) : undefined;
  const fullQaReport = options.fullQaReport || DEFAULT_FULL_QA_REPORT;
  const completionAudit = options.completionAudit || DEFAULT_COMPLETION_AUDIT;
  const handoffReport = options.handoffReport || DEFAULT_HANDOFF_REPORT;
  const env = siteRoot ? await validateDeploymentEnv(siteRoot) : null;
  const fullQa = await readJsonIfExists(fullQaReport);
  const audit = await readJsonIfExists(completionAudit);
  const handoff = await readJsonIfExists(handoffReport);
  const artifacts = {
    full_qa_report: { file: fullQaReport, exists: await pathExists(fullQaReport) },
    completion_audit: { file: completionAudit, exists: await pathExists(completionAudit) },
    handoff_report: { file: handoffReport, exists: await pathExists(handoffReport) }
  };
  const data = buildDashboardData({ siteRoot, fullQa, audit, handoff, env, artifacts });

  return {
    data,
    html: renderHtml(data)
  };
}

async function writeDashboard(options) {
  const output = path.resolve(options.output || DEFAULT_HTML_OUTPUT);
  const jsonOutput = path.resolve(options.jsonOutput || DEFAULT_JSON_OUTPUT);
  const dashboard = await generateOpsDashboard(options);

  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(path.dirname(jsonOutput), { recursive: true });
  await writeFile(output, dashboard.html);
  await writeFile(jsonOutput, `${JSON.stringify(dashboard.data, null, 2)}\n`);

  return {
    ok: true,
    output,
    json_output: jsonOutput,
    blockers: dashboard.data.summary.blockers,
    next_actions: dashboard.data.next_actions.map((action) => action.key)
  };
}

function printHelp() {
  console.log([
    'Usage: npm run dashboard:ops -- --site-root /path/to/store',
    '',
    'Options:',
    '  --site-root <path>          Storefront root used for env readiness checks',
    '  --full-qa-report <path>     full QA JSON report',
    '  --completion-audit <path>   completion audit JSON report',
    '  --handoff-report <path>     deployment handoff JSON report',
    '  --output <path>             HTML output path',
    '  --json-output <path>        JSON output path'
  ].join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = await writeDashboard(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  buildDashboardData,
  generateOpsDashboard,
  nextActions,
  parseArgs,
  renderHtml,
  writeDashboard
};

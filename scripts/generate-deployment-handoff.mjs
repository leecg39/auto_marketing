import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIREMENTS, validateDeploymentEnv } from './validate-deployment-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FULL_QA_REPORT = path.join(KIT_ROOT, 'dist', 'full-qa-report.json');
const DEFAULT_MARKDOWN_OUTPUT = path.join(KIT_ROOT, 'dist', 'deployment-handoff.md');
const DEFAULT_JSON_OUTPUT = path.join(KIT_ROOT, 'dist', 'deployment-handoff.json');
const DEFAULT_GTM_IMPORT = path.join(KIT_ROOT, 'dist', 'gtm-container-import.json');
const DEFAULT_COMPLETION_AUDIT = path.join(KIT_ROOT, 'dist', 'completion-audit.json');

const EXTRA_ENV_KEYS = [
  {
    key: 'DOWNSTREAM_CRM_API_KEY',
    label: 'Email/Kakao/CRM downstream API key',
    placeholder: 'replace-with-crm-api-key'
  },
  {
    key: 'NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY',
    label: 'Default ecommerce currency',
    placeholder: 'KRW'
  }
];

const PLACEHOLDER_BY_KEY = {
  NEXT_PUBLIC_GTM_ID: 'GTM-XXXXXXX',
  NEXT_PUBLIC_CRM_WEBHOOK_URL: '/api/crm/events',
  DOWNSTREAM_CRM_WEBHOOK_URL: 'https://your-crm.example/webhook',
  NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-XXXXXXXXXX',
  NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID: 'AW-XXXXXXXXX',
  NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL: 'replace-with-purchase-label',
  NEXT_PUBLIC_META_PIXEL_ID: 'replace-with-meta-pixel-id',
  DOWNSTREAM_CRM_API_KEY: 'replace-with-crm-api-key',
  NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY: 'KRW'
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

function envBlock() {
  return [
    ...REQUIREMENTS.map((requirement) => requirement.key),
    ...EXTRA_ENV_KEYS.map((entry) => entry.key)
  ]
    .map((key) => `${key}=${PLACEHOLDER_BY_KEY[key] || ''}`)
    .join('\n');
}

function summarizeGtmImport(containerImport) {
  const version = containerImport?.containerVersion;
  if (!version) {
    return null;
  }

  return {
    public_id: version.container?.publicId || '',
    tags: Array.isArray(version.tag) ? version.tag.length : 0,
    triggers: Array.isArray(version.trigger) ? version.trigger.length : 0,
    variables: Array.isArray(version.variable) ? version.variable.length : 0
  };
}

function buildRequiredInputs(envReport) {
  const statuses = new Map(envReport.checks.map((check) => [check.key, check]));

  return [
    ...REQUIREMENTS.map((requirement) => {
      const check = statuses.get(requirement.key);
      return {
        key: requirement.key,
        label: requirement.label,
        status: check?.status || 'missing',
        required_for: requirement.required_for,
        placeholder: PLACEHOLDER_BY_KEY[requirement.key] || ''
      };
    }),
    ...EXTRA_ENV_KEYS.map((entry) => ({
      key: entry.key,
      label: entry.label,
      status: 'manual_check',
      required_for: ['downstream_auth'],
      placeholder: entry.placeholder
    }))
  ];
}

function renderStatusList(inputs) {
  return inputs
    .map((input) => `- \`${input.key}\`: ${input.label} (${input.status})`)
    .join('\n');
}

function renderFullQaSummary(fullQaReport) {
  if (!fullQaReport) {
    return '- full QA report not found. Run `npm run full:qa` first.';
  }

  return [
    `- \`local_qa_ok\`: \`${fullQaReport.local_qa_ok}\``,
    `- \`deployment_ready\`: \`${fullQaReport.deployment_ready}\``,
    `- passed/warning/failed: \`${fullQaReport.summary?.passed || 0}/${fullQaReport.summary?.warning || 0}/${fullQaReport.summary?.failed || 0}\``
  ].join('\n');
}

function renderGtmSummary(gtmSummary) {
  if (!gtmSummary) {
    return '- GTM import file not found. Run `npm run generate:gtm -- --public-id GTM-XXXXXXX`.';
  }

  return [
    `- public ID: \`${gtmSummary.public_id}\``,
    `- tags/triggers/variables: \`${gtmSummary.tags}/${gtmSummary.triggers}/${gtmSummary.variables}\``,
    '- file: `dist/gtm-container-import.json`'
  ].join('\n');
}

function renderMarkdown(report) {
  const missing = report.env.summary.missing.length
    ? report.env.summary.missing.map((key) => `\`${key}\``).join(', ')
    : '없음';
  const placeholders = report.env.summary.placeholders.length
    ? report.env.summary.placeholders.map((key) => `\`${key}\``).join(', ')
    : '없음';
  const invalid = report.env.summary.invalid.length
    ? report.env.summary.invalid.map((key) => `\`${key}\``).join(', ')
    : '없음';

  return [
    '# 마케팅 자동화 배포 Handoff',
    '',
    `생성일: ${report.generated_at}`,
    `대상 사이트: \`${report.site_root}\``,
    '',
    '## 현재 상태',
    '',
    `- 로컬 QA 통과: \`${report.full_qa?.local_qa_ok ?? 'unknown'}\``,
    `- 운영 배포 준비: \`${report.env.ready}\``,
    `- missing: ${missing}`,
    `- placeholders: ${placeholders}`,
    `- invalid: ${invalid}`,
    '',
    '## Full QA 요약',
    '',
    renderFullQaSummary(report.full_qa),
    '',
    '## GTM Import',
    '',
    renderGtmSummary(report.gtm_import),
    '',
    '## 완료 감사',
    '',
    `- command: \`npm run audit:completion -- --site-root ${report.site_root}\``,
    `- file: \`dist/completion-audit.json\``,
    `- exists: \`${report.artifacts.completion_audit.exists}\``,
    '',
    '## 입력해야 할 값',
    '',
    renderStatusList(report.required_inputs),
    '',
    '## `.env.local`에 추가할 블록',
    '',
    '```bash',
    report.env_template,
    '```',
    '',
    '## 실행 순서',
    '',
    '```bash',
    'cd marketing-automation-kit',
    `npm run generate:gtm -- --public-id GTM-XXXXXXX`,
    `npm run apply:env -- --site-root ${report.site_root} --env-file /path/to/marketing-production.env --dry-run`,
    `npm run apply:env -- --site-root ${report.site_root} --env-file /path/to/marketing-production.env`,
    `npm run render:gtm -- --site-root ${report.site_root}`,
    `npm run verify:gtm -- --input dist/gtm-container-import.production.json`,
    `npm run validate:env -- ${report.site_root}`,
    `npm run full:qa -- --site-root ${report.site_root} --start-local --start-site --site-port 3100 --require-env-ready`,
    `npm run audit:completion -- --site-root ${report.site_root}`,
    '```',
    '',
    '## 운영에서 직접 확인할 항목',
    '',
    '- GTM Admin > Import Container에서 `dist/gtm-container-import.json` 가져오기',
    '- GTM Constant Variable을 실제 GA4, Google Ads, Meta 값으로 교체',
    '- GTM Preview와 GA4 DebugView에서 7개 이벤트 확인',
    '- Google Ads/Meta 테스트 이벤트 도구에서 구매 전환 수신 확인',
    '- 실제 주문 DB와 GA4 매출 CSV를 48시간 뒤 `npm run reconcile:revenue`로 비교'
  ].join('\n');
}

async function generateDeploymentHandoff(options) {
  const siteRoot = path.resolve(options.siteRoot || process.cwd());
  const env = await validateDeploymentEnv(siteRoot);
  const fullQa = await readJsonIfExists(options.fullQaReport || DEFAULT_FULL_QA_REPORT);
  const gtmImport = await readJsonIfExists(options.gtmImport || DEFAULT_GTM_IMPORT);
  const completionAudit = options.completionAudit || DEFAULT_COMPLETION_AUDIT;
  const report = {
    generated_at: new Date().toISOString(),
    site_root: siteRoot,
    env,
    full_qa: fullQa,
    gtm_import: summarizeGtmImport(gtmImport),
    required_inputs: buildRequiredInputs(env),
    env_template: envBlock(),
    artifacts: {
      full_qa_report: {
        file: options.fullQaReport || DEFAULT_FULL_QA_REPORT,
        exists: await pathExists(options.fullQaReport || DEFAULT_FULL_QA_REPORT)
      },
      gtm_import: {
        file: options.gtmImport || DEFAULT_GTM_IMPORT,
        exists: await pathExists(options.gtmImport || DEFAULT_GTM_IMPORT)
      },
      completion_audit: {
        file: completionAudit,
        exists: await pathExists(completionAudit)
      }
    }
  };

  return {
    report,
    markdown: renderMarkdown(report)
  };
}

function parseArgs(args) {
  const parsed = {
    output: DEFAULT_MARKDOWN_OUTPUT,
    jsonOutput: DEFAULT_JSON_OUTPUT,
    fullQaReport: DEFAULT_FULL_QA_REPORT,
    gtmImport: DEFAULT_GTM_IMPORT,
    completionAudit: DEFAULT_COMPLETION_AUDIT
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
    if (key === 'output') {
      parsed.output = path.resolve(value);
    }
    if (key === 'json-output') {
      parsed.jsonOutput = path.resolve(value);
    }
    if (key === 'full-qa-report') {
      parsed.fullQaReport = path.resolve(value);
    }
    if (key === 'gtm-import') {
      parsed.gtmImport = path.resolve(value);
    }
    if (key === 'completion-audit') {
      parsed.completionAudit = path.resolve(value);
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  npm run handoff:deployment -- --site-root /path/to/store',
    '',
    'Options:',
    '  --output FILE          Markdown handoff output. Default: dist/deployment-handoff.md',
    '  --json-output FILE     JSON handoff output. Default: dist/deployment-handoff.json',
    '  --full-qa-report FILE  Full QA report input. Default: dist/full-qa-report.json',
    '  --gtm-import FILE      GTM import input. Default: dist/gtm-container-import.json',
    '  --completion-audit FILE Completion audit input. Default: dist/completion-audit.json'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.siteRoot) {
    console.log(usage());
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const { report, markdown } = await generateDeploymentHandoff(options);
  await mkdir(path.dirname(options.output), { recursive: true });
  await mkdir(path.dirname(options.jsonOutput), { recursive: true });
  await writeFile(options.output, `${markdown}\n`);
  await writeFile(options.jsonOutput, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    output: options.output,
    json_output: options.jsonOutput,
    deployment_ready: report.env.ready,
    missing: report.env.summary.missing,
    placeholders: report.env.summary.placeholders,
    invalid: report.env.summary.invalid,
    next_step: report.env.ready
      ? '운영 env 값이 준비되어 있습니다. --require-env-ready full QA와 GTM/GA4 DebugView 검증으로 넘어가세요.'
      : 'handoff 문서의 env 블록을 실제 운영 값으로 채운 뒤 validate:env와 full:qa --require-env-ready를 실행하세요.'
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  buildRequiredInputs,
  envBlock,
  generateDeploymentHandoff,
  parseArgs,
  renderMarkdown
};

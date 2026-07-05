import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIREMENTS, classifyRequirement, parseDotenv } from './validate-deployment-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = process.env.VERCEL_PRODUCTION_URL || 'https://auto-marketing-sigma.vercel.app';
const DEFAULT_MARKDOWN_OUTPUT = path.join(KIT_ROOT, 'dist', 'vercel-env-plan.md');
const DEFAULT_JSON_OUTPUT = path.join(KIT_ROOT, 'dist', 'vercel-env-plan.json');
const DEFAULT_ENV_FILES = ['.env.local', '.env.production', '.env', '.env.marketing'];

const KNOWN_PUBLIC_VALUES = [
  {
    key: 'NEXT_PUBLIC_CRM_WEBHOOK_URL',
    value: '/api/crm/events',
    source: 'production_serverless_route',
    reason: 'Vercel production에 `/api/crm/events` CRM 이벤트 수신 API가 배포되어 있습니다.'
  },
  {
    key: 'NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY',
    value: 'KRW',
    source: 'plan_default',
    reason: '초기 자사몰 기준 통화가 KRW로 설계되어 있습니다.'
  }
];

const EXTRA_SERVER_KEYS = [
  {
    key: 'DOWNSTREAM_CRM_API_KEY',
    label: 'Email/Kakao/CRM downstream API key',
    required_for: ['downstream_auth'],
    required: false
  }
];

function normalizeBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function parseArgs(args) {
  const parsed = {
    baseUrl: DEFAULT_BASE_URL,
    output: DEFAULT_MARKDOWN_OUTPUT,
    jsonOutput: DEFAULT_JSON_OUTPUT,
    envFiles: DEFAULT_ENV_FILES
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
    if (key === 'base-url') {
      parsed.baseUrl = value;
    }
    if (key === 'output') {
      parsed.output = path.resolve(value);
    }
    if (key === 'json-output') {
      parsed.jsonOutput = path.resolve(value);
    }
    if (key === 'env-file') {
      parsed.envFiles = [value];
    }
  }

  parsed.baseUrl = normalizeBaseUrl(parsed.baseUrl);
  if (parsed.siteRoot) {
    parsed.siteRoot = path.resolve(parsed.siteRoot);
  }

  return parsed;
}

async function readEnvValues(root, envFiles = DEFAULT_ENV_FILES) {
  if (!root) {
    return {
      loaded: [],
      values: {}
    };
  }

  const loaded = [];
  const values = {};

  for (const fileName of envFiles) {
    const file = path.isAbsolute(fileName) ? fileName : path.join(root, fileName);
    try {
      Object.assign(values, parseDotenv(await readFile(file, 'utf8')));
      loaded.push(fileName);
    } catch {
      // Missing local env files are expected while preparing handoff artifacts.
    }
  }

  return { loaded, values };
}

async function fetchJson(url, runtime = {}) {
  const fetcher = runtime.fetch || fetch;
  const response = await fetcher(url);
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    json: text ? JSON.parse(text) : null
  };
}

async function readProductionEnvStatus(baseUrl, runtime = {}) {
  try {
    const result = await fetchJson(`${baseUrl}/api/marketing/env-status`, runtime);
    if (!result.ok || !result.json?.ok) {
      return {
        available: false,
        status: result.status,
        ready: false,
        summary: null,
        error: `env_status_http_${result.status}`
      };
    }

    return {
      available: true,
      status: result.status,
      ready: result.json.ready === true,
      summary: result.json.summary,
      checks: result.json.checks || [],
      error: ''
    };
  } catch (error) {
    return {
      available: false,
      status: null,
      ready: false,
      summary: null,
      error: error.message
    };
  }
}

function isPublicKey(key) {
  return key.startsWith('NEXT_PUBLIC_');
}

function maskValue(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  if (text.length <= 8) {
    return `${text.slice(0, 2)}...`;
  }
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function displayValue(key, value, source) {
  if (!value) {
    return '';
  }
  if (source === 'auto_derived' || isPublicKey(key)) {
    return value;
  }
  return maskValue(value);
}

function commandFor(key) {
  return `vercel env add ${key} production`;
}

function buildKnownValues(baseUrl) {
  return [
    {
      key: 'NEXT_PUBLIC_APP_URL',
      value: baseUrl,
      source: 'production_url',
      reason: '현재 Vercel production URL이 확인되었습니다.'
    },
    ...KNOWN_PUBLIC_VALUES
  ];
}

function classifyEnvItem(requirement, context) {
  const known = context.knownValues.find((entry) => entry.key === requirement.key);
  if (known) {
    const check = classifyRequirement(requirement, { [requirement.key]: known.value });
    return {
      key: requirement.key,
      label: requirement.label,
      required_for: requirement.required_for,
      group: check.ok ? 'ready_to_add' : 'needs_external_value',
      status: check.status,
      source: known.source,
      value: known.value,
      display_value: displayValue(requirement.key, known.value, 'auto_derived'),
      command: commandFor(requirement.key),
      confirmation_required: true,
      reason: known.reason
    };
  }

  const localValue = context.localValues[requirement.key] || '';
  if (localValue) {
    const check = classifyRequirement(requirement, { [requirement.key]: localValue });
    return {
      key: requirement.key,
      label: requirement.label,
      required_for: requirement.required_for,
      group: check.ok ? 'candidate_from_local_env' : 'needs_external_value',
      status: check.status,
      source: 'local_env',
      value: isPublicKey(requirement.key) ? localValue : '',
      display_value: displayValue(requirement.key, localValue, 'local_env'),
      command: commandFor(requirement.key),
      confirmation_required: true,
      reason: check.ok
        ? '로컬 후보 env에 형식상 유효한 값이 있습니다. 실제 운영 계정값인지 확인 후 Vercel에 입력하세요.'
        : '로컬 후보 env 값이 placeholder이거나 형식이 맞지 않습니다.'
    };
  }

  return {
    key: requirement.key,
    label: requirement.label,
    required_for: requirement.required_for,
    group: 'needs_external_value',
    status: 'missing',
    source: 'external_account',
    value: '',
    display_value: '',
    command: commandFor(requirement.key),
    confirmation_required: true,
    reason: 'GTM/GA4/광고/CRM 운영 계정에서 값을 확인해야 합니다.'
  };
}

function buildExtraItems(context) {
  return [
    {
      key: 'NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY',
      label: 'Default ecommerce currency',
      required_for: ['ecommerce_value'],
      group: 'ready_to_add',
      status: 'ready',
      source: 'plan_default',
      value: 'KRW',
      display_value: 'KRW',
      command: commandFor('NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY'),
      confirmation_required: true,
      reason: '초기 자사몰 기준 통화가 KRW입니다.'
    },
    ...EXTRA_SERVER_KEYS.map((entry) => {
      const localValue = context.localValues[entry.key] || '';
      return {
        ...entry,
        group: localValue ? 'candidate_from_local_env' : 'optional_external_value',
        status: localValue ? 'manual_check' : 'optional',
        source: localValue ? 'local_env' : 'external_account',
        value: '',
        display_value: localValue ? maskValue(localValue) : '',
        command: commandFor(entry.key),
        confirmation_required: true,
        reason: localValue
          ? '로컬 env에 값이 있습니다. Vercel 입력 전 실제 downstream CRM 인증값인지 확인하세요.'
          : 'downstream CRM provider가 인증을 요구할 때만 필요합니다.'
      };
    })
  ];
}

function summarizeItems(items) {
  return {
    ready_to_add: items.filter((item) => item.group === 'ready_to_add').map((item) => item.key),
    candidate_from_local_env: items.filter((item) => item.group === 'candidate_from_local_env').map((item) => item.key),
    needs_external_value: items.filter((item) => item.group === 'needs_external_value').map((item) => item.key),
    optional_external_value: items.filter((item) => item.group === 'optional_external_value').map((item) => item.key)
  };
}

async function generateVercelEnvPlan(options, runtime = {}) {
  const localEnv = await readEnvValues(options.siteRoot, options.envFiles);
  const knownValues = buildKnownValues(options.baseUrl);
  const productionEnv = await readProductionEnvStatus(options.baseUrl, runtime);
  const items = [
    ...REQUIREMENTS.map((requirement) => classifyEnvItem(requirement, {
      knownValues,
      localValues: localEnv.values
    })),
    ...buildExtraItems({ localValues: localEnv.values })
  ];
  const summary = summarizeItems(items);

  return {
    generated_at: new Date().toISOString(),
    base_url: options.baseUrl,
    site_root: options.siteRoot || '',
    loaded_env_files: localEnv.loaded,
    production_env: productionEnv,
    summary,
    items,
    next_step: productionEnv.ready
      ? 'Vercel production env가 준비되어 있습니다. `npm run verify:vercel -- --require-env-ready`로 검증하세요.'
      : 'ready_to_add 값부터 Vercel Environment Variables에 입력하고, needs_external_value 값은 각 외부 계정에서 확인하세요.'
  };
}

function renderItemList(items, group) {
  const groupItems = items.filter((item) => item.group === group);
  if (!groupItems.length) {
    return '- 없음';
  }

  return groupItems
    .map((item) => [
      `- \`${item.key}\`: ${item.label}`,
      item.display_value ? `  - 값: \`${item.display_value}\`` : '',
      `  - 상태: \`${item.status}\` / 출처: \`${item.source}\``,
      `  - Vercel 입력 명령: \`${item.command}\``,
      `  - 확인 필요: \`${item.confirmation_required}\``,
      `  - 메모: ${item.reason}`
    ].filter(Boolean).join('\n'))
    .join('\n');
}

function renderMarkdown(plan) {
  const productionSummary = plan.production_env.available
    ? [
        `- endpoint: \`available\` (${plan.production_env.status})`,
        `- ready: \`${plan.production_env.ready}\``,
        `- missing: \`${plan.production_env.summary?.missing?.join(', ') || '없음'}\``,
        `- placeholders: \`${plan.production_env.summary?.placeholders?.join(', ') || '없음'}\``,
        `- invalid: \`${plan.production_env.summary?.invalid?.join(', ') || '없음'}\``
      ].join('\n')
    : `- endpoint: \`unavailable\` (${plan.production_env.error || 'unknown'})`;

  return [
    '# Vercel Production Env 입력 계획',
    '',
    `생성일: ${plan.generated_at}`,
    `production URL: \`${plan.base_url}\``,
    `대상 사이트: \`${plan.site_root || '없음'}\``,
    `로드한 env 파일: \`${plan.loaded_env_files.join(', ') || '없음'}\``,
    '',
    '## 현재 production env readiness',
    '',
    productionSummary,
    '',
    '## 바로 입력 가능한 값',
    '',
    renderItemList(plan.items, 'ready_to_add'),
    '',
    '## 로컬 env 후보값 확인 후 입력',
    '',
    renderItemList(plan.items, 'candidate_from_local_env'),
    '',
    '## 외부 계정에서 확인해야 할 값',
    '',
    renderItemList(plan.items, 'needs_external_value'),
    '',
    '## 선택 입력값',
    '',
    renderItemList(plan.items, 'optional_external_value'),
    '',
    '## 다음 단계',
    '',
    plan.next_step
  ].join('\n');
}

async function writeOutputs(plan, options) {
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${renderMarkdown(plan)}\n`);
  await writeFile(options.jsonOutput, `${JSON.stringify(plan, null, 2)}\n`);
}

function usage() {
  return [
    'Usage:',
    '  npm run plan:vercel-env -- --site-root /path/to/store --base-url https://project.vercel.app',
    '',
    'Options:',
    '  --site-root PATH    Optional storefront root to read local env candidates.',
    '  --base-url URL      Vercel production URL.',
    '  --env-file FILE     Read one explicit local env file.',
    '  --output FILE       Markdown output. Default: dist/vercel-env-plan.md',
    '  --json-output FILE  JSON output. Default: dist/vercel-env-plan.json'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const plan = await generateVercelEnvPlan(options);
  await writeOutputs(plan, options);
  console.log(JSON.stringify({
    base_url: plan.base_url,
    production_env_ready: plan.production_env.ready,
    summary: plan.summary,
    output: options.output,
    json_output: options.jsonOutput,
    next_step: plan.next_step
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  buildKnownValues,
  classifyEnvItem,
  generateVercelEnvPlan,
  maskValue,
  parseArgs,
  renderMarkdown,
  summarizeItems
};

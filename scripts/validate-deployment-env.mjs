import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENV_FILES = [
  '.env.local',
  '.env.production',
  '.env',
  '.env.marketing'
];

const DEPLOYMENT_ENV_ALIASES = {
  UPSTASH_REDIS_REST_URL: [
    'UPSTASH_REDIS_KV_REST_API_URL',
    'KV_REST_API_URL'
  ],
  UPSTASH_REDIS_REST_TOKEN: [
    'UPSTASH_REDIS_KV_REST_API_TOKEN',
    'KV_REST_API_TOKEN'
  ]
};

const UPSTASH_REDIS_ENV_PAIRS = [
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ['UPSTASH_REDIS_KV_REST_API_URL', 'UPSTASH_REDIS_KV_REST_API_TOKEN'],
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN']
];

const REQUIREMENTS = [
  {
    key: 'NEXT_PUBLIC_GTM_ID',
    label: 'GTM web container ID',
    required_for: ['gtm_loader', 'ga4', 'ads_retargeting'],
    pattern: /^GTM-[A-Z0-9]+$/,
    placeholder: /^GTM-X+$/i
  },
  {
    key: 'NEXT_PUBLIC_CRM_WEBHOOK_URL',
    label: 'Browser to CRM event endpoint',
    required_for: ['crm_event_capture'],
    pattern: /^\/.+|^https:\/\/.+/i,
    placeholder: /^$/
  },
  {
    key: 'NEXT_PUBLIC_APP_URL',
    label: 'Production storefront URL',
    required_for: ['ga4_web_stream', 'ads_landing_page', 'meta_domain_verification', 'crm_cors'],
    pattern: /^https:\/\/(?!localhost(?:\/|:|$))(?!127\.0\.0\.1(?:\/|:|$))[^\s]+$/i,
    placeholder: /^https:\/\/your-store\.example|^https:\/\/example\.com|^http:\/\/localhost|^http:\/\/127\.0\.0\.1/i
  },
  {
    key: 'DOWNSTREAM_CRM_WEBHOOK_URL',
    label: 'Email/Kakao/CRM downstream webhook',
    required_for: ['email_kakao_delivery'],
    pattern: /^https:\/\/.+/i,
    placeholder: /^$/
  },
  {
    key: 'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
    label: 'GA4 measurement ID for GTM variable replacement',
    required_for: ['gtm_import_publish'],
    pattern: /^G-[A-Z0-9]+$/,
    placeholder: /^G-X+$/i
  },
  {
    key: 'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID',
    label: 'Google Ads conversion ID for GTM variable replacement',
    required_for: ['google_ads_conversion'],
    pattern: /^AW-[0-9]+$/,
    placeholder: /^AW-X+$/i
  },
  {
    key: 'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL',
    label: 'Google Ads purchase conversion label',
    required_for: ['google_ads_conversion'],
    pattern: /^[A-Za-z0-9_-]{8,}$/,
    placeholder: /^replace-with-/i
  },
  {
    key: 'NEXT_PUBLIC_META_PIXEL_ID',
    label: 'Meta Pixel ID for GTM variable replacement',
    required_for: ['meta_retargeting'],
    pattern: /^[0-9]{6,}$/,
    placeholder: /^replace-with-/i
  }
];

const DELIVERY_GATEWAY_REQUIREMENTS = [
  {
    key: 'DOWNSTREAM_CRM_API_KEY',
    label: 'Delivery gateway Bearer token',
    required_for: ['delivery_gateway_auth'],
    pattern: /^.{24,}$/,
    placeholder: /^replace-with-|^$/i
  },
  {
    key: 'CRM_DELIVERY_MODE',
    label: 'Delivery safety mode',
    required_for: ['test_recipient_safety'],
    pattern: /^(test|live)$/,
    placeholder: /^$/
  },
  {
    key: 'CRM_TEST_RECIPIENTS',
    label: 'Test delivery recipient allowlist',
    required_for: ['test_recipient_safety'],
    pattern: /^.+$/,
    placeholder: /^replace-with-|^$/i
  },
  {
    key: 'UPSTASH_REDIS_REST_URL',
    label: 'Upstash Redis REST URL',
    required_for: ['delivery_idempotency', 'scheduled_delivery_cancellation'],
    pattern: /^https:\/\/.+/i,
    placeholder: /^https:\/\/your-|^$/i
  },
  {
    key: 'UPSTASH_REDIS_REST_TOKEN',
    label: 'Upstash Redis REST token',
    required_for: ['delivery_idempotency', 'scheduled_delivery_cancellation'],
    pattern: /^.{12,}$/,
    placeholder: /^replace-with-|^$/i
  },
  {
    key: 'RESEND_API_KEY',
    label: 'Resend API key',
    required_for: ['email_delivery'],
    pattern: /^re_.+/i,
    placeholder: /^replace-with-|^$/i
  },
  {
    key: 'RESEND_FROM_EMAIL',
    label: 'Verified email sender',
    required_for: ['email_delivery'],
    pattern: /@.+\..+/,
    placeholder: /^replace-with-|^$/i
  },
  {
    key: 'SOLAPI_API_KEY',
    label: 'SOLAPI API key',
    required_for: ['kakao_brand_message'],
    pattern: /^.{8,}$/,
    placeholder: /^replace-with-|^$/i
  },
  {
    key: 'SOLAPI_API_SECRET',
    label: 'SOLAPI API secret',
    required_for: ['kakao_brand_message'],
    pattern: /^.{12,}$/,
    placeholder: /^replace-with-|^$/i
  },
  {
    key: 'SOLAPI_KAKAO_PF_ID',
    label: 'SOLAPI Kakao channel profile ID',
    required_for: ['kakao_brand_message'],
    pattern: /^.+$/,
    placeholder: /^replace-with-|^$/i
  }
];

function usesSelfHostedDeliveryGateway(value) {
  try {
    return new URL(value).pathname === '/api/crm/downstream';
  } catch {
    return value === '/api/crm/downstream';
  }
}

function deploymentRequirements(values) {
  if (!usesSelfHostedDeliveryGateway(values.DOWNSTREAM_CRM_WEBHOOK_URL)) {
    return REQUIREMENTS;
  }

  return [
    ...REQUIREMENTS,
    ...DELIVERY_GATEWAY_REQUIREMENTS.filter((requirement) =>
      requirement.key !== 'CRM_TEST_RECIPIENTS' || (values.CRM_DELIVERY_MODE || 'test') === 'test'
    )
  ];
}

const URL_ENV_KEYS = [
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_STORE_URL',
  'SITE_URL',
  'APP_URL',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'VERCEL_URL',
  'URL'
];

const URL_SCAN_FILES = [
  'package.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'vercel.json',
  'netlify.toml',
  'wrangler.toml',
  'firebase.json'
];

function parseDotenv(text) {
  const values = {};
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    const value = rawValue
      .replace(/^['"]|['"]$/g, '')
      .trim();
    values[key] = value;
  }

  return values;
}

async function readEnvFile(root, fileName) {
  const file = path.isAbsolute(fileName) ? fileName : path.join(root, fileName);
  try {
    return {
      file: path.isAbsolute(fileName) ? file : fileName,
      values: parseDotenv(await readFile(file, 'utf8'))
    };
  } catch {
    return null;
  }
}

async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function normalizeUrl(rawValue) {
  const value = String(rawValue || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\/+$/, '');

  if (!value) {
    return '';
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(value)) {
    return `https://${value}`;
  }

  return value;
}

function classifyUrl(rawValue) {
  const url = normalizeUrl(rawValue);

  if (!url || !/^https?:\/\//i.test(url)) {
    return { url, status: 'invalid' };
  }

  if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(url)) {
    return { url, status: 'local' };
  }

  if (/^https:\/\/(?:your-store\.example|example\.com)(?:\/|$)/i.test(url)) {
    return { url, status: 'placeholder' };
  }

  if (!/^https:\/\//i.test(url)) {
    return { url, status: 'non_https' };
  }

  return { url, status: 'ready' };
}

function addUrlCandidate(candidates, source, value) {
  const classified = classifyUrl(value);
  if (!classified.url) {
    return;
  }

  if (candidates.some((candidate) => candidate.url === classified.url && candidate.source === source)) {
    return;
  }

  candidates.push({
    source,
    url: classified.url,
    status: classified.status
  });
}

function extractUrls(text) {
  return Array.from(text.matchAll(/https?:\/\/[^\s"'`),\]}<>]+/gi))
    .map((match) => match[0].replace(/[.,;:]+$/, ''));
}

async function discoverStorefrontUrls(root, values = {}) {
  const candidates = [];

  for (const key of URL_ENV_KEYS) {
    addUrlCandidate(candidates, `env:${key}`, values[key]);
  }

  const packageText = await readTextIfExists(path.join(root, 'package.json'));
  if (packageText) {
    try {
      const packageJson = JSON.parse(packageText);
      addUrlCandidate(candidates, 'package.json:homepage', packageJson.homepage);
    } catch {
      // Ignore malformed package.json here. Env validation will surface other failures.
    }
  }

  for (const fileName of URL_SCAN_FILES.filter((fileName) => fileName !== 'package.json')) {
    const text = await readTextIfExists(path.join(root, fileName));
    for (const url of extractUrls(text)) {
      addUrlCandidate(candidates, fileName, url);
    }
  }

  const ready = candidates.filter((candidate) => candidate.status === 'ready');

  return {
    ready: ready.length > 0,
    suggested_url: ready[0]?.url || '',
    candidates,
    next_step: ready.length
      ? `NEXT_PUBLIC_APP_URL에 ${ready[0].url}를 넣고 validate:env를 다시 실행하세요.`
      : '운영 HTTPS URL을 찾지 못했습니다. 배포 플랫폼에서 production domain을 확정한 뒤 NEXT_PUBLIC_APP_URL에 넣으세요.'
  };
}

async function loadEnv(root, envFiles = DEFAULT_ENV_FILES) {
  const loaded = [];
  const values = {};

  for (const fileName of envFiles) {
    const envFile = await readEnvFile(root, fileName);
    if (!envFile) {
      continue;
    }

    loaded.push(envFile.file);
    Object.assign(values, envFile.values);
  }

  return { loaded, values };
}

function normalizeDeploymentEnvValues(values = {}) {
  const normalized = { ...values };
  const sourcePair = UPSTASH_REDIS_ENV_PAIRS.find(([urlKey, tokenKey]) =>
    values[urlKey] && values[tokenKey]
  );

  normalized.UPSTASH_REDIS_REST_URL = sourcePair ? values[sourcePair[0]] : '';
  normalized.UPSTASH_REDIS_REST_TOKEN = sourcePair ? values[sourcePair[1]] : '';

  return normalized;
}

function classifyRequirement(requirement, values) {
  const value = values[requirement.key] || '';

  if (!value) {
    return {
      key: requirement.key,
      label: requirement.label,
      required_for: requirement.required_for,
      status: 'missing',
      ok: false
    };
  }

  if (requirement.placeholder.test(value)) {
    return {
      key: requirement.key,
      label: requirement.label,
      required_for: requirement.required_for,
      status: 'placeholder',
      ok: false
    };
  }

  if (!requirement.pattern.test(value)) {
    return {
      key: requirement.key,
      label: requirement.label,
      required_for: requirement.required_for,
      status: 'invalid_format',
      ok: false
    };
  }

  return {
    key: requirement.key,
    label: requirement.label,
    required_for: requirement.required_for,
    status: 'ready',
    ok: true
  };
}

function summarize(results) {
  return {
    ready: results.every((result) => result.ok),
    missing: results.filter((result) => result.status === 'missing').map((result) => result.key),
    placeholders: results.filter((result) => result.status === 'placeholder').map((result) => result.key),
    invalid: results.filter((result) => result.status === 'invalid_format').map((result) => result.key)
  };
}

async function validateDeploymentEnv(root, options = {}) {
  const envFiles = options.envFile ? [options.envFile] : options.envFiles || DEFAULT_ENV_FILES;
  const env = await loadEnv(root, envFiles);
  const values = normalizeDeploymentEnvValues(env.values);
  const results = deploymentRequirements(values)
    .map((requirement) => classifyRequirement(requirement, values));
  const summary = summarize(results);
  const urlDiscovery = await discoverStorefrontUrls(root, values);

  return {
    root,
    loaded_env_files: env.loaded,
    ready: summary.ready,
    summary,
    checks: results,
    url_discovery: urlDiscovery,
    next_step: summary.ready
      ? '운영 GTM/GA4/광고/CRM 값이 준비되어 있습니다. GTM Preview와 GA4 DebugView 검증으로 넘어가세요.'
      : 'missing/placeholders/invalid 항목을 실제 운영 값으로 채운 뒤 다시 검증하세요.'
  };
}

function parseArgs(args) {
  const parsed = {
    strict: false,
    envFiles: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith('--')) {
      parsed.root = parsed.root || arg;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : args[index + 1];

    if (key === 'strict') {
      parsed.strict = true;
      continue;
    }
    if (key === 'help') {
      parsed.help = true;
      continue;
    }

    if (equalsIndex < 0) {
      index += 1;
    }

    if (key === 'env-file') {
      parsed.envFiles.push(value);
    }
  }

  parsed.root = path.resolve(parsed.root || process.cwd());
  if (!parsed.envFiles.length) {
    delete parsed.envFiles;
  }

  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  npm run validate:env -- /path/to/store',
    '  npm run validate:env -- /path/to/store --env-file /path/to/marketing-production.env',
    '',
    'Options:',
    '  --env-file FILE  Read one explicit env file instead of the default site env files.',
    '  --strict         Exit non-zero when required operating values are not ready.'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const report = await validateDeploymentEnv(options.root, {
    envFiles: options.envFiles
  });

  console.log(JSON.stringify(report, null, 2));

  if (options.strict && !report.ready) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  DEPLOYMENT_ENV_ALIASES,
  DELIVERY_GATEWAY_REQUIREMENTS,
  REQUIREMENTS,
  classifyRequirement,
  classifyUrl,
  discoverStorefrontUrls,
  deploymentRequirements,
  normalizeDeploymentEnvValues,
  parseArgs,
  parseDotenv,
  summarize,
  usesSelfHostedDeliveryGateway,
  validateDeploymentEnv
};

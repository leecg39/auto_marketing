import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENV_FILES = [
  '.env.local',
  '.env.production',
  '.env',
  '.env.marketing'
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
  const file = path.join(root, fileName);
  try {
    return {
      file: fileName,
      values: parseDotenv(await readFile(file, 'utf8'))
    };
  } catch {
    return null;
  }
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
  const env = await loadEnv(root, options.envFiles || DEFAULT_ENV_FILES);
  const results = REQUIREMENTS.map((requirement) => classifyRequirement(requirement, env.values));
  const summary = summarize(results);

  return {
    root,
    loaded_env_files: env.loaded,
    ready: summary.ready,
    summary,
    checks: results,
    next_step: summary.ready
      ? '운영 GTM/GA4/광고/CRM 값이 준비되어 있습니다. GTM Preview와 GA4 DebugView 검증으로 넘어가세요.'
      : 'missing/placeholders/invalid 항목을 실제 운영 값으로 채운 뒤 다시 검증하세요.'
  };
}

async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const rootArg = args.find((arg) => !arg.startsWith('--')) || process.cwd();
  const root = path.resolve(rootArg);
  const report = await validateDeploymentEnv(root);

  console.log(JSON.stringify(report, null, 2));

  if (strict && !report.ready) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { REQUIREMENTS, parseDotenv, validateDeploymentEnv };

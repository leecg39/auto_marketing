import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifySourceValues, maskValue } from './apply-marketing-env.mjs';
import { parseDotenv } from './validate-deployment-env.mjs';
import { validateGtmImport } from './verify-gtm-import.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_IMPORT = path.join(ROOT, 'dist', 'gtm-container-import.json');
const DEFAULT_BLUEPRINT = path.join(ROOT, 'config', 'gtm-workspace-blueprint.json');
const DEFAULT_OUTPUT = path.join(ROOT, 'dist', 'gtm-container-import.production.json');
const DEFAULT_ENV_FILES = ['.env.local', '.env.production', '.env', '.env.marketing'];

const CONSTANT_ENV_MAP = {
  'GA4 Measurement ID': 'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
  'Google Ads Conversion ID': 'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID',
  'Google Ads Purchase Label': 'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL',
  'Meta Pixel ID': 'NEXT_PUBLIC_META_PIXEL_ID'
};
const GTM_ENV_KEYS = new Set([
  'NEXT_PUBLIC_GTM_ID',
  ...Object.values(CONSTANT_ENV_MAP)
]);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function loadSiteEnv(siteRoot, envFile) {
  if (envFile) {
    return {
      loaded_env_files: [path.resolve(envFile)],
      values: parseDotenv(await readFile(envFile, 'utf8'))
    };
  }

  const loaded = [];
  const values = {};

  for (const fileName of DEFAULT_ENV_FILES) {
    const file = path.join(siteRoot, fileName);
    try {
      Object.assign(values, parseDotenv(await readFile(file, 'utf8')));
      loaded.push(fileName);
    } catch {
      // Missing env files are allowed; readiness validation below catches missing keys.
    }
  }

  return { loaded_env_files: loaded, values };
}

function setTemplateParameter(parameters, key, value) {
  const parameter = parameters?.find((entry) => entry.key === key);
  if (parameter) {
    parameter.value = value;
  }
}

function gtmConstantValue(variableName, value) {
  if (variableName === 'Google Ads Conversion ID') {
    return value.replace(/^AW-/i, '');
  }

  return value;
}

function selectGtmSourceStatus(sourceStatus) {
  const select = (keys = []) => keys.filter((key) => GTM_ENV_KEYS.has(key));
  const missing = select(sourceStatus.missing);
  const placeholders = select(sourceStatus.placeholders);
  const invalid = select(sourceStatus.invalid);

  return {
    ready: missing.length === 0 && placeholders.length === 0 && invalid.length === 0,
    missing,
    placeholders,
    invalid,
    checks: (sourceStatus.checks || []).filter((check) => GTM_ENV_KEYS.has(check.key))
  };
}

function renderGtmImport(containerImport, values, options = {}) {
  const rendered = JSON.parse(JSON.stringify(containerImport));
  const version = rendered.containerVersion;
  const publicId = options.publicId || values.NEXT_PUBLIC_GTM_ID;
  const changedConstants = {};

  if (version?.container) {
    version.container.publicId = publicId;
  }

  for (const variable of version?.variable || []) {
    const envKey = CONSTANT_ENV_MAP[variable.name];
    if (!envKey) {
      continue;
    }

    setTemplateParameter(variable.parameter, 'value', gtmConstantValue(variable.name, values[envKey]));
    changedConstants[variable.name] = {
      env_key: envKey,
      masked_value: maskValue(values[envKey])
    };
  }

  rendered.exportTime = new Date().toISOString();

  return {
    rendered,
    changed: {
      public_id: maskValue(publicId),
      constants: changedConstants
    }
  };
}

async function renderGtmImportFromEnv(options) {
  const siteRoot = path.resolve(options.siteRoot || process.cwd());
  const input = path.resolve(options.input || DEFAULT_IMPORT);
  const output = path.resolve(options.output || DEFAULT_OUTPUT);
  const blueprintFile = path.resolve(options.blueprint || DEFAULT_BLUEPRINT);
  const env = await loadSiteEnv(siteRoot, options.envFile);
  const sourceStatus = selectGtmSourceStatus(classifySourceValues(env.values));

  if (!sourceStatus.ready) {
    return {
      ok: false,
      dry_run: Boolean(options.dryRun),
      site_root: siteRoot,
      input,
      output,
      loaded_env_files: env.loaded_env_files,
      source_status: sourceStatus,
      changed: null,
      next_step: 'GTM 렌더링에 필요한 공개 env 값의 missing/placeholders/invalid 항목을 채운 뒤 render:gtm을 다시 실행하세요.'
    };
  }

  const [containerImport, blueprint] = await Promise.all([
    readJson(input),
    readJson(blueprintFile)
  ]);
  const { rendered, changed } = renderGtmImport(containerImport, env.values, {
    publicId: options.publicId
  });
  const verification = validateGtmImport(rendered, blueprint);

  if (!options.dryRun) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(rendered, null, 2)}\n`);
  }

  return {
    ok: verification.ok,
    dry_run: Boolean(options.dryRun),
    site_root: siteRoot,
    input,
    output,
    loaded_env_files: env.loaded_env_files,
    source_status: sourceStatus,
    changed,
    verification: {
      ok: verification.ok,
      summary: verification.summary,
      failed_checks: verification.checks.filter((check) => !check.ok).map((check) => check.id)
    },
    next_step: verification.ok
      ? '운영 GTM import 파일이 렌더링됐습니다. GTM Admin에서 이 파일을 가져온 뒤 Preview로 확인하세요.'
      : '렌더링된 GTM import 검증이 실패했습니다. failed_checks를 수정한 뒤 다시 실행하세요.'
  };
}

function parseArgs(args) {
  const parsed = {
    dryRun: false,
    input: DEFAULT_IMPORT,
    output: DEFAULT_OUTPUT,
    blueprint: DEFAULT_BLUEPRINT
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

    if (key === 'dry-run') {
      parsed.dryRun = true;
      continue;
    }
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
    if (key === 'env-file') {
      parsed.envFile = value;
    }
    if (key === 'input') {
      parsed.input = value;
    }
    if (key === 'output') {
      parsed.output = value;
    }
    if (key === 'blueprint') {
      parsed.blueprint = value;
    }
    if (key === 'public-id') {
      parsed.publicId = value;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  npm run render:gtm -- --site-root /path/to/store --output dist/gtm-container-import.production.json',
    '',
    'Options:',
    '  --env-file FILE   Use a specific env file instead of site env files.',
    '  --input FILE      Source GTM import. Default: dist/gtm-container-import.json',
    '  --output FILE     Rendered GTM import. Default: dist/gtm-container-import.production.json',
    '  --dry-run         Validate and report without writing.'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.siteRoot) {
    console.log(usage());
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const report = await renderGtmImportFromEnv(options);
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  renderGtmImport,
  renderGtmImportFromEnv
};

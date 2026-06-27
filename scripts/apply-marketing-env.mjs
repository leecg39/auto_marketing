import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDotenv, REQUIREMENTS, validateDeploymentEnv } from './validate-deployment-env.mjs';

const MARKETING_OPTIONAL_KEYS = [
  'DOWNSTREAM_CRM_API_KEY',
  'NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY'
];
const REQUIRED_KEYS = REQUIREMENTS.map((requirement) => requirement.key);
const MANAGED_KEYS = [...REQUIRED_KEYS, ...MARKETING_OPTIONAL_KEYS];

function maskValue(value) {
  if (!value) {
    return '';
  }
  if (value.length <= 6) {
    return '***';
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function classifySourceValues(values) {
  const checks = REQUIREMENTS.map((requirement) => {
    const value = values[requirement.key] || '';

    if (!value) {
      return { key: requirement.key, status: 'missing', ok: false };
    }
    if (requirement.placeholder.test(value)) {
      return { key: requirement.key, status: 'placeholder', ok: false };
    }
    if (!requirement.pattern.test(value)) {
      return { key: requirement.key, status: 'invalid_format', ok: false };
    }

    return { key: requirement.key, status: 'ready', ok: true };
  });

  return {
    ready: checks.every((check) => check.ok),
    missing: checks.filter((check) => check.status === 'missing').map((check) => check.key),
    placeholders: checks.filter((check) => check.status === 'placeholder').map((check) => check.key),
    invalid: checks.filter((check) => check.status === 'invalid_format').map((check) => check.key),
    checks
  };
}

function parseEnvLines(text) {
  return text.split(/\r?\n/).map((raw) => {
    const match = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return {
      raw,
      key: match?.[1] || null
    };
  });
}

function serializeEnv(lines) {
  return `${lines.map((line) => line.raw).join('\n').replace(/\n*$/, '')}\n`;
}

function quoteIfNeeded(value) {
  if (/[\s#'"]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function mergeEnvText(currentText, values, keys = MANAGED_KEYS) {
  const lines = parseEnvLines(currentText);
  const existing = new Set();
  const updated = [];
  const inserted = [];

  for (const line of lines) {
    if (line.key && keys.includes(line.key) && Object.prototype.hasOwnProperty.call(values, line.key)) {
      existing.add(line.key);
      updated.push(line.key);
      line.raw = `${line.key}=${quoteIfNeeded(values[line.key])}`;
    }
  }

  const missingKeys = keys.filter((key) => Object.prototype.hasOwnProperty.call(values, key) && !existing.has(key));
  if (missingKeys.length > 0) {
    const hasContent = lines.some((line) => line.raw.trim());
    if (hasContent && lines[lines.length - 1]?.raw.trim()) {
      lines.push({ raw: '', key: null });
    }
    lines.push({ raw: '# Marketing automation', key: null });

    for (const key of missingKeys) {
      inserted.push(key);
      lines.push({ raw: `${key}=${quoteIfNeeded(values[key])}`, key });
    }
  }

  return {
    text: serializeEnv(lines),
    updated,
    inserted
  };
}

async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function applyMarketingEnv(options) {
  const siteRoot = path.resolve(options.siteRoot || process.cwd());
  const sourceFile = path.resolve(options.envFile);
  const targetFile = path.resolve(options.target || path.join(siteRoot, '.env.local'));
  const sourceText = await readFile(sourceFile, 'utf8');
  const sourceValues = parseDotenv(sourceText);
  const pickedValues = {};

  for (const key of MANAGED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sourceValues, key)) {
      pickedValues[key] = sourceValues[key];
    }
  }

  if (!Object.prototype.hasOwnProperty.call(pickedValues, 'NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY')) {
    pickedValues.NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY = 'KRW';
  }

  const sourceStatus = classifySourceValues(pickedValues);
  if (!sourceStatus.ready) {
    return {
      ok: false,
      dry_run: Boolean(options.dryRun),
      site_root: siteRoot,
      source_file: sourceFile,
      target_file: targetFile,
      source_status: sourceStatus,
      changed_keys: [],
      masked_values: Object.fromEntries(Object.entries(pickedValues).map(([key, value]) => [key, maskValue(value)])),
      next_step: 'source env의 missing/placeholders/invalid 항목을 실제 운영 값으로 채운 뒤 다시 실행하세요.'
    };
  }

  const currentText = await readTextIfExists(targetFile);
  const merged = mergeEnvText(currentText, pickedValues);
  const changedKeys = [...new Set([...merged.updated, ...merged.inserted])];
  let backupFile = null;

  if (!options.dryRun) {
    await mkdir(path.dirname(targetFile), { recursive: true });
    if (currentText) {
      backupFile = `${targetFile}.backup-${timestamp()}`;
      await writeFile(backupFile, currentText);
    }
    await writeFile(targetFile, merged.text);
  }

  const envReport = options.dryRun
    ? null
    : await validateDeploymentEnv(siteRoot, { envFiles: [path.basename(targetFile)] });

  return {
    ok: true,
    dry_run: Boolean(options.dryRun),
    site_root: siteRoot,
    source_file: sourceFile,
    target_file: targetFile,
    backup_file: backupFile,
    changed_keys: changedKeys,
    updated_keys: merged.updated,
    inserted_keys: merged.inserted,
    masked_values: Object.fromEntries(Object.entries(pickedValues).map(([key, value]) => [key, maskValue(value)])),
    deployment_ready: envReport?.ready ?? null,
    env_summary: envReport?.summary || null,
    next_step: options.dryRun
      ? 'dry-run 결과를 확인했습니다. 실제 반영하려면 --dry-run 없이 다시 실행하세요.'
      : 'env 값을 반영했습니다. full:qa --require-env-ready와 GTM/GA4 DebugView 검증을 실행하세요.'
  };
}

function parseArgs(args) {
  const parsed = {
    dryRun: false
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
    if (key === 'target') {
      parsed.target = value;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  npm run apply:env -- --site-root /path/to/store --env-file /path/to/marketing.env --dry-run',
    '',
    'Options:',
    '  --env-file FILE  Source env file containing marketing automation values.',
    '  --target FILE    Target env file. Default: <site-root>/.env.local',
    '  --dry-run        Validate and report changes without writing.'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.siteRoot || !options.envFile) {
    console.log(usage());
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const report = await applyMarketingEnv(options);
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  applyMarketingEnv,
  classifySourceValues,
  maskValue,
  mergeEnvText,
  parseArgs
};

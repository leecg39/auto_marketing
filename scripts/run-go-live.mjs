import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMarketingEnv } from './apply-marketing-env.mjs';
import { auditCompletion, renderMarkdown as renderCompletionMarkdown } from './audit-completion.mjs';
import { generateDeploymentHandoff, renderMarkdown as renderHandoffMarkdown } from './generate-deployment-handoff.mjs';
import { buildContainerImport } from './generate-gtm-import.mjs';
import { renderGtmImportFromEnv } from './render-gtm-import-from-env.mjs';
import { parseArgs as parseFullQaArgs, runFullQa } from './run-full-qa.mjs';
import { validateDeploymentEnv } from './validate-deployment-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BLUEPRINT = path.join(KIT_ROOT, 'config', 'gtm-workspace-blueprint.json');
const DEFAULT_GTM_IMPORT = path.join(KIT_ROOT, 'dist', 'gtm-container-import.json');
const DEFAULT_PRODUCTION_GTM_IMPORT = path.join(KIT_ROOT, 'dist', 'gtm-container-import.production.json');
const DEFAULT_FULL_QA_REPORT = path.join(KIT_ROOT, 'dist', 'full-qa-report.json');
const DEFAULT_HANDOFF_OUTPUT = path.join(KIT_ROOT, 'dist', 'deployment-handoff.md');
const DEFAULT_HANDOFF_JSON = path.join(KIT_ROOT, 'dist', 'deployment-handoff.json');
const DEFAULT_COMPLETION_OUTPUT = path.join(KIT_ROOT, 'dist', 'completion-audit.md');
const DEFAULT_COMPLETION_JSON = path.join(KIT_ROOT, 'dist', 'completion-audit.json');
const DEFAULT_GO_LIVE_REPORT = path.join(KIT_ROOT, 'dist', 'go-live-report.json');
const DEFAULT_SITE_PORT = 3100;
const DEFAULT_TIMEOUT_MS = 240000;

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${value}\n`);
}

function step(id, title, status, details = {}, fatal = true) {
  return {
    id,
    title,
    status,
    ok: status === 'passed' || status === 'warning' || status === 'skipped',
    fatal,
    details
  };
}

function summarizeSteps(steps) {
  const counts = steps.reduce((accumulator, item) => {
    accumulator[item.status] = (accumulator[item.status] || 0) + 1;
    return accumulator;
  }, {});

  return {
    passed: counts.passed || 0,
    warning: counts.warning || 0,
    skipped: counts.skipped || 0,
    failed: counts.failed || 0
  };
}

function publicSummary(report) {
  if (!report) {
    return null;
  }

  return {
    local_qa_ok: report.local_qa_ok,
    deployment_ready: report.deployment_ready,
    summary: report.summary,
    report_file: report.report_file
  };
}

async function generateGtmImport(options) {
  const blueprint = await readJson(options.blueprint);
  const containerImport = buildContainerImport(blueprint, { publicId: 'GTM-XXXXXXX' });

  await writeJson(options.output, containerImport);

  return {
    ok: true,
    output: options.output,
    tags: containerImport.containerVersion.tag.length,
    triggers: containerImport.containerVersion.trigger.length,
    variables: containerImport.containerVersion.variable.length
  };
}

async function writeDeploymentHandoff(options) {
  const { report, markdown } = await generateDeploymentHandoff({
    siteRoot: options.siteRoot,
    fullQaReport: options.fullQaReport,
    gtmImport: options.gtmImport,
    completionAudit: options.completionJsonOutput
  });

  await writeText(options.handoffOutput, markdown);
  await writeJson(options.handoffJsonOutput, report);

  return {
    ok: true,
    output: options.handoffOutput,
    json_output: options.handoffJsonOutput,
    deployment_ready: report.env.ready,
    missing: report.env.summary.missing,
    placeholders: report.env.summary.placeholders,
    invalid: report.env.summary.invalid
  };
}

async function writeCompletionAudit(options) {
  const report = await auditCompletion({
    siteRoot: options.siteRoot,
    fullQaReport: options.fullQaReport,
    handoffReport: options.handoffJsonOutput
  });

  await writeText(options.completionOutput, renderCompletionMarkdown(report));
  await writeJson(options.completionJsonOutput, report);

  return {
    ok: report.completion_ready,
    output: options.completionOutput,
    json_output: options.completionJsonOutput,
    completion_ready: report.completion_ready,
    summary: report.summary,
    blocking_inputs: report.blocking_inputs
  };
}

async function maybeRunFullQa(options, envReport, renderReport) {
  if (options.skipFullQa) {
    return {
      skipped: true,
      reason: 'skip_full_qa'
    };
  }
  if (options.dryRun) {
    return {
      skipped: true,
      reason: 'dry_run'
    };
  }
  if (!envReport.ready || !renderReport.ok) {
    return {
      skipped: true,
      reason: 'env_or_gtm_not_ready',
      env_ready: envReport.ready,
      render_ok: renderReport.ok
    };
  }

  const args = [
    '--site-root',
    options.siteRoot,
    '--site-port',
    String(options.sitePort),
    '--timeout-ms',
    String(options.timeoutMs),
    '--report',
    options.fullQaReport,
    '--require-env-ready'
  ];

  if (options.startLocal) {
    args.push('--start-local');
  }
  if (options.startSite) {
    args.push('--start-site');
  }

  const fullQaOptions = parseFullQaArgs(args);
  const report = await runFullQa(fullQaOptions);
  await writeJson(options.fullQaReport, report);
  return report;
}

async function runGoLive(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const steps = [];

  let applyReport = null;
  if (options.envFile) {
    applyReport = await applyMarketingEnv({
      siteRoot: options.siteRoot,
      envFile: options.envFile,
      target: options.target,
      dryRun: options.dryRun
    });
    steps.push(step(
      'apply_env',
      options.dryRun ? 'Validate production marketing env source' : 'Apply production marketing env to site',
      applyReport.ok ? 'passed' : 'failed',
      {
        dry_run: applyReport.dry_run,
        target_file: applyReport.target_file,
        backup_file: applyReport.backup_file,
        changed_keys: applyReport.changed_keys,
        source_status: applyReport.source_status,
        deployment_ready: applyReport.deployment_ready,
        env_summary: applyReport.env_summary,
        masked_values: applyReport.masked_values
      }
    ));
  } else {
    steps.push(step('apply_env', 'Apply production marketing env to site', 'skipped', {
      reason: 'env_file_not_provided'
    }, false));
  }

  const hasFatalFailure = () => steps.some((item) => item.status === 'failed' && item.fatal);
  if (hasFatalFailure()) {
    return finalizeGoLiveReport(options, steps, null);
  }

  const gtmReport = await generateGtmImport({
    blueprint: options.blueprint,
    output: options.gtmImport
  });
  steps.push(step('generate_gtm_import', 'Generate base GTM import', 'passed', gtmReport));

  const renderReport = await renderGtmImportFromEnv({
    siteRoot: options.siteRoot,
    envFile: options.dryRun ? options.envFile : null,
    input: options.gtmImport,
    output: options.productionGtmImport,
    dryRun: options.dryRun
  });
  steps.push(step('render_gtm_import', options.dryRun ? 'Validate production GTM import rendering' : 'Render production GTM import', renderReport.ok ? 'passed' : 'failed', {
    dry_run: renderReport.dry_run,
    input: renderReport.input,
    output: renderReport.output,
    loaded_env_files: renderReport.loaded_env_files,
    source_status: renderReport.source_status,
    changed: renderReport.changed,
    verification: renderReport.verification
  }));

  const envReport = await validateDeploymentEnv(options.siteRoot);
  const envStatus = envReport.ready ? 'passed' : options.dryRun && options.envFile ? 'warning' : 'failed';
  steps.push(step('validate_site_env', 'Validate applied site env readiness', envStatus, {
    loaded_env_files: envReport.loaded_env_files,
    ready: envReport.ready,
    summary: envReport.summary
  }, !options.dryRun));

  const fullQaReport = await maybeRunFullQa(options, envReport, renderReport);
  steps.push(step(
    'full_qa_strict',
    'Run strict full QA',
    fullQaReport.skipped ? 'skipped' : fullQaReport.local_qa_ok && fullQaReport.deployment_ready === true ? 'passed' : 'failed',
    fullQaReport.skipped ? fullQaReport : publicSummary(fullQaReport),
    !options.dryRun && !options.skipFullQa
  ));

  const handoffReport = await writeDeploymentHandoff(options);
  steps.push(step('deployment_handoff', 'Regenerate deployment handoff', 'passed', handoffReport, false));

  const completionReport = await writeCompletionAudit(options);
  const completionStatus = completionReport.completion_ready ? 'passed' : options.dryRun ? 'warning' : 'failed';
  steps.push(step('completion_audit', 'Regenerate completion audit', completionStatus, completionReport, !options.dryRun));

  return finalizeGoLiveReport(options, steps, completionReport);
}

function finalizeGoLiveReport(options, steps, completionReport) {
  const summary = summarizeSteps(steps);
  const fatalFailure = steps.some((item) => item.status === 'failed' && item.fatal);
  const dryRunOk = options.dryRun && !fatalFailure;
  const goLiveReady = completionReport?.completion_ready === true;
  const ok = options.dryRun ? dryRunOk : goLiveReady && !fatalFailure;

  return {
    generated_at: new Date().toISOString(),
    dry_run: options.dryRun,
    site_root: options.siteRoot,
    ok,
    go_live_ready: goLiveReady,
    summary,
    steps,
    artifacts: {
      go_live_report: options.goLiveReport,
      gtm_import: options.gtmImport,
      production_gtm_import: options.productionGtmImport,
      full_qa_report: options.fullQaReport,
      deployment_handoff: options.handoffOutput,
      deployment_handoff_json: options.handoffJsonOutput,
      completion_audit: options.completionOutput,
      completion_audit_json: options.completionJsonOutput
    },
    next_step: ok
      ? options.dryRun
        ? 'dry-run이 통과했습니다. --dry-run 없이 실행하면 env 반영, GTM production import, strict QA까지 진행합니다.'
        : 'go-live 자동 검증이 완료되었습니다. GTM/GA4/광고 도구 화면에서 운영 수신을 최종 확인하세요.'
      : 'failed 또는 blocked 항목을 해결한 뒤 go-live를 다시 실행하세요.'
  };
}

function parseArgs(args) {
  const parsed = {
    dryRun: false,
    skipFullQa: false,
    startLocal: true,
    startSite: true,
    sitePort: DEFAULT_SITE_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    blueprint: DEFAULT_BLUEPRINT,
    gtmImport: DEFAULT_GTM_IMPORT,
    productionGtmImport: DEFAULT_PRODUCTION_GTM_IMPORT,
    fullQaReport: DEFAULT_FULL_QA_REPORT,
    handoffOutput: DEFAULT_HANDOFF_OUTPUT,
    handoffJsonOutput: DEFAULT_HANDOFF_JSON,
    completionOutput: DEFAULT_COMPLETION_OUTPUT,
    completionJsonOutput: DEFAULT_COMPLETION_JSON,
    goLiveReport: DEFAULT_GO_LIVE_REPORT
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
    if (key === 'skip-full-qa') {
      parsed.skipFullQa = true;
      continue;
    }
    if (key === 'no-start-local') {
      parsed.startLocal = false;
      continue;
    }
    if (key === 'no-start-site') {
      parsed.startSite = false;
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
    if (key === 'site-port') {
      parsed.sitePort = Number(value);
    }
    if (key === 'timeout-ms') {
      parsed.timeoutMs = Number(value);
    }
    if (key === 'blueprint') {
      parsed.blueprint = value;
    }
    if (key === 'gtm-import') {
      parsed.gtmImport = value;
    }
    if (key === 'production-gtm-import') {
      parsed.productionGtmImport = value;
    }
    if (key === 'full-qa-report') {
      parsed.fullQaReport = value;
    }
    if (key === 'handoff-output') {
      parsed.handoffOutput = value;
    }
    if (key === 'handoff-json-output') {
      parsed.handoffJsonOutput = value;
    }
    if (key === 'completion-output') {
      parsed.completionOutput = value;
    }
    if (key === 'completion-json-output') {
      parsed.completionJsonOutput = value;
    }
    if (key === 'report') {
      parsed.goLiveReport = value;
    }
  }

  return normalizeOptions(parsed);
}

function normalizeOptions(options) {
  const normalized = {
    ...options,
    dryRun: Boolean(options.dryRun),
    skipFullQa: Boolean(options.skipFullQa),
    startLocal: options.startLocal !== false,
    startSite: options.startSite !== false,
    sitePort: Number(options.sitePort || DEFAULT_SITE_PORT),
    timeoutMs: Number(options.timeoutMs || DEFAULT_TIMEOUT_MS),
    blueprint: path.resolve(options.blueprint || DEFAULT_BLUEPRINT),
    gtmImport: path.resolve(options.gtmImport || DEFAULT_GTM_IMPORT),
    productionGtmImport: path.resolve(options.productionGtmImport || DEFAULT_PRODUCTION_GTM_IMPORT),
    fullQaReport: path.resolve(options.fullQaReport || DEFAULT_FULL_QA_REPORT),
    handoffOutput: path.resolve(options.handoffOutput || DEFAULT_HANDOFF_OUTPUT),
    handoffJsonOutput: path.resolve(options.handoffJsonOutput || DEFAULT_HANDOFF_JSON),
    completionOutput: path.resolve(options.completionOutput || DEFAULT_COMPLETION_OUTPUT),
    completionJsonOutput: path.resolve(options.completionJsonOutput || DEFAULT_COMPLETION_JSON),
    goLiveReport: path.resolve(options.goLiveReport || DEFAULT_GO_LIVE_REPORT)
  };

  if (normalized.siteRoot) {
    normalized.siteRoot = path.resolve(normalized.siteRoot);
  }
  if (normalized.envFile) {
    normalized.envFile = path.resolve(normalized.envFile);
  }
  if (normalized.target) {
    normalized.target = path.resolve(normalized.target);
  }

  if (!Number.isFinite(normalized.sitePort) || normalized.sitePort <= 0) {
    throw new Error('--site-port must be a positive number');
  }
  if (!Number.isFinite(normalized.timeoutMs) || normalized.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }

  return normalized;
}

function usage() {
  return [
    'Usage:',
    '  npm run go:live -- --site-root /path/to/store --env-file /path/to/marketing-production.env --dry-run',
    '  npm run go:live -- --site-root /path/to/store --env-file /path/to/marketing-production.env',
    '',
    'Options:',
    '  --env-file FILE              Production marketing env file.',
    '  --target FILE                Target env file. Default: <site-root>/.env.local',
    '  --dry-run                    Validate source env and GTM rendering without writing site env or production GTM import.',
    '  --skip-full-qa               Skip strict full QA. Intended for tests only.',
    '  --no-start-local             Do not restart local demo/CRM/downstream during full QA.',
    '  --no-start-site              Do not start the applied store dev server during full QA.',
    '  --site-port PORT             Applied store dev server port. Default: 3100',
    '  --timeout-ms MS              Per-command timeout for full QA. Default: 240000',
    '  --report FILE                Go-live JSON report. Default: dist/go-live-report.json'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.siteRoot) {
    console.log(usage());
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const report = await runGoLive(options);
  await writeJson(options.goLiveReport, report);

  console.log(JSON.stringify({
    ok: report.ok,
    dry_run: report.dry_run,
    go_live_ready: report.go_live_ready,
    summary: report.summary,
    blocking_inputs: report.steps.find((item) => item.id === 'completion_audit')?.details?.blocking_inputs || [],
    report: options.goLiveReport,
    next_step: report.next_step
  }, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  parseArgs,
  runGoLive,
  summarizeSteps
};

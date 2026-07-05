import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SITE_PORT = 3100;
const DEFAULT_TIMEOUT_MS = 240000;
const DEFAULT_REPORT = path.join(KIT_ROOT, 'dist', 'ops-refresh-report.json');
const DEFAULT_FULL_QA_REPORT = path.join(KIT_ROOT, 'dist', 'full-qa-report.json');
const DEFAULT_DASHBOARD = path.join(KIT_ROOT, 'dist', 'growth-ops-dashboard.html');

function nowIso() {
  return new Date().toISOString();
}

function commandString(command, args = []) {
  return [command, ...args]
    .map((part) => /\s/.test(part) ? JSON.stringify(part) : part)
    .join(' ');
}

function excerpt(text, max = 5000) {
  const value = String(text || '');
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, Math.floor(max / 2))}\n...[truncated ${value.length - max} chars]...\n${value.slice(-Math.floor(max / 2))}`;
}

function extractJson(text) {
  const value = String(text || '');
  const start = value.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(value.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function parseArgs(args) {
  const parsed = {
    sitePort: DEFAULT_SITE_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    report: DEFAULT_REPORT,
    fullQaReport: DEFAULT_FULL_QA_REPORT,
    startLocal: false,
    startSite: false,
    requireEnvReady: false,
    skipFullQa: false,
    openDashboard: false
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
    if (key === 'start-local') {
      parsed.startLocal = true;
      continue;
    }
    if (key === 'start-site') {
      parsed.startSite = true;
      continue;
    }
    if (key === 'require-env-ready') {
      parsed.requireEnvReady = true;
      continue;
    }
    if (key === 'skip-full-qa') {
      parsed.skipFullQa = true;
      continue;
    }
    if (key === 'open-dashboard') {
      parsed.openDashboard = true;
      continue;
    }

    if (equalsIndex < 0) {
      index += 1;
    }

    if (key === 'site-root') {
      parsed.siteRoot = value;
    }
    if (key === 'site-port') {
      parsed.sitePort = Number(value);
    }
    if (key === 'timeout-ms') {
      parsed.timeoutMs = Number(value);
    }
    if (key === 'report') {
      parsed.report = path.resolve(value);
    }
    if (key === 'full-qa-report') {
      parsed.fullQaReport = path.resolve(value);
    }
  }

  if (!Number.isFinite(parsed.sitePort) || parsed.sitePort <= 0) {
    throw new Error('--site-port must be a positive number');
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  if (parsed.siteRoot) {
    parsed.siteRoot = path.resolve(parsed.siteRoot);
  }

  return parsed;
}

function buildSteps(options) {
  const steps = [];

  if (options.skipFullQa) {
    steps.push({
      id: 'full_qa',
      label: 'Full QA refresh',
      skip: true,
      reason: 'skip_full_qa'
    });
  } else {
    const args = [
      path.join(KIT_ROOT, 'scripts', 'run-full-qa.mjs'),
      '--site-root',
      options.siteRoot,
      '--site-port',
      String(options.sitePort),
      '--timeout-ms',
      String(options.timeoutMs),
      '--report',
      options.fullQaReport
    ];

    if (options.startLocal) {
      args.push('--start-local');
    }
    if (options.startSite) {
      args.push('--start-site');
    }
    if (options.requireEnvReady) {
      args.push('--require-env-ready');
    }

    steps.push({
      id: 'full_qa',
      label: 'Full QA refresh',
      command: process.execPath,
      args
    });
  }

  steps.push(
    {
      id: 'handoff',
      label: 'Deployment handoff refresh',
      command: process.execPath,
      args: [
        path.join(KIT_ROOT, 'scripts', 'generate-deployment-handoff.mjs'),
        '--site-root',
        options.siteRoot
      ]
    },
    {
      id: 'completion_audit',
      label: 'Completion audit refresh',
      command: process.execPath,
      args: [
        path.join(KIT_ROOT, 'scripts', 'audit-completion.mjs'),
        '--site-root',
        options.siteRoot
      ]
    },
    {
      id: 'ops_dashboard',
      label: 'Growth Ops dashboard refresh',
      command: process.execPath,
      args: [
        path.join(KIT_ROOT, 'scripts', 'generate-ops-dashboard.mjs'),
        '--site-root',
        options.siteRoot,
        '--full-qa-report',
        options.fullQaReport
      ]
    }
  );

  if (options.openDashboard) {
    steps.push({
      id: 'open_dashboard',
      label: 'Open Growth Ops dashboard',
      command: 'open',
      args: [DEFAULT_DASHBOARD],
      optional: true
    });
  }

  return steps;
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

function stepResult(step, status, details = {}) {
  return {
    id: step.id,
    label: step.label,
    status,
    ok: status === 'passed' || status === 'warning' || status === 'skipped',
    optional: Boolean(step.optional),
    ...details
  };
}

function runCommand(step) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(step.command, step.args, {
      cwd: KIT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve(stepResult(step, step.optional ? 'warning' : 'failed', {
        command: commandString(step.command, step.args),
        duration_ms: Date.now() - startedAt,
        error: error.message,
        stdout: excerpt(stdout),
        stderr: excerpt(stderr)
      }));
    });
    child.on('close', (exitCode, signal) => {
      const passed = exitCode === 0;
      resolve(stepResult(step, passed ? 'passed' : step.optional ? 'warning' : 'failed', {
        command: commandString(step.command, step.args),
        exit_code: exitCode,
        signal,
        duration_ms: Date.now() - startedAt,
        stdout: excerpt(stdout),
        stderr: excerpt(stderr),
        json: extractJson(stdout)
      }));
    });
  });
}

async function runOpsRefresh(rawOptions, runner = runCommand) {
  const options = parseArgs(rawOptions);
  if (!options.siteRoot) {
    throw new Error('--site-root is required');
  }

  const steps = [];
  for (const step of buildSteps(options)) {
    if (step.skip) {
      steps.push(stepResult(step, 'skipped', { reason: step.reason }));
      continue;
    }

    steps.push(await runner(step));
  }

  const summary = summarizeSteps(steps);
  const report = {
    generated_at: nowIso(),
    site_root: options.siteRoot,
    ok: summary.failed === 0,
    summary,
    dashboard: DEFAULT_DASHBOARD,
    steps
  };

  await mkdir(path.dirname(options.report), { recursive: true });
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);

  return {
    ...report,
    report_file: options.report
  };
}

function printHelp() {
  console.log([
    'Usage: npm run ops:refresh -- --site-root /path/to/store',
    '',
    'Options:',
    '  --site-root <path>       Storefront root',
    '  --start-local            Start kit demo/CRM/downstream servers during full QA',
    '  --start-site             Start the storefront dev server during full QA',
    '  --site-port <number>     Storefront dev server port, default 3100',
    '  --timeout-ms <number>    Per-command timeout passed to full QA, default 240000',
    '  --require-env-ready      Treat missing operating env as full QA failure',
    '  --skip-full-qa           Regenerate handoff/audit/dashboard from existing QA evidence',
    '  --open-dashboard         Open dist/growth-ops-dashboard.html after refresh',
    '  --report <path>          JSON refresh report output'
  ].join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    return;
  }

  const report = await runOpsRefresh(args);
  console.log(JSON.stringify({
    ok: report.ok,
    report_file: report.report_file,
    dashboard: report.dashboard,
    summary: report.summary
  }, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  buildSteps,
  extractJson,
  parseArgs,
  runOpsRefresh,
  summarizeSteps
};

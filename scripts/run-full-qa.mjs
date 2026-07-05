import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPORT = path.join(KIT_ROOT, 'dist', 'full-qa-report.json');
const DEFAULT_SITE_PORT = 3100;
const DEFAULT_TIMEOUT_MS = 180000;

function nowIso() {
  return new Date().toISOString();
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
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
    live: true,
    siteChecks: true,
    startLocal: false,
    startSite: false,
    requireEnvReady: false,
    siteEventProbe: false,
    sitePort: DEFAULT_SITE_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    report: DEFAULT_REPORT
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

    if (key === 'skip-live') {
      parsed.live = false;
      continue;
    }
    if (key === 'skip-site') {
      parsed.siteChecks = false;
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
    if (key === 'site-event-probe') {
      parsed.siteEventProbe = true;
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
    if (key === 'site-url') {
      parsed.siteUrl = value;
    }
    if (key === 'site-port') {
      parsed.sitePort = Number(value);
    }
    if (key === 'report') {
      parsed.report = path.resolve(value);
    }
    if (key === 'timeout-ms') {
      parsed.timeoutMs = Number(value);
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
  if (parsed.startSite && !parsed.siteUrl) {
    parsed.siteUrl = `http://127.0.0.1:${parsed.sitePort}`;
  }

  return parsed;
}

function buildSteps(options) {
  const steps = [];

  if (options.startLocal) {
    steps.push({
      id: 'start_local_servers',
      label: 'Start local demo, CRM, and downstream simulator',
      cwd: KIT_ROOT,
      command: 'npm',
      args: ['run', 'start:local'],
      fatal: true
    });
  }

  steps.push(
    {
      id: 'kit_check',
      label: 'Kit syntax checks',
      cwd: KIT_ROOT,
      command: 'npm',
      args: ['run', 'check'],
      fatal: true
    },
    {
      id: 'kit_tests',
      label: 'Kit test suite',
      cwd: KIT_ROOT,
      command: 'npm',
      args: ['test'],
      fatal: true
    },
    {
      id: 'gtm_import',
      label: 'Generate GTM import container',
      cwd: KIT_ROOT,
      command: 'npm',
      args: ['run', 'generate:gtm', '--', '--public-id', 'GTM-XXXXXXX'],
      fatal: true,
      expectJson: true
    },
    {
      id: 'gtm_import_verify',
      label: 'Verify GTM import tags, triggers, variables, and consent settings',
      cwd: KIT_ROOT,
      command: 'npm',
      args: ['run', 'verify:gtm'],
      fatal: true,
      expectJson: true
    },
    {
      id: 'revenue_reconciliation',
      label: 'Example order DB vs GA4 revenue reconciliation',
      cwd: KIT_ROOT,
      command: 'npm',
      args: [
        'run',
        'reconcile:revenue',
        '--',
        '--orders',
        'examples/orders-revenue.csv',
        '--ga4',
        'examples/ga4-revenue.csv',
        '--threshold',
        '0.05'
      ],
      fatal: true,
      expectJson: true
    }
  );

  if (options.live) {
    steps.push(
      {
        id: 'local_e2e',
        label: 'Local demo, CRM, automation actions, and downstream delivery',
        cwd: KIT_ROOT,
        command: 'npm',
        args: ['run', 'verify:local'],
        fatal: true,
        expectJson: true
      },
      {
        id: 'browser_demo_e2e',
        label: 'Headless Chrome demo funnel and UTM attribution QA',
        cwd: KIT_ROOT,
        command: 'npm',
        args: ['run', 'verify:browser'],
        fatal: true,
        expectJson: true
      }
    );
  }

  if (options.siteChecks && options.siteRoot) {
    steps.push(
      {
        id: 'site_audit',
        label: 'Applied store installation audit',
        cwd: KIT_ROOT,
        command: 'npm',
        args: ['run', 'audit:site', '--', options.siteRoot],
        fatal: true,
        expectJson: true
      },
      {
        id: 'site_env',
        label: 'Applied store deployment env readiness',
        cwd: KIT_ROOT,
        command: 'npm',
        args: ['run', 'validate:env', '--', options.siteRoot],
        fatal: options.requireEnvReady,
        expectJson: true,
        readiness: 'deployment_env'
      },
      {
        id: 'gtm_import_render',
        label: 'Render GTM import with applied store production env values',
        cwd: KIT_ROOT,
        command: 'npm',
        args: ['run', 'render:gtm', '--', '--site-root', options.siteRoot],
        fatal: options.requireEnvReady,
        expectJson: true,
        readiness: 'requires_deployment_env'
      },
      {
        id: 'site_lint',
        label: 'Applied store lint',
        cwd: options.siteRoot,
        command: 'npm',
        args: ['run', 'lint'],
        fatal: true
      },
      {
        id: 'site_tests',
        label: 'Applied store tests',
        cwd: options.siteRoot,
        command: 'npm',
        args: ['test'],
        fatal: true
      },
      {
        id: 'site_build',
        label: 'Applied store production build',
        cwd: options.siteRoot,
        command: 'npm',
        args: ['run', 'build'],
        fatal: true
      }
    );
  }

  if (options.siteChecks && options.siteUrl) {
    const siteRuntimeArgs = ['run', 'verify:site', '--', '--site-url', options.siteUrl];
    if (options.siteEventProbe) {
      siteRuntimeArgs.push('--event-probe');
    }

    steps.push({
      id: 'site_runtime',
      label: options.siteEventProbe
        ? 'Applied store runtime SDK, event probe, consent UI, and CRM route QA'
        : 'Applied store runtime SDK, consent UI, and CRM route QA',
      cwd: KIT_ROOT,
      command: 'npm',
      args: siteRuntimeArgs,
      fatal: true,
      expectJson: true,
      requiresSiteServer: true
    });
  }

  return steps;
}

async function runCommand(step, options = {}) {
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(step.env || {})
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        id: step.id,
        label: step.label,
        command: commandString(step.command, step.args),
        cwd: step.cwd,
        exit_code: code,
        signal,
        timed_out: timedOut,
        duration_ms: elapsedMs(startedAt),
        stdout: excerpt(stdout),
        stderr: excerpt(stderr),
        json: step.expectJson ? extractJson(stdout) : null,
        ok: code === 0 && !timedOut
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        id: step.id,
        label: step.label,
        command: commandString(step.command, step.args),
        cwd: step.cwd,
        exit_code: null,
        signal: null,
        timed_out: timedOut,
        duration_ms: elapsedMs(startedAt),
        stdout: excerpt(stdout),
        stderr: excerpt(`${stderr}\n${error.message}`),
        json: null,
        ok: false
      });
    });
  });
}

async function waitForHttp(url, timeoutMs = 45000) {
  const startedAt = Date.now();
  let lastError = '';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          waited_ms: elapsedMs(startedAt)
        };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    ok: false,
    status: null,
    waited_ms: elapsedMs(startedAt),
    error: lastError || 'timeout'
  };
}

async function withSiteServer(options, callback) {
  if (!options.startSite) {
    return callback(null);
  }

  if (!options.siteRoot) {
    throw new Error('--start-site requires --site-root');
  }

  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  const child = spawn('npm', ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', String(options.sitePort)], {
    cwd: options.siteRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const readiness = await waitForHttp(options.siteUrl, options.timeoutMs);
  const serverStep = {
    id: 'start_site_server',
    label: 'Start applied store dev server',
    command: `npm run dev -- --hostname 127.0.0.1 --port ${options.sitePort}`,
    cwd: options.siteRoot,
    exit_code: null,
    signal: null,
    timed_out: false,
    duration_ms: elapsedMs(startedAt),
    stdout: excerpt(stdout),
    stderr: excerpt(stderr),
    json: readiness,
    ok: readiness.ok
  };

  if (!readiness.ok) {
    child.kill('SIGTERM');
    return callback(serverStep);
  }

  try {
    return await callback(serverStep);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function deriveStepStatus(step, result, options) {
  if (step.readiness === 'requires_deployment_env' && !result.ok && !options.requireEnvReady) {
    return 'warning';
  }

  if (!result.ok) {
    return 'failed';
  }

  if (step.readiness === 'deployment_env') {
    if (result.json?.ready === true) {
      return 'passed';
    }
    return options.requireEnvReady ? 'failed' : 'warning';
  }

  return 'passed';
}

function summarize(results) {
  const counts = results.reduce((accumulator, result) => {
    accumulator[result.status] = (accumulator[result.status] || 0) + 1;
    return accumulator;
  }, {});

  return {
    passed: counts.passed || 0,
    warning: counts.warning || 0,
    skipped: counts.skipped || 0,
    failed: counts.failed || 0
  };
}

async function runFullQa(options, executor = runCommand) {
  const startedAt = Date.now();
  const steps = buildSteps(options);
  const results = [];

  for (const step of steps) {
    if (step.requiresSiteServer && options.startSite) {
      let shouldStop = false;
      await withSiteServer(options, async (siteServerStep) => {
        if (siteServerStep) {
          results.push({
            ...siteServerStep,
            status: siteServerStep.ok ? 'passed' : 'failed',
            fatal: true
          });

          if (!siteServerStep.ok) {
            shouldStop = true;
            return;
          }
        }

        const result = await executor(step, { timeoutMs: options.timeoutMs });
        const status = deriveStepStatus(step, result, options);
        results.push({
          ...result,
          fatal: step.fatal,
          status
        });

        if (status === 'failed' && step.fatal) {
          shouldStop = true;
        }
      });

      if (shouldStop) {
        break;
      }
      continue;
    }

    const result = await executor(step, { timeoutMs: options.timeoutMs });
    const status = deriveStepStatus(step, result, options);
    results.push({
      ...result,
      fatal: step.fatal,
      status
    });

    if (status === 'failed' && step.fatal) {
      break;
    }
  }

  const summary = summarize(results);
  const envStep = results.find((result) => result.id === 'site_env');
  const deploymentReady = envStep ? envStep.json?.ready === true : null;
  const localQaOk = results.every((result) => result.status !== 'failed');

  return {
    generated_at: nowIso(),
    duration_ms: elapsedMs(startedAt),
    local_qa_ok: localQaOk,
    deployment_ready: deploymentReady,
    require_env_ready: options.requireEnvReady,
    summary,
    report_file: options.report,
    steps: results,
    next_step: deploymentReady === false
      ? '로컬 자동화 QA는 실행됐지만 운영 GTM/GA4/광고/CRM 값이 아직 없습니다. env 값을 채운 뒤 --require-env-ready로 다시 실행하세요.'
      : localQaOk
        ? 'Full QA가 통과했습니다. 운영 계정값과 GTM/GA4 DebugView 검증 상태를 확인하세요.'
        : '실패한 fatal step을 수정한 뒤 full QA를 다시 실행하세요.'
  };
}

async function writeReport(report, file) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
}

function usage() {
  return [
    'Usage:',
    '  npm run full:qa -- --site-root /path/to/store --start-local --start-site --site-port 3100',
    '',
    'Options:',
    '  --site-root /path       Run applied store audit/lint/test/build/env checks.',
    '  --site-url URL          Run runtime site QA against an already running store.',
    '  --start-site            Start the applied store dev server for runtime QA.',
    '  --start-local           Restart local demo, CRM, and downstream tmux servers before live QA.',
    '  --skip-live             Skip verify:local and verify:browser.',
    '  --skip-site             Skip applied store checks.',
    '  --require-env-ready     Treat missing GTM/GA4/Ads/CRM env values as a failure.',
    '  --site-event-probe      Execute SDK event probe during applied store runtime QA.',
    '  --report FILE           Write JSON report. Default: dist/full-qa-report.json'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const report = await runFullQa(options);
  await writeReport(report, options.report);

  console.log(JSON.stringify({
    generated_at: report.generated_at,
    local_qa_ok: report.local_qa_ok,
    deployment_ready: report.deployment_ready,
    summary: report.summary,
    report_file: report.report_file,
    next_step: report.next_step
  }, null, 2));

  if (!report.local_qa_ok || (options.requireEnvReady && report.deployment_ready !== true)) {
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
  runFullQa,
  summarize
};

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SITE_PORT = 3101;
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_REPORT = path.join(KIT_ROOT, 'dist', 'production-runtime-report.json');

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
    build: false,
    eventProbe: false,
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

    if (key === 'help') {
      parsed.help = true;
      continue;
    }
    if (key === 'build') {
      parsed.build = true;
      continue;
    }
    if (key === 'event-probe') {
      parsed.eventProbe = true;
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
    if (key === 'site-url') {
      parsed.siteUrl = value;
    }
    if (key === 'timeout-ms') {
      parsed.timeoutMs = Number(value);
    }
    if (key === 'report') {
      parsed.report = path.resolve(value);
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
  if (!parsed.siteUrl) {
    parsed.siteUrl = `http://127.0.0.1:${parsed.sitePort}`;
  }

  return parsed;
}

function buildStartArgs(options) {
  return [
    'run',
    'start',
    '--',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(options.sitePort)
  ];
}

function buildVerifySiteArgs(options) {
  const args = ['run', 'verify:site', '--', '--site-url', options.siteUrl];
  if (options.eventProbe) {
    args.push('--event-probe');
  }
  return args;
}

async function isPortFree(port) {
  const server = createServer();

  return await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForHttp(url, timeoutMs = DEFAULT_TIMEOUT_MS, getExitState = () => null) {
  const startedAt = Date.now();
  let lastError = '';

  while (Date.now() - startedAt < timeoutMs) {
    const exitState = getExitState();
    if (exitState) {
      return {
        ok: false,
        status: null,
        waited_ms: elapsedMs(startedAt),
        error: `server exited before readiness: code=${exitState.code} signal=${exitState.signal || 'null'}`
      };
    }

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

async function startProductionServer(options) {
  const startedAt = Date.now();
  const args = buildStartArgs(options);
  let stdout = '';
  let stderr = '';
  let exitState = null;

  if (!await isPortFree(options.sitePort)) {
    return {
      child: null,
      result: {
        id: 'start_production_server',
        label: 'Start applied store production server',
        command: commandString('npm', args),
        cwd: options.siteRoot,
        exit_code: null,
        signal: null,
        timed_out: false,
        duration_ms: elapsedMs(startedAt),
        stdout: '',
        stderr: `Port ${options.sitePort} is already in use.`,
        json: {
          ok: false,
          error: 'port_in_use',
          port: options.sitePort
        },
        ok: false
      }
    };
  }

  const child = spawn('npm', args, {
    cwd: options.siteRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('close', (code, signal) => {
    exitState = { code, signal };
  });

  const readiness = await waitForHttp(options.siteUrl, options.timeoutMs, () => exitState);

  return {
    child,
    result: {
      id: 'start_production_server',
      label: 'Start applied store production server',
      command: commandString('npm', args),
      cwd: options.siteRoot,
      exit_code: exitState?.code ?? null,
      signal: exitState?.signal ?? null,
      timed_out: false,
      duration_ms: elapsedMs(startedAt),
      stdout: excerpt(stdout),
      stderr: excerpt(stderr),
      json: readiness,
      ok: readiness.ok
    }
  };
}

async function stopChild(child) {
  if (!child || child.killed) {
    return;
  }

  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    return;
  }

  const closed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2500);
    child.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!closed) {
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // The process may already be gone.
    }
  }
}

function summarize(results) {
  const counts = results.reduce((accumulator, result) => {
    accumulator[result.status] = (accumulator[result.status] || 0) + 1;
    return accumulator;
  }, {});

  return {
    passed: counts.passed || 0,
    failed: counts.failed || 0
  };
}

async function writeReport(report, file) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
}

async function runProductionRuntime(options, runtime = {}) {
  const startedAt = Date.now();
  const results = [];
  const runStep = runtime.runCommand || runCommand;
  const startServer = runtime.startProductionServer || startProductionServer;
  const stopServer = runtime.stopChild || stopChild;

  if (!options.siteRoot) {
    throw new Error('--site-root is required');
  }

  if (options.build) {
    const buildStep = {
      id: 'site_build',
      label: 'Applied store production build',
      cwd: options.siteRoot,
      command: 'npm',
      args: ['run', 'build']
    };
    const buildResult = await runStep(buildStep, { timeoutMs: options.timeoutMs });
    results.push({
      ...buildResult,
      status: buildResult.ok ? 'passed' : 'failed'
    });

    if (!buildResult.ok) {
      const report = makeReport(options, results, startedAt);
      await writeReport(report, options.report);
      return report;
    }
  }

  const server = await startServer(options);
  results.push({
    ...server.result,
    status: server.result.ok ? 'passed' : 'failed'
  });

  try {
    if (server.result.ok) {
      const verifyStep = {
        id: 'site_production_runtime',
        label: options.eventProbe
          ? 'Applied store production runtime SDK, event probe, consent UI, and CRM route QA'
          : 'Applied store production runtime SDK, consent UI, and CRM route QA',
        cwd: KIT_ROOT,
        command: 'npm',
        args: buildVerifySiteArgs(options),
        expectJson: true
      };
      const verifyResult = await runStep(verifyStep, { timeoutMs: options.timeoutMs });
      results.push({
        ...verifyResult,
        status: verifyResult.ok ? 'passed' : 'failed'
      });
    }
  } finally {
    await stopServer(server.child);
  }

  const report = makeReport(options, results, startedAt);
  await writeReport(report, options.report);
  return report;
}

function makeReport(options, results, startedAt) {
  const summary = summarize(results);
  const ok = summary.failed === 0;

  return {
    generated_at: nowIso(),
    duration_ms: elapsedMs(startedAt),
    ok,
    site_root: options.siteRoot,
    site_url: options.siteUrl,
    build: options.build,
    event_probe: options.eventProbe,
    summary,
    report_file: options.report,
    steps: results,
    next_step: ok
      ? 'Production runtime QA가 통과했습니다. 운영 도메인과 외부 계정값을 채운 뒤 같은 검증을 배포 URL에서 다시 실행하세요.'
      : '실패한 production runtime step을 수정한 뒤 다시 실행하세요.'
  };
}

function usage() {
  return [
    'Usage:',
    '  npm run verify:prod-site -- --site-root /path/to/store --build --event-probe',
    '',
    'Options:',
    '  --site-root /path       Storefront root.',
    '  --build                 Run npm run build before starting production server.',
    '  --site-port <number>    Local production server port. Default: 3101.',
    '  --site-url URL          Runtime URL. Default: http://127.0.0.1:<site-port>.',
    '  --event-probe           Execute SDK event probe during production runtime QA.',
    '  --timeout-ms <number>   Per-step timeout. Default: 180000.',
    '  --report FILE           Write JSON report. Default: dist/production-runtime-report.json.'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.siteRoot) {
    console.error(usage());
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const report = await runProductionRuntime(options);
  console.log(JSON.stringify({
    ok: report.ok,
    site_url: report.site_url,
    summary: report.summary,
    report_file: report.report_file,
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
  buildStartArgs,
  buildVerifySiteArgs,
  extractJson,
  isPortFree,
  parseArgs,
  runProductionRuntime,
  summarize,
  waitForHttp
};

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDeploymentEnv } from './validate-deployment-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MARKDOWN_OUTPUT = path.join(KIT_ROOT, 'dist', 'deployment-target-plan.md');
const DEFAULT_JSON_OUTPUT = path.join(KIT_ROOT, 'dist', 'deployment-target-plan.json');
const DEFAULT_TIMEOUT_MS = 10000;

const PRODUCTION_ENV_KEYS = [
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_GTM_ID',
  'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
  'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID',
  'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL',
  'NEXT_PUBLIC_META_PIXEL_ID',
  'NEXT_PUBLIC_CRM_WEBHOOK_URL',
  'DOWNSTREAM_CRM_WEBHOOK_URL',
  'DOWNSTREAM_CRM_API_KEY',
  'NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY'
];

async function pathExists(file) {
  try {
    await access(file);
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

async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function quoteShell(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function commandString(parts) {
  return parts.map(quoteShell).join(' ');
}

function firstUsefulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('─') && !/^Update available/i.test(line) && !/^Changelog:/i.test(line) && !/^Run `npm/i.test(line)) || '';
}

function detectPackageManager(files) {
  if (files.has('pnpm-lock.yaml')) {
    return 'pnpm';
  }
  if (files.has('yarn.lock')) {
    return 'yarn';
  }
  if (files.has('bun.lockb') || files.has('bun.lock')) {
    return 'bun';
  }
  return 'npm';
}

function scriptCommand(packageManager, scriptName) {
  if (packageManager === 'yarn') {
    return `yarn ${scriptName}`;
  }
  if (packageManager === 'pnpm') {
    return `pnpm ${scriptName}`;
  }
  if (packageManager === 'bun') {
    return `bun run ${scriptName}`;
  }
  return `npm run ${scriptName}`;
}

async function collectRootFiles(root) {
  const names = [
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'bun.lock',
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'vercel.json',
    'netlify.toml',
    'wrangler.toml',
    'Dockerfile',
    'fly.toml',
    'render.yaml'
  ];

  const files = new Set();
  for (const name of names) {
    if (await pathExists(path.join(root, name))) {
      files.add(name);
    }
  }

  if (await pathExists(path.join(root, '.vercel', 'project.json'))) {
    files.add('.vercel/project.json');
  }
  if (await pathExists(path.join(root, '.netlify', 'state.json'))) {
    files.add('.netlify/state.json');
  }

  return files;
}

function detectFramework(packageJson, files) {
  const dependencies = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {})
  };
  const scripts = packageJson?.scripts || {};
  const hasNextDependency = Boolean(dependencies.next);
  const hasNextBuild = /(^|\s)next\s+build(\s|$)/.test(scripts.build || '');
  const hasNextConfig = ['next.config.js', 'next.config.mjs', 'next.config.ts'].some((file) => files.has(file));

  if (hasNextDependency || hasNextBuild || hasNextConfig) {
    return {
      name: 'next',
      detected: true,
      signals: {
        dependency: hasNextDependency,
        build_script: hasNextBuild,
        config_file: hasNextConfig
      }
    };
  }

  return {
    name: 'unknown',
    detected: false,
    signals: {
      dependency: false,
      build_script: false,
      config_file: false
    }
  };
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
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
        command: commandString([command, ...args]),
        exit_code: code,
        signal,
        timed_out: timedOut,
        stdout,
        stderr,
        ok: code === 0 && !timedOut
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        command: commandString([command, ...args]),
        exit_code: null,
        signal: null,
        timed_out: timedOut,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        ok: false
      });
    });
  });
}

async function inspectVercel(root, files, runner = runCommand) {
  const projectJson = await readJsonIfExists(path.join(root, '.vercel', 'project.json'));
  const version = await runner('vercel', ['--version'], { cwd: root, timeoutMs: DEFAULT_TIMEOUT_MS });
  const whoami = version.ok
    ? await runner('vercel', ['whoami'], { cwd: root, timeoutMs: DEFAULT_TIMEOUT_MS })
    : null;

  return {
    detected: files.has('vercel.json') || files.has('.vercel/project.json') || version.ok,
    config_file: files.has('vercel.json') ? 'vercel.json' : '',
    project_linked: Boolean(projectJson?.projectId && projectJson?.orgId),
    project_id: projectJson?.projectId || '',
    org_id: projectJson?.orgId || '',
    cli: {
      available: version.ok,
      version: firstUsefulLine(version.stdout || version.stderr),
      logged_in: Boolean(whoami?.ok),
      account: whoami?.ok ? firstUsefulLine(whoami.stdout || whoami.stderr) : '',
      error: version.ok ? '' : firstUsefulLine(version.stderr || version.stdout)
    }
  };
}

async function inspectDeploymentTarget(options, runtime = {}) {
  const siteRoot = path.resolve(options.siteRoot || process.cwd());
  const files = await collectRootFiles(siteRoot);
  const packageJson = await readJsonIfExists(path.join(siteRoot, 'package.json'));
  const packageManager = detectPackageManager(files);
  const framework = detectFramework(packageJson, files);
  const env = await validateDeploymentEnv(siteRoot);
  const vercel = await inspectVercel(siteRoot, files, runtime.runCommand || runCommand);
  const netlify = {
    detected: files.has('netlify.toml') || files.has('.netlify/state.json'),
    config_file: files.has('netlify.toml') ? 'netlify.toml' : '',
    project_linked: files.has('.netlify/state.json')
  };
  const cloudflare = {
    detected: files.has('wrangler.toml'),
    config_file: files.has('wrangler.toml') ? 'wrangler.toml' : ''
  };
  const generic = {
    dockerfile: files.has('Dockerfile'),
    fly: files.has('fly.toml'),
    render: files.has('render.yaml')
  };

  const commands = buildRecommendedCommands(siteRoot, packageManager);
  const blockers = buildBlockers({
    framework,
    env,
    vercel,
    netlify,
    cloudflare,
    generic
  });
  const ready = blockers.length === 0;

  return {
    generated_at: new Date().toISOString(),
    site_root: siteRoot,
    ready_for_production_deploy: ready,
    framework,
    package_manager: packageManager,
    scripts: {
      build: packageJson?.scripts?.build || '',
      start: packageJson?.scripts?.start || '',
      recommended_build: scriptCommand(packageManager, 'build'),
      recommended_start: scriptCommand(packageManager, 'start')
    },
    hosting: {
      vercel,
      netlify,
      cloudflare,
      generic
    },
    env: {
      ready: env.ready,
      summary: env.summary,
      url_discovery: env.url_discovery
    },
    blockers,
    recommended_platform: chooseRecommendedPlatform({ framework, vercel, netlify, cloudflare, generic }),
    commands,
    confirmation_required: commands.filter((command) => command.confirmation_required),
    next_step: nextStep(blockers, vercel, env)
  };
}

function chooseRecommendedPlatform({ framework, vercel, netlify, cloudflare, generic }) {
  if (vercel.detected || framework.name === 'next') {
    return {
      id: 'vercel',
      reason: framework.name === 'next'
        ? 'Next.js 앱이고 Vercel CLI가 설치되어 있어 production domain 확보 경로가 가장 짧습니다.'
        : 'Vercel 설정 또는 CLI가 감지되었습니다.'
    };
  }
  if (netlify.detected) {
    return {
      id: 'netlify',
      reason: 'Netlify 설정이 감지되었습니다.'
    };
  }
  if (cloudflare.detected) {
    return {
      id: 'cloudflare',
      reason: 'Cloudflare Wrangler 설정이 감지되었습니다.'
    };
  }
  if (generic.dockerfile || generic.fly || generic.render) {
    return {
      id: 'generic',
      reason: '범용 배포 설정이 감지되었습니다.'
    };
  }
  return {
    id: 'vercel',
    reason: '호스팅 설정이 없고 Next.js 앱이면 Vercel 신규 프로젝트 연결이 가장 단순합니다.'
  };
}

function buildBlockers({ framework, env, vercel, netlify, cloudflare, generic }) {
  const blockers = [];
  const hasHostingLink = vercel.project_linked || netlify.project_linked || cloudflare.detected || generic.dockerfile || generic.fly || generic.render;

  if (!framework.detected) {
    blockers.push({
      id: 'framework_not_detected',
      severity: 'warning',
      detail: '지원 프레임워크를 자동 감지하지 못했습니다. build/start 명령을 수동 확인하세요.'
    });
  }
  if (!hasHostingLink) {
    blockers.push({
      id: 'hosting_project_not_linked',
      severity: 'blocking',
      detail: '배포 플랫폼 프로젝트 링크나 설정 파일이 없습니다.'
    });
  }
  if (!vercel.cli.available && !hasHostingLink) {
    blockers.push({
      id: 'vercel_cli_unavailable',
      severity: 'blocking',
      detail: 'Vercel CLI를 사용할 수 없어 추천 배포 경로를 바로 실행할 수 없습니다.'
    });
  }
  if (vercel.cli.available && !vercel.cli.logged_in && !hasHostingLink) {
    blockers.push({
      id: 'vercel_cli_not_logged_in',
      severity: 'blocking',
      detail: 'Vercel CLI 로그인 계정이 확인되지 않았습니다.'
    });
  }
  if (!env.ready) {
    blockers.push({
      id: 'marketing_env_not_ready',
      severity: 'blocking',
      detail: '운영 GTM/GA4/광고/CRM env 값이 아직 준비되지 않았습니다.',
      missing: env.summary.missing,
      placeholders: env.summary.placeholders,
      invalid: env.summary.invalid
    });
  }

  return blockers;
}

function buildRecommendedCommands(siteRoot, packageManager) {
  const cwd = ['vercel', '--cwd', siteRoot];
  const envCommands = PRODUCTION_ENV_KEYS.map((key) => ({
    id: `vercel_env_${key}`,
    label: `${key} 값을 Vercel production env에 추가`,
    command: commandString([...cwd, 'env', 'add', key, 'production']),
    confirmation_required: true,
    reason: 'Vercel 프로젝트 환경변수를 생성하거나 수정합니다.'
  }));

  return [
    {
      id: 'local_build',
      label: '배포 전 로컬 production build',
      command: scriptCommand(packageManager, 'build'),
      confirmation_required: false,
      reason: '외부 상태를 바꾸지 않는 로컬 검증입니다.'
    },
    {
      id: 'vercel_link',
      label: 'Vercel 프로젝트 링크',
      command: commandString([...cwd, 'link', '--yes', '--project', '<project-name-or-id>']),
      confirmation_required: true,
      reason: '로컬 디렉터리를 Vercel 프로젝트와 연결합니다.'
    },
    ...envCommands,
    {
      id: 'vercel_pull',
      label: 'Vercel 프로젝트 설정 pull',
      command: commandString([...cwd, 'pull']),
      confirmation_required: false,
      reason: '연결된 프로젝트 설정을 로컬로 가져와 배포 설정을 비교합니다.'
    },
    {
      id: 'vercel_prod_deploy',
      label: 'Vercel production 배포',
      command: commandString([...cwd, 'deploy', '--prod']),
      confirmation_required: true,
      reason: '외부 production deployment를 생성합니다.'
    }
  ];
}

function nextStep(blockers, vercel, env) {
  if (!vercel.cli.available) {
    return 'Vercel CLI를 설치하거나 다른 호스팅 플랫폼 설정 파일을 추가한 뒤 다시 실행하세요.';
  }
  if (!vercel.cli.logged_in) {
    return '`vercel login`으로 계정을 확인한 뒤 다시 실행하세요.';
  }
  if (!vercel.project_linked) {
    return '사용자 확인 후 `vercel --cwd <site-root> link --yes --project <project-name-or-id>`로 프로젝트를 연결하세요.';
  }
  if (!env.ready) {
    return '운영 env 값을 확보한 뒤 Vercel production env와 사이트 `.env.local`에 반영하세요.';
  }
  if (blockers.length === 0) {
    return '배포 대상이 준비되었습니다. 사용자 확인 후 production deploy를 실행하고 배포 URL에서 verify:site를 다시 실행하세요.';
  }
  return '표시된 blocker를 해결한 뒤 다시 실행하세요.';
}

function renderCommandList(commands) {
  return commands
    .map((command) => [
      `- ${command.label}`,
      `  - 명령: \`${command.command}\``,
      `  - 확인 필요: \`${command.confirmation_required}\``,
      `  - 이유: ${command.reason}`
    ].join('\n'))
    .join('\n');
}

function renderBlockers(blockers) {
  if (!blockers.length) {
    return '- 없음';
  }

  return blockers
    .map((blocker) => {
      const extra = [
        blocker.missing?.length ? `missing=${blocker.missing.join(', ')}` : '',
        blocker.placeholders?.length ? `placeholders=${blocker.placeholders.join(', ')}` : '',
        blocker.invalid?.length ? `invalid=${blocker.invalid.join(', ')}` : ''
      ].filter(Boolean).join(' / ');
      return `- \`${blocker.id}\` (${blocker.severity}): ${blocker.detail}${extra ? ` (${extra})` : ''}`;
    })
    .join('\n');
}

function renderMarkdown(report) {
  const urlDiscovery = report.env.url_discovery;
  const discoveredUrls = Array.isArray(urlDiscovery?.candidates) && urlDiscovery.candidates.length
    ? urlDiscovery.candidates.map((candidate) => `- \`${candidate.url}\`: ${candidate.status} (${candidate.source})`).join('\n')
    : '- 없음';

  return [
    '# 배포 대상 사전 점검',
    '',
    `생성일: ${report.generated_at}`,
    `대상 사이트: \`${report.site_root}\``,
    `production 배포 준비: \`${report.ready_for_production_deploy}\``,
    '',
    '## 앱 감지',
    '',
    `- framework: \`${report.framework.name}\``,
    `- package manager: \`${report.package_manager}\``,
    `- build script: \`${report.scripts.build || '없음'}\``,
    `- start script: \`${report.scripts.start || '없음'}\``,
    '',
    '## 호스팅 상태',
    '',
    `- 추천 플랫폼: \`${report.recommended_platform.id}\``,
    `- 추천 이유: ${report.recommended_platform.reason}`,
    `- Vercel CLI: \`${report.hosting.vercel.cli.available}\` (${report.hosting.vercel.cli.version || report.hosting.vercel.cli.error || 'unknown'})`,
    `- Vercel 로그인: \`${report.hosting.vercel.cli.logged_in}\`${report.hosting.vercel.cli.account ? ` (${report.hosting.vercel.cli.account})` : ''}`,
    `- Vercel 프로젝트 링크: \`${report.hosting.vercel.project_linked}\``,
    `- Netlify 설정: \`${report.hosting.netlify.detected}\``,
    `- Cloudflare 설정: \`${report.hosting.cloudflare.detected}\``,
    '',
    '## 운영 URL 탐색',
    '',
    `- 추천 URL: \`${urlDiscovery?.suggested_url || '없음'}\``,
    discoveredUrls,
    '',
    '## 차단점',
    '',
    renderBlockers(report.blockers),
    '',
    '## 실행 명령',
    '',
    renderCommandList(report.commands),
    '',
    '## 다음 단계',
    '',
    report.next_step
  ].join('\n');
}

async function writeOutputs(report, options) {
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${renderMarkdown(report)}\n`);
  await writeFile(options.jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {
    output: DEFAULT_MARKDOWN_OUTPUT,
    jsonOutput: DEFAULT_JSON_OUTPUT
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
  }

  if (parsed.siteRoot) {
    parsed.siteRoot = path.resolve(parsed.siteRoot);
  }

  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  npm run inspect:deployment -- --site-root /path/to/store',
    '',
    'Options:',
    '  --site-root /path     Storefront root.',
    '  --output FILE         Markdown output. Default: dist/deployment-target-plan.md',
    '  --json-output FILE    JSON output. Default: dist/deployment-target-plan.json'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.siteRoot) {
    console.error(usage());
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const report = await inspectDeploymentTarget(options);
  await writeOutputs(report, options);
  console.log(JSON.stringify({
    ready_for_production_deploy: report.ready_for_production_deploy,
    recommended_platform: report.recommended_platform,
    blockers: report.blockers.map((blocker) => blocker.id),
    output: options.output,
    json_output: options.jsonOutput,
    next_step: report.next_step
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  buildRecommendedCommands,
  commandString,
  detectFramework,
  detectPackageManager,
  inspectDeploymentTarget,
  parseArgs,
  quoteShell,
  renderMarkdown
};

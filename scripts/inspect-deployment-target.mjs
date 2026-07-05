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

function parseVercelProjectUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) {
    return {
      ok: false,
      url: '',
      scope: '',
      project: '',
      error: 'missing_vercel_project_url'
    };
  }

  try {
    const url = new URL(input);
    const parts = url.pathname.split('/').filter(Boolean);

    if (!/(^|\.)vercel\.com$/i.test(url.hostname) || parts.length < 2) {
      return {
        ok: false,
        url: input,
        scope: '',
        project: '',
        error: 'expected_vercel_project_url'
      };
    }

    return {
      ok: true,
      url: `https://vercel.com/${parts[0]}/${parts[1]}`,
      scope: parts[0],
      project: parts[1],
      error: ''
    };
  } catch {
    return {
      ok: false,
      url: input,
      scope: '',
      project: '',
      error: 'invalid_vercel_project_url'
    };
  }
}

function resolveVercelTargetProject(options = {}) {
  const fromUrl = options.vercelProjectUrl
    ? parseVercelProjectUrl(options.vercelProjectUrl)
    : null;
  const scope = options.vercelScope || fromUrl?.scope || '';
  const project = options.vercelProject || fromUrl?.project || '';
  const provided = Boolean(options.vercelProjectUrl || options.vercelScope || options.vercelProject);

  if (!provided) {
    return {
      provided: false,
      source: '',
      url: '',
      scope: '',
      project: '',
      valid: true,
      error: ''
    };
  }

  if (fromUrl && !fromUrl.ok) {
    return {
      provided: true,
      source: 'url',
      url: fromUrl.url,
      scope: '',
      project: '',
      valid: false,
      error: fromUrl.error
    };
  }

  if (!scope || !project) {
    return {
      provided: true,
      source: fromUrl ? 'url' : 'flags',
      url: fromUrl?.url || '',
      scope,
      project,
      valid: false,
      error: 'vercel_scope_and_project_required'
    };
  }

  return {
    provided: true,
    source: fromUrl ? 'url' : 'flags',
    url: fromUrl?.url || `https://vercel.com/${scope}/${project}`,
    scope,
    project,
    valid: true,
    error: ''
  };
}

function firstUsefulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('─') && !/^Update available/i.test(line) && !/^Changelog:/i.test(line) && !/^Run `npm/i.test(line)) || '';
}

function extractJsonObject(text) {
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

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function siteSignals(root, packageJson = {}) {
  const names = [
    path.basename(root),
    packageJson.name,
    packageJson.homepage
  ].filter(Boolean);
  const tokens = new Set(names.flatMap(tokenize));

  return {
    names: names.map((name) => String(name).toLowerCase()),
    tokens
  };
}

function scoreVercelProject(project, signals) {
  const projectName = String(project.name || '').toLowerCase();
  const projectUrl = String(project.latestProductionUrl || '').toLowerCase();
  const projectTokens = new Set([
    ...tokenize(projectName),
    ...tokenize(projectUrl)
  ]);
  const reasons = [];
  let score = 0;

  if (signals.names.includes(projectName)) {
    score += 100;
    reasons.push('exact_name');
  }

  for (const token of signals.tokens) {
    if (projectTokens.has(token)) {
      score += 12;
      reasons.push(`token:${token}`);
    }
  }

  if (signals.tokens.has('shopee') && (projectTokens.has('shopping') || projectTokens.has('mall') || projectTokens.has('commerce'))) {
    score += 2;
    reasons.push('weak_ecommerce_context');
  }

  return {
    name: project.name || '',
    id: project.id || '',
    latest_production_url: project.latestProductionUrl && project.latestProductionUrl !== '--'
      ? project.latestProductionUrl
      : '',
    updated_at: project.updatedAt || null,
    score,
    reasons,
    url_probe: {
      checked: false,
      ok: false,
      status: null,
      title: '',
      error: ''
    }
  };
}

function rankVercelProjects(projects = [], root = process.cwd(), packageJson = {}) {
  const signals = siteSignals(root, packageJson);
  return projects
    .map((project) => scoreVercelProject(project, signals))
    .sort((left, right) => right.score - left.score || String(left.name).localeCompare(String(right.name)));
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

async function probeUrl(url, options = {}) {
  if (!url) {
    return {
      checked: false,
      ok: false,
      status: null,
      title: '',
      error: 'missing_url'
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 5000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'marketing-automation-kit-deployment-inspector'
      }
    });
    const contentType = response.headers.get('content-type') || '';
    const text = contentType.includes('text/html') ? await response.text() : '';
    const titleMatch = text.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '';

    return {
      checked: true,
      ok: response.ok,
      status: response.status,
      title,
      error: ''
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      status: null,
      title: '',
      error: error.name === 'AbortError' ? 'timeout' : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function annotateProjectUrlProbes(projects, urlProbe = probeUrl) {
  return await Promise.all(projects.map(async (project) => ({
    ...project,
    url_probe: project.latest_production_url
      ? await urlProbe(project.latest_production_url)
      : {
          checked: false,
          ok: false,
          status: null,
          title: '',
          error: 'missing_url'
        }
  })));
}

function dedupeProjects(projects) {
  const seen = new Set();
  const deduped = [];

  for (const project of projects) {
    const key = project.id || project.name;
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    deduped.push(project);
  }

  return deduped;
}

async function inspectTargetVercelProject(root, targetProject, packageJson, runner, urlProbe) {
  const base = {
    ...targetProject,
    scope_accessible: false,
    found: false,
    accessible: false,
    context: '',
    project_id: '',
    latest_production_url: '',
    url_probe: {
      checked: false,
      ok: false,
      status: null,
      title: '',
      error: ''
    },
    error: targetProject.error || '',
    next_step: ''
  };

  if (!targetProject.provided) {
    return base;
  }
  if (!targetProject.valid) {
    return {
      ...base,
      next_step: 'Vercel 프로젝트 URL 또는 scope/project 값을 다시 확인하세요.'
    };
  }

  const projectsResult = await runner('vercel', [
    'projects',
    'ls',
    '--scope',
    targetProject.scope,
    '--format=json'
  ], { cwd: root, timeoutMs: DEFAULT_TIMEOUT_MS });
  const projectsJson = projectsResult.ok ? extractJsonObject(projectsResult.stdout || projectsResult.stderr) : null;
  const exactProject = projectsJson?.projects?.find((project) => (
    project.name === targetProject.project || project.id === targetProject.project
  ));
  const scopedError = projectsResult.ok
    ? ''
    : firstUsefulLine(projectsResult.stderr || projectsResult.stdout);

  if (!projectsResult.ok || !projectsJson) {
    return {
      ...base,
      scope_accessible: false,
      error: scopedError || 'vercel_scope_not_accessible',
      next_step: `Vercel CLI 계정에 \`${targetProject.scope}\` scope 접근 권한을 부여하거나 권한 있는 계정으로 다시 로그인하세요.`
    };
  }

  if (!exactProject) {
    return {
      ...base,
      scope_accessible: true,
      context: projectsJson.contextName || targetProject.scope,
      error: `project_not_found:${targetProject.project}`,
      next_step: `\`${targetProject.scope}\` scope에서 \`${targetProject.project}\` 프로젝트가 보이지 않습니다. 프로젝트명 또는 권한을 확인하세요.`
    };
  }

  const [candidate] = await annotateProjectUrlProbes([
    {
      ...scoreVercelProject(exactProject, siteSignals(root, packageJson)),
      score: 1000,
      reasons: ['explicit_target'],
      target: true
    }
  ], urlProbe);

  return {
    ...base,
    scope_accessible: true,
    found: true,
    accessible: true,
    context: projectsJson.contextName || targetProject.scope,
    project_id: candidate.id,
    latest_production_url: candidate.latest_production_url,
    url_probe: candidate.url_probe,
    candidate,
    error: ''
  };
}

async function inspectVercel(root, files, packageJson = {}, runner = runCommand, urlProbe = probeUrl, options = {}) {
  const projectJson = await readJsonIfExists(path.join(root, '.vercel', 'project.json'));
  const targetProject = resolveVercelTargetProject(options);
  const version = await runner('vercel', ['--version'], { cwd: root, timeoutMs: DEFAULT_TIMEOUT_MS });
  const whoami = version.ok
    ? await runner('vercel', ['whoami'], { cwd: root, timeoutMs: DEFAULT_TIMEOUT_MS })
    : null;
  const projectsResult = whoami?.ok
    ? await runner('vercel', ['projects', 'ls', '--format=json'], { cwd: root, timeoutMs: DEFAULT_TIMEOUT_MS })
    : null;
  const projectsJson = projectsResult?.ok ? extractJsonObject(projectsResult.stdout || projectsResult.stderr) : null;
  const projectCandidates = await annotateProjectUrlProbes(
    rankVercelProjects(projectsJson?.projects || [], root, packageJson).slice(0, 5),
    urlProbe
  );
  const targetStatus = whoami?.ok
    ? await inspectTargetVercelProject(root, targetProject, packageJson, runner, urlProbe)
    : {
        ...targetProject,
        scope_accessible: false,
        found: false,
        accessible: false,
        context: '',
        project_id: '',
        latest_production_url: '',
        url_probe: {
          checked: false,
          ok: false,
          status: null,
          title: '',
          error: ''
        },
        error: targetProject.provided ? 'vercel_cli_not_logged_in' : '',
        next_step: targetProject.provided ? '`vercel login`으로 계정을 확인한 뒤 다시 실행하세요.' : ''
      };
  const allCandidates = dedupeProjects([
    ...(targetStatus.candidate ? [targetStatus.candidate] : []),
    ...projectCandidates
  ]);
  const recommendedProject = targetStatus.candidate
    || allCandidates.find((candidate) => candidate.score >= 12)
    || null;

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
    },
    target_project: targetStatus,
    projects: {
      available: Boolean(projectsJson),
      context: projectsJson?.contextName || '',
      count: Array.isArray(projectsJson?.projects) ? projectsJson.projects.length : 0,
      candidates: allCandidates,
      recommended: recommendedProject,
      error: projectsResult && !projectsResult.ok ? firstUsefulLine(projectsResult.stderr || projectsResult.stdout) : ''
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
  const vercel = await inspectVercel(
    siteRoot,
    files,
    packageJson || {},
    runtime.runCommand || runCommand,
    runtime.probeUrl || probeUrl,
    options
  );
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

  const commands = buildRecommendedCommands(siteRoot, packageManager, vercel.projects.recommended);
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

  if (vercel.target_project?.provided && !vercel.target_project.accessible) {
    blockers.push({
      id: 'target_vercel_project_inaccessible',
      severity: 'blocking',
      detail: targetVercelProjectBlockerDetail(vercel.target_project)
    });
  }
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

function targetVercelProjectBlockerDetail(targetProject) {
  const label = targetProject.scope && targetProject.project
    ? `${targetProject.scope}/${targetProject.project}`
    : targetProject.url || 'unknown';

  if (!targetProject.valid) {
    return `지정한 Vercel 프로젝트 ${label} 값을 파싱할 수 없습니다: ${targetProject.error}`;
  }
  if (!targetProject.scope_accessible) {
    return `현재 Vercel CLI 계정에서 지정한 프로젝트 ${label}의 scope를 조회할 수 없습니다: ${targetProject.error || 'scope_not_accessible'}`;
  }
  if (!targetProject.found) {
    return `지정한 Vercel 프로젝트 ${label}가 조회 가능한 scope 안에서 발견되지 않았습니다: ${targetProject.error || 'project_not_found'}`;
  }
  return `지정한 Vercel 프로젝트 ${label}에 접근할 수 없습니다.`;
}

function buildRecommendedCommands(siteRoot, packageManager, recommendedProject = null) {
  const cwd = ['vercel', '--cwd', siteRoot];
  const projectTarget = recommendedProject?.id || '<project-name-or-id>';
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
      label: recommendedProject ? `Vercel 프로젝트 링크 (${recommendedProject.name})` : 'Vercel 프로젝트 링크',
      command: commandString([...cwd, 'link', '--yes', '--project', projectTarget]),
      confirmation_required: true,
      reason: recommendedProject
        ? `로컬 디렉터리를 후보 프로젝트 ${recommendedProject.name}에 연결합니다.`
        : '로컬 디렉터리를 Vercel 프로젝트와 연결합니다.'
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
  if (vercel.target_project?.provided && !vercel.target_project.accessible) {
    return vercel.target_project.next_step || '지정한 Vercel 프로젝트 접근 권한을 확인한 뒤 다시 실행하세요.';
  }
  if (!vercel.project_linked) {
    if (vercel.projects.recommended) {
      return `사용자 확인 후 \`vercel --cwd <site-root> link --yes --project ${vercel.projects.recommended.id}\`로 후보 프로젝트 \`${vercel.projects.recommended.name}\`에 연결하세요.`;
    }
    if (vercel.projects.candidates.length) {
      return '기존 Vercel 프로젝트 후보를 확인한 뒤 사용자 확인 후 `vercel --cwd <site-root> link --yes --project <project-name-or-id>`로 프로젝트를 연결하세요.';
    }
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

function renderVercelProjectCandidates(projects) {
  if (!projects?.available) {
    return '- 프로젝트 목록 조회 안 됨';
  }
  if (!projects.candidates.length) {
    return '- 기존 프로젝트 없음';
  }

  return projects.candidates
    .map((project) => {
      const suffix = [
        `score=${project.score}`,
        project.latest_production_url ? `url=${project.latest_production_url}` : '',
        project.url_probe?.checked ? `http=${project.url_probe.status || project.url_probe.error}` : '',
        project.url_probe?.title ? `title=${project.url_probe.title}` : '',
        project.reasons.length ? `reasons=${project.reasons.join(',')}` : ''
      ].filter(Boolean).join(' / ');
      return `- \`${project.name}\` (${project.id})${suffix ? `: ${suffix}` : ''}`;
    })
    .join('\n');
}

function renderVercelTargetProject(targetProject) {
  if (!targetProject?.provided) {
    return '- 지정 안 됨';
  }

  const label = targetProject.scope && targetProject.project
    ? `${targetProject.scope}/${targetProject.project}`
    : targetProject.url || 'unknown';
  const status = [
    `valid=${targetProject.valid}`,
    `scope_accessible=${targetProject.scope_accessible}`,
    `found=${targetProject.found}`,
    `accessible=${targetProject.accessible}`,
    targetProject.project_id ? `project_id=${targetProject.project_id}` : '',
    targetProject.latest_production_url ? `url=${targetProject.latest_production_url}` : '',
    targetProject.url_probe?.checked ? `http=${targetProject.url_probe.status || targetProject.url_probe.error}` : '',
    targetProject.error ? `error=${targetProject.error}` : ''
  ].filter(Boolean).join(' / ');

  return `- \`${label}\`${status ? `: ${status}` : ''}`;
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
    `- Vercel 프로젝트 목록: \`${report.hosting.vercel.projects.available}\`${report.hosting.vercel.projects.context ? ` (${report.hosting.vercel.projects.context}, ${report.hosting.vercel.projects.count}개)` : ''}`,
    `- 추천 Vercel 프로젝트: \`${report.hosting.vercel.projects.recommended?.name || '없음'}\``,
    `- Netlify 설정: \`${report.hosting.netlify.detected}\``,
    `- Cloudflare 설정: \`${report.hosting.cloudflare.detected}\``,
    '',
    '### 지정 Vercel 프로젝트',
    '',
    renderVercelTargetProject(report.hosting.vercel.target_project),
    '',
    '### Vercel 프로젝트 후보',
    '',
    renderVercelProjectCandidates(report.hosting.vercel.projects),
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
    if (key === 'vercel-project-url') {
      parsed.vercelProjectUrl = value;
    }
    if (key === 'vercel-scope') {
      parsed.vercelScope = value;
    }
    if (key === 'vercel-project') {
      parsed.vercelProject = value;
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
    '  --json-output FILE    JSON output. Default: dist/deployment-target-plan.json',
    '  --vercel-project-url URL  Expected Vercel project URL, for example https://vercel.com/team/project',
    '  --vercel-scope NAME       Expected Vercel scope/team slug',
    '  --vercel-project NAME     Expected Vercel project name or id'
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
    target_project: report.hosting.vercel.target_project?.provided
      ? {
          scope: report.hosting.vercel.target_project.scope,
          project: report.hosting.vercel.target_project.project,
          accessible: report.hosting.vercel.target_project.accessible,
          error: report.hosting.vercel.target_project.error
        }
      : null,
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
  extractJsonObject,
  inspectDeploymentTarget,
  parseArgs,
  parseVercelProjectUrl,
  probeUrl,
  quoteShell,
  rankVercelProjects,
  renderMarkdown
};

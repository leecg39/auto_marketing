import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROOTS = [
  path.join(os.homedir(), 'Library', 'CloudStorage'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Downloads')
];

const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ROOTS;
const MAX_DEPTH = Number(process.env.MAX_CANDIDATE_DEPTH || 5);
const MAX_TEXT_FILES_PER_PROJECT = Number(process.env.MAX_TEXT_FILES_PER_PROJECT || 80);

const IGNORE_DIRS = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report'
]);

const PROJECT_MARKERS = new Set([
  'package.json',
  'vite.config.js',
  'vite.config.ts',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'nuxt.config.js',
  'nuxt.config.ts',
  'astro.config.mjs',
  'index.html'
]);

const TEXT_EXTENSIONS = new Set([
  '.astro',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.mjs',
  '.svelte',
  '.ts',
  '.tsx',
  '.vue'
]);

const SIGNALS = [
  { name: 'product', weight: 3, terms: ['product', 'products', '상품', '제품'] },
  { name: 'cart', weight: 5, terms: ['cart', 'add_to_cart', 'add-to-cart', '장바구니'] },
  { name: 'checkout', weight: 5, terms: ['checkout', '결제', '주문서'] },
  { name: 'purchase_order', weight: 5, terms: ['purchase', 'order', 'orders', '주문', '구매'] },
  { name: 'payment', weight: 5, terms: ['payment', 'payments', 'pay', '결제', 'toss', 'inicis', 'iamport', 'portone'] },
  { name: 'customer', weight: 3, terms: ['customer', 'customers', '회원', '고객'] },
  { name: 'lead_contact', weight: 2, terms: ['contact', 'inquiry', 'lead', '문의', '상담'] },
  { name: 'analytics', weight: 2, terms: ['gtm', 'ga4', 'analytics', 'dataLayer'] }
];

function unique(values) {
  return [...new Set(values)];
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function listDirSafe(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function findProjectRoots(root, depth = 0, projects = new Set()) {
  if (depth > MAX_DEPTH) {
    return projects;
  }

  const entries = await listDirSafe(root);
  const names = new Set(entries.map((entry) => entry.name));
  if ([...PROJECT_MARKERS].some((marker) => names.has(marker))) {
    projects.add(root);
    return projects;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) {
      continue;
    }

    await findProjectRoots(path.join(root, entry.name), depth + 1, projects);
  }

  return projects;
}

async function walkProjectFiles(root, depth = 0, files = []) {
  if (depth > 8 || files.length >= MAX_TEXT_FILES_PER_PROJECT) {
    return files;
  }

  const entries = await listDirSafe(root);
  for (const entry of entries) {
    if (files.length >= MAX_TEXT_FILES_PER_PROJECT) {
      break;
    }

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        await walkProjectFiles(fullPath, depth + 1, files);
      }
      continue;
    }

    if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readText(file) {
  try {
    return (await readFile(file, 'utf8')).slice(0, 120000);
  } catch {
    return '';
  }
}

async function readPackage(root) {
  const packagePath = path.join(root, 'package.json');
  if (!(await exists(packagePath))) {
    return null;
  }

  try {
    return JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectFramework(root, packageJson, fileNames) {
  const deps = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies
  };

  if (deps.next || fileNames.includes('next.config.js') || fileNames.includes('next.config.mjs') || fileNames.includes('next.config.ts')) {
    return 'next';
  }

  if (deps.vite || fileNames.includes('vite.config.js') || fileNames.includes('vite.config.ts')) {
    return 'vite';
  }

  if (deps.nuxt || fileNames.includes('nuxt.config.js') || fileNames.includes('nuxt.config.ts')) {
    return 'nuxt';
  }

  if (fileNames.includes('index.html')) {
    return 'static-html';
  }

  return 'unknown';
}

function matchTerm(haystack, term) {
  const normalized = term.toLowerCase();
  if (/[\u3131-\uD79D]/.test(normalized)) {
    return haystack.includes(normalized);
  }

  if (normalized.includes('_') || normalized.includes('-')) {
    return haystack.includes(normalized);
  }

  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalized)}([^a-z0-9]|$)`).test(haystack);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function scoreProject(root) {
  const files = await walkProjectFiles(root);
  const relativeFiles = files.map((file) => path.relative(root, file));
  const packageJson = await readPackage(root);
  const topLevelNames = (await listDirSafe(root)).map((entry) => entry.name);
  const framework = detectFramework(root, packageJson, topLevelNames);
  const signals = {};
  const evidence = {};
  let score = 0;

  for (const signal of SIGNALS) {
    signals[signal.name] = 0;
    evidence[signal.name] = [];
  }

  for (const file of files) {
    const relative = path.relative(root, file);
    if (/(^|\/)(__tests__|tests|e2e|scripts|docs)(\/|$)|\.test\.|\.spec\./.test(relative)) {
      continue;
    }

    if (path.extname(relative).toLowerCase() === '.json' && !/(package\.json|routes|schema|database)/i.test(relative)) {
      continue;
    }

    const haystack = `${relative}\n${await readText(file)}`.toLowerCase();

    for (const signal of SIGNALS) {
      if (signal.terms.some((term) => matchTerm(haystack, term))) {
        signals[signal.name] += 1;
        if (evidence[signal.name].length < 4) {
          evidence[signal.name].push(relative);
        }
      }
    }
  }

  for (const signal of SIGNALS) {
    if (signals[signal.name] > 0) {
      score += signal.weight;
    }
  }

  if (framework !== 'unknown') {
    score += 2;
  }

  if (packageJson?.name && /shop|store|commerce|mall|market|model|crew|brand/i.test(packageJson.name)) {
    score += 2;
  }

  return {
    root,
    package_name: packageJson?.name || null,
    framework,
    score,
    signal_counts: signals,
    evidence,
    sampled_files: relativeFiles.slice(0, 12)
  };
}

const projectRoots = new Set();
for (const root of roots.map((candidate) => path.resolve(candidate))) {
  for (const project of await findProjectRoots(root)) {
    projectRoots.add(project);
  }
}

const scored = [];
for (const project of projectRoots) {
  scored.push(await scoreProject(project));
}

scored.sort((a, b) => b.score - a.score || a.root.localeCompare(b.root));

const result = {
  scanned_roots: roots,
  project_count: scored.length,
  likely_candidates: scored.filter((project) => project.score >= 12).slice(0, 15),
  other_projects: scored.filter((project) => project.score < 12).slice(0, 20),
  next_step: '실제 자사몰 후보가 맞으면 `npm run audit:site -- <root>`로 통합 지점을 확인하세요.'
};

console.log(JSON.stringify(result, null, 2));

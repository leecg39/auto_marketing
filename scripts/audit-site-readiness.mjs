import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const rootArg = process.argv[2] || process.cwd();
const root = path.resolve(rootArg);
const MAX_FILES = Number(process.env.MAX_SCAN_FILES || 5000);
const MAX_DEPTH = Number(process.env.MAX_SCAN_DEPTH || 8);

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

const TEXT_EXTENSIONS = new Set([
  '.astro',
  '.css',
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

const EVENT_TERMS = {
  view_item: ['trackviewitem', 'view_item', 'product detail', 'product-detail', 'product_detail', '상품상세', '상품 상세', 'product'],
  add_to_cart: ['trackaddtocart', 'addtocart', 'add-to-cart', 'add_to_cart', 'cart.add', '장바구니', 'cart'],
  begin_checkout: ['trackbegincheckout', 'begin_checkout', 'checkout', '결제 시작', '주문서', 'payment'],
  purchase: ['trackpurchase', 'purchase', 'transaction_id', 'order_id', 'order complete', 'order-complete', 'success', 'thank', 'complete', '구매완료', '결제완료', '주문완료'],
  sign_up: ['tracksignup', 'sign_up', 'signup', 'sign-up', 'register', '회원가입'],
  login: ['tracklogin', 'login', '로그인'],
  generate_lead: ['trackgeneratelead', 'generate_lead', 'lead', 'contact', 'inquiry', '상담', '문의', '쿠폰']
};

const EVENT_SUPPORT_TERMS = {
  view_item: ['trackviewitem', 'view_item'],
  add_to_cart: ['trackaddtocart', 'add_to_cart'],
  begin_checkout: ['trackbegincheckout', 'begin_checkout'],
  purchase: ['trackpurchase', 'purchase'],
  sign_up: ['tracksignup', 'sign_up'],
  login: ['tracklogin', 'login'],
  generate_lead: ['trackgeneratelead', 'generate_lead']
};

const SKIP_EVENT_PATH_PATTERNS = [
  /(^|\/)__tests__(\/|$)/,
  /(^|\/)__mocks__(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)docs(\/|$)/,
  /(^|\/)e2e(\/|$)/,
  /(^|\/)scripts(\/|$)/,
  /(^|\/)test(s)?(\/|$)/,
  /\.config\./,
  /\.spec\./,
  /\.test\./
];

function relative(file) {
  return path.relative(root, file) || '.';
}

function isTextFile(file) {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, depth = 0, files = []) {
  if (files.length >= MAX_FILES || depth > MAX_DEPTH) {
    return files;
  }

  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (files.length >= MAX_FILES) {
      break;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        await walk(fullPath, depth + 1, files);
      }
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readText(file, maxLength = 250000) {
  if (!isTextFile(file)) {
    return '';
  }

  try {
    const content = await readFile(file, 'utf8');
    return content.slice(0, maxLength);
  } catch {
    return '';
  }
}

async function readPackageJson() {
  const packagePath = path.join(root, 'package.json');
  if (!(await pathExists(packagePath))) {
    return null;
  }

  try {
    return JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    return null;
  }
}

async function detectFramework(packageJson, files) {
  const names = new Set(files.map((file) => relative(file)));
  const deps = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies
  };

  if (deps.next || names.has('next.config.js') || names.has('next.config.mjs') || names.has('next.config.ts')) {
    return 'next';
  }

  if (deps.vite || [...names].some((name) => name.startsWith('vite.config.'))) {
    return 'vite';
  }

  if (deps.nuxt || names.has('nuxt.config.ts') || names.has('nuxt.config.js')) {
    return 'nuxt';
  }

  if (deps['@sveltejs/kit'] || names.has('svelte.config.js')) {
    return 'sveltekit';
  }

  if (names.has('index.html')) {
    return 'static-html';
  }

  return 'unknown';
}

function findLayoutCandidates(files) {
  const patterns = [
    /(^|\/)app\/layout\.(tsx|jsx|ts|js)$/,
    /(^|\/)src\/app\/layout\.(tsx|jsx|ts|js)$/,
    /(^|\/)pages\/_app\.(tsx|jsx|ts|js)$/,
    /(^|\/)pages\/_document\.(tsx|jsx|ts|js)$/,
    /(^|\/)src\/main\.(tsx|jsx|ts|js)$/,
    /(^|\/)src\/App\.(tsx|jsx|ts|js)$/,
    /(^|\/)index\.html$/
  ];

  return files
    .map(relative)
    .filter((name) => patterns.some((pattern) => pattern.test(name)))
    .slice(0, 20);
}

async function fileContains(relativeName, files, terms) {
  const file = files.find((candidate) => relative(candidate) === relativeName);
  if (!file) {
    return false;
  }

  const content = (await readText(file, 250000)).toLowerCase();
  return terms.some((term) => content.includes(term.toLowerCase()));
}

async function detectInstallation(files, layoutCandidates) {
  const names = new Set(files.map((file) => relative(file)));
  const sdkInstalled = names.has('public/assets/marketing-automation.js') || names.has('assets/marketing-automation.js');
  const wrapperInstalled = names.has('src/lib/marketing-automation.ts') || names.has('lib/marketing-automation.ts');
  const crmRouteInstalled = names.has('src/app/api/crm/events/route.ts') || names.has('app/api/crm/events/route.ts');
  const providerFile = names.has('src/components/marketing/marketing-automation-provider.tsx')
    ? 'src/components/marketing/marketing-automation-provider.tsx'
    : names.has('components/marketing/marketing-automation-provider.tsx')
      ? 'components/marketing/marketing-automation-provider.tsx'
      : null;

  const providerImplemented = providerFile
    ? await fileContains(providerFile, files, ['MarketingAutomation', 'marketing-automation.js'])
    : false;
  const providerMounted = await layoutCandidates.reduce(async (previous, layout) => {
    if (await previous) {
      return true;
    }
    return fileContains(layout, files, ['MarketingAutomationProvider', 'marketing-automation.js']);
  }, Promise.resolve(false));

  const supportFiles = [
    'public/assets/marketing-automation.js',
    'src/lib/marketing-automation.ts',
    'src/app/api/crm/events/route.ts',
    'assets/marketing-automation.js',
    'lib/marketing-automation.ts',
    'app/api/crm/events/route.ts'
  ].filter((name) => names.has(name));
  const supportedEvents = {};

  for (const [eventName, terms] of Object.entries(EVENT_SUPPORT_TERMS)) {
    let supported = false;
    for (const file of supportFiles) {
      if (await fileContains(file, files, terms)) {
        supported = true;
        break;
      }
    }
    supportedEvents[eventName] = supported;
  }

  return {
    sdk_installed: sdkInstalled,
    wrapper_installed: wrapperInstalled,
    crm_route_installed: crmRouteInstalled,
    provider_implemented: providerImplemented,
    provider_mounted: providerMounted,
    supported_events: supportedEvents
  };
}

async function findEventCandidates(files) {
  const candidates = {};

  for (const eventName of Object.keys(EVENT_TERMS)) {
    candidates[eventName] = [];
  }

  for (const file of files) {
    if (!isTextFile(file)) {
      continue;
    }

    const name = relative(file).toLowerCase();
    if (SKIP_EVENT_PATH_PATTERNS.some((pattern) => pattern.test(name))) {
      continue;
    }

    const content = (await readText(file, 60000)).toLowerCase();
    const haystack = `${name}\n${content}`;

    for (const [eventName, terms] of Object.entries(EVENT_TERMS)) {
      if (candidates[eventName].length >= 12) {
        continue;
      }

      if (terms.some((term) => termMatches(haystack, term))) {
        candidates[eventName].push(relative(file));
      }
    }
  }

  return candidates;
}

function termMatches(haystack, term) {
  const normalizedTerm = term.toLowerCase();

  if (/[\u3131-\uD79D]/.test(normalizedTerm)) {
    return haystack.includes(normalizedTerm);
  }

  if (normalizedTerm.includes('-') || normalizedTerm.includes('_') || normalizedTerm.includes('.') || normalizedTerm.includes(' ')) {
    return haystack.includes(normalizedTerm);
  }

  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedTerm)}([^a-z0-9]|$)`).test(haystack);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRecommendations(framework, layoutCandidates, eventCandidates, installationStatus) {
  const recommendations = [];

  if (installationStatus.provider_mounted) {
    recommendations.push('설치 확인: 공통 레이아웃에서 MarketingAutomationProvider가 마운트되어 있습니다.');
  } else if (layoutCandidates.length > 0) {
    recommendations.push(`공통 초기화 후보: ${layoutCandidates[0]}`);
  } else {
    recommendations.push('공통 레이아웃 후보를 찾지 못했습니다. 앱 엔트리 파일을 지정해야 합니다.');
  }

  if (installationStatus.sdk_installed) {
    recommendations.push('설치 확인: marketing-automation.js SDK 파일이 존재합니다.');
  }

  if (installationStatus.crm_route_installed) {
    recommendations.push('설치 확인: CRM 이벤트 수신 라우트가 존재합니다.');
  }

  for (const [eventName, files] of Object.entries(eventCandidates)) {
    if (installationStatus.supported_events[eventName]) {
      recommendations.push(`${eventName} 지원 확인: SDK/wrapper/CRM 라우트에서 이벤트 계약을 찾았습니다.`);
    } else if (files.length > 0) {
      recommendations.push(`${eventName} 호출 후보: ${files[0]}`);
    } else {
      recommendations.push(`${eventName} 호출 후보가 없습니다. 해당 사용자 행동의 성공 콜백 위치를 지정해야 합니다.`);
    }
  }

  if (framework === 'next') {
    recommendations.push('Next.js라면 `app/layout.*` 또는 `pages/_app.*`에서 SDK를 초기화하고, 클라이언트 컴포넌트에서 이벤트 함수를 호출합니다.');
  }

  if (framework === 'vite' || framework === 'static-html') {
    recommendations.push('Vite/정적 HTML이라면 `index.html` 또는 `src/main.*`에서 SDK를 로드합니다.');
  }

  return recommendations;
}

const files = await walk(root);
const packageJson = await readPackageJson();
const framework = await detectFramework(packageJson, files);
const layoutCandidates = findLayoutCandidates(files);
const eventCandidates = await findEventCandidates(files);
const installationStatus = await detectInstallation(files, layoutCandidates);
const recommendations = buildRecommendations(framework, layoutCandidates, eventCandidates, installationStatus);
const isInstalled = installationStatus.sdk_installed && installationStatus.provider_mounted && installationStatus.crm_route_installed;

const report = {
  root,
  scanned_files: files.length,
  framework,
  package_name: packageJson?.name || null,
  installation_status: installationStatus,
  layout_candidates: layoutCandidates,
  event_candidates: eventCandidates,
  recommendations,
  next_step: isInstalled
    ? '기본 SDK/Provider/CRM route는 설치되어 있습니다. 남은 작업은 실제 GTM/GA4/광고/CRM 계정 값 연결과 실제 결제 성공 콜백의 purchase 이벤트 확인입니다.'
    : '실제 자사몰 루트가 맞다면 위 후보 파일에 marketing-automation.js 초기화와 이벤트 호출을 추가합니다.'
};

console.log(JSON.stringify(report, null, 2));

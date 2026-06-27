import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const targetArg = args.find((arg) => !arg.startsWith('--'));
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceSdk = path.join(kitRoot, 'src', 'marketing-automation.js');

function usage() {
  return [
    'Usage:',
    '  npm run install:sdk -- /path/to/store [--dry-run] [--force]',
    '',
    'Installs:',
    '  public/assets/marketing-automation.js',
    '  .env.marketing.example',
    '  MARKETING_AUTOMATION_INSTALL.md'
  ].join('\n');
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readPackage(targetRoot) {
  const packagePath = path.join(targetRoot, 'package.json');
  if (!(await exists(packagePath))) {
    return null;
  }

  try {
    return JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    return null;
  }
}

async function detectPublicDir(targetRoot) {
  const candidates = ['public', 'static'];
  for (const candidate of candidates) {
    const fullPath = path.join(targetRoot, candidate);
    if (await exists(fullPath)) {
      return fullPath;
    }
  }

  return path.join(targetRoot, 'public');
}

async function writeIfNeeded(file, content, actions) {
  if (dryRun) {
    actions.push({ action: 'write', file, dry_run: true });
    return;
  }

  if ((await exists(file)) && !force) {
    const backupFile = `${file}.bak-${Date.now()}`;
    await copyFile(file, backupFile);
    actions.push({ action: 'backup', file, backup_file: backupFile });
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  actions.push({ action: 'write', file });
}

async function copySdk(destination, actions) {
  if (dryRun) {
    actions.push({ action: 'copy', from: sourceSdk, to: destination, dry_run: true });
    return;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  if ((await exists(destination)) && !force) {
    const backupFile = `${destination}.bak-${Date.now()}`;
    await copyFile(destination, backupFile);
    actions.push({ action: 'backup', file: destination, backup_file: backupFile });
  }

  await copyFile(sourceSdk, destination);
  actions.push({ action: 'copy', from: sourceSdk, to: destination });
}

function envExample() {
  return [
    'NEXT_PUBLIC_GTM_ID=GTM-XXXXXXX',
    'NEXT_PUBLIC_CRM_WEBHOOK_URL=/crm/events',
    'NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY=KRW',
    'NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-XXXXXXXXXX',
    'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-XXXXXXXXX',
    'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL=replace-with-purchase-label',
    'NEXT_PUBLIC_META_PIXEL_ID=replace-with-meta-pixel-id',
    ''
  ].join('\n');
}

function installGuide({ packageName, framework, sdkUrl }) {
  return `# Marketing Automation Install

Package: ${packageName || 'unknown'}
Framework: ${framework}

## SDK

The SDK has been installed at:

\`\`\`text
${sdkUrl}
\`\`\`

## Add to common layout

\`\`\`html
<script src="${sdkUrl}"></script>
<script>
  MarketingAutomation.init({
    gtmId: 'GTM-XXXXXXX',
    crmWebhookUrl: '/crm/events',
    defaultCurrency: 'KRW'
  });
</script>
\`\`\`

## Event calls

\`\`\`js
MarketingAutomation.trackViewItem(product);
MarketingAutomation.trackAddToCart(product);
MarketingAutomation.trackBeginCheckout(checkout);
MarketingAutomation.trackPurchase(order);
MarketingAutomation.trackSignUp({ method: 'email', email, marketing_consent: true });
MarketingAutomation.trackLogin({ method: 'email' });
MarketingAutomation.trackGenerateLead({ value: 10000, email, phone, marketing_consent: true });
\`\`\`

## Verify

Run from the marketing automation kit:

\`\`\`bash
npm run audit:site -- ${targetArg}
\`\`\`
`;
}

function detectFramework(packageJson, targetRoot) {
  const deps = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies
  };

  if (deps.next) {
    return 'next';
  }
  if (deps.vite) {
    return 'vite';
  }
  if (deps.nuxt) {
    return 'nuxt';
  }
  if (deps['@sveltejs/kit']) {
    return 'sveltekit';
  }
  return path.basename(targetRoot);
}

if (!targetArg) {
  console.error(usage());
  process.exit(2);
}

const targetRoot = path.resolve(targetArg);
if (!(await exists(targetRoot))) {
  console.error(`Target does not exist: ${targetRoot}`);
  process.exit(2);
}

const packageJson = await readPackage(targetRoot);
const publicDir = await detectPublicDir(targetRoot);
const sdkDestination = path.join(publicDir, 'assets', 'marketing-automation.js');
const sdkUrl = `/${path.relative(publicDir, sdkDestination).split(path.sep).join('/')}`;
const framework = detectFramework(packageJson, targetRoot);
const actions = [];

await copySdk(sdkDestination, actions);
await writeIfNeeded(path.join(targetRoot, '.env.marketing.example'), envExample(), actions);
await writeIfNeeded(
  path.join(targetRoot, 'MARKETING_AUTOMATION_INSTALL.md'),
  installGuide({ packageName: packageJson?.name || null, framework, sdkUrl }),
  actions
);

console.log(JSON.stringify({
  ok: true,
  dry_run: dryRun,
  target_root: targetRoot,
  package_name: packageJson?.name || null,
  framework,
  sdk_url: sdkUrl,
  actions,
  next_step: 'Add the SDK initialization snippet to the common layout and call event functions at product/cart/checkout/purchase/signup/login/lead success points.'
}, null, 2));

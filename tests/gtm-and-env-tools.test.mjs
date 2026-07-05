import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildContainerImport } from '../scripts/generate-gtm-import.mjs';
import {
  classifyUrl,
  discoverStorefrontUrls,
  parseArgs,
  parseDotenv,
  validateDeploymentEnv
} from '../scripts/validate-deployment-env.mjs';

const blueprint = JSON.parse(await readFile(new URL('../config/gtm-workspace-blueprint.json', import.meta.url), 'utf8'));
const execFileAsync = promisify(execFile);

test('builds a GTM container import with required ecommerce tags', () => {
  const containerImport = buildContainerImport(blueprint, { publicId: 'GTM-TEST123' });
  const version = containerImport.containerVersion;
  const tagNames = version.tag.map((tag) => tag.name);
  const triggerNames = version.trigger.map((trigger) => trigger.name);
  const variableNames = version.variable.map((variable) => variable.name);

  assert.equal(containerImport.exportFormatVersion, 2);
  assert.equal(version.container.publicId, 'GTM-TEST123');
  assert.equal(tagNames.includes('GA4 - Config'), true);
  assert.equal(tagNames.includes('GA4 Event - purchase'), true);
  assert.equal(tagNames.includes('Google Ads - Purchase Conversion'), true);
  assert.equal(tagNames.includes('Meta Pixel - Purchase'), true);
  assert.equal(triggerNames.includes('CE - purchase'), true);
  assert.equal(variableNames.includes('DLV - ecommerce.transaction_id'), true);
});

test('GTM purchase and ads tags require the expected consent types', () => {
  const containerImport = buildContainerImport(blueprint);
  const purchase = containerImport.containerVersion.tag.find((tag) => tag.name === 'GA4 Event - purchase');
  const ads = containerImport.containerVersion.tag.find((tag) => tag.name === 'Google Ads - Purchase Conversion');
  const meta = containerImport.containerVersion.tag.find((tag) => tag.name === 'Meta Pixel - Purchase');

  assert.deepEqual(
    purchase.consentSettings.consentType.list.map((entry) => entry.value),
    ['analytics_storage']
  );
  assert.deepEqual(
    ads.consentSettings.consentType.list.map((entry) => entry.value),
    ['ad_storage', 'ad_user_data', 'ad_personalization']
  );
  assert.deepEqual(
    meta.consentSettings.consentType.list.map((entry) => entry.value),
    ['ad_storage', 'ad_personalization']
  );
});

test('parses dotenv values without quotes', () => {
  assert.deepEqual(parseDotenv('A=1\nB="two"\nC=\'three\'\n# ignored\n'), {
    A: '1',
    B: 'two',
    C: 'three'
  });
});

test('parses deployment env validator CLI arguments', () => {
  const parsed = parseArgs([
    '/tmp/store',
    '--env-file',
    '/tmp/marketing-production.env',
    '--strict'
  ]);

  assert.equal(parsed.root, '/tmp/store');
  assert.deepEqual(parsed.envFiles, ['/tmp/marketing-production.env']);
  assert.equal(parsed.strict, true);
});

test('deployment env validator reports ready only for real-looking IDs', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-env-'));

  try {
    await writeFile(path.join(tmp, '.env.local'), [
      'NEXT_PUBLIC_GTM_ID=GTM-ABC1234',
      'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events',
      'NEXT_PUBLIC_APP_URL=https://store.example.test',
      'DOWNSTREAM_CRM_WEBHOOK_URL=https://crm.example.test/events',
      'NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-ABCD123456',
      'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-123456789',
      'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL=Purchase_Label_123',
      'NEXT_PUBLIC_META_PIXEL_ID=1234567890',
      ''
    ].join('\n'));

    const report = await validateDeploymentEnv(tmp);

    assert.equal(report.ready, true);
    assert.deepEqual(report.summary.missing, []);
    assert.deepEqual(report.summary.placeholders, []);
    assert.deepEqual(report.summary.invalid, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('deployment env validator flags placeholders and missing downstream CRM', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-env-'));

  try {
    await writeFile(path.join(tmp, '.env.local'), [
      'NEXT_PUBLIC_GTM_ID=GTM-XXXXXXX',
      'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events',
      'NEXT_PUBLIC_APP_URL=http://localhost:3000',
      'NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-XXXXXXXXXX',
      'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-XXXXXXXXX',
      'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL=replace-with-purchase-label',
      'NEXT_PUBLIC_META_PIXEL_ID=replace-with-meta-pixel-id',
      ''
    ].join('\n'));

    const report = await validateDeploymentEnv(tmp);

    assert.equal(report.ready, false);
    assert.equal(report.summary.missing.includes('DOWNSTREAM_CRM_WEBHOOK_URL'), true);
    assert.equal(report.summary.placeholders.includes('NEXT_PUBLIC_GTM_ID'), true);
    assert.equal(report.summary.placeholders.includes('NEXT_PUBLIC_APP_URL'), true);
    assert.equal(report.summary.placeholders.includes('NEXT_PUBLIC_GA4_MEASUREMENT_ID'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('deployment env validator discovers production storefront URL candidates', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-env-url-'));

  try {
    await writeFile(path.join(tmp, '.env.local'), 'NEXT_PUBLIC_APP_URL=http://localhost:3000\n');
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({
      homepage: 'https://store.example.test'
    }));
    await writeFile(path.join(tmp, 'README.md'), 'Open http://localhost:3000 for local development.\n');

    const report = await validateDeploymentEnv(tmp);

    assert.equal(report.url_discovery.ready, true);
    assert.equal(report.url_discovery.suggested_url, 'https://store.example.test');
    assert.equal(report.url_discovery.candidates.some((candidate) => candidate.status === 'local'), true);
    assert.equal(report.summary.placeholders.includes('NEXT_PUBLIC_APP_URL'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('storefront URL discovery classifies local, placeholder, and ready URLs', async () => {
  const discovery = await discoverStorefrontUrls('/tmp/not-a-store', {
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    VERCEL_PROJECT_PRODUCTION_URL: 'my-store.example.test'
  });

  assert.deepEqual(classifyUrl('https://your-store.example'), {
    url: 'https://your-store.example',
    status: 'placeholder'
  });
  assert.equal(discovery.ready, true);
  assert.equal(discovery.suggested_url, 'https://my-store.example.test');
});

test('GTM generator CLI writes an import file', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-gtm-'));
  const output = path.join(tmp, 'gtm-import.json');

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/generate-gtm-import.mjs', import.meta.url)),
      '--output',
      output,
      '--public-id',
      'GTM-CLI123'
    ]);
    const report = JSON.parse(stdout);
    const generated = JSON.parse(await readFile(output, 'utf8'));

    assert.equal(report.ok, true);
    assert.equal(generated.containerVersion.container.publicId, 'GTM-CLI123');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('deployment env validator CLI prints readiness JSON', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-env-'));

  try {
    await writeFile(path.join(tmp, '.env.local'), 'NEXT_PUBLIC_GTM_ID=GTM-XXXXXXX\n');
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/validate-deployment-env.mjs', import.meta.url)),
      tmp
    ]);
    const report = JSON.parse(stdout);

    assert.equal(report.ready, false);
    assert.equal(report.summary.placeholders.includes('NEXT_PUBLIC_GTM_ID'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('deployment env validator CLI reads an explicit env file', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-env-file-'));
  const envFile = path.join(tmp, 'candidate.env');

  try {
    await writeFile(envFile, [
      'NEXT_PUBLIC_GTM_ID=GTM-ABC1234',
      'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events',
      'NEXT_PUBLIC_APP_URL=https://store.example.test',
      'NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-ABCD123456',
      'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-123456789',
      ''
    ].join('\n'));

    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/validate-deployment-env.mjs', import.meta.url)),
      tmp,
      '--env-file',
      envFile
    ]);
    const report = JSON.parse(stdout);

    assert.equal(report.ready, false);
    assert.deepEqual(report.loaded_env_files, [envFile]);
    assert.deepEqual(report.summary.missing, [
      'DOWNSTREAM_CRM_WEBHOOK_URL',
      'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL',
      'NEXT_PUBLIC_META_PIXEL_ID'
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

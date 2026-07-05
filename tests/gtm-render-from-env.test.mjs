import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildContainerImport } from '../scripts/generate-gtm-import.mjs';
import { renderGtmImport, renderGtmImportFromEnv } from '../scripts/render-gtm-import-from-env.mjs';

const execFileAsync = promisify(execFile);
const blueprint = JSON.parse(await readFile(new URL('../config/gtm-workspace-blueprint.json', import.meta.url), 'utf8'));

function validEnvText() {
  return [
    'NEXT_PUBLIC_GTM_ID=GTM-ABC1234',
    'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events',
    'NEXT_PUBLIC_APP_URL=https://store.example.test',
    'DOWNSTREAM_CRM_WEBHOOK_URL=https://crm.example.test/events',
    'NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-ABCD123456',
    'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-123456789',
    'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL=Purchase_Label_123',
    'NEXT_PUBLIC_META_PIXEL_ID=1234567890',
    ''
  ].join('\n');
}

function constantValues(containerImport) {
  return Object.fromEntries(containerImport.containerVersion.variable
    .filter((variable) => variable.type === 'c')
    .map((variable) => [
      variable.name,
      variable.parameter.find((parameter) => parameter.key === 'value')?.value
    ]));
}

test('renders GTM public ID and constant variables from env values', () => {
  const source = buildContainerImport(blueprint);
  const { rendered, changed } = renderGtmImport(source, {
    NEXT_PUBLIC_GTM_ID: 'GTM-ABC1234',
    NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-ABCD123456',
    NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID: 'AW-123456789',
    NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL: 'Purchase_Label_123',
    NEXT_PUBLIC_META_PIXEL_ID: '1234567890'
  });
  const constants = constantValues(rendered);

  assert.equal(rendered.containerVersion.container.publicId, 'GTM-ABC1234');
  assert.equal(constants['GA4 Measurement ID'], 'G-ABCD123456');
  assert.equal(constants['Google Ads Conversion ID'], 'AW-123456789');
  assert.equal(constants['Google Ads Purchase Label'], 'Purchase_Label_123');
  assert.equal(constants['Meta Pixel ID'], '1234567890');
  assert.equal(changed.public_id, 'GTM***234');
});

test('dry-run renders and verifies without writing output', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-gtm-render-'));
  const siteRoot = path.join(tmp, 'store');
  const envFile = path.join(tmp, 'marketing.env');
  const input = path.join(tmp, 'gtm.json');
  const output = path.join(tmp, 'rendered.json');

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(envFile, validEnvText());
    await writeFile(input, JSON.stringify(buildContainerImport(blueprint)));

    const report = await renderGtmImportFromEnv({
      siteRoot,
      envFile,
      input,
      output,
      dryRun: true
    });

    assert.equal(report.ok, true);
    assert.equal(report.dry_run, true);
    assert.equal(report.verification.summary.failed, 0);
    await assert.rejects(readFile(output, 'utf8'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('writes production GTM import when env values are ready', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-gtm-render-'));
  const siteRoot = path.join(tmp, 'store');
  const envFile = path.join(tmp, 'marketing.env');
  const input = path.join(tmp, 'gtm.json');
  const output = path.join(tmp, 'rendered.json');

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(envFile, validEnvText());
    await writeFile(input, JSON.stringify(buildContainerImport(blueprint)));

    const report = await renderGtmImportFromEnv({
      siteRoot,
      envFile,
      input,
      output
    });
    const rendered = JSON.parse(await readFile(output, 'utf8'));
    const constants = constantValues(rendered);

    assert.equal(report.ok, true);
    assert.equal(rendered.containerVersion.container.publicId, 'GTM-ABC1234');
    assert.equal(constants['Meta Pixel ID'], '1234567890');
    assert.equal(report.changed.constants['Meta Pixel ID'].masked_value, '123***890');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('refuses to render GTM import from placeholder env values', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-gtm-render-'));
  const siteRoot = path.join(tmp, 'store');
  const envFile = path.join(tmp, 'marketing.env');
  const input = path.join(tmp, 'gtm.json');

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(envFile, 'NEXT_PUBLIC_GTM_ID=GTM-XXXXXXX\n');
    await writeFile(input, JSON.stringify(buildContainerImport(blueprint)));

    const report = await renderGtmImportFromEnv({
      siteRoot,
      envFile,
      input
    });

    assert.equal(report.ok, false);
    assert.equal(report.source_status.placeholders.includes('NEXT_PUBLIC_GTM_ID'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('GTM render CLI masks values in stdout', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-gtm-render-cli-'));
  const siteRoot = path.join(tmp, 'store');
  const envFile = path.join(tmp, 'marketing.env');
  const input = path.join(tmp, 'gtm.json');
  const output = path.join(tmp, 'rendered.json');

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(envFile, validEnvText());
    await writeFile(input, JSON.stringify(buildContainerImport(blueprint)));

    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/render-gtm-import-from-env.mjs', import.meta.url)),
      '--site-root',
      siteRoot,
      '--env-file',
      envFile,
      '--input',
      input,
      '--output',
      output,
      '--dry-run'
    ]);
    const report = JSON.parse(stdout);

    assert.equal(report.ok, true);
    assert.equal(stdout.includes('G-ABCD123456'), false);
    assert.equal(stdout.includes('1234567890'), false);
    assert.equal(report.changed.constants['GA4 Measurement ID'].masked_value, 'G-A***456');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

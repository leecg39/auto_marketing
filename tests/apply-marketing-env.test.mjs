import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  applyMarketingEnv,
  classifySourceValues,
  maskValue,
  mergeEnvText
} from '../scripts/apply-marketing-env.mjs';

const execFileAsync = promisify(execFile);

function validMarketingEnv() {
  return [
    'NEXT_PUBLIC_GTM_ID=GTM-ABC1234',
    'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events',
    'NEXT_PUBLIC_APP_URL=https://store.example.test',
    'DOWNSTREAM_CRM_WEBHOOK_URL=https://crm.example.test/events',
    'DOWNSTREAM_CRM_API_KEY=test-api-key-123456',
    'NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY=KRW',
    'NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-ABCD123456',
    'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-123456789',
    'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL=Purchase_Label_123',
    'NEXT_PUBLIC_META_PIXEL_ID=1234567890',
    ''
  ].join('\n');
}

test('masks env values in reports', () => {
  assert.equal(maskValue('abcdef123456'), 'abc***456');
  assert.equal(maskValue('short'), '***');
});

test('classifies source env placeholders and missing keys', () => {
  const status = classifySourceValues({
    NEXT_PUBLIC_GTM_ID: 'GTM-XXXXXXX'
  });

  assert.equal(status.ready, false);
  assert.equal(status.placeholders.includes('NEXT_PUBLIC_GTM_ID'), true);
  assert.equal(status.missing.includes('NEXT_PUBLIC_GA4_MEASUREMENT_ID'), true);
});

test('merges marketing values into existing env text', () => {
  const merged = mergeEnvText('NEXT_PUBLIC_APP_URL=http://localhost:3000\nNEXT_PUBLIC_GTM_ID=GTM-OLD123\n', {
    NEXT_PUBLIC_GTM_ID: 'GTM-NEW123',
    NEXT_PUBLIC_CRM_WEBHOOK_URL: '/api/crm/events'
  });

  assert.equal(merged.text.includes('NEXT_PUBLIC_APP_URL=http://localhost:3000'), true);
  assert.equal(merged.text.includes('NEXT_PUBLIC_GTM_ID=GTM-NEW123'), true);
  assert.equal(merged.text.includes('NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events'), true);
  assert.deepEqual(merged.updated, ['NEXT_PUBLIC_GTM_ID']);
  assert.deepEqual(merged.inserted, ['NEXT_PUBLIC_CRM_WEBHOOK_URL']);
});

test('dry-run validates source env without writing target env', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-apply-env-'));
  const siteRoot = path.join(tmp, 'store');
  const source = path.join(tmp, 'marketing.env');
  const target = path.join(siteRoot, '.env.local');

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(source, validMarketingEnv());
    await writeFile(target, 'NEXT_PUBLIC_APP_URL=http://localhost:3000\n');

    const report = await applyMarketingEnv({
      siteRoot,
      envFile: source,
      dryRun: true
    });
    const targetText = await readFile(target, 'utf8');

    assert.equal(report.ok, true);
    assert.equal(report.dry_run, true);
    assert.equal(report.deployment_ready, null);
    assert.equal(report.changed_keys.includes('NEXT_PUBLIC_GTM_ID'), true);
    assert.equal(report.masked_values.DOWNSTREAM_CRM_API_KEY, 'tes***456');
    assert.equal(targetText, 'NEXT_PUBLIC_APP_URL=http://localhost:3000\n');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('applies marketing env and validates target readiness', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-apply-env-'));
  const siteRoot = path.join(tmp, 'store');
  const source = path.join(tmp, 'marketing.env');
  const target = path.join(siteRoot, '.env.local');

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(source, validMarketingEnv());
    await writeFile(target, 'NEXT_PUBLIC_APP_URL=http://localhost:3000\n');

    const report = await applyMarketingEnv({
      siteRoot,
      envFile: source
    });
    const targetText = await readFile(target, 'utf8');

    assert.equal(report.ok, true);
    assert.equal(report.deployment_ready, true);
    assert.equal(Boolean(report.backup_file), true);
    assert.equal(targetText.includes('NEXT_PUBLIC_APP_URL=https://store.example.test'), true);
    assert.equal(targetText.includes('NEXT_PUBLIC_GTM_ID=GTM-ABC1234'), true);
    assert.equal(targetText.includes('DOWNSTREAM_CRM_API_KEY=test-api-key-123456'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('apply env CLI does not print raw secret values', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-apply-env-cli-'));
  const siteRoot = path.join(tmp, 'store');
  const source = path.join(tmp, 'marketing.env');

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(source, validMarketingEnv());

    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/apply-marketing-env.mjs', import.meta.url)),
      '--site-root',
      siteRoot,
      '--env-file',
      source,
      '--dry-run'
    ]);
    const report = JSON.parse(stdout);

    assert.equal(report.ok, true);
    assert.equal(stdout.includes('test-api-key-123456'), false);
    assert.equal(report.masked_values.DOWNSTREAM_CRM_API_KEY, 'tes***456');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

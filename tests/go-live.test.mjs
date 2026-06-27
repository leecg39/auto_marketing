import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseArgs, runGoLive, summarizeSteps } from '../scripts/run-go-live.mjs';

const execFileAsync = promisify(execFile);

function validMarketingEnv() {
  return [
    'NEXT_PUBLIC_GTM_ID=GTM-ABC1234',
    'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events',
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

function isolatedOutputs(tmp) {
  return {
    gtmImport: path.join(tmp, 'gtm-container-import.json'),
    productionGtmImport: path.join(tmp, 'gtm-container-import.production.json'),
    fullQaReport: path.join(tmp, 'full-qa-report.json'),
    handoffOutput: path.join(tmp, 'deployment-handoff.md'),
    handoffJsonOutput: path.join(tmp, 'deployment-handoff.json'),
    completionOutput: path.join(tmp, 'completion-audit.md'),
    completionJsonOutput: path.join(tmp, 'completion-audit.json'),
    goLiveReport: path.join(tmp, 'go-live-report.json')
  };
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

test('parses go-live arguments', () => {
  const parsed = parseArgs([
    '--site-root',
    '/tmp/store',
    '--env-file',
    '/tmp/marketing.env',
    '--dry-run',
    '--skip-full-qa',
    '--no-start-local',
    '--no-start-site',
    '--site-port',
    '3200'
  ]);

  assert.equal(parsed.siteRoot, '/tmp/store');
  assert.equal(parsed.envFile, '/tmp/marketing.env');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.skipFullQa, true);
  assert.equal(parsed.startLocal, false);
  assert.equal(parsed.startSite, false);
  assert.equal(parsed.sitePort, 3200);
});

test('summarizes go-live step statuses', () => {
  assert.deepEqual(summarizeSteps([
    { status: 'passed' },
    { status: 'warning' },
    { status: 'skipped' },
    { status: 'failed' }
  ]), {
    passed: 1,
    warning: 1,
    skipped: 1,
    failed: 1
  });
});

test('go-live dry-run validates source env and GTM rendering without writing site env', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-go-live-'));
  const siteRoot = path.join(tmp, 'store');
  const envFile = path.join(tmp, 'marketing.env');
  const target = path.join(siteRoot, '.env.local');

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(envFile, validMarketingEnv());
    await writeFile(target, 'NEXT_PUBLIC_APP_URL=http://localhost:3000\n');

    const report = await runGoLive({
      siteRoot,
      envFile,
      target,
      dryRun: true,
      skipFullQa: true,
      ...isolatedOutputs(tmp)
    });
    const targetText = await readFile(target, 'utf8');

    assert.equal(report.ok, true);
    assert.equal(report.dry_run, true);
    assert.equal(report.steps.find((item) => item.id === 'apply_env').status, 'passed');
    assert.equal(report.steps.find((item) => item.id === 'render_gtm_import').status, 'passed');
    assert.equal(report.steps.find((item) => item.id === 'validate_site_env').status, 'warning');
    assert.equal(targetText, 'NEXT_PUBLIC_APP_URL=http://localhost:3000\n');
    assert.equal(await exists(path.join(tmp, 'gtm-container-import.production.json')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('go-live applies env and renders production GTM import before strict QA', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-go-live-apply-'));
  const siteRoot = path.join(tmp, 'store');
  const envFile = path.join(tmp, 'marketing.env');
  const target = path.join(siteRoot, '.env.local');
  const outputs = isolatedOutputs(tmp);

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(envFile, validMarketingEnv());
    await writeFile(target, 'NEXT_PUBLIC_APP_URL=http://localhost:3000\n');

    const report = await runGoLive({
      siteRoot,
      envFile,
      target,
      skipFullQa: true,
      ...outputs
    });
    const targetText = await readFile(target, 'utf8');
    const rendered = JSON.parse(await readFile(outputs.productionGtmImport, 'utf8'));

    assert.equal(report.ok, false);
    assert.equal(report.steps.find((item) => item.id === 'apply_env').status, 'passed');
    assert.equal(report.steps.find((item) => item.id === 'render_gtm_import').status, 'passed');
    assert.equal(report.steps.find((item) => item.id === 'validate_site_env').status, 'passed');
    assert.equal(targetText.includes('NEXT_PUBLIC_GTM_ID=GTM-ABC1234'), true);
    assert.equal(rendered.containerVersion.container.publicId, 'GTM-ABC1234');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('go-live CLI writes report and masks source secrets', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-go-live-cli-'));
  const siteRoot = path.join(tmp, 'store');
  const envFile = path.join(tmp, 'marketing.env');
  const target = path.join(siteRoot, '.env.local');
  const outputs = isolatedOutputs(tmp);

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(envFile, validMarketingEnv());
    await writeFile(target, 'NEXT_PUBLIC_APP_URL=http://localhost:3000\n');

    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/run-go-live.mjs', import.meta.url)),
      '--site-root',
      siteRoot,
      '--env-file',
      envFile,
      '--target',
      target,
      '--dry-run',
      '--skip-full-qa',
      '--gtm-import',
      outputs.gtmImport,
      '--production-gtm-import',
      outputs.productionGtmImport,
      '--full-qa-report',
      outputs.fullQaReport,
      '--handoff-output',
      outputs.handoffOutput,
      '--handoff-json-output',
      outputs.handoffJsonOutput,
      '--completion-output',
      outputs.completionOutput,
      '--completion-json-output',
      outputs.completionJsonOutput,
      '--report',
      outputs.goLiveReport
    ]);
    const cli = JSON.parse(stdout);
    const report = JSON.parse(await readFile(outputs.goLiveReport, 'utf8'));

    assert.equal(cli.ok, true);
    assert.equal(report.dry_run, true);
    assert.equal(stdout.includes('test-api-key-123456'), false);
    assert.equal(stdout.includes('G-ABCD123456'), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

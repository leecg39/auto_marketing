import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildContainerImport } from '../scripts/generate-gtm-import.mjs';
import { validateGtmImport } from '../scripts/verify-gtm-import.mjs';

const execFileAsync = promisify(execFile);
const blueprint = JSON.parse(await readFile(new URL('../config/gtm-workspace-blueprint.json', import.meta.url), 'utf8'));

test('validates generated GTM import against the marketing blueprint', () => {
  const containerImport = buildContainerImport(blueprint, { publicId: 'GTM-TEST123' });
  const report = validateGtmImport(containerImport, blueprint);

  assert.equal(report.ok, true);
  assert.equal(report.summary.tags, 12);
  assert.equal(report.summary.triggers, 7);
  assert.equal(report.summary.variables, 14);
  assert.equal(report.checks.every((check) => check.ok), true);
});

test('fails when Google Ads purchase conversion is not tied to purchase trigger only', () => {
  const containerImport = buildContainerImport(blueprint);
  const ads = containerImport.containerVersion.tag.find((tag) => tag.name === 'Google Ads - Purchase Conversion');
  ads.firingTriggerId = ['101'];

  const report = validateGtmImport(containerImport, blueprint);
  const failed = report.checks.find((check) => check.id === 'google_ads_purchase_trigger');

  assert.equal(report.ok, false);
  assert.equal(failed.ok, false);
});

test('fails when GTM import contains contact PII variable names', () => {
  const containerImport = buildContainerImport(blueprint);
  containerImport.containerVersion.variable.push({
    name: 'DLV - email',
    type: 'v',
    parameter: [
      { type: 'TEMPLATE', key: 'name', value: 'email' }
    ]
  });

  const report = validateGtmImport(containerImport, blueprint);
  const failed = report.checks.find((check) => check.id === 'no_contact_pii');

  assert.equal(report.ok, false);
  assert.equal(failed.ok, false);
});

test('GTM import verifier CLI prints a JSON report', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-gtm-verify-'));
  const input = path.join(tmp, 'gtm.json');

  try {
    await writeFile(input, JSON.stringify(buildContainerImport(blueprint)));
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/verify-gtm-import.mjs', import.meta.url)),
      '--input',
      input
    ]);
    const report = JSON.parse(stdout);

    assert.equal(report.ok, true);
    assert.equal(report.summary.tags, 12);
    assert.equal(report.input, input);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

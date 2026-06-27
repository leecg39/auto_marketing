import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  buildRequiredInputs,
  envBlock,
  generateDeploymentHandoff,
  parseArgs
} from '../scripts/generate-deployment-handoff.mjs';

const execFileAsync = promisify(execFile);

test('builds a deployment env template with required marketing keys', () => {
  const block = envBlock();

  assert.equal(block.includes('NEXT_PUBLIC_GTM_ID=GTM-XXXXXXX'), true);
  assert.equal(block.includes('NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-XXXXXXXXXX'), true);
  assert.equal(block.includes('NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events'), true);
  assert.equal(block.includes('NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY=KRW'), true);
});

test('parses deployment handoff arguments', () => {
  const parsed = parseArgs([
    '--site-root',
    '/tmp/store',
    '--output',
    '/tmp/handoff.md',
    '--json-output',
    '/tmp/handoff.json'
  ]);

  assert.equal(parsed.siteRoot, '/tmp/store');
  assert.equal(parsed.output, '/tmp/handoff.md');
  assert.equal(parsed.jsonOutput, '/tmp/handoff.json');
});

test('marks missing deployment keys as required inputs', () => {
  const inputs = buildRequiredInputs({
    checks: [
      {
        key: 'NEXT_PUBLIC_GTM_ID',
        status: 'missing'
      }
    ]
  });
  const gtm = inputs.find((input) => input.key === 'NEXT_PUBLIC_GTM_ID');
  const apiKey = inputs.find((input) => input.key === 'DOWNSTREAM_CRM_API_KEY');

  assert.equal(gtm.status, 'missing');
  assert.equal(gtm.placeholder, 'GTM-XXXXXXX');
  assert.equal(apiKey.status, 'manual_check');
});

test('generates markdown and JSON deployment handoff', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-handoff-'));
  const siteRoot = path.join(tmp, 'store');
  const fullQaReport = path.join(tmp, 'full-qa-report.json');
  const gtmImport = path.join(tmp, 'gtm-container-import.json');
  const completionAudit = path.join(tmp, 'completion-audit.json');

  try {
    await writeFile(path.join(tmp, 'placeholder'), '');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(path.join(siteRoot, '.env.local'), 'NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000\n');
    await writeFile(fullQaReport, JSON.stringify({
      local_qa_ok: true,
      deployment_ready: false,
      summary: {
        passed: 13,
        warning: 1,
        failed: 0
      }
    }));
    await writeFile(gtmImport, JSON.stringify({
      containerVersion: {
        container: {
          publicId: 'GTM-XXXXXXX'
        },
        tag: [{}, {}],
        trigger: [{}],
        variable: [{}, {}, {}]
      }
    }));

    const { report, markdown } = await generateDeploymentHandoff({
      siteRoot,
      fullQaReport,
      gtmImport,
      completionAudit
    });

    assert.equal(report.env.ready, false);
    assert.equal(report.full_qa.local_qa_ok, true);
    assert.equal(report.gtm_import.tags, 2);
    assert.equal(report.artifacts.completion_audit.exists, false);
    assert.equal(markdown.includes('마케팅 자동화 배포 Handoff'), true);
    assert.equal(markdown.includes('npm run audit:completion'), true);
    assert.equal(markdown.includes('NEXT_PUBLIC_GTM_ID'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('deployment handoff CLI writes files', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-handoff-cli-'));
  const siteRoot = path.join(tmp, 'store');
  const output = path.join(tmp, 'handoff.md');
  const jsonOutput = path.join(tmp, 'handoff.json');

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(siteRoot));
    await writeFile(path.join(siteRoot, '.env.local'), '');
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/generate-deployment-handoff.mjs', import.meta.url)),
      '--site-root',
      siteRoot,
      '--output',
      output,
      '--json-output',
      jsonOutput
    ]);
    const cli = JSON.parse(stdout);
    const markdown = await readFile(output, 'utf8');
    const json = JSON.parse(await readFile(jsonOutput, 'utf8'));

    assert.equal(cli.ok, true);
    assert.equal(cli.deployment_ready, false);
    assert.equal(markdown.includes('`.env.local`에 추가할 블록'), true);
    assert.equal(json.env.ready, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

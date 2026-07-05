import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  buildSetupPlan,
  generateExternalSetupPlan,
  parseArgs,
  renderMarkdown
} from '../scripts/generate-external-setup-plan.mjs';

const execFileAsync = promisify(execFile);

test('parses external setup plan arguments', () => {
  const parsed = parseArgs([
    '--site-root',
    '/tmp/store',
    '--output',
    '/tmp/external.md',
    '--json-output',
    '/tmp/external.json'
  ]);

  assert.equal(parsed.siteRoot, '/tmp/store');
  assert.equal(parsed.output, '/tmp/external.md');
  assert.equal(parsed.jsonOutput, '/tmp/external.json');
});

test('builds setup tasks from deployment env status', () => {
  const plan = buildSetupPlan({
    ready: false,
    checks: [
      { key: 'NEXT_PUBLIC_APP_URL', label: 'Production storefront URL', status: 'placeholder', ok: false },
      { key: 'NEXT_PUBLIC_GTM_ID', label: 'GTM web container ID', status: 'missing', ok: false },
      { key: 'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID', label: 'Google Ads conversion ID', status: 'ready', ok: true },
      { key: 'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL', label: 'Google Ads purchase label', status: 'missing', ok: false }
    ]
  });
  const domain = plan.tasks.find((task) => task.id === 'production_domain');
  const ads = plan.tasks.find((task) => task.id === 'google_ads_purchase');

  assert.equal(plan.env_ready, false);
  assert.equal(plan.blocking_keys.includes('NEXT_PUBLIC_APP_URL'), true);
  assert.equal(plan.blocking_keys.includes('NEXT_PUBLIC_GTM_ID'), true);
  assert.equal(domain.status, 'blocked_external');
  assert.deepEqual(ads.blocking_keys, [
    'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL',
    'NEXT_PUBLIC_APP_URL'
  ]);
});

test('renders external setup markdown with confirmation gates', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-external-setup-'));
  const siteRoot = path.join(tmp, 'store');

  try {
    await mkdir(siteRoot, { recursive: true });
    await writeFile(path.join(siteRoot, '.env.local'), 'NEXT_PUBLIC_APP_URL=http://localhost:3000\n');

    const { report, markdown } = await generateExternalSetupPlan({ siteRoot });

    assert.equal(report.plan.env_ready, false);
    assert.equal(report.plan.blocking_keys.includes('NEXT_PUBLIC_APP_URL'), true);
    assert.match(markdown, /외부 계정 실행 체크리스트/);
    assert.match(markdown, /Computer Use 확인 게이트/);
    assert.match(markdown, /tagmanager\.google\.com/);
    assert.match(markdown, /NEXT_PUBLIC_APP_URL/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('external setup plan CLI writes markdown and JSON', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-external-cli-'));
  const siteRoot = path.join(tmp, 'store');
  const output = path.join(tmp, 'external.md');
  const jsonOutput = path.join(tmp, 'external.json');

  try {
    await mkdir(siteRoot, { recursive: true });
    await writeFile(path.join(siteRoot, '.env.local'), '');

    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/generate-external-setup-plan.mjs', import.meta.url)),
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
    assert.equal(cli.env_ready, false);
    assert.equal(markdown.includes('값을 받은 뒤 실행'), true);
    assert.equal(json.plan.tasks.some((task) => task.id === 'crm_delivery'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('markdown renderer reports ready plans without blockers', () => {
  const markdown = renderMarkdown({
    generated_at: '2026-07-05T00:00:00.000Z',
    site_root: '/tmp/store',
    plan: {
      env_ready: true,
      blocking_keys: [],
      tasks: [
        {
          title: '운영 자사몰 도메인 확정',
          owner: 'Site/Hosting',
          url: '',
          status: 'ready',
          env: [{ key: 'NEXT_PUBLIC_APP_URL', required: true, status: 'ready' }],
          steps: ['운영 URL을 확인합니다.'],
          evidence: ['운영 URL 접속 성공'],
          confirmation_gate: '저장 직전 확인합니다.'
        }
      ]
    }
  });

  assert.match(markdown, /현재 차단값: 없음/);
  assert.match(markdown, /운영 env 준비: `true`/);
});

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
    '/tmp/external.json',
    '--env-file',
    '/tmp/marketing-production.env'
  ]);

  assert.equal(parsed.siteRoot, '/tmp/store');
  assert.equal(parsed.output, '/tmp/external.md');
  assert.equal(parsed.jsonOutput, '/tmp/external.json');
  assert.equal(parsed.envFile, '/tmp/marketing-production.env');
});

test('builds setup tasks from deployment env status', () => {
  const plan = buildSetupPlan({
    ready: false,
    checks: [
      { key: 'NEXT_PUBLIC_APP_URL', label: 'Production storefront URL', status: 'placeholder', ok: false },
      { key: 'NEXT_PUBLIC_GTM_ID', label: 'GTM web container ID', status: 'missing', ok: false },
      { key: 'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID', label: 'Google Ads conversion ID', status: 'ready', ok: true },
      { key: 'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL', label: 'Google Ads purchase label', status: 'missing', ok: false }
    ],
    url_discovery: {
      suggested_url: 'https://store.example.test',
      candidates: [
        { source: 'package.json:homepage', url: 'https://store.example.test', status: 'ready' }
      ],
      next_step: 'NEXT_PUBLIC_APP_URL에 https://store.example.test를 넣고 validate:env를 다시 실행하세요.'
    }
  });
  const domain = plan.tasks.find((task) => task.id === 'production_domain');
  const ads = plan.tasks.find((task) => task.id === 'google_ads_purchase');

  assert.equal(plan.env_ready, false);
  assert.equal(plan.blocking_keys.includes('NEXT_PUBLIC_APP_URL'), true);
  assert.equal(plan.blocking_keys.includes('NEXT_PUBLIC_GTM_ID'), true);
  assert.equal(domain.status, 'blocked_external');
  assert.equal(domain.suggested_url, 'https://store.example.test');
  assert.equal(domain.discovered_urls[0].source, 'package.json:homepage');
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
    assert.match(markdown, /탐색된 운영 URL/);
    assert.match(markdown, /tagmanager\.google\.com/);
    assert.match(markdown, /NEXT_PUBLIC_APP_URL/);
    assert.match(markdown, /Action-time 확인 문구/);
    assert.match(markdown, /oliveyoung-shopee-web을 실제 생성합니다/);
    assert.equal(report.plan.tasks.find((task) => task.id === 'gtm_container').confirmation_prompt.includes('만들기를 눌러도 될까요'), true);
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
    assert.equal(json.plan.tasks.find((task) => task.id === 'crm_delivery').confirmation_prompt.includes('테스트 계정으로만 진행'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('external setup plan can use an explicit env file', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-external-env-file-'));
  const siteRoot = path.join(tmp, 'store');
  const envFile = path.join(tmp, 'candidate.env');
  const output = path.join(tmp, 'external.md');
  const jsonOutput = path.join(tmp, 'external.json');

  try {
    await mkdir(siteRoot, { recursive: true });
    await writeFile(envFile, [
      'NEXT_PUBLIC_GTM_ID=GTM-NHSTBZ3N',
      'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events',
      'NEXT_PUBLIC_APP_URL=https://auto-marketing-sigma.vercel.app',
      'NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-FECEN229PE',
      'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-4464425600',
      ''
    ].join('\n'));

    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/generate-external-setup-plan.mjs', import.meta.url)),
      '--site-root',
      siteRoot,
      '--env-file',
      envFile,
      '--output',
      output,
      '--json-output',
      jsonOutput
    ]);
    const cli = JSON.parse(stdout);
    const markdown = await readFile(output, 'utf8');
    const json = JSON.parse(await readFile(jsonOutput, 'utf8'));

    assert.equal(cli.env_ready, false);
    assert.deepEqual(cli.blocking_keys, [
      'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL',
      'NEXT_PUBLIC_META_PIXEL_ID',
      'DOWNSTREAM_CRM_WEBHOOK_URL'
    ]);
    assert.equal(json.env_file, envFile);
    assert.deepEqual(json.env.summary.missing, [
      'DOWNSTREAM_CRM_WEBHOOK_URL',
      'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL',
      'NEXT_PUBLIC_META_PIXEL_ID'
    ]);
    assert.equal(markdown.includes(`운영 env 파일: \`${envFile}\``), true);
    assert.match(markdown, /--env-file '/);
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

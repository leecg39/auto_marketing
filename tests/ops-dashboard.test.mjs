import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildDashboardData,
  nextActions,
  parseArgs,
  renderHtml,
  writeDashboard
} from '../scripts/generate-ops-dashboard.mjs';

test('parses ops dashboard arguments', () => {
  const parsed = parseArgs([
    '--site-root',
    '/tmp/store',
    '--output',
    '/tmp/dashboard.html',
    '--json-output',
    '/tmp/dashboard.json'
  ]);

  assert.equal(parsed.siteRoot, '/tmp/store');
  assert.equal(parsed.output, '/tmp/dashboard.html');
  assert.equal(parsed.jsonOutput, '/tmp/dashboard.json');
});

test('maps missing external env keys to next actions', () => {
  const actions = nextActions([
    'NEXT_PUBLIC_GTM_ID',
    'NEXT_PUBLIC_META_PIXEL_ID',
    'DOWNSTREAM_CRM_WEBHOOK_URL'
  ]);

  assert.deepEqual(actions.map((action) => action.key), [
    'NEXT_PUBLIC_GTM_ID',
    'NEXT_PUBLIC_META_PIXEL_ID',
    'DOWNSTREAM_CRM_WEBHOOK_URL'
  ]);
  assert.equal(actions[0].title, 'GTM 웹 컨테이너 생성');
  assert.equal(actions[0].confirmation_required, true);
  assert.match(actions[0].confirmation_reason, /GTM/);
  assert.equal(actions.every((action) => action.confirmation_required), true);
});

test('builds dashboard data from current env and completion audit', () => {
  const data = buildDashboardData({
    siteRoot: '/tmp/store',
    fullQa: {
      local_qa_ok: true,
      deployment_ready: false,
      summary: {
        passed: 14,
        warning: 2,
        failed: 0
      }
    },
    audit: {
      completion_ready: false,
      summary: {
        complete: 6,
        blocked_external: 2,
        failed: 0
      },
      blocking_inputs: ['NEXT_PUBLIC_GTM_ID'],
      requirements: [
        {
          id: 'operating_env',
          title: '운영 계정값 적용',
          status: 'blocked_external',
          next_step: '운영 env 값을 채웁니다.'
        }
      ]
    },
    handoff: null,
    env: {
      ready: false,
      summary: {
        missing: ['NEXT_PUBLIC_GTM_ID', 'NEXT_PUBLIC_GA4_MEASUREMENT_ID'],
        placeholders: [],
        invalid: []
      }
    },
    artifacts: {}
  });

  assert.equal(data.status.local_qa_ok, true);
  assert.equal(data.status.completion_ready, false);
  assert.deepEqual(data.summary.blockers, [
    'NEXT_PUBLIC_GTM_ID',
    'NEXT_PUBLIC_GA4_MEASUREMENT_ID'
  ]);
  assert.equal(data.next_actions[1].key, 'NEXT_PUBLIC_GA4_MEASUREMENT_ID');
  assert.equal(data.next_actions[1].confirmation_required, true);
});

test('renders escaped HTML dashboard', () => {
  const html = renderHtml({
    generated_at: '2026-07-05T00:00:00.000Z',
    site_root: '/tmp/<store>',
    status: {
      local_qa_ok: true,
      deployment_ready: false,
      completion_ready: false
    },
    summary: {
      full_qa: { passed: 1, warning: 1, failed: 0 },
      completion: { complete: 6, blocked_external: 2, failed: 0 },
      blockers: ['NEXT_PUBLIC_GTM_ID']
    },
    requirements: [],
    next_actions: nextActions(['NEXT_PUBLIC_GTM_ID'])
  });

  assert.match(html, /Growth Ops Dashboard/);
  assert.match(html, /\/tmp\/&lt;store&gt;/);
  assert.match(html, /실행 전 확인 필요/);
  assert.match(html, /Google 계정에 새 GTM 계정\/컨테이너를 생성합니다/);
  assert.doesNotMatch(html, /\/tmp\/<store>/);
});

test('ops dashboard CLI writer emits HTML and JSON files', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-dashboard-'));
  const siteRoot = path.join(tmp, 'store');
  const fullQaReport = path.join(tmp, 'full-qa.json');
  const auditReport = path.join(tmp, 'completion.json');
  const handoffReport = path.join(tmp, 'handoff.json');
  const output = path.join(tmp, 'dashboard.html');
  const jsonOutput = path.join(tmp, 'dashboard.json');

  try {
    await mkdir(siteRoot, { recursive: true });
    await writeFile(path.join(siteRoot, '.env.local'), [
      'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events',
      'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-123456789'
    ].join('\n'));
    await writeFile(fullQaReport, JSON.stringify({
      local_qa_ok: true,
      deployment_ready: false,
      summary: { passed: 14, warning: 2, failed: 0 }
    }));
    await writeFile(auditReport, JSON.stringify({
      completion_ready: false,
      summary: { complete: 6, blocked_external: 2, failed: 0 },
      blocking_inputs: ['NEXT_PUBLIC_GTM_ID'],
      requirements: []
    }));
    await writeFile(handoffReport, JSON.stringify({
      site_root: siteRoot,
      env: {
        summary: {
          missing: ['NEXT_PUBLIC_GTM_ID']
        }
      }
    }));

    const result = await writeDashboard({
      siteRoot,
      fullQaReport,
      completionAudit: auditReport,
      handoffReport,
      output,
      jsonOutput
    });

    assert.equal(result.ok, true);
    assert.equal(result.output, output);
    assert.match(await readFile(output, 'utf8'), /Growth Ops Dashboard/);

    const json = JSON.parse(await readFile(jsonOutput, 'utf8'));
    assert.equal(json.summary.blockers.includes('NEXT_PUBLIC_GTM_ID'), true);
    assert.equal(json.next_actions[0].key, 'NEXT_PUBLIC_GTM_ID');
    assert.equal(json.next_actions[0].confirmation_required, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

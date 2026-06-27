import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  REQUIRED_AUTOMATION_ACTIONS,
  REQUIRED_EVENTS,
  auditCompletion,
  parseArgs,
  renderMarkdown
} from '../scripts/audit-completion.mjs';

const execFileAsync = promisify(execFile);

function passedStep(id, json = { ok: true }) {
  return {
    id,
    status: 'passed',
    ok: true,
    json
  };
}

function baseFullQa({ envReady = false, renderReady = false } = {}) {
  const supportedEvents = Object.fromEntries(REQUIRED_EVENTS.map((eventName) => [eventName, true]));

  return {
    local_qa_ok: true,
    deployment_ready: envReady,
    summary: {
      passed: renderReady ? 16 : 14,
      warning: renderReady ? 0 : 2,
      failed: 0
    },
    steps: [
      passedStep('gtm_import_verify', {
        ok: true,
        summary: {
          checks: 77,
          passed: 77,
          failed: 0,
          tags: 12,
          triggers: 7,
          variables: 14
        }
      }),
      passedStep('site_audit', {
        installation_status: {
          sdk_installed: true,
          wrapper_installed: true,
          crm_route_installed: true,
          provider_implemented: true,
          provider_mounted: true,
          supported_events: supportedEvents
        }
      }),
      passedStep('site_runtime'),
      passedStep('browser_demo_e2e', {
        summary: {
          duplicate_purchase: 'duplicate_transaction_id',
          pii_in_data_layer: false,
          automation_action_flows: REQUIRED_AUTOMATION_ACTIONS
        }
      }),
      passedStep('local_e2e', {
        summary: {
          crm_events: [
            { automation_flow: 'cart_abandonment_candidate' },
            { automation_flow: 'checkout_abandonment_candidate' },
            { automation_flow: 'post_purchase_review_and_recommendation' },
            { automation_flow: 'lead_followup' }
          ],
          downstream: {
            event_names: ['add_to_cart', 'begin_checkout', 'purchase', 'generate_lead']
          }
        }
      }),
      passedStep('revenue_reconciliation', {
        ok: true,
        totals: {
          diff_percent: 0.0143
        }
      }),
      {
        id: 'site_env',
        status: envReady ? 'passed' : 'warning',
        ok: true,
        json: {
          ready: envReady,
          summary: envReady
            ? { missing: [], placeholders: [], invalid: [] }
            : { missing: ['NEXT_PUBLIC_GTM_ID'], placeholders: [], invalid: [] }
        }
      },
      {
        id: 'gtm_import_render',
        status: renderReady ? 'passed' : 'warning',
        ok: renderReady,
        json: {
          ok: renderReady,
          output: '/tmp/gtm-container-import.production.json'
        }
      }
    ]
  };
}

function handoff({ ready = false } = {}) {
  return {
    site_root: '/tmp/store',
    env: {
      ready,
      summary: ready
        ? { missing: [], placeholders: [], invalid: [] }
        : { missing: ['NEXT_PUBLIC_GTM_ID'], placeholders: [], invalid: [] }
    }
  };
}

const READY_ENV = [
  'NEXT_PUBLIC_GTM_ID=GTM-ABCDE12',
  'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events',
  'DOWNSTREAM_CRM_WEBHOOK_URL=https://crm.example.test/webhook',
  'NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-ABCDE12345',
  'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-123456789',
  'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL=Purchase_Label_123',
  'NEXT_PUBLIC_META_PIXEL_ID=123456789012'
].join('\n');

async function writeSiteEnv(siteRoot, lines) {
  await mkdir(siteRoot, { recursive: true });
  await writeFile(path.join(siteRoot, '.env.local'), `${lines.join('\n')}\n`);
}

test('parses completion audit arguments', () => {
  const parsed = parseArgs([
    '--site-root',
    '/tmp/store',
    '--output',
    '/tmp/completion.md',
    '--json-output',
    '/tmp/completion.json',
    '--strict'
  ]);

  assert.equal(parsed.siteRoot, '/tmp/store');
  assert.equal(parsed.output, '/tmp/completion.md');
  assert.equal(parsed.jsonOutput, '/tmp/completion.json');
  assert.equal(parsed.strict, true);
});

test('completion audit marks missing operating values as external blockers', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-completion-'));
  const siteRoot = path.join(tmp, 'store');
  const fullQaReport = path.join(tmp, 'full-qa.json');
  const handoffReport = path.join(tmp, 'handoff.json');

  try {
    await writeSiteEnv(siteRoot, READY_ENV.split('\n').filter((line) => !line.startsWith('NEXT_PUBLIC_GTM_ID=')));
    await writeFile(fullQaReport, JSON.stringify(baseFullQa()));
    await writeFile(handoffReport, JSON.stringify(handoff()));

    const report = await auditCompletion({
      siteRoot,
      fullQaReport,
      handoffReport
    });

    assert.equal(report.completion_ready, false);
    assert.equal(report.summary.complete, 6);
    assert.equal(report.summary.blocked_external, 2);
    assert.deepEqual(report.blocking_inputs, ['NEXT_PUBLIC_GTM_ID']);
    assert.equal(report.requirements.find((item) => item.id === 'operating_env').status, 'blocked_external');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('completion audit uses current site env before stale handoff inputs', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-completion-current-env-'));
  const siteRoot = path.join(tmp, 'store');
  const fullQaReport = path.join(tmp, 'full-qa.json');
  const handoffReport = path.join(tmp, 'handoff.json');

  try {
    await writeSiteEnv(siteRoot, [
      'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events'
    ]);
    await writeFile(fullQaReport, JSON.stringify(baseFullQa()));
    await writeFile(handoffReport, JSON.stringify({
      ...handoff(),
      env: {
        ready: false,
        summary: {
          missing: ['NEXT_PUBLIC_GTM_ID', 'NEXT_PUBLIC_CRM_WEBHOOK_URL'],
          placeholders: [],
          invalid: []
        }
      }
    }));

    const report = await auditCompletion({
      siteRoot,
      fullQaReport,
      handoffReport
    });

    assert.equal(report.blocking_inputs.includes('NEXT_PUBLIC_CRM_WEBHOOK_URL'), false);
    assert.equal(report.blocking_inputs.includes('NEXT_PUBLIC_GTM_ID'), true);
    assert.equal(report.blocking_inputs.includes('DOWNSTREAM_CRM_WEBHOOK_URL'), true);
    assert.deepEqual(report.evidence_files.current_env.loaded_env_files, ['.env.local']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('completion audit reports ready when all requirement evidence is complete', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-completion-ready-'));
  const siteRoot = path.join(tmp, 'store');
  const fullQaReport = path.join(tmp, 'full-qa.json');
  const handoffReport = path.join(tmp, 'handoff.json');

  try {
    await writeSiteEnv(siteRoot, READY_ENV.split('\n'));
    await writeFile(fullQaReport, JSON.stringify(baseFullQa({ envReady: true, renderReady: true })));
    await writeFile(handoffReport, JSON.stringify(handoff({ ready: true })));

    const report = await auditCompletion({
      siteRoot,
      fullQaReport,
      handoffReport
    });
    const markdown = renderMarkdown(report);

    assert.equal(report.completion_ready, true);
    assert.equal(report.summary.complete, 8);
    assert.equal(report.summary.blocked_external, 0);
    assert.equal(markdown.includes('완료 판정: `true`'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('completion audit CLI writes markdown and JSON outputs', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-completion-cli-'));
  const siteRoot = path.join(tmp, 'store');
  const fullQaReport = path.join(tmp, 'full-qa.json');
  const handoffReport = path.join(tmp, 'handoff.json');
  const output = path.join(tmp, 'completion.md');
  const jsonOutput = path.join(tmp, 'completion.json');

  try {
    await writeSiteEnv(siteRoot, READY_ENV.split('\n').filter((line) => !line.startsWith('NEXT_PUBLIC_GTM_ID=')));
    await writeFile(fullQaReport, JSON.stringify(baseFullQa()));
    await writeFile(handoffReport, JSON.stringify(handoff()));

    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/audit-completion.mjs', import.meta.url)),
      '--site-root',
      siteRoot,
      '--full-qa-report',
      fullQaReport,
      '--handoff-report',
      handoffReport,
      '--output',
      output,
      '--json-output',
      jsonOutput
    ]);
    const cli = JSON.parse(stdout);
    const markdown = await readFile(output, 'utf8');
    const json = JSON.parse(await readFile(jsonOutput, 'utf8'));

    assert.equal(cli.completion_ready, false);
    assert.equal(markdown.includes('마케팅 자동화 완료 감사'), true);
    assert.equal(json.summary.blocked_external, 2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

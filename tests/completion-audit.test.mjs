import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const fullQaReport = path.join(tmp, 'full-qa.json');
  const handoffReport = path.join(tmp, 'handoff.json');

  try {
    await writeFile(fullQaReport, JSON.stringify(baseFullQa()));
    await writeFile(handoffReport, JSON.stringify(handoff()));

    const report = await auditCompletion({
      siteRoot: '/tmp/store',
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

test('completion audit reports ready when all requirement evidence is complete', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-completion-ready-'));
  const fullQaReport = path.join(tmp, 'full-qa.json');
  const handoffReport = path.join(tmp, 'handoff.json');

  try {
    await writeFile(fullQaReport, JSON.stringify(baseFullQa({ envReady: true, renderReady: true })));
    await writeFile(handoffReport, JSON.stringify(handoff({ ready: true })));

    const report = await auditCompletion({
      siteRoot: '/tmp/store',
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
  const fullQaReport = path.join(tmp, 'full-qa.json');
  const handoffReport = path.join(tmp, 'handoff.json');
  const output = path.join(tmp, 'completion.md');
  const jsonOutput = path.join(tmp, 'completion.json');

  try {
    await writeFile(fullQaReport, JSON.stringify(baseFullQa()));
    await writeFile(handoffReport, JSON.stringify(handoff()));

    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/audit-completion.mjs', import.meta.url)),
      '--site-root',
      '/tmp/store',
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

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSteps,
  extractJson,
  parseArgs,
  runOpsRefresh,
  summarizeSteps
} from '../scripts/refresh-ops-status.mjs';

test('parses ops refresh arguments', () => {
  const parsed = parseArgs([
    '--site-root',
    '/tmp/store',
    '--start-local',
    '--start-site',
    '--require-env-ready',
    '--site-port',
    '3200',
    '--timeout-ms',
    '1000',
    '--report',
    '/tmp/report.json'
  ]);

  assert.equal(parsed.siteRoot, '/tmp/store');
  assert.equal(parsed.startLocal, true);
  assert.equal(parsed.startSite, true);
  assert.equal(parsed.requireEnvReady, true);
  assert.equal(parsed.sitePort, 3200);
  assert.equal(parsed.timeoutMs, 1000);
  assert.equal(parsed.report, '/tmp/report.json');
});

test('builds refresh steps with optional full QA skip', () => {
  const options = parseArgs([
    '--site-root',
    '/tmp/store',
    '--skip-full-qa'
  ]);
  const steps = buildSteps(options);

  assert.equal(steps[0].id, 'full_qa');
  assert.equal(steps[0].skip, true);
  assert.deepEqual(steps.slice(1).map((step) => step.id), [
    'handoff',
    'external_setup',
    'completion_audit',
    'ops_dashboard'
  ]);
});

test('extracts first JSON object from command stdout', () => {
  assert.deepEqual(extractJson([
    'prefix',
    '{"ok":true,"nested":{"value":1}}',
    'suffix'
  ].join('\n')), {
    ok: true,
    nested: {
      value: 1
    }
  });
});

test('summarizes refresh step statuses', () => {
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

test('ops refresh continues after a failed command and writes report', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-ops-refresh-'));
  const reportFile = path.join(tmp, 'ops-refresh.json');
  const calls = [];

  try {
    const report = await runOpsRefresh([
      '--site-root',
      path.join(tmp, 'store'),
      '--report',
      reportFile
    ], async (step) => {
      calls.push(step.id);

      return {
        id: step.id,
        label: step.label,
        status: step.id === 'full_qa' ? 'failed' : 'passed',
        ok: step.id !== 'full_qa',
        optional: false,
        command: 'mock',
        exit_code: step.id === 'full_qa' ? 1 : 0,
        stdout: '{"ok":true}',
        stderr: '',
        json: { ok: true }
      };
    });

    const saved = JSON.parse(await readFile(reportFile, 'utf8'));

    assert.deepEqual(calls, [
      'full_qa',
      'handoff',
      'external_setup',
      'completion_audit',
      'ops_dashboard'
    ]);
    assert.equal(report.ok, false);
    assert.equal(report.summary.failed, 1);
    assert.equal(saved.steps.length, 5);
    assert.equal(saved.steps[0].status, 'failed');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ops refresh can skip full QA and still refresh dashboard stack', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-ops-refresh-skip-'));
  const reportFile = path.join(tmp, 'ops-refresh.json');
  const calls = [];

  try {
    const report = await runOpsRefresh([
      '--site-root',
      path.join(tmp, 'store'),
      '--skip-full-qa',
      '--report',
      reportFile
    ], async (step) => {
      calls.push(step.id);
      return {
        id: step.id,
        label: step.label,
        status: 'passed',
        ok: true,
        optional: false,
        command: 'mock',
        exit_code: 0,
        stdout: '{}',
        stderr: '',
        json: {}
      };
    });

    assert.deepEqual(calls, [
      'handoff',
      'external_setup',
      'completion_audit',
      'ops_dashboard'
    ]);
    assert.equal(report.ok, true);
    assert.equal(report.summary.skipped, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

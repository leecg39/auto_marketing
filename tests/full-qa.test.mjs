import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSteps,
  extractJson,
  parseArgs,
  runFullQa,
  summarize
} from '../scripts/run-full-qa.mjs';

test('extracts the first JSON object from npm-style output', () => {
  const parsed = extractJson([
    '> marketing-automation-kit@1.0.0 verify',
    '> node script.mjs',
    '',
    '{ "ok": true, "nested": { "ready": false } }',
    'trailing log'
  ].join('\n'));

  assert.deepEqual(parsed, {
    ok: true,
    nested: {
      ready: false
    }
  });
});

test('parses full QA arguments and builds expected steps', () => {
  const options = parseArgs([
    '--site-root',
    '/tmp/store',
    '--site-url',
    'http://127.0.0.1:3100',
    '--site-event-probe',
    '--site-production-probe',
    '--skip-live',
    '--report',
    '/tmp/report.json'
  ]);
  const steps = buildSteps(options);

  assert.equal(options.siteRoot, '/tmp/store');
  assert.equal(options.live, false);
  assert.equal(options.siteEventProbe, true);
  assert.equal(options.siteProductionProbe, true);
  assert.equal(options.report, '/tmp/report.json');
  assert.equal(steps.some((step) => step.id === 'kit_check'), true);
  assert.equal(steps.some((step) => step.id === 'local_e2e'), false);
  assert.equal(steps.some((step) => step.id === 'site_production_runtime'), true);
  assert.equal(steps.find((step) => step.id === 'site_production_runtime').args.includes('verify:prod-site'), true);
  assert.equal(steps.find((step) => step.id === 'site_production_runtime').args.includes('--event-probe'), true);
  assert.equal(steps.some((step) => step.id === 'site_runtime'), true);
  assert.equal(steps.find((step) => step.id === 'site_runtime').args.includes('--event-probe'), true);
});

test('summarizes step statuses', () => {
  assert.deepEqual(summarize([
    { status: 'passed' },
    { status: 'passed' },
    { status: 'warning' },
    { status: 'failed' }
  ]), {
    passed: 2,
    warning: 1,
    skipped: 0,
    failed: 1
  });
});

test('full QA treats missing deployment env as warning by default', async () => {
  const calls = [];
  const options = parseArgs([
    '--site-root',
    '/tmp/store',
    '--site-url',
    'http://127.0.0.1:3100',
    '--skip-live'
  ]);
  const report = await runFullQa(options, async (step) => {
    calls.push(step.id);

    if (step.id === 'site_env') {
      return {
        id: step.id,
        label: step.label,
        command: 'mock',
        cwd: step.cwd,
        exit_code: 0,
        signal: null,
        timed_out: false,
        duration_ms: 1,
        stdout: '',
        stderr: '',
        json: {
          ready: false,
          summary: {
            missing: ['NEXT_PUBLIC_GTM_ID']
          }
        },
        ok: true
      };
    }

    if (step.id === 'gtm_import_render') {
      return {
        id: step.id,
        label: step.label,
        command: 'mock',
        cwd: step.cwd,
        exit_code: 1,
        signal: null,
        timed_out: false,
        duration_ms: 1,
        stdout: '',
        stderr: '',
        json: {
          ok: false,
          source_status: {
            missing: ['NEXT_PUBLIC_GTM_ID']
          }
        },
        ok: false
      };
    }

    return {
      id: step.id,
      label: step.label,
      command: 'mock',
      cwd: step.cwd,
      exit_code: 0,
      signal: null,
      timed_out: false,
      duration_ms: 1,
      stdout: '',
      stderr: '',
      json: { ok: true },
      ok: true
    };
  });

  assert.equal(calls.includes('site_env'), true);
  assert.equal(report.local_qa_ok, true);
  assert.equal(report.deployment_ready, false);
  assert.equal(report.summary.warning, 2);
  assert.equal(report.steps.find((step) => step.id === 'gtm_import_render').status, 'warning');
});

test('full QA fails deployment env when strict readiness is required', async () => {
  const options = parseArgs([
    '--site-root',
    '/tmp/store',
    '--skip-live',
    '--require-env-ready'
  ]);
  const report = await runFullQa(options, async (step) => ({
    id: step.id,
    label: step.label,
    command: 'mock',
    cwd: step.cwd,
    exit_code: 0,
    signal: null,
    timed_out: false,
    duration_ms: 1,
    stdout: '',
    stderr: '',
    json: step.id === 'site_env' ? { ready: false } : { ok: true },
    ok: true
  }));

  assert.equal(report.local_qa_ok, false);
  assert.equal(report.deployment_ready, false);
  assert.equal(report.steps.find((step) => step.id === 'site_env').status, 'failed');
});

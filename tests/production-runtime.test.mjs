import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildStartArgs,
  buildVerifySiteArgs,
  parseArgs,
  runProductionRuntime
} from '../scripts/verify-production-runtime.mjs';

test('parses production runtime arguments and builds command args', () => {
  const options = parseArgs([
    '--site-root',
    '/tmp/store',
    '--build',
    '--event-probe',
    '--site-port',
    '3201',
    '--timeout-ms',
    '1000',
    '--report',
    '/tmp/production-runtime.json'
  ]);

  assert.equal(options.siteRoot, '/tmp/store');
  assert.equal(options.build, true);
  assert.equal(options.eventProbe, true);
  assert.equal(options.sitePort, 3201);
  assert.equal(options.siteUrl, 'http://127.0.0.1:3201');
  assert.equal(options.timeoutMs, 1000);
  assert.equal(options.report, '/tmp/production-runtime.json');
  assert.deepEqual(buildStartArgs(options), [
    'run',
    'start',
    '--',
    '--hostname',
    '127.0.0.1',
    '--port',
    '3201'
  ]);
  assert.deepEqual(buildVerifySiteArgs(options), [
    'run',
    'verify:site',
    '--',
    '--site-url',
    'http://127.0.0.1:3201',
    '--event-probe'
  ]);
});

test('runs build, starts production server, and verifies runtime', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-prod-runtime-'));
  const reportFile = path.join(tmp, 'report.json');
  const calls = [];

  try {
    const options = parseArgs([
      '--site-root',
      path.join(tmp, 'store'),
      '--build',
      '--event-probe',
      '--report',
      reportFile
    ]);

    const report = await runProductionRuntime(options, {
      runCommand: async (step) => {
        calls.push(step.id);
        return {
          id: step.id,
          label: step.label,
          command: 'mock',
          cwd: step.cwd,
          exit_code: 0,
          signal: null,
          timed_out: false,
          duration_ms: 1,
          stdout: '{"ok":true}',
          stderr: '',
          json: { ok: true },
          ok: true
        };
      },
      startProductionServer: async () => {
        calls.push('start');
        return {
          child: { mock: true },
          result: {
            id: 'start_production_server',
            label: 'Start applied store production server',
            command: 'mock',
            cwd: options.siteRoot,
            exit_code: null,
            signal: null,
            timed_out: false,
            duration_ms: 1,
            stdout: '',
            stderr: '',
            json: { ok: true },
            ok: true
          }
        };
      },
      stopChild: async () => {
        calls.push('stop');
      }
    });

    const saved = JSON.parse(await readFile(reportFile, 'utf8'));

    assert.deepEqual(calls, [
      'site_build',
      'start',
      'site_production_runtime',
      'stop'
    ]);
    assert.equal(report.ok, true);
    assert.equal(report.summary.passed, 3);
    assert.equal(saved.steps.length, 3);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('does not start production server when build fails', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-prod-runtime-fail-'));
  const reportFile = path.join(tmp, 'report.json');
  const calls = [];

  try {
    const options = parseArgs([
      '--site-root',
      path.join(tmp, 'store'),
      '--build',
      '--report',
      reportFile
    ]);

    const report = await runProductionRuntime(options, {
      runCommand: async (step) => {
        calls.push(step.id);
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
          stderr: 'build failed',
          json: null,
          ok: false
        };
      },
      startProductionServer: async () => {
        calls.push('start');
        throw new Error('should not start');
      }
    });

    assert.deepEqual(calls, ['site_build']);
    assert.equal(report.ok, false);
    assert.equal(report.summary.failed, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

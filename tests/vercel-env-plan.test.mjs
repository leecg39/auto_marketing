import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  generateVercelEnvPlan,
  maskValue,
  parseArgs,
  renderMarkdown
} from '../scripts/generate-vercel-env-plan.mjs';

function fakeFetch(statusJson) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(statusJson)
  });
}

test('parses Vercel env plan arguments and masks server values', () => {
  const parsed = parseArgs([
    '--site-root',
    '/tmp/store',
    '--base-url',
    'https://auto-marketing-sigma.vercel.app/',
    '--output',
    '/tmp/vercel-env.md',
    '--json-output',
    '/tmp/vercel-env.json'
  ]);

  assert.equal(parsed.siteRoot, '/tmp/store');
  assert.equal(parsed.baseUrl, 'https://auto-marketing-sigma.vercel.app');
  assert.equal(parsed.output, '/tmp/vercel-env.md');
  assert.equal(parsed.jsonOutput, '/tmp/vercel-env.json');
  assert.equal(maskValue('https://crm.example.test/webhook'), 'http...hook');
});

test('generates Vercel env plan with ready values, local candidates, and external blockers', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-vercel-env-plan-'));

  try {
    await writeFile(path.join(tmp, '.env.local'), [
      'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-4464425600',
      'DOWNSTREAM_CRM_WEBHOOK_URL=https://crm.example.test/webhook',
      ''
    ].join('\n'));

    const plan = await generateVercelEnvPlan({
      siteRoot: tmp,
      baseUrl: 'https://auto-marketing-sigma.vercel.app',
      envFiles: ['.env.local']
    }, {
      fetch: fakeFetch({
        ok: true,
        ready: false,
        summary: {
          ready: false,
          missing: ['NEXT_PUBLIC_GTM_ID'],
          placeholders: [],
          invalid: []
        },
        checks: []
      })
    });
    const byKey = new Map(plan.items.map((item) => [item.key, item]));
    const markdown = renderMarkdown(plan);

    assert.equal(byKey.get('NEXT_PUBLIC_APP_URL').group, 'ready_to_add');
    assert.equal(byKey.get('NEXT_PUBLIC_APP_URL').value, 'https://auto-marketing-sigma.vercel.app');
    assert.equal(byKey.get('NEXT_PUBLIC_CRM_WEBHOOK_URL').value, '/api/crm/events');
    assert.equal(byKey.get('NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID').group, 'candidate_from_local_env');
    assert.equal(byKey.get('NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID').display_value, 'AW-4464425600');
    assert.equal(byKey.get('DOWNSTREAM_CRM_WEBHOOK_URL').group, 'candidate_from_local_env');
    assert.equal(byKey.get('DOWNSTREAM_CRM_WEBHOOK_URL').value, '');
    assert.equal(byKey.get('DOWNSTREAM_CRM_WEBHOOK_URL').display_value, 'http...hook');
    assert.equal(byKey.get('NEXT_PUBLIC_GTM_ID').group, 'needs_external_value');
    assert.deepEqual(plan.summary.ready_to_add.sort(), [
      'NEXT_PUBLIC_APP_URL',
      'NEXT_PUBLIC_CRM_WEBHOOK_URL',
      'NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY'
    ].sort());
    assert.equal(markdown.includes('https://crm.example.test/webhook'), false);
    assert.match(markdown, /Vercel Production Env 입력 계획/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Vercel env plan CLI writes markdown and JSON outputs', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-vercel-env-plan-cli-'));
  const output = path.join(tmp, 'plan.md');
  const jsonOutput = path.join(tmp, 'plan.json');

  try {
    await writeFile(path.join(tmp, '.env.local'), 'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-123456789\n');

    const plan = await generateVercelEnvPlan({
      siteRoot: tmp,
      baseUrl: 'https://auto-marketing-sigma.vercel.app',
      output,
      jsonOutput,
      envFiles: ['.env.local']
    }, {
      fetch: fakeFetch({
        ok: true,
        ready: false,
        summary: {
          ready: false,
          missing: [],
          placeholders: [],
          invalid: []
        },
        checks: []
      })
    });

    await writeFile(output, `${renderMarkdown(plan)}\n`);
    await writeFile(jsonOutput, `${JSON.stringify(plan, null, 2)}\n`);

    assert.match(await readFile(output, 'utf8'), /바로 입력 가능한 값/);
    assert.equal(JSON.parse(await readFile(jsonOutput, 'utf8')).base_url, 'https://auto-marketing-sigma.vercel.app');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRecommendedCommands,
  commandString,
  detectFramework,
  detectPackageManager,
  inspectDeploymentTarget,
  parseArgs,
  quoteShell,
  renderMarkdown
} from '../scripts/inspect-deployment-target.mjs';

test('parses deployment target arguments and quotes shell commands', () => {
  const parsed = parseArgs([
    '--site-root',
    '/tmp/store root',
    '--output',
    '/tmp/deploy.md',
    '--json-output',
    '/tmp/deploy.json'
  ]);

  assert.equal(parsed.siteRoot, '/tmp/store root');
  assert.equal(parsed.output, '/tmp/deploy.md');
  assert.equal(parsed.jsonOutput, '/tmp/deploy.json');
  assert.equal(quoteShell('/tmp/store root'), "'/tmp/store root'");
  assert.equal(commandString(['vercel', '--cwd', '/tmp/store root', 'deploy', '--prod']), "vercel --cwd '/tmp/store root' deploy --prod");
});

test('detects Next.js framework and package manager', () => {
  assert.deepEqual(detectPackageManager(new Set(['pnpm-lock.yaml'])), 'pnpm');
  assert.equal(detectFramework({
    dependencies: { next: '16.1.6' },
    scripts: { build: 'next build' }
  }, new Set()).name, 'next');
  assert.equal(detectFramework({
    dependencies: {},
    scripts: {}
  }, new Set(['next.config.ts'])).detected, true);
});

test('builds confirmation-gated Vercel commands', () => {
  const commands = buildRecommendedCommands('/tmp/store root', 'npm');
  const link = commands.find((command) => command.id === 'vercel_link');
  const deploy = commands.find((command) => command.id === 'vercel_prod_deploy');
  const appUrl = commands.find((command) => command.id === 'vercel_env_NEXT_PUBLIC_APP_URL');

  assert.equal(link.confirmation_required, true);
  assert.equal(deploy.confirmation_required, true);
  assert.equal(appUrl.command.includes('env add NEXT_PUBLIC_APP_URL production'), true);
  assert.equal(commands.find((command) => command.id === 'local_build').confirmation_required, false);
});

test('reports Vercel login but missing project link as deploy blocker', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-deploy-target-'));

  try {
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({
      scripts: {
        build: 'next build',
        start: 'next start'
      },
      dependencies: {
        next: '16.1.6'
      }
    }));
    await writeFile(path.join(tmp, '.env.local'), [
      'NEXT_PUBLIC_CRM_WEBHOOK_URL=/api/crm/events',
      'NEXT_PUBLIC_APP_URL=http://localhost:3000',
      'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID=AW-123456789',
      ''
    ].join('\n'));

    const report = await inspectDeploymentTarget({ siteRoot: tmp }, {
      runCommand: async (command, args) => {
        if (command === 'vercel' && args[0] === '--version') {
          return {
            ok: true,
            stdout: 'Vercel CLI 50.25.4\n',
            stderr: ''
          };
        }
        if (command === 'vercel' && args[0] === 'whoami') {
          return {
            ok: true,
            stdout: 'leecg39-8923\n',
            stderr: ''
          };
        }
        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command'
        };
      }
    });

    assert.equal(report.ready_for_production_deploy, false);
    assert.equal(report.framework.name, 'next');
    assert.equal(report.hosting.vercel.cli.logged_in, true);
    assert.equal(report.hosting.vercel.project_linked, false);
    assert.equal(report.blockers.some((blocker) => blocker.id === 'hosting_project_not_linked'), true);
    assert.equal(report.blockers.some((blocker) => blocker.id === 'marketing_env_not_ready'), true);
    assert.match(renderMarkdown(report), /배포 대상 사전 점검/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

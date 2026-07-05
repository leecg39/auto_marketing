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
  extractJsonObject,
  inspectDeploymentTarget,
  parseArgs,
  parseVercelProjectUrl,
  quoteShell,
  rankVercelProjects,
  renderMarkdown
} from '../scripts/inspect-deployment-target.mjs';

test('parses deployment target arguments and quotes shell commands', () => {
  const parsed = parseArgs([
    '--site-root',
    '/tmp/store root',
    '--output',
    '/tmp/deploy.md',
    '--json-output',
    '/tmp/deploy.json',
    '--vercel-project-url',
    'https://vercel.com/petasos/auto-marketing'
  ]);

  assert.equal(parsed.siteRoot, '/tmp/store root');
  assert.equal(parsed.output, '/tmp/deploy.md');
  assert.equal(parsed.jsonOutput, '/tmp/deploy.json');
  assert.equal(parsed.vercelProjectUrl, 'https://vercel.com/petasos/auto-marketing');
  assert.deepEqual(parseVercelProjectUrl('https://vercel.com/petasos/auto-marketing'), {
    ok: true,
    url: 'https://vercel.com/petasos/auto-marketing',
    scope: 'petasos',
    project: 'auto-marketing',
    error: ''
  });
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
  const commands = buildRecommendedCommands('/tmp/store root', 'npm', {
    name: 'oliveyoung-shopee',
    id: 'prj_olive123'
  });
  const link = commands.find((command) => command.id === 'vercel_link');
  const deploy = commands.find((command) => command.id === 'vercel_prod_deploy');
  const appUrl = commands.find((command) => command.id === 'vercel_env_NEXT_PUBLIC_APP_URL');

  assert.equal(link.confirmation_required, true);
  assert.equal(link.command.includes('prj_olive123'), true);
  assert.equal(deploy.confirmation_required, true);
  assert.equal(appUrl.command.includes('env add NEXT_PUBLIC_APP_URL production'), true);
  assert.equal(commands.find((command) => command.id === 'local_build').confirmation_required, false);
});

test('extracts Vercel project JSON and ranks matching projects', () => {
  const parsed = extractJsonObject([
    'Fetching projects in test-team',
    '{',
    '  "projects": [',
    '    {"name":"shopping-mall","id":"prj_shop","latestProductionUrl":"https://shopping.example"},',
    '    {"name":"oliveyoung-shopee","id":"prj_olive","latestProductionUrl":"https://olive.example"}',
    '  ],',
    '  "contextName": "test-team"',
    '}'
  ].join('\n'));
  const ranked = rankVercelProjects(parsed.projects, '/tmp/oliveyoung', {
    name: 'oliveyoung-shopee'
  });

  assert.equal(parsed.contextName, 'test-team');
  assert.equal(ranked[0].name, 'oliveyoung-shopee');
  assert.equal(ranked[0].score >= 100, true);
});

test('reports Vercel login but missing project link as deploy blocker', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-deploy-target-'));

  try {
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'oliveyoung-shopee',
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
        if (command === 'vercel' && args.join(' ') === 'projects ls --format=json') {
          return {
            ok: true,
            stdout: [
              'Fetching projects in test-team',
              '{',
              '  "projects": [',
              '    { "name": "oliveyoung-shopee", "id": "prj_olive", "latestProductionUrl": "https://oliveyoung-shopee.vercel.app" },',
              '    { "name": "shopping-mall", "id": "prj_shop", "latestProductionUrl": "https://shopping-mall.vercel.app" }',
              '  ],',
              '  "contextName": "test-team"',
              '}'
            ].join('\n'),
            stderr: ''
          };
        }
        return {
          ok: false,
          stdout: '',
          stderr: 'unexpected command'
        };
      },
      probeUrl: async (url) => ({
        checked: true,
        ok: url.includes('oliveyoung-shopee'),
        status: url.includes('oliveyoung-shopee') ? 200 : 404,
        title: url.includes('oliveyoung-shopee') ? 'Oliveyoung Shopee' : '',
        error: ''
      })
    });

    const markdown = renderMarkdown(report);

    assert.equal(report.ready_for_production_deploy, false);
    assert.equal(report.framework.name, 'next');
    assert.equal(report.hosting.vercel.cli.logged_in, true);
    assert.equal(report.hosting.vercel.project_linked, false);
    assert.equal(report.hosting.vercel.projects.recommended.id, 'prj_olive');
    assert.equal(report.hosting.vercel.projects.recommended.url_probe.status, 200);
    assert.equal(report.commands.find((command) => command.id === 'vercel_link').command.includes('prj_olive'), true);
    assert.equal(report.blockers.some((blocker) => blocker.id === 'hosting_project_not_linked'), true);
    assert.equal(report.blockers.some((blocker) => blocker.id === 'marketing_env_not_ready'), true);
    assert.match(markdown, /배포 대상 사전 점검/);
    assert.match(markdown, /http=200/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('does not auto-recommend a weak Vercel candidate even when URL is reachable', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-deploy-target-weak-'));

  try {
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'oliveyoung-shopee',
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
          return { ok: true, stdout: 'Vercel CLI 50.25.4\n', stderr: '' };
        }
        if (command === 'vercel' && args[0] === 'whoami') {
          return { ok: true, stdout: 'leecg39-8923\n', stderr: '' };
        }
        if (command === 'vercel' && args.join(' ') === 'projects ls --format=json') {
          return {
            ok: true,
            stdout: JSON.stringify({
              projects: [
                {
                  name: 'shopping-mall',
                  id: 'prj_shop',
                  latestProductionUrl: 'https://shopping-mall.vercel.app'
                }
              ],
              contextName: 'test-team'
            }),
            stderr: ''
          };
        }
        return { ok: false, stdout: '', stderr: 'unexpected command' };
      },
      probeUrl: async () => ({
        checked: true,
        ok: true,
        status: 200,
        title: 'Shopping Mall',
        error: ''
      })
    });

    assert.equal(report.ready_for_production_deploy, false);
    assert.equal(report.hosting.vercel.projects.recommended, null);
    assert.equal(report.hosting.vercel.projects.candidates[0].url_probe.status, 200);
    assert.equal(report.commands.find((command) => command.id === 'vercel_link').command.includes('<project-name-or-id>'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('reports a user-provided Vercel project URL when the scope is inaccessible', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-deploy-target-scope-'));

  try {
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'oliveyoung-shopee',
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

    const report = await inspectDeploymentTarget({
      siteRoot: tmp,
      vercelProjectUrl: 'https://vercel.com/petasos/auto-marketing'
    }, {
      runCommand: async (command, args) => {
        if (command === 'vercel' && args[0] === '--version') {
          return { ok: true, stdout: 'Vercel CLI 50.25.4\n', stderr: '' };
        }
        if (command === 'vercel' && args[0] === 'whoami') {
          return { ok: true, stdout: 'leecg39-8923\n', stderr: '' };
        }
        if (command === 'vercel' && args.join(' ') === 'projects ls --format=json') {
          return {
            ok: true,
            stdout: JSON.stringify({
              projects: [],
              contextName: 'annatars-projects'
            }),
            stderr: ''
          };
        }
        if (command === 'vercel' && args.join(' ') === 'projects ls --scope petasos --format=json') {
          return {
            ok: false,
            stdout: '',
            stderr: 'Error: The specified scope does not exist\n'
          };
        }
        return { ok: false, stdout: '', stderr: `unexpected command: ${args.join(' ')}` };
      }
    });
    const markdown = renderMarkdown(report);

    assert.equal(report.ready_for_production_deploy, false);
    assert.equal(report.hosting.vercel.target_project.provided, true);
    assert.equal(report.hosting.vercel.target_project.scope, 'petasos');
    assert.equal(report.hosting.vercel.target_project.project, 'auto-marketing');
    assert.equal(report.hosting.vercel.target_project.accessible, false);
    assert.match(report.hosting.vercel.target_project.error, /scope does not exist/);
    assert.equal(report.blockers.some((blocker) => blocker.id === 'target_vercel_project_inaccessible'), true);
    assert.match(report.next_step, /petasos/);
    assert.match(markdown, /petasos\/auto-marketing/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('uses an accessible user-provided Vercel project as the recommended target', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-deploy-target-explicit-'));

  try {
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'oliveyoung-shopee',
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

    const report = await inspectDeploymentTarget({
      siteRoot: tmp,
      vercelProjectUrl: 'https://vercel.com/petasos/auto-marketing'
    }, {
      runCommand: async (command, args) => {
        if (command === 'vercel' && args[0] === '--version') {
          return { ok: true, stdout: 'Vercel CLI 50.25.4\n', stderr: '' };
        }
        if (command === 'vercel' && args[0] === 'whoami') {
          return { ok: true, stdout: 'leecg39-8923\n', stderr: '' };
        }
        if (command === 'vercel' && args.join(' ') === 'projects ls --format=json') {
          return {
            ok: true,
            stdout: JSON.stringify({
              projects: [],
              contextName: 'annatars-projects'
            }),
            stderr: ''
          };
        }
        if (command === 'vercel' && args.join(' ') === 'projects ls --scope petasos --format=json') {
          return {
            ok: true,
            stdout: JSON.stringify({
              projects: [
                {
                  name: 'auto-marketing',
                  id: 'prj_auto123',
                  latestProductionUrl: 'https://auto-marketing-petasos.vercel.app'
                }
              ],
              contextName: 'petasos'
            }),
            stderr: ''
          };
        }
        return { ok: false, stdout: '', stderr: `unexpected command: ${args.join(' ')}` };
      },
      probeUrl: async () => ({
        checked: true,
        ok: true,
        status: 200,
        title: 'Auto Marketing',
        error: ''
      })
    });

    assert.equal(report.hosting.vercel.target_project.accessible, true);
    assert.equal(report.hosting.vercel.target_project.project_id, 'prj_auto123');
    assert.equal(report.hosting.vercel.projects.recommended.id, 'prj_auto123');
    assert.equal(report.hosting.vercel.projects.recommended.reasons.includes('explicit_target'), true);
    assert.equal(report.commands.find((command) => command.id === 'vercel_link').command.includes('prj_auto123'), true);
    assert.equal(report.blockers.some((blocker) => blocker.id === 'target_vercel_project_inaccessible'), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

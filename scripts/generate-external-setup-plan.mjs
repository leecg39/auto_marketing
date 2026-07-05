import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDeploymentEnv } from './validate-deployment-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MARKDOWN_OUTPUT = path.join(KIT_ROOT, 'dist', 'external-account-setup.md');
const DEFAULT_JSON_OUTPUT = path.join(KIT_ROOT, 'dist', 'external-account-setup.json');

const SETUP_TASKS = [
  {
    id: 'production_domain',
    title: '운영 자사몰 도메인 확정',
    owner: 'Site/Hosting',
    url: '',
    env: [
      { key: 'NEXT_PUBLIC_APP_URL', required: true }
    ],
    steps: [
      '운영에 사용할 canonical HTTPS URL을 확정합니다.',
      '후보 사이트가 해당 URL에서 열리고 결제 완료 페이지까지 접근 가능한지 확인합니다.',
      '확정한 URL을 marketing-production.env의 NEXT_PUBLIC_APP_URL에 넣습니다.'
    ],
    evidence: [
      '브라우저에서 운영 URL 접속 성공',
      'GA4 웹 스트림과 광고 랜딩 페이지에 같은 URL 사용',
      'CRM 서버 CORS_ALLOW_ORIGIN에 같은 origin 사용'
    ],
    confirmation_gate: '도메인/배포 설정 저장은 운영 라우팅에 영향을 줄 수 있으므로 Computer Use로 저장 또는 게시하기 직전에 확인합니다.'
  },
  {
    id: 'gtm_container',
    title: 'GTM 웹 컨테이너 생성',
    owner: 'Google Tag Manager',
    url: 'https://tagmanager.google.com/',
    env: [
      { key: 'NEXT_PUBLIC_GTM_ID', required: true }
    ],
    steps: [
      'GTM 계정에서 웹 컨테이너를 생성합니다.',
      '컨테이너 ID를 GTM-... 형식으로 복사합니다.',
      'marketing-production.env의 NEXT_PUBLIC_GTM_ID에 넣습니다.',
      'dist/gtm-container-import.production.json을 가져온 뒤 Preview에서 확인하고 게시합니다.'
    ],
    evidence: [
      'GTM-... 컨테이너 ID',
      'GTM Preview에서 view_item, add_to_cart, begin_checkout, purchase 이벤트 확인',
      'GTM 게시 버전 기록'
    ],
    confirmation_gate: '컨테이너 최종 생성, Import Container 적용, Publish 클릭은 외부 계정 상태를 바꾸므로 실행 직전 확인합니다.'
  },
  {
    id: 'ga4_stream',
    title: 'GA4 속성 및 웹 스트림 생성',
    owner: 'Google Analytics',
    url: 'https://analytics.google.com/',
    env: [
      { key: 'NEXT_PUBLIC_GA4_MEASUREMENT_ID', required: true },
      { key: 'NEXT_PUBLIC_APP_URL', required: true }
    ],
    steps: [
      'GA4 속성과 웹 데이터 스트림을 생성합니다.',
      '웹 스트림 URL에는 확정한 운영 자사몰 URL을 사용합니다.',
      '측정 ID를 G-... 형식으로 복사합니다.',
      'marketing-production.env의 NEXT_PUBLIC_GA4_MEASUREMENT_ID에 넣습니다.'
    ],
    evidence: [
      'G-... 측정 ID',
      'GA4 DebugView에서 7개 권장 이벤트 수신',
      'purchase 이벤트의 transaction_id와 value 확인'
    ],
    confirmation_gate: 'GA4 속성/스트림 최종 생성은 외부 계정 리소스를 만들기 때문에 실행 직전 확인합니다.'
  },
  {
    id: 'google_ads_purchase',
    title: 'Google Ads 구매 전환 액션 생성',
    owner: 'Google Ads',
    url: 'https://ads.google.com/',
    env: [
      { key: 'NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_ID', required: true },
      { key: 'NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL', required: true },
      { key: 'NEXT_PUBLIC_APP_URL', required: true }
    ],
    steps: [
      '구매 전환 액션을 생성하거나 기존 구매 전환을 선택합니다.',
      'conversion ID(AW-...)와 purchase conversion label을 복사합니다.',
      'conversion ID와 label을 marketing-production.env에 넣습니다.',
      'GTM Preview와 Google Ads 테스트 도구에서 purchase 전환 수신을 확인합니다.'
    ],
    evidence: [
      'AW-... 전환 ID',
      '구매 전환 label',
      '테스트 구매 전환 수신 결과'
    ],
    confirmation_gate: '전환 액션 생성/수정은 광고 계정 설정을 바꾸므로 실행 직전 확인합니다.'
  },
  {
    id: 'meta_pixel',
    title: 'Meta 데이터 세트/픽셀 생성',
    owner: 'Meta Events Manager',
    url: 'https://business.facebook.com/events_manager',
    env: [
      { key: 'NEXT_PUBLIC_META_PIXEL_ID', required: true },
      { key: 'NEXT_PUBLIC_APP_URL', required: true }
    ],
    steps: [
      'Meta Business Settings 또는 Events Manager에서 데이터 세트/픽셀을 생성합니다.',
      '픽셀 ID를 숫자 문자열로 복사합니다.',
      'marketing-production.env의 NEXT_PUBLIC_META_PIXEL_ID에 넣습니다.',
      'Meta 테스트 이벤트 도구에서 AddToCart, InitiateCheckout, Purchase 수신을 확인합니다.'
    ],
    evidence: [
      'Meta Pixel ID',
      '테스트 이벤트 수신 결과',
      '운영 도메인 검증 상태'
    ],
    confirmation_gate: '픽셀/데이터 세트 생성과 도메인 검증 저장은 외부 계정 상태를 바꾸므로 실행 직전 확인합니다.'
  },
  {
    id: 'crm_delivery',
    title: '이메일/카카오/CRM webhook 연결',
    owner: 'CRM/Message Provider',
    url: '',
    env: [
      { key: 'DOWNSTREAM_CRM_WEBHOOK_URL', required: true },
      { key: 'DOWNSTREAM_CRM_API_KEY', required: false, label: 'Email/Kakao/CRM downstream API key' }
    ],
    steps: [
      '실제 이메일/카카오/CRM 발송툴의 수신 webhook을 준비합니다.',
      'webhook URL을 DOWNSTREAM_CRM_WEBHOOK_URL에 넣습니다.',
      '필요하면 API key를 DOWNSTREAM_CRM_API_KEY에 넣습니다.',
      '테스트 계정으로만 장바구니, 결제 이탈, 구매 후, 리드 후속 플로우를 발송 검증합니다.'
    ],
    evidence: [
      'https webhook URL',
      '테스트 계정 발송 성공 로그',
      '수신동의 없는 계정 미발송 결과'
    ],
    confirmation_gate: '실제 고객에게 메시지가 발송될 수 있는 provider 설정 저장 또는 테스트 발송 직전에 확인합니다.'
  }
];

function envStatus(checks, item) {
  const check = checks.get(item.key);
  if (!check) {
    return {
      key: item.key,
      label: item.label || item.key,
      required: item.required,
      status: item.required ? 'not_validated' : 'manual_check',
      ok: !item.required
    };
  }

  return {
    key: item.key,
    label: check.label || item.label || item.key,
    required: item.required,
    status: check.status,
    ok: check.ok
  };
}

function buildSetupPlan(envReport) {
  const checks = new Map((envReport.checks || []).map((check) => [check.key, check]));
  const tasks = SETUP_TASKS.map((task) => {
    const env = task.env.map((item) => envStatus(checks, item));
    const blocking_keys = env
      .filter((item) => item.required && !item.ok)
      .map((item) => item.key);

    return {
      ...task,
      env,
      status: blocking_keys.length ? 'blocked_external' : 'ready',
      blocking_keys
    };
  });

  return {
    env_ready: envReport.ready,
    blocking_keys: Array.from(new Set(tasks.flatMap((task) => task.blocking_keys))),
    tasks
  };
}

function renderEnvList(items) {
  return items
    .map((item) => `- \`${item.key}\`: ${item.required ? '필수' : '선택'} / ${item.status}`)
    .join('\n');
}

function renderNumbered(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function renderBullets(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function renderMarkdown(report) {
  const blocking = report.plan.blocking_keys.length
    ? report.plan.blocking_keys.map((key) => `\`${key}\``).join(', ')
    : '없음';

  const taskSections = report.plan.tasks.map((task, index) => [
    `## ${index + 1}. ${task.title}`,
    '',
    `- 상태: \`${task.status}\``,
    `- 담당 화면: ${task.owner}`,
    task.url ? `- 열기: ${task.url}` : '- 열기: 제공사 관리자 또는 배포 콘솔',
    '',
    '수집/확인할 env:',
    '',
    renderEnvList(task.env),
    '',
    '실행 순서:',
    '',
    renderNumbered(task.steps),
    '',
    '완료 증거:',
    '',
    renderBullets(task.evidence),
    '',
    `Computer Use 확인 게이트: ${task.confirmation_gate}`,
    ''
  ].join('\n'));

  return [
    '# 외부 계정 실행 체크리스트',
    '',
    `생성일: ${report.generated_at}`,
    `대상 사이트: \`${report.site_root}\``,
    `운영 env 준비: \`${report.plan.env_ready}\``,
    `현재 차단값: ${blocking}`,
    '',
    '## 원칙',
    '',
    '- 값 확인, 화면 탐색, 문서 작성은 바로 진행할 수 있습니다.',
    '- 계정 리소스 생성, 전환 액션 생성, 도메인 설정 저장, GTM 게시, 실제 메시지 발송은 실행 직전 사용자 확인 후 진행합니다.',
    '- 이메일, 전화번호, API key 같은 민감값은 GA4/GTM 이벤트에 넣지 않고 env 또는 서버 설정에만 둡니다.',
    '',
    ...taskSections,
    '',
    '## 값을 받은 뒤 실행',
    '',
    '```bash',
    'cp examples/marketing-production.env.example /path/to/marketing-production.env',
    `npm run apply:env -- --site-root ${report.site_root} --env-file /path/to/marketing-production.env --dry-run`,
    `npm run go:live -- --site-root ${report.site_root} --env-file /path/to/marketing-production.env`,
    `npm run audit:completion -- --site-root ${report.site_root} --strict`,
    '```'
  ].join('\n');
}

async function generateExternalSetupPlan(options) {
  const siteRoot = path.resolve(options.siteRoot || process.cwd());
  const env = await validateDeploymentEnv(siteRoot);
  const plan = buildSetupPlan(env);
  const report = {
    generated_at: new Date().toISOString(),
    site_root: siteRoot,
    env,
    plan
  };

  return {
    report,
    markdown: renderMarkdown(report)
  };
}

function parseArgs(args) {
  const parsed = {
    output: DEFAULT_MARKDOWN_OUTPUT,
    jsonOutput: DEFAULT_JSON_OUTPUT
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith('--')) {
      parsed.siteRoot = parsed.siteRoot || arg;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : args[index + 1];

    if (key === 'help') {
      parsed.help = true;
      continue;
    }
    if (equalsIndex < 0) {
      index += 1;
    }

    if (key === 'site-root') {
      parsed.siteRoot = value;
    }
    if (key === 'output') {
      parsed.output = path.resolve(value);
    }
    if (key === 'json-output') {
      parsed.jsonOutput = path.resolve(value);
    }
  }

  if (parsed.siteRoot) {
    parsed.siteRoot = path.resolve(parsed.siteRoot);
  }

  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  npm run handoff:external -- --site-root /path/to/store',
    '',
    'Options:',
    '  --output FILE       Markdown output. Default: dist/external-account-setup.md',
    '  --json-output FILE  JSON output. Default: dist/external-account-setup.json'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.siteRoot) {
    console.log(usage());
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const { report, markdown } = await generateExternalSetupPlan(options);
  await mkdir(path.dirname(options.output), { recursive: true });
  await mkdir(path.dirname(options.jsonOutput), { recursive: true });
  await writeFile(options.output, `${markdown}\n`);
  await writeFile(options.jsonOutput, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    output: options.output,
    json_output: options.jsonOutput,
    env_ready: report.plan.env_ready,
    blocking_keys: report.plan.blocking_keys,
    next_step: report.plan.env_ready
      ? '운영 env 값이 준비되어 있습니다. go:live와 GTM/GA4/광고 테스트 검증으로 넘어가세요.'
      : 'external account setup 문서 순서대로 외부 계정값을 확보한 뒤 marketing-production.env에 채우세요.'
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  SETUP_TASKS,
  buildSetupPlan,
  generateExternalSetupPlan,
  parseArgs,
  renderMarkdown
};

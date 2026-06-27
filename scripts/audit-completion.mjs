import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDeploymentEnv } from './validate-deployment-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FULL_QA_REPORT = path.join(KIT_ROOT, 'dist', 'full-qa-report.json');
const DEFAULT_HANDOFF_REPORT = path.join(KIT_ROOT, 'dist', 'deployment-handoff.json');
const DEFAULT_MARKDOWN_OUTPUT = path.join(KIT_ROOT, 'dist', 'completion-audit.md');
const DEFAULT_JSON_OUTPUT = path.join(KIT_ROOT, 'dist', 'completion-audit.json');

const REQUIRED_EVENTS = [
  'view_item',
  'add_to_cart',
  'begin_checkout',
  'purchase',
  'sign_up',
  'login',
  'generate_lead'
];

const REQUIRED_AUTOMATION_ACTIONS = [
  'cart_abandonment_reminder',
  'cart_retargeting_audience',
  'checkout_abandonment_reminder',
  'checkout_retargeting_audience',
  'review_request',
  'repurchase_due',
  'purchase_exclusion',
  'lead_followup'
];

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function stepById(fullQa, id) {
  return fullQa?.steps?.find((step) => step.id === id) || null;
}

function stepPassed(fullQa, id) {
  const step = stepById(fullQa, id);
  return Boolean(step && step.status === 'passed' && step.ok !== false);
}

function statusFromEvidence(ok, missingEvidence, externalBlocker = false) {
  if (ok) {
    return 'complete';
  }
  if (externalBlocker) {
    return 'blocked_external';
  }
  if (missingEvidence) {
    return 'missing_evidence';
  }
  return 'failed';
}

function requirement(id, title, status, evidence, nextStep) {
  return {
    id,
    title,
    status,
    evidence: evidence.filter(Boolean),
    next_step: nextStep
  };
}

function allSupportedEvents(siteAudit) {
  const supported = siteAudit?.json?.installation_status?.supported_events || {};
  return REQUIRED_EVENTS.every((eventName) => supported[eventName] === true);
}

function hasAllAutomationActions(step) {
  const actions = step?.json?.summary?.automation_action_flows || [];
  return REQUIRED_AUTOMATION_ACTIONS.every((action) => actions.includes(action));
}

function hasExpectedLocalFlows(step) {
  const flows = step?.json?.summary?.crm_events?.map((event) => event.automation_flow) || [];
  return [
    'cart_abandonment_candidate',
    'checkout_abandonment_candidate',
    'post_purchase_review_and_recommendation',
    'lead_followup'
  ].every((flow) => flows.includes(flow));
}

function summarizeRequirements(requirements) {
  const counts = requirements.reduce((accumulator, item) => {
    accumulator[item.status] = (accumulator[item.status] || 0) + 1;
    return accumulator;
  }, {});

  return {
    complete: counts.complete || 0,
    blocked_external: counts.blocked_external || 0,
    missing_evidence: counts.missing_evidence || 0,
    failed: counts.failed || 0,
    total: requirements.length
  };
}

function missingInputs(currentEnv, fullQa, handoff) {
  const source = currentEnv?.summary || stepById(fullQa, 'site_env')?.json?.summary || handoff?.env?.summary || {};
  return {
    missing: source.missing || [],
    placeholders: source.placeholders || [],
    invalid: source.invalid || []
  };
}

function buildRequirements(fullQa, handoff, currentEnv) {
  const gtmVerify = stepById(fullQa, 'gtm_import_verify');
  const browserDemo = stepById(fullQa, 'browser_demo_e2e');
  const localE2e = stepById(fullQa, 'local_e2e');
  const siteAudit = stepById(fullQa, 'site_audit');
  const siteRuntime = stepById(fullQa, 'site_runtime');
  const siteEnv = stepById(fullQa, 'site_env');
  const gtmRender = stepById(fullQa, 'gtm_import_render');
  const revenue = stepById(fullQa, 'revenue_reconciliation');
  const envReady = currentEnv?.ready === true;
  const gtmReady = gtmRender?.status === 'passed' && gtmRender?.json?.ok === true;
  const fullQaExists = Boolean(fullQa);
  const inputSummary = missingInputs(currentEnv, fullQa, handoff);

  return [
    requirement(
      'gtm_blueprint',
      'GTM에서 GA4, Google Ads, Meta 태그를 관리할 import 구조',
      statusFromEvidence(stepPassed(fullQa, 'gtm_import_verify'), !fullQaExists),
      [
        `full QA step gtm_import_verify=${gtmVerify?.status || 'missing'}`,
        gtmVerify?.json?.summary
          ? `checks=${gtmVerify.json.summary.passed}/${gtmVerify.json.summary.checks}, tags=${gtmVerify.json.summary.tags}, triggers=${gtmVerify.json.summary.triggers}, variables=${gtmVerify.json.summary.variables}`
          : null
      ],
      'GTM Admin에서 검증된 import 파일을 가져온 뒤 Preview로 확인합니다.'
    ),
    requirement(
      'site_installation',
      '사이트 공통 레이아웃 SDK 설치, 동의 UI, CRM route 연결',
      statusFromEvidence(
        stepPassed(fullQa, 'site_audit') && stepPassed(fullQa, 'site_runtime'),
        !fullQaExists || !siteAudit || !siteRuntime
      ),
      [
        `site_audit=${siteAudit?.status || 'missing'}`,
        `site_runtime=${siteRuntime?.status || 'missing'}`,
        siteAudit?.json?.installation_status
          ? `sdk=${siteAudit.json.installation_status.sdk_installed}, provider=${siteAudit.json.installation_status.provider_mounted}, crm_route=${siteAudit.json.installation_status.crm_route_installed}`
          : null
      ],
      '실제 사이트 dev/prod 서버에서 SDK, consent UI, CRM route를 계속 확인합니다.'
    ),
    requirement(
      'ga4_event_contract',
      'GA4 권장 이벤트 7개 dataLayer 계약 구현',
      statusFromEvidence(
        stepPassed(fullQa, 'gtm_import_verify') && stepPassed(fullQa, 'site_audit') && allSupportedEvents(siteAudit),
        !fullQaExists || !siteAudit || !gtmVerify
      ),
      [
        `required_events=${REQUIRED_EVENTS.join(', ')}`,
        siteAudit?.json?.installation_status?.supported_events
          ? `site_supported=${JSON.stringify(siteAudit.json.installation_status.supported_events)}`
          : null
      ],
      '운영 GTM Preview와 GA4 DebugView에서 7개 이벤트를 실제 사용자 흐름으로 확인합니다.'
    ),
    requirement(
      'purchase_quality',
      'purchase 주문번호 중복 방지와 GA4 개인정보 제거',
      statusFromEvidence(
        stepPassed(fullQa, 'browser_demo_e2e') &&
          browserDemo?.json?.summary?.duplicate_purchase === 'duplicate_transaction_id' &&
          browserDemo?.json?.summary?.pii_in_data_layer === false,
        !fullQaExists || !browserDemo
      ),
      [
        `browser_demo_e2e=${browserDemo?.status || 'missing'}`,
        `duplicate_purchase=${browserDemo?.json?.summary?.duplicate_purchase || 'missing'}`,
        `pii_in_data_layer=${browserDemo?.json?.summary?.pii_in_data_layer ?? 'missing'}`
      ],
      '운영 결제 성공 페이지에서도 실제 주문번호로 새로고침 중복을 재확인합니다.'
    ),
    requirement(
      'crm_automation_flows',
      '이메일/카카오/광고 리타겟팅 자동화 플로우와 downstream 전달',
      statusFromEvidence(
        stepPassed(fullQa, 'local_e2e') &&
          stepPassed(fullQa, 'browser_demo_e2e') &&
          hasExpectedLocalFlows(localE2e) &&
          hasAllAutomationActions(browserDemo),
        !fullQaExists || !localE2e || !browserDemo
      ),
      [
        `local_e2e=${localE2e?.status || 'missing'}`,
        `browser_demo_e2e=${browserDemo?.status || 'missing'}`,
        browserDemo?.json?.summary?.automation_action_flows
          ? `actions=${browserDemo.json.summary.automation_action_flows.join(', ')}`
          : null,
        localE2e?.json?.summary?.downstream
          ? `downstream_events=${localE2e.json.summary.downstream.event_names.join(', ')}`
          : null
      ],
      '실제 발송툴 webhook URL과 API key를 넣은 뒤 테스트 계정에만 발송합니다.'
    ),
    requirement(
      'revenue_reconciliation',
      '주문 DB와 GA4 매출 대조 절차',
      statusFromEvidence(
        stepPassed(fullQa, 'revenue_reconciliation') && revenue?.json?.ok === true,
        !fullQaExists || !revenue
      ),
      [
        `revenue_reconciliation=${revenue?.status || 'missing'}`,
        revenue?.json?.totals ? `example_diff_percent=${revenue.json.totals.diff_percent}` : null
      ],
      '운영 결제 발생 48시간 뒤 실제 주문 CSV와 GA4 CSV로 다시 대조합니다.'
    ),
    requirement(
      'operating_env',
      '운영 GTM/GA4/광고/CRM 계정값 적용',
      statusFromEvidence(envReady, !fullQaExists && !handoff, !envReady),
      [
        `site_env=${siteEnv?.status || 'missing'}`,
        `env_ready=${envReady}`,
        `missing=${inputSummary.missing.join(', ') || 'none'}`,
        `placeholders=${inputSummary.placeholders.join(', ') || 'none'}`,
        `invalid=${inputSummary.invalid.join(', ') || 'none'}`
      ],
      '누락된 운영 env 값을 실제 값으로 채운 뒤 validate:env와 full:qa --require-env-ready를 실행합니다.'
    ),
    requirement(
      'production_gtm_import',
      '운영값이 치환된 GTM import 파일 생성',
      statusFromEvidence(gtmReady, !fullQaExists && !handoff, !gtmReady),
      [
        `gtm_import_render=${gtmRender?.status || 'missing'}`,
        `render_ok=${gtmRender?.json?.ok ?? false}`,
        `output=${gtmRender?.json?.output || 'missing'}`
      ],
      '운영 env 값이 준비되면 render:gtm으로 production import를 생성하고 verify:gtm --input으로 검증합니다.'
    )
  ];
}

function renderMarkdown(report) {
  const lines = [
    '# 마케팅 자동화 완료 감사',
    '',
    `생성일: ${report.generated_at}`,
    `대상 사이트: \`${report.site_root || 'unknown'}\``,
    `완료 판정: \`${report.completion_ready}\``,
    '',
    '## 요약',
    '',
    `- complete: \`${report.summary.complete}\``,
    `- blocked_external: \`${report.summary.blocked_external}\``,
    `- missing_evidence: \`${report.summary.missing_evidence}\``,
    `- failed: \`${report.summary.failed}\``,
    `- total: \`${report.summary.total}\``,
    '',
    '## 요구사항별 판정',
    ''
  ];

  for (const item of report.requirements) {
    lines.push(`### ${item.title}`);
    lines.push('');
    lines.push(`- id: \`${item.id}\``);
    lines.push(`- status: \`${item.status}\``);
    for (const evidence of item.evidence) {
      lines.push(`- evidence: ${evidence}`);
    }
    lines.push(`- next_step: ${item.next_step}`);
    lines.push('');
  }

  if (report.blocking_inputs.length > 0) {
    lines.push('## 현재 외부 입력 대기값');
    lines.push('');
    for (const key of report.blocking_inputs) {
      lines.push(`- \`${key}\``);
    }
    lines.push('');
  }

  lines.push('## 다음 실행');
  lines.push('');
  lines.push(report.next_step);

  return lines.join('\n');
}

async function auditCompletion(options = {}) {
  const fullQaReport = path.resolve(options.fullQaReport || DEFAULT_FULL_QA_REPORT);
  const handoffReport = path.resolve(options.handoffReport || DEFAULT_HANDOFF_REPORT);
  const fullQa = await readJsonIfExists(fullQaReport);
  const handoff = await readJsonIfExists(handoffReport);
  const siteRoot = path.resolve(options.siteRoot || handoff?.site_root || stepById(fullQa, 'site_audit')?.json?.root || process.cwd());
  const currentEnv = await validateDeploymentEnv(siteRoot);
  const requirements = buildRequirements(fullQa, handoff, currentEnv);
  const summary = summarizeRequirements(requirements);
  const blocking = missingInputs(currentEnv, fullQa, handoff);
  const blockingInputs = [...blocking.missing, ...blocking.placeholders, ...blocking.invalid];
  const completionReady = requirements.every((item) => item.status === 'complete');

  return {
    generated_at: new Date().toISOString(),
    site_root: siteRoot,
    completion_ready: completionReady,
    summary,
    evidence_files: {
      full_qa_report: {
        file: fullQaReport,
        exists: await pathExists(fullQaReport)
      },
      deployment_handoff: {
        file: handoffReport,
        exists: await pathExists(handoffReport)
      },
      current_env: {
        root: currentEnv.root,
        loaded_env_files: currentEnv.loaded_env_files,
        ready: currentEnv.ready
      }
    },
    blocking_inputs: blockingInputs,
    requirements,
    next_step: completionReady
      ? '계획의 자동 검증 가능 항목이 모두 완료되었습니다. 운영 GTM/GA4/광고 도구 화면에서 최종 수신을 유지 모니터링하세요.'
      : blockingInputs.length > 0
        ? '운영 GTM/GA4/광고/CRM 값을 채운 뒤 apply:env, render:gtm, full:qa --require-env-ready, GTM/GA4/광고 도구 검증을 실행하세요.'
        : 'missing_evidence 또는 failed 항목의 산출물을 만든 뒤 감사를 다시 실행하세요.'
  };
}

function parseArgs(args) {
  const parsed = {
    output: DEFAULT_MARKDOWN_OUTPUT,
    jsonOutput: DEFAULT_JSON_OUTPUT,
    fullQaReport: DEFAULT_FULL_QA_REPORT,
    handoffReport: DEFAULT_HANDOFF_REPORT,
    strict: false
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
    if (key === 'strict') {
      parsed.strict = true;
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
    if (key === 'full-qa-report') {
      parsed.fullQaReport = path.resolve(value);
    }
    if (key === 'handoff-report') {
      parsed.handoffReport = path.resolve(value);
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
    '  npm run audit:completion -- --site-root /path/to/store',
    '',
    'Options:',
    '  --output FILE           Markdown output. Default: dist/completion-audit.md',
    '  --json-output FILE      JSON output. Default: dist/completion-audit.json',
    '  --full-qa-report FILE   Full QA report input. Default: dist/full-qa-report.json',
    '  --handoff-report FILE   Deployment handoff JSON input. Default: dist/deployment-handoff.json',
    '  --strict                Exit non-zero unless every requirement is complete.'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const report = await auditCompletion(options);
  const markdown = renderMarkdown(report);
  await mkdir(path.dirname(options.output), { recursive: true });
  await mkdir(path.dirname(options.jsonOutput), { recursive: true });
  await writeFile(options.output, `${markdown}\n`);
  await writeFile(options.jsonOutput, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: report.completion_ready,
    completion_ready: report.completion_ready,
    summary: report.summary,
    blocking_inputs: report.blocking_inputs,
    output: options.output,
    json_output: options.jsonOutput,
    next_step: report.next_step
  }, null, 2));

  if (options.strict && !report.completion_ready) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  REQUIRED_AUTOMATION_ACTIONS,
  REQUIRED_EVENTS,
  auditCompletion,
  buildRequirements,
  parseArgs,
  renderMarkdown
};

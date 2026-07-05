async function loadEnvValidator() {
  return await import('../../scripts/validate-deployment-env.mjs');
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

function runtimeValues(requirements) {
  return Object.fromEntries(requirements.map((requirement) => [
    requirement.key,
    process.env[requirement.key] || ''
  ]));
}

async function handler(request, response) {
  if (request.method !== 'GET') {
    sendJson(response, 405, {
      ok: false,
      errors: ['method_not_allowed']
    });
    return;
  }

  const { REQUIREMENTS, classifyRequirement, summarize } = await loadEnvValidator();
  const values = runtimeValues(REQUIREMENTS);
  const checks = REQUIREMENTS.map((requirement) => ({
    ...classifyRequirement(requirement, values),
    has_value: Boolean(values[requirement.key])
  }));
  const summary = summarize(checks);

  sendJson(response, 200, {
    ok: true,
    ready: summary.ready,
    summary,
    checks,
    next_step: summary.ready
      ? '운영 GTM/GA4/광고/CRM env 값이 준비되어 있습니다.'
      : 'missing/placeholders/invalid 항목을 Vercel production environment variables에 실제 운영 값으로 채우세요.'
  });
}

module.exports = handler;
module.exports._internals = {
  runtimeValues
};

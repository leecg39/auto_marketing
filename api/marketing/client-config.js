function sendJavaScript(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(payload);
}

function pickPublicConfig(env) {
  return {
    gtmId: env.NEXT_PUBLIC_GTM_ID || '',
    ga4MeasurementId: env.NEXT_PUBLIC_GA4_MEASUREMENT_ID || '',
    crmWebhookUrl: env.NEXT_PUBLIC_CRM_WEBHOOK_URL || '',
    appUrl: env.NEXT_PUBLIC_APP_URL || '',
    defaultCurrency: env.NEXT_PUBLIC_MARKETING_DEFAULT_CURRENCY || 'KRW'
  };
}

function handler(request, response) {
  if (request.method !== 'GET') {
    sendJavaScript(response, 405, 'window.__MARKETING_AUTOMATION_CONFIG__ = {};');
    return;
  }

  const config = pickPublicConfig(process.env);
  sendJavaScript(
    response,
    200,
    `window.__MARKETING_AUTOMATION_CONFIG__ = ${JSON.stringify(config)};\n`
  );
}

module.exports = handler;
module.exports._internals = {
  pickPublicConfig
};

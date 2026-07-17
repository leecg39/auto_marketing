const REQUIRED_FIELDS = ['event_name', 'occurred_at'];
const LIFECYCLE_EVENTS = new Set(['dormant_60_days', 'dormant_90_days', 'vip_qualified']);

async function loadAutomationEngine() {
  return await import('../../server/automation-flow-engine.mjs');
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Access-Control-Allow-Origin', process.env.CORS_ALLOW_ORIGIN || '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    if (request.body && typeof request.body === 'object') {
      resolve(JSON.stringify(request.body));
      return;
    }
    if (typeof request.body === 'string') {
      resolve(request.body);
      return;
    }

    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('payload_too_large'));
        request.destroy?.();
      }
    });

    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function pickAllowedFields(payload) {
  return {
    user_id: payload.user_id || '',
    email: payload.email || '',
    phone: payload.phone || '',
    marketing_consent: payload.marketing_consent === true,
    event_name: payload.event_name || '',
    product_id: payload.product_id || payload.item_id || '',
    cart_id: payload.cart_id || '',
    order_id: payload.order_id || payload.transaction_id || '',
    value: Number.isFinite(Number(payload.value)) ? Number(payload.value) : undefined,
    occurred_at: payload.occurred_at || new Date().toISOString(),
    utm_source: payload.utm_source || '',
    utm_medium: payload.utm_medium || '',
    utm_campaign: payload.utm_campaign || '',
    metadata: payload.metadata || {}
  };
}

function validatePayload(payload, flowByEvent) {
  const errors = [];

  REQUIRED_FIELDS.forEach((field) => {
    if (!payload[field]) {
      errors.push(`${field}_required`);
    }
  });

  if (payload.event_name && !flowByEvent[payload.event_name]) {
    errors.push('unsupported_event_name');
  }

  if (LIFECYCLE_EVENTS.has(payload.event_name) && !payload.user_id) {
    errors.push('user_id_required_for_lifecycle_event');
  }

  if ((payload.email || payload.phone) && payload.marketing_consent !== true) {
    errors.push('marketing_consent_required_for_contact_payload');
  }

  return errors;
}

async function forwardToDownstream(payload) {
  const downstreamUrl = process.env.DOWNSTREAM_CRM_WEBHOOK_URL || '';
  const downstreamApiKey = process.env.DOWNSTREAM_CRM_API_KEY || '';
  const downstreamTimeoutMs = Number(process.env.DOWNSTREAM_CRM_TIMEOUT_MS || 5000);

  if (!downstreamUrl) {
    return {
      ok: true,
      status: 202,
      skipped: true,
      reason: 'serverless_demo_no_downstream'
    };
  }

  try {
    const response = await fetch(downstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(downstreamApiKey ? { Authorization: `Bearer ${downstreamApiKey}` } : {})
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(downstreamTimeoutMs)
    });

    return {
      ok: response.ok,
      status: response.status
    };
  } catch (error) {
    console.error(JSON.stringify({
      downstream_delivery_failed: true,
      reason: error.name === 'TimeoutError' ? 'downstream_timeout' : 'downstream_unreachable',
      message: error.message
    }));

    return {
      ok: false,
      status: 0,
      error: error.name === 'TimeoutError' ? 'downstream_timeout' : 'downstream_unreachable'
    };
  }
}

async function handler(request, response) {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      service: 'marketing-automation-crm-events'
    });
    return;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, {
      ok: false,
      errors: ['method_not_allowed']
    });
    return;
  }

  const { FLOW_BY_EVENT, buildAutomationActions } = await loadAutomationEngine();
  let parsed;

  try {
    parsed = JSON.parse(await readBody(request));
  } catch (error) {
    sendJson(response, error.message === 'payload_too_large' ? 413 : 400, {
      ok: false,
      errors: [error.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json']
    });
    return;
  }

  const payload = pickAllowedFields(parsed);
  const errors = validatePayload(payload, FLOW_BY_EVENT);
  if (errors.length > 0) {
    sendJson(response, 422, {
      ok: false,
      errors
    });
    return;
  }

  const flow = FLOW_BY_EVENT[payload.event_name];
  const automationActions = buildAutomationActions(payload);
  const delivery = await forwardToDownstream({
    ...payload,
    automation_flow: flow,
    automation_actions: automationActions
  });

  sendJson(response, 202, {
    ok: true,
    automation_flow: flow,
    automation_actions: automationActions,
    delivery
  });
}

module.exports = handler;
module.exports._internals = {
  pickAllowedFields,
  validatePayload
};

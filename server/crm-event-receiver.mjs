import { createServer } from 'node:http';
import { FLOW_BY_EVENT, buildAutomationActions } from './automation-flow-engine.mjs';

const PORT = Number(process.env.PORT || 8787);
const DOWNSTREAM_CRM_WEBHOOK_URL = process.env.DOWNSTREAM_CRM_WEBHOOK_URL || '';
const DOWNSTREAM_CRM_API_KEY = process.env.DOWNSTREAM_CRM_API_KEY || '';

const REQUIRED_FIELDS = ['event_name', 'occurred_at'];

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('payload_too_large'));
        request.destroy();
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
    marketing_consent: Boolean(payload.marketing_consent),
    event_name: payload.event_name || '',
    product_id: payload.product_id || '',
    cart_id: payload.cart_id || '',
    order_id: payload.order_id || '',
    value: Number.isFinite(Number(payload.value)) ? Number(payload.value) : undefined,
    occurred_at: payload.occurred_at || new Date().toISOString(),
    utm_source: payload.utm_source || '',
    utm_medium: payload.utm_medium || '',
    utm_campaign: payload.utm_campaign || '',
    metadata: payload.metadata || {}
  };
}

function validatePayload(payload) {
  const errors = [];

  REQUIRED_FIELDS.forEach((field) => {
    if (!payload[field]) {
      errors.push(`${field}_required`);
    }
  });

  if (payload.event_name && !FLOW_BY_EVENT[payload.event_name]) {
    errors.push('unsupported_event_name');
  }

  if ((payload.email || payload.phone) && payload.marketing_consent !== true) {
    errors.push('marketing_consent_required_for_contact_payload');
  }

  return errors;
}

async function forwardToDownstream(payload) {
  if (!DOWNSTREAM_CRM_WEBHOOK_URL) {
    return { skipped: true, reason: 'missing_downstream_crm_webhook_url' };
  }

  if (!globalThis.fetch) {
    return { skipped: true, reason: 'fetch_unavailable' };
  }

  const response = await fetch(DOWNSTREAM_CRM_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(DOWNSTREAM_CRM_API_KEY ? { Authorization: `Bearer ${DOWNSTREAM_CRM_API_KEY}` } : {})
    },
    body: JSON.stringify(payload)
  });

  return {
    ok: response.ok,
    status: response.status
  };
}

async function handleCrmEvent(request, response) {
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
  const errors = validatePayload(payload);
  if (errors.length > 0) {
    sendJson(response, 422, { ok: false, errors });
    return;
  }

  const flow = FLOW_BY_EVENT[payload.event_name];
  const automationActions = buildAutomationActions(payload);
  const delivery = await forwardToDownstream({
    ...payload,
    automation_flow: flow,
    automation_actions: automationActions
  });

  if (!DOWNSTREAM_CRM_WEBHOOK_URL) {
    console.log(JSON.stringify({ received: payload, automation_flow: flow, automation_actions: automationActions }));
  }

  sendJson(response, 202, {
    ok: true,
    automation_flow: flow,
    automation_actions: automationActions,
    delivery
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/crm/events') {
    await handleCrmEvent(request, response);
    return;
  }

  sendJson(response, 404, { ok: false, errors: ['not_found'] });
});

server.listen(PORT, () => {
  console.log(`CRM event receiver listening on http://localhost:${PORT}`);
});

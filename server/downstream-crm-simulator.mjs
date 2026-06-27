import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8792);
const receivedEvents = [];

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

function validatePayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('payload_required');
    return errors;
  }

  if (!payload.event_name) {
    errors.push('event_name_required');
  }

  if (!payload.automation_flow) {
    errors.push('automation_flow_required');
  }

  if (!Array.isArray(payload.automation_actions)) {
    errors.push('automation_actions_required');
  }

  return errors;
}

async function handleDownstreamEvent(request, response) {
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

  const errors = validatePayload(parsed);
  if (errors.length > 0) {
    sendJson(response, 422, { ok: false, errors });
    return;
  }

  const stored = {
    received_at: new Date().toISOString(),
    payload: parsed
  };
  receivedEvents.push(stored);

  sendJson(response, 202, {
    ok: true,
    accepted: true,
    received_count: receivedEvents.length,
    automation_flow: parsed.automation_flow,
    action_flows: parsed.automation_actions.map((action) => action.flow).filter(Boolean)
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    sendJson(response, 200, { ok: true, received_count: receivedEvents.length });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/events') {
    sendJson(response, 200, { ok: true, events: receivedEvents });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/reset') {
    receivedEvents.length = 0;
    sendJson(response, 200, { ok: true, received_count: receivedEvents.length });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/crm/downstream') {
    await handleDownstreamEvent(request, response);
    return;
  }

  sendJson(response, 404, { ok: false, errors: ['not_found'] });
});

server.listen(PORT, () => {
  console.log(`Downstream CRM simulator listening on http://localhost:${PORT}`);
});

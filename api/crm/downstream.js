async function loadDeliveryGateway() {
  return await import('../../server/delivery-gateway.mjs');
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Allow', 'GET, POST, OPTIONS');
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

async function handler(request, response) {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  const gateway = await loadDeliveryGateway();
  if (request.method === 'GET') {
    const readiness = gateway.deliveryReadiness(process.env);
    sendJson(response, 200, {
      ok: true,
      service: 'marketing-automation-delivery-gateway',
      ...readiness
    });
    return;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, errors: ['method_not_allowed'] });
    return;
  }

  if (!gateway.gatewayAuthorized(request.headers?.authorization, process.env.DOWNSTREAM_CRM_API_KEY)) {
    sendJson(response, 401, { ok: false, errors: ['unauthorized'] });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch (error) {
    sendJson(response, error.message === 'payload_too_large' ? 413 : 400, {
      ok: false,
      errors: [error.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json']
    });
    return;
  }

  const errors = gateway.validateGatewayPayload(payload);
  if (errors.length > 0) {
    sendJson(response, 422, { ok: false, errors });
    return;
  }

  try {
    const delivery = await gateway.processDelivery(payload, { env: process.env });
    sendJson(response, delivery.ok ? 202 : 502, delivery);
  } catch (error) {
    console.error(JSON.stringify({ delivery_gateway_error: true, message: error.message }));
    sendJson(response, 502, { ok: false, errors: ['delivery_gateway_failed'] });
  }
}

module.exports = handler;
module.exports._internals = { readBody };

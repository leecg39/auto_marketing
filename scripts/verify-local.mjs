const DEMO_URLS = process.env.DEMO_URL
  ? [process.env.DEMO_URL]
  : [
      'http://127.0.0.1:8081/examples/demo-store.html',
      'http://127.0.0.1:8081/marketing-automation-kit/examples/demo-store.html'
    ];
const CRM_URL = process.env.CRM_URL || 'http://127.0.0.1:8791';
const DOWNSTREAM_URL = process.env.DOWNSTREAM_URL || 'http://127.0.0.1:8792';

const EXPECTED_FLOWS = {
  add_to_cart: 'cart_abandonment_candidate',
  begin_checkout: 'checkout_abandonment_candidate',
  purchase: 'post_purchase_review_and_recommendation',
  generate_lead: 'lead_followup',
  dormant_60_days: 'dormant_reactivation',
  dormant_90_days: 'dormant_reactivation',
  vip_qualified: 'vip_benefit'
};

const EXPECTED_ACTIONS = {
  add_to_cart: ['cart_abandonment_reminder', 'cart_retargeting_audience'],
  begin_checkout: ['checkout_abandonment_reminder', 'checkout_retargeting_audience'],
  purchase: ['review_request', 'repurchase_due', 'purchase_exclusion'],
  generate_lead: ['lead_followup'],
  dormant_60_days: ['dormant_reactivation_60', 'dormant_retargeting_audience'],
  dormant_90_days: ['dormant_reactivation_90', 'dormant_retargeting_audience'],
  vip_qualified: ['vip_benefit']
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    body = text;
  }

  return { response, body };
}

async function verifyDemo() {
  const attempts = [];

  for (const url of DEMO_URLS) {
    const response = await fetch(url);
    const body = await response.text();

    attempts.push({ url, status: response.status });

    if (!response.ok) {
      continue;
    }

    assert(body.includes('MarketingAutomation.init'), 'demo page does not initialize MarketingAutomation');
    assert(body.includes('최근 이벤트'), 'demo page does not expose the QA status line');

    return { ok: true, status: response.status, url };
  }

  throw new Error(`demo page not found: ${JSON.stringify(attempts)}`);
}

async function verifyCrmHealth() {
  const { response, body } = await fetchJson(`${CRM_URL}/healthz`);

  assert(response.ok, `CRM health returned ${response.status}`);
  assert(body && body.ok === true, 'CRM health body is not ok');

  return body;
}

async function verifyDownstreamHealth() {
  const { response, body } = await fetchJson(`${DOWNSTREAM_URL}/healthz`);

  assert(response.ok, `Downstream health returned ${response.status}`);
  assert(body && body.ok === true, 'Downstream health body is not ok');

  return body;
}

async function resetDownstream() {
  const { response, body } = await fetchJson(`${DOWNSTREAM_URL}/reset`, { method: 'POST' });

  assert(response.ok, `Downstream reset returned ${response.status}`);
  assert(body && body.ok === true, 'Downstream reset body is not ok');

  return body;
}

async function verifyDownstreamEvents(expectedCount) {
  const { response, body } = await fetchJson(`${DOWNSTREAM_URL}/events`);

  assert(response.ok, `Downstream events returned ${response.status}`);
  assert(body && body.ok === true, 'Downstream events body is not ok');
  assert(Array.isArray(body.events), 'Downstream events payload is not an array');
  assert(body.events.length === expectedCount, `Downstream received ${body.events.length}, expected ${expectedCount}`);

  const events = body.events.map((entry) => entry.payload);
  const eventNames = events.map((event) => event.event_name);

  Object.keys(EXPECTED_FLOWS).forEach((eventName) => {
    assert(eventNames.includes(eventName), `Downstream missing ${eventName}`);
  });

  events.forEach((event) => {
    assert(event.automation_flow === EXPECTED_FLOWS[event.event_name], `${event.event_name} downstream flow mismatch`);
    assert(Array.isArray(event.automation_actions), `${event.event_name} downstream actions missing`);
    const actionFlows = event.automation_actions.map((action) => action.flow);
    assert(
      EXPECTED_ACTIONS[event.event_name].every((flow) => actionFlows.includes(flow)),
      `${event.event_name} downstream action flows mismatch`
    );
  });

  return {
    received_count: body.events.length,
    event_names: eventNames
  };
}

async function verifyCrmEvent(eventName, index) {
  const payload = {
    event_name: eventName,
    occurred_at: new Date().toISOString(),
    marketing_consent: true,
    email: `qa-${eventName}@example.test`,
    user_id: `USER-${index}`,
    phone: eventName === 'generate_lead' ? '01012345678' : undefined,
    product_id: eventName === 'add_to_cart' ? 'SKU_001' : undefined,
    cart_id: eventName === 'begin_checkout' ? `CART-${index}` : undefined,
    order_id: eventName === 'purchase' ? `ORDER-${Date.now()}-${index}` : undefined,
    value: eventName === 'generate_lead' ? 10000 : 129000
  };

  const { response, body } = await fetchJson(`${CRM_URL}/crm/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert(response.status === 202, `${eventName} returned ${response.status}`);
  assert(body && body.ok === true, `${eventName} body is not ok`);
  assert(body.automation_flow === EXPECTED_FLOWS[eventName], `${eventName} flow mismatch`);
  assert(body.delivery && body.delivery.ok === true, `${eventName} downstream delivery was not ok`);
  assert(body.delivery.status === 202, `${eventName} downstream delivery status mismatch`);

  const actionFlows = Array.isArray(body.automation_actions)
    ? body.automation_actions.map((action) => action.flow)
    : [];

  assert(
    EXPECTED_ACTIONS[eventName].every((flow) => actionFlows.includes(flow)),
    `${eventName} automation_actions mismatch`
  );

  return {
    event_name: eventName,
    automation_flow: body.automation_flow,
    automation_actions: actionFlows
  };
}

const summary = {
  demo: await verifyDemo(),
  crm_health: await verifyCrmHealth(),
  downstream_health: await verifyDownstreamHealth(),
  crm_events: []
};

await resetDownstream();

let index = 0;
for (const eventName of Object.keys(EXPECTED_FLOWS)) {
  index += 1;
  summary.crm_events.push(await verifyCrmEvent(eventName, index));
}

summary.downstream = await verifyDownstreamEvents(Object.keys(EXPECTED_FLOWS).length);

console.log(JSON.stringify({ ok: true, summary }, null, 2));

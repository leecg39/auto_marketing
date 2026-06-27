import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null
  };
}

async function waitForHealth(url) {
  for (let index = 0; index < 30; index += 1) {
    try {
      const { response, body } = await fetchJson(`${url}/healthz`);
      if (response.ok && body.ok) {
        return;
      }
    } catch {
      // Retry while the child process starts.
    }

    await wait(100);
  }

  throw new Error('downstream simulator did not become healthy');
}

test('downstream simulator accepts and stores automation payloads', async () => {
  const port = 18992;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/downstream-crm-simulator.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe']
  });

  try {
    await waitForHealth(baseUrl);

    const invalid = await fetchJson(`${baseUrl}/crm/downstream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_name: 'purchase' })
    });
    assert.equal(invalid.response.status, 422);
    assert.equal(invalid.body.errors.includes('automation_flow_required'), true);

    const accepted = await fetchJson(`${baseUrl}/crm/downstream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_name: 'purchase',
        automation_flow: 'post_purchase_review_and_recommendation',
        automation_actions: [
          { flow: 'review_request' },
          { flow: 'repurchase_due' }
        ]
      })
    });
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.body.accepted, true);
    assert.deepEqual(accepted.body.action_flows, ['review_request', 'repurchase_due']);

    const events = await fetchJson(`${baseUrl}/events`);
    assert.equal(events.response.status, 200);
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].payload.event_name, 'purchase');
  } finally {
    child.kill('SIGTERM');
  }
});

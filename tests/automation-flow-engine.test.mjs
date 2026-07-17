import assert from 'node:assert/strict';
import test from 'node:test';

import { automationFlowForEvent, buildAutomationActions } from '../server/automation-flow-engine.mjs';

const occurredAt = '2026-06-27T00:00:00.000Z';

test('maps raw CRM events to the primary automation flow', () => {
  assert.equal(automationFlowForEvent('sign_up'), 'welcome_coupon');
  assert.equal(automationFlowForEvent('add_to_cart'), 'cart_abandonment_candidate');
  assert.equal(automationFlowForEvent('begin_checkout'), 'checkout_abandonment_candidate');
  assert.equal(automationFlowForEvent('purchase'), 'post_purchase_review_and_recommendation');
  assert.equal(automationFlowForEvent('generate_lead'), 'lead_followup');
  assert.equal(automationFlowForEvent('dormant_60_days'), 'dormant_reactivation');
  assert.equal(automationFlowForEvent('dormant_90_days'), 'dormant_reactivation');
  assert.equal(automationFlowForEvent('vip_qualified'), 'vip_benefit');
});

test('schedules cart abandonment message and ads audience with purchase cancellation', () => {
  const actions = buildAutomationActions({
    event_name: 'add_to_cart',
    email: 'buyer@example.test',
    marketing_consent: true,
    product_id: 'SKU_001',
    cart_id: 'CART_001',
    occurred_at: occurredAt
  });

  assert.deepEqual(actions.map((action) => action.flow), [
    'cart_abandonment_reminder',
    'cart_retargeting_audience'
  ]);
  assert.equal(actions[0].status, 'ready');
  assert.equal(actions[0].scheduled_at, '2026-06-27T01:00:00.000Z');
  assert.equal(actions[0].cancel_on_event, 'purchase');
  assert.equal(actions[1].exclude_on_event, 'purchase');
});

test('schedules checkout abandonment after 30 minutes', () => {
  const actions = buildAutomationActions({
    event_name: 'begin_checkout',
    phone: '01012345678',
    marketing_consent: true,
    cart_id: 'CART_002',
    occurred_at: occurredAt
  });

  assert.equal(actions[0].flow, 'checkout_abandonment_reminder');
  assert.equal(actions[0].scheduled_at, '2026-06-27T00:30:00.000Z');
  assert.equal(actions[0].status, 'ready');
});

test('suppresses message actions when contact or consent is missing', () => {
  const noConsent = buildAutomationActions({
    event_name: 'generate_lead',
    email: 'lead@example.test',
    marketing_consent: false,
    occurred_at: occurredAt
  });
  const noContact = buildAutomationActions({
    event_name: 'generate_lead',
    marketing_consent: true,
    occurred_at: occurredAt
  });

  assert.equal(noConsent[0].status, 'suppressed');
  assert.equal(noConsent[0].suppress_reason, 'marketing_consent_required');
  assert.equal(noContact[0].status, 'suppressed');
  assert.equal(noContact[0].suppress_reason, 'contact_required');
});

test('schedules first purchase, review, repurchase, and purchase exclusion actions', () => {
  const actions = buildAutomationActions({
    event_name: 'purchase',
    email: 'buyer@example.test',
    marketing_consent: true,
    order_id: 'ORDER_001',
    metadata: { order_count: 1 },
    occurred_at: occurredAt
  });

  assert.deepEqual(actions.map((action) => action.flow), [
    'first_purchase_thank_you',
    'review_request',
    'repurchase_due',
    'purchase_exclusion'
  ]);
  assert.equal(actions[0].scheduled_at, occurredAt);
  assert.equal(actions[1].scheduled_at, '2026-07-04T00:00:00.000Z');
  assert.equal(actions[2].scheduled_at, '2026-07-27T00:00:00.000Z');
  assert.equal(actions[3].action_type, 'audience');
});

test('creates distinct 60-day and 90-day dormant reactivation milestones', () => {
  const sixtyDayActions = buildAutomationActions({
    event_name: 'dormant_60_days',
    user_id: 'USER_001',
    email: 'buyer@example.test',
    marketing_consent: true,
    occurred_at: occurredAt
  });
  const ninetyDayActions = buildAutomationActions({
    event_name: 'dormant_90_days',
    user_id: 'USER_001',
    phone: '01012345678',
    marketing_consent: true,
    occurred_at: occurredAt
  });

  assert.deepEqual(sixtyDayActions.map((action) => action.flow), [
    'dormant_reactivation_60',
    'dormant_retargeting_audience'
  ]);
  assert.equal(sixtyDayActions[0].lifecycle_milestone, 'dormant_60_days');
  assert.equal(sixtyDayActions[1].exclude_on_event, 'purchase');
  assert.equal(ninetyDayActions[0].flow, 'dormant_reactivation_90');
  assert.equal(ninetyDayActions[0].lifecycle_milestone, 'dormant_90_days');
});

test('creates a consent-gated VIP benefit action', () => {
  const ready = buildAutomationActions({
    event_name: 'vip_qualified',
    user_id: 'USER_002',
    email: 'vip@example.test',
    marketing_consent: true,
    occurred_at: occurredAt
  });
  const suppressed = buildAutomationActions({
    event_name: 'vip_qualified',
    user_id: 'USER_003',
    marketing_consent: false,
    occurred_at: occurredAt
  });

  assert.equal(ready[0].flow, 'vip_benefit');
  assert.equal(ready[0].status, 'ready');
  assert.equal(suppressed[0].status, 'suppressed');
  assert.equal(suppressed[0].suppress_reason, 'marketing_consent_required');
});

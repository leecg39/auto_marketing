const FLOW_BY_EVENT = {
  sign_up: 'welcome_coupon',
  add_to_cart: 'cart_abandonment_candidate',
  begin_checkout: 'checkout_abandonment_candidate',
  purchase: 'post_purchase_review_and_recommendation',
  generate_lead: 'lead_followup',
  login: 'customer_activity_refresh'
};

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
}

function addDays(iso, days) {
  return addMinutes(iso, days * 24 * 60);
}

function occurredAt(payload) {
  const parsed = new Date(payload.occurred_at || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function orderCount(payload) {
  const count = Number(payload.metadata?.order_count ?? payload.order_count);
  return Number.isFinite(count) ? count : undefined;
}

function hasContact(payload) {
  return Boolean(payload.email || payload.phone);
}

function baseAction(payload, overrides) {
  return {
    event_name: payload.event_name,
    user_id: payload.user_id || '',
    email_available: Boolean(payload.email),
    phone_available: Boolean(payload.phone),
    marketing_consent: payload.marketing_consent === true,
    ...overrides
  };
}

function messageAction(payload, overrides) {
  const action = baseAction(payload, {
    action_type: 'message',
    status: payload.marketing_consent === true && hasContact(payload) ? 'ready' : 'suppressed',
    suppress_reason:
      payload.marketing_consent !== true
        ? 'marketing_consent_required'
        : hasContact(payload)
          ? undefined
          : 'contact_required',
    ...overrides
  });

  return Object.fromEntries(Object.entries(action).filter(([, value]) => value !== undefined));
}

function audienceAction(payload, overrides) {
  return baseAction(payload, {
    action_type: 'audience',
    status: 'ready',
    ...overrides
  });
}

function buildAutomationActions(payload) {
  const at = occurredAt(payload);
  const count = orderCount(payload);

  switch (payload.event_name) {
    case 'sign_up':
      return [
        messageAction(payload, {
          flow: 'welcome_coupon',
          segment: 'new_subscriber',
          channels: ['email', 'kakao'],
          scheduled_at: at
        })
      ];

    case 'add_to_cart':
      return [
        messageAction(payload, {
          flow: 'cart_abandonment_reminder',
          segment: 'cart_abandoners',
          channels: ['email', 'kakao'],
          scheduled_at: addMinutes(at, 60),
          cancel_on_event: 'purchase',
          cart_id: payload.cart_id || '',
          product_id: payload.product_id || ''
        }),
        audienceAction(payload, {
          flow: 'cart_retargeting_audience',
          segment: 'cart_abandoners',
          channels: ['ads'],
          scheduled_at: at,
          exclude_on_event: 'purchase'
        })
      ];

    case 'begin_checkout':
      return [
        messageAction(payload, {
          flow: 'checkout_abandonment_reminder',
          segment: 'checkout_abandoners',
          channels: ['email', 'kakao'],
          scheduled_at: addMinutes(at, 30),
          cancel_on_event: 'purchase',
          cart_id: payload.cart_id || ''
        }),
        audienceAction(payload, {
          flow: 'checkout_retargeting_audience',
          segment: 'checkout_abandoners',
          channels: ['ads'],
          scheduled_at: at,
          exclude_on_event: 'purchase'
        })
      ];

    case 'purchase': {
      const actions = [
        messageAction(payload, {
          flow: 'review_request',
          segment: 'review_request',
          channels: ['email', 'kakao'],
          scheduled_at: addDays(at, 7),
          order_id: payload.order_id || ''
        }),
        messageAction(payload, {
          flow: 'repurchase_due',
          segment: 'repurchase_due',
          channels: ['email', 'kakao'],
          scheduled_at: addDays(at, 30),
          order_id: payload.order_id || ''
        }),
        audienceAction(payload, {
          flow: 'purchase_exclusion',
          segment: 'recent_purchasers',
          channels: ['ads'],
          scheduled_at: at,
          order_id: payload.order_id || ''
        })
      ];

      if (count === 1) {
        actions.unshift(messageAction(payload, {
          flow: 'first_purchase_thank_you',
          segment: 'first_purchase',
          channels: ['email', 'kakao'],
          scheduled_at: at,
          order_id: payload.order_id || ''
        }));
      }

      return actions;
    }

    case 'generate_lead':
      return [
        messageAction(payload, {
          flow: 'lead_followup',
          segment: 'lead_submitted',
          channels: ['email', 'kakao'],
          scheduled_at: at
        })
      ];

    case 'login':
      return [
        audienceAction(payload, {
          flow: 'customer_activity_refresh',
          segment: 'active_customers',
          channels: ['ads'],
          scheduled_at: at
        })
      ];

    default:
      return [];
  }
}

function automationFlowForEvent(eventName) {
  return FLOW_BY_EVENT[eventName] || '';
}

export { FLOW_BY_EVENT, automationFlowForEvent, buildAutomationActions };

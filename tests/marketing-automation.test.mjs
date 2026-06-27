import assert from 'node:assert/strict';
import test from 'node:test';
import MarketingAutomation from '../src/marketing-automation.js';

function createLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

function resetBrowser({ search = '' } = {}) {
  globalThis.localStorage = createLocalStorage();
  globalThis.dataLayer = [];
  globalThis.location = {
    search,
    href: `https://example.test/products?${search.replace(/^\?/, '')}`
  };
  globalThis.document = {
    referrer: 'https://google.test/',
    createElement() {
      return {};
    },
    getElementsByTagName() {
      return [];
    },
    head: {
      appendChild() {}
    }
  };
  delete globalThis.fetch;
  MarketingAutomation._resetForTest();
}

test('captures UTM attribution and initializes denied consent by default', () => {
  resetBrowser({ search: '?utm_source=google&utm_medium=cpc&utm_campaign=spring' });

  const result = MarketingAutomation.init();

  assert.equal(result.consent.analytics, false);
  assert.equal(result.attribution.last_touch.utm_source, 'google');
  assert.equal(globalThis.dataLayer.length >= 1, true);
});

test('pushes GA4 ecommerce events without contact PII', () => {
  resetBrowser();
  MarketingAutomation.init({ consent: { analytics: true, ads: false, marketing: false, crm: false } });

  const event = MarketingAutomation.trackAddToCart({
    item_id: 'SKU_001',
    item_name: 'Product name',
    item_category: 'Category',
    price: 129000,
    quantity: 1,
    email: 'buyer@example.test',
    phone: '01012345678'
  });

  assert.equal(event.event, 'add_to_cart');
  assert.equal(event.ecommerce.items[0].item_id, 'SKU_001');
  assert.equal(event.ecommerce.items[0].email, undefined);
  assert.equal(event.ecommerce.items[0].phone, undefined);
});

test('pushes the planned GA4 event names for funnel actions', () => {
  resetBrowser();
  MarketingAutomation.init({ consent: { analytics: true, ads: true, marketing: true, crm: false } });

  MarketingAutomation.trackViewItem({
    item_id: 'SKU_001',
    item_name: 'Product name',
    price: 129000
  });
  MarketingAutomation.trackBeginCheckout({
    cart_id: 'CART-001',
    value: 129000,
    items: [{ item_id: 'SKU_001', item_name: 'Product name', price: 129000, quantity: 1 }]
  });
  MarketingAutomation.trackSignUp({ method: 'email', email: 'buyer@example.test' });
  MarketingAutomation.trackLogin({ method: 'email', email: 'buyer@example.test' });
  MarketingAutomation.trackGenerateLead({ value: 10000, email: 'buyer@example.test', phone: '01012345678' });

  const events = globalThis.dataLayer
    .filter((entry) => entry && entry.event)
    .map((entry) => entry.event);

  assert.deepEqual(events, ['view_item', 'begin_checkout', 'sign_up', 'login', 'generate_lead']);
  assert.equal(globalThis.dataLayer.at(-1).email, undefined);
  assert.equal(globalThis.dataLayer.at(-1).phone, undefined);
});

test('prevents duplicate purchase events by transaction id', () => {
  resetBrowser();
  MarketingAutomation.init();

  const first = MarketingAutomation.trackPurchase({
    transaction_id: 'ORDER-1001',
    value: 129000,
    items: [{ item_id: 'SKU_001', item_name: 'Product name', price: 129000, quantity: 1 }]
  });
  const second = MarketingAutomation.trackPurchase({
    transaction_id: 'ORDER-1001',
    value: 129000,
    items: [{ item_id: 'SKU_001', item_name: 'Product name', price: 129000, quantity: 1 }]
  });

  assert.equal(first.event, 'purchase');
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'duplicate_transaction_id');
});

test('skips CRM delivery when CRM consent is denied', async () => {
  resetBrowser();
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, status: 202, text: async () => '{}' };
  };

  MarketingAutomation.init({
    crmWebhookUrl: '/crm/events',
    consent: { analytics: true, ads: true, marketing: true, crm: false }
  });

  const result = await MarketingAutomation.sendCrmEvent('generate_lead', {
    email: 'lead@example.test',
    marketing_consent: true,
    value: 10000
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'crm_consent_denied');
  assert.equal(fetchCalled, false);
});

test('sends CRM payload only when CRM consent and webhook are configured', async () => {
  resetBrowser({ search: '?utm_source=newsletter&utm_campaign=launch' });
  let requestBody;

  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ ok: true, automation_flow: 'post_purchase_review_and_recommendation' })
    };
  };

  MarketingAutomation.init({
    crmWebhookUrl: '/crm/events',
    consent: { analytics: true, ads: true, marketing: true, crm: true }
  });

  const result = await MarketingAutomation.sendCrmEvent('purchase', {
    email: 'buyer@example.test',
    marketing_consent: true,
    order_id: 'ORDER-1002',
    value: 99000
  });

  assert.equal(result.ok, true);
  assert.equal(result.automation_flow, 'post_purchase_review_and_recommendation');
  assert.equal(requestBody.email, 'buyer@example.test');
  assert.equal(requestBody.event_name, 'purchase');
  assert.equal(requestBody.utm_source, 'newsletter');
});

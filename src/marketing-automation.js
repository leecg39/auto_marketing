(function (globalScope) {
  'use strict';

  var root = globalScope || {};
  var memoryStore = {};
  var state = {
    initialized: false,
    options: {
      defaultCurrency: 'KRW',
      gtmId: '',
      crmWebhookUrl: '',
      autoSendCrm: true,
      userId: ''
    }
  };

  var STORAGE_KEYS = {
    consent: 'ma_consent_v1',
    firstTouch: 'ma_first_touch_v1',
    lastTouch: 'ma_last_touch_v1',
    purchases: 'ma_purchase_ids_v1'
  };

  var ATTRIBUTION_PARAMS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'gclid',
    'fbclid',
    'ttclid',
    'msclkid'
  ];

  var PII_KEYS = {
    email: true,
    phone: true,
    phone_number: true,
    mobile: true,
    name: true,
    first_name: true,
    last_name: true,
    address: true,
    postal_code: true,
    zip: true
  };

  var DEFAULT_CONSENT = {
    analytics: false,
    ads: false,
    marketing: false,
    crm: false
  };

  function assign(target) {
    var output = target || {};
    for (var i = 1; i < arguments.length; i += 1) {
      var source = arguments[i] || {};
      Object.keys(source).forEach(function (key) {
        output[key] = source[key];
      });
    }
    return output;
  }

  function cleanObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    var result = {};
    Object.keys(value).forEach(function (key) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
        result[key] = value[key];
      }
    });
    return result;
  }

  function stripPii(value) {
    if (Array.isArray(value)) {
      return value.map(stripPii);
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    var result = {};
    Object.keys(value).forEach(function (key) {
      if (!PII_KEYS[String(key).toLowerCase()]) {
        result[key] = stripPii(value[key]);
      }
    });
    return result;
  }

  function numberOrUndefined(value) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function requiredString(value, label) {
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error('MarketingAutomation: ' + label + ' is required');
    }

    return String(value);
  }

  function getStorage() {
    try {
      if (root.localStorage) {
        return root.localStorage;
      }
    } catch (error) {
      return null;
    }

    return {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
      },
      setItem: function (key, value) {
        memoryStore[key] = String(value);
      },
      removeItem: function (key) {
        delete memoryStore[key];
      }
    };
  }

  function readJson(key, fallback) {
    var storage = getStorage();
    if (!storage) {
      return fallback;
    }

    try {
      var raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    var storage = getStorage();
    if (!storage) {
      return;
    }

    storage.setItem(key, JSON.stringify(value));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function getDataLayer() {
    root.dataLayer = root.dataLayer || [];
    return root.dataLayer;
  }

  function ensureGtag() {
    if (!root.gtag) {
      root.gtag = function () {
        getDataLayer().push(arguments);
      };
    }
  }

  function normalizeConsent(consent) {
    return assign({}, DEFAULT_CONSENT, consent || {});
  }

  function consentToGoogle(consent) {
    return {
      analytics_storage: consent.analytics ? 'granted' : 'denied',
      ad_storage: consent.ads ? 'granted' : 'denied',
      ad_user_data: consent.ads ? 'granted' : 'denied',
      ad_personalization: consent.marketing ? 'granted' : 'denied'
    };
  }

  function applyGoogleConsent(consent, mode) {
    ensureGtag();
    root.gtag('consent', mode || 'update', consentToGoogle(consent));
  }

  function getConsent() {
    return normalizeConsent(readJson(STORAGE_KEYS.consent, DEFAULT_CONSENT));
  }

  function setConsent(consent) {
    var normalized = normalizeConsent(consent);
    writeJson(STORAGE_KEYS.consent, normalized);
    applyGoogleConsent(normalized, 'update');
    return normalized;
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }

  function parseQuery(search) {
    var query = {};
    var source = String(search || '').replace(/^\?/, '');
    if (!source) {
      return query;
    }

    source.split('&').forEach(function (part) {
      var pair = part.split('=');
      var key = safeDecode(pair[0] || '');
      var value = safeDecode((pair[1] || '').replace(/\+/g, ' '));
      if (key) {
        query[key] = value;
      }
    });

    return query;
  }

  function captureAttribution() {
    var location = root.location || {};
    var params = parseQuery(location.search || '');
    var touch = {
      captured_at: nowIso(),
      landing_page: location.href || '',
      referrer: root.document ? root.document.referrer || '' : ''
    };
    var hasCampaign = false;

    ATTRIBUTION_PARAMS.forEach(function (key) {
      if (params[key]) {
        touch[key] = params[key];
        hasCampaign = true;
      }
    });

    if (!hasCampaign) {
      return getAttribution();
    }

    if (!readJson(STORAGE_KEYS.firstTouch, null)) {
      writeJson(STORAGE_KEYS.firstTouch, touch);
    }

    writeJson(STORAGE_KEYS.lastTouch, touch);
    return getAttribution();
  }

  function getAttribution() {
    return {
      first_touch: readJson(STORAGE_KEYS.firstTouch, null),
      last_touch: readJson(STORAGE_KEYS.lastTouch, null)
    };
  }

  function normalizeItem(item) {
    var source = item || {};
    return cleanObject({
      item_id: requiredString(source.item_id || source.id || source.sku || source.product_id, 'item_id'),
      item_name: requiredString(source.item_name || source.name || source.title, 'item_name'),
      item_category: source.item_category || source.category,
      item_brand: source.item_brand || source.brand,
      item_variant: source.item_variant || source.variant,
      price: numberOrUndefined(source.price),
      quantity: numberOrUndefined(source.quantity) || 1,
      coupon: source.coupon
    });
  }

  function inferItems(payload) {
    if (payload.items && Array.isArray(payload.items)) {
      return payload.items.map(normalizeItem);
    }

    if (payload.product) {
      return [normalizeItem(payload.product)];
    }

    if (payload.item) {
      return [normalizeItem(payload.item)];
    }

    return [normalizeItem(payload)];
  }

  function calculateValue(items) {
    return items.reduce(function (sum, item) {
      var price = numberOrUndefined(item.price) || 0;
      var quantity = numberOrUndefined(item.quantity) || 1;
      return sum + price * quantity;
    }, 0);
  }

  function normalizeEcommerce(payload) {
    var source = payload || {};
    var items = inferItems(source);
    var value = numberOrUndefined(source.value);

    return cleanObject({
      transaction_id: source.transaction_id || source.order_id,
      currency: source.currency || state.options.defaultCurrency,
      value: value !== undefined ? value : calculateValue(items),
      tax: numberOrUndefined(source.tax),
      shipping: numberOrUndefined(source.shipping),
      coupon: source.coupon,
      items: items
    });
  }

  function pushDataLayer(payload) {
    getDataLayer().push(payload);
    return payload;
  }

  function pushEcommerceEvent(eventName, payload) {
    var ecommerce = stripPii(normalizeEcommerce(payload || {}));
    pushDataLayer({ ecommerce: null });
    return pushDataLayer({
      event: eventName,
      ecommerce: ecommerce
    });
  }

  function purchaseIds() {
    return readJson(STORAGE_KEYS.purchases, []);
  }

  function hasPurchaseFired(transactionId) {
    return purchaseIds().indexOf(String(transactionId)) !== -1;
  }

  function markPurchaseFired(transactionId) {
    var ids = purchaseIds();
    ids.push(String(transactionId));
    writeJson(STORAGE_KEYS.purchases, ids.slice(-100));
  }

  function crmBasePayload(eventName, payload) {
    var source = payload || {};
    var attribution = getAttribution();
    var lastTouch = attribution.last_touch || {};
    var firstTouch = attribution.first_touch || {};

    return cleanObject({
      user_id: source.user_id || state.options.userId,
      email: source.email,
      phone: source.phone || source.phone_number,
      marketing_consent: Boolean(source.marketing_consent),
      event_name: eventName,
      product_id: source.product_id || source.item_id || source.sku,
      cart_id: source.cart_id,
      order_id: source.order_id || source.transaction_id,
      value: numberOrUndefined(source.value),
      occurred_at: source.occurred_at || nowIso(),
      utm_source: lastTouch.utm_source || firstTouch.utm_source,
      utm_medium: lastTouch.utm_medium || firstTouch.utm_medium,
      utm_campaign: lastTouch.utm_campaign || firstTouch.utm_campaign,
      metadata: source.metadata
    });
  }

  function sendCrmEvent(eventName, payload) {
    var consent = getConsent();
    var webhookUrl = state.options.crmWebhookUrl;
    var body = crmBasePayload(eventName, payload || {});

    if (!webhookUrl) {
      return Promise.resolve({ skipped: true, reason: 'missing_crm_webhook_url', body: body });
    }

    if (!consent.crm) {
      return Promise.resolve({ skipped: true, reason: 'crm_consent_denied', body: body });
    }

    if (!root.fetch) {
      return Promise.resolve({ skipped: true, reason: 'fetch_unavailable', body: body });
    }

    return root.fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.text().then(function (text) {
        var responseBody = null;

        try {
          responseBody = text ? JSON.parse(text) : null;
        } catch (error) {
          responseBody = text || null;
        }

        return assign({
          ok: response.ok,
          status: response.status,
          body: body
        }, responseBody && typeof responseBody === 'object' ? responseBody : { response_body: responseBody });
      });
    });
  }

  function maybeSendCrm(eventName, payload) {
    if (state.options.autoSendCrm) {
      sendCrmEvent(eventName, payload).catch(function () {});
    }
  }

  function trackViewItem(product) {
    return pushEcommerceEvent('view_item', product);
  }

  function trackAddToCart(product) {
    var event = pushEcommerceEvent('add_to_cart', product);
    maybeSendCrm('add_to_cart', product);
    return event;
  }

  function trackBeginCheckout(checkout) {
    var event = pushEcommerceEvent('begin_checkout', checkout);
    maybeSendCrm('begin_checkout', checkout);
    return event;
  }

  function trackPurchase(order) {
    var source = order || {};
    var transactionId = requiredString(source.transaction_id || source.order_id, 'transaction_id');

    if (hasPurchaseFired(transactionId)) {
      return {
        skipped: true,
        reason: 'duplicate_transaction_id',
        transaction_id: transactionId
      };
    }

    var event = pushEcommerceEvent('purchase', assign({}, source, { transaction_id: transactionId }));
    markPurchaseFired(transactionId);
    maybeSendCrm('purchase', assign({}, source, { transaction_id: transactionId }));
    return event;
  }

  function trackSignUp(payload) {
    var source = payload || {};
    var event = pushDataLayer(stripPii(cleanObject({
      event: 'sign_up',
      method: source.method
    })));
    maybeSendCrm('sign_up', source);
    return event;
  }

  function trackLogin(payload) {
    var source = payload || {};
    var event = pushDataLayer(stripPii(cleanObject({
      event: 'login',
      method: source.method
    })));
    maybeSendCrm('login', source);
    return event;
  }

  function trackGenerateLead(payload) {
    var source = payload || {};
    var event = pushDataLayer(stripPii(cleanObject({
      event: 'generate_lead',
      currency: source.currency || state.options.defaultCurrency,
      value: numberOrUndefined(source.value)
    })));
    maybeSendCrm('generate_lead', source);
    return event;
  }

  function loadGtm(gtmId) {
    var id = gtmId || state.options.gtmId;
    var doc = root.document;
    if (!id || !doc || !doc.createElement) {
      return false;
    }

    if (doc.getElementById && doc.getElementById('ma-gtm-' + id)) {
      return true;
    }

    var dataLayer = getDataLayer();
    dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });

    var script = doc.createElement('script');
    script.async = true;
    script.id = 'ma-gtm-' + id;
    script.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id);

    var firstScript = doc.getElementsByTagName ? doc.getElementsByTagName('script')[0] : null;
    if (firstScript && firstScript.parentNode) {
      firstScript.parentNode.insertBefore(script, firstScript);
    } else if (doc.head && doc.head.appendChild) {
      doc.head.appendChild(script);
    }

    return true;
  }

  function init(options) {
    state.options = assign({}, state.options, options || {});
    getDataLayer();
    ensureGtag();

    var storedConsent = readJson(STORAGE_KEYS.consent, null);
    var consent = normalizeConsent((options && options.consent) || storedConsent || DEFAULT_CONSENT);
    writeJson(STORAGE_KEYS.consent, consent);
    applyGoogleConsent(consent, 'default');
    captureAttribution();

    if (state.options.gtmId) {
      loadGtm(state.options.gtmId);
    }

    state.initialized = true;
    return {
      initialized: true,
      consent: consent,
      attribution: getAttribution()
    };
  }

  function resetForTest() {
    memoryStore = {};
    state = {
      initialized: false,
      options: {
        defaultCurrency: 'KRW',
        gtmId: '',
        crmWebhookUrl: '',
        autoSendCrm: true,
        userId: ''
      }
    };
    root.dataLayer = [];
    delete root.gtag;
  }

  var api = {
    init: init,
    loadGtm: loadGtm,
    setConsent: setConsent,
    getConsent: getConsent,
    captureAttribution: captureAttribution,
    getAttribution: getAttribution,
    sendCrmEvent: sendCrmEvent,
    trackViewItem: trackViewItem,
    trackAddToCart: trackAddToCart,
    trackBeginCheckout: trackBeginCheckout,
    trackPurchase: trackPurchase,
    trackSignUp: trackSignUp,
    trackLogin: trackLogin,
    trackGenerateLead: trackGenerateLead,
    _resetForTest: resetForTest
  };

  root.MarketingAutomation = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

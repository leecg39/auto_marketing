(function (globalScope) {
  'use strict';

  var root = globalScope || {};
  var config = root.__MARKETING_AUTOMATION_CONFIG__ || {};

  if (root.__MARKETING_AUTOMATION_RUNTIME__) {
    return;
  }

  if (!root.MarketingAutomation || !config.gtmId) {
    return;
  }

  root.__MARKETING_AUTOMATION_RUNTIME__ = root.MarketingAutomation.init({
    gtmId: config.gtmId,
    crmWebhookUrl: config.crmWebhookUrl || '',
    defaultCurrency: config.defaultCurrency || 'KRW',
    autoSendCrm: false
  });
}(typeof window !== 'undefined' ? window : this));

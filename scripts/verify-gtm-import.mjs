import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_IMPORT = path.join(ROOT, 'dist', 'gtm-container-import.json');
const DEFAULT_BLUEPRINT = path.join(ROOT, 'config', 'gtm-workspace-blueprint.json');
const REQUIRED_EVENTS = ['view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'sign_up', 'login', 'generate_lead'];
const PII_PATTERNS = [
  /\bemail\b/i,
  /\bphone\b/i,
  /\bname\b/i,
  /\baddress\b/i,
  /e-?mail/i,
  /전화/,
  /주소/,
  /이름/
];

function paramValue(parameters, key) {
  const parameter = parameters?.find((entry) => entry.key === key);
  return parameter?.value;
}

function mapParamValues(parameter) {
  const values = {};
  for (const entry of parameter?.map || []) {
    values[entry.key] = entry.value;
  }
  return values;
}

function listParameter(parameters, key) {
  return parameters?.find((entry) => entry.key === key)?.list || [];
}

function consentTypes(tag) {
  return tag.consentSettings?.consentType?.list?.map((entry) => entry.value) || [];
}

function arrayIncludesAll(actual, expected) {
  return expected.every((entry) => actual.includes(entry));
}

function findTriggerByEvent(version, eventName) {
  return version.trigger.find((trigger) => {
    const filter = trigger.customEventFilter?.[0];
    const configuredEvent = filter?.parameter?.find((parameter) => parameter.key === 'arg1')?.value;
    return configuredEvent === eventName;
  });
}

function eventParameters(tag) {
  return listParameter(tag.parameter, 'eventParameters')
    .map((entry) => mapParamValues(entry))
    .filter((entry) => entry.name);
}

function check(ok, id, message, details = {}) {
  return {
    id,
    ok,
    message,
    details
  };
}

function collectDataLayerFieldReferences(version) {
  const references = [];

  for (const variable of version.variable || []) {
    if (variable.type === 'v') {
      references.push(variable.name);
      references.push(paramValue(variable.parameter, 'name'));
    }
  }

  for (const tag of version.tag || []) {
    for (const parameter of eventParameters(tag)) {
      references.push(parameter.name);
      references.push(parameter.value);
    }

    if (tag.name === 'Google Ads - Purchase Conversion') {
      references.push(paramValue(tag.parameter, 'orderId'));
      references.push(paramValue(tag.parameter, 'conversionValue'));
      references.push(paramValue(tag.parameter, 'currencyCode'));
    }
  }

  return references.filter(Boolean);
}

function validateGtmImport(containerImport, blueprint) {
  const version = containerImport.containerVersion || {};
  const tags = version.tag || [];
  const triggers = version.trigger || [];
  const variables = version.variable || [];
  const checks = [];
  const triggerByEvent = new Map();

  checks.push(check(containerImport.exportFormatVersion === 2, 'export_format', 'GTM export format version is 2'));
  checks.push(check(version.container?.usageContext?.includes('WEB'), 'web_container', 'Container usage context includes WEB'));

  for (const eventName of REQUIRED_EVENTS) {
    const trigger = findTriggerByEvent(version, eventName);
    if (trigger) {
      triggerByEvent.set(eventName, trigger);
    }
    checks.push(check(Boolean(trigger), `trigger_${eventName}`, `Custom Event trigger exists for ${eventName}`));
  }

  for (const variable of blueprint.data_layer_variables) {
    const found = variables.find((candidate) => candidate.name === variable.name);
    const configuredPath = paramValue(found?.parameter, 'name');
    checks.push(check(Boolean(found) && configuredPath === variable.path, `variable_${variable.name}`, `Data Layer Variable exists for ${variable.path}`, {
      expected_path: variable.path,
      actual_path: configuredPath || null
    }));
  }

  for (const variableName of ['GA4 Measurement ID', 'Google Ads Conversion ID', 'Google Ads Purchase Label', 'Meta Pixel ID']) {
    checks.push(check(variables.some((variable) => variable.name === variableName), `constant_${variableName}`, `Constant variable exists: ${variableName}`));
  }

  const adsConversionIdVariable = variables.find((variable) => variable.name === 'Google Ads Conversion ID');
  const adsConversionId = paramValue(adsConversionIdVariable?.parameter, 'value');
  checks.push(check(
    /^(?:\d+|X+)$/.test(adsConversionId || ''),
    'google_ads_conversion_id_format',
    'Google Ads Conversion ID is numeric without an AW- prefix',
    {
      actual: adsConversionId || null
    }
  ));

  const ga4Config = tags.find((tag) => tag.name === 'GA4 - Config');
  checks.push(check(Boolean(ga4Config), 'ga4_config_tag', 'GA4 config tag exists'));
  checks.push(check(arrayIncludesAll(consentTypes(ga4Config || {}), ['analytics_storage']), 'ga4_config_consent', 'GA4 config requires analytics_storage'));

  for (const tagConfig of blueprint.tags.filter((tag) => tag.type === 'GA4 Event')) {
    const tag = tags.find((candidate) => candidate.name === tagConfig.name);
    const trigger = triggerByEvent.get(tagConfig.event_name);
    const measurementIdOverride = paramValue(tag?.parameter, 'measurementIdOverride');
    const configuredEventName = paramValue(tag?.parameter, 'eventName');
    const configuredParameters = eventParameters(tag || {}).map((entry) => entry.name);

    checks.push(check(Boolean(tag), `ga4_tag_${tagConfig.event_name}`, `GA4 event tag exists for ${tagConfig.event_name}`));
    checks.push(check(
      measurementIdOverride === '{{GA4 Measurement ID}}',
      `ga4_measurement_id_${tagConfig.event_name}`,
      `GA4 event tag uses the GA4 Measurement ID override for ${tagConfig.event_name}`,
      {
        actual: measurementIdOverride || null
      }
    ));
    checks.push(check(configuredEventName === tagConfig.event_name, `ga4_event_name_${tagConfig.event_name}`, `GA4 event tag sends ${tagConfig.event_name}`, {
      actual: configuredEventName || null
    }));
    checks.push(check(
      Boolean(trigger) && tag?.firingTriggerId?.includes(trigger.triggerId),
      `ga4_trigger_${tagConfig.event_name}`,
      `GA4 event tag uses ${tagConfig.trigger}`,
      {
        trigger_id: trigger?.triggerId || null,
        firing_trigger_ids: tag?.firingTriggerId || []
      }
    ));
    checks.push(check(
      arrayIncludesAll(configuredParameters, tagConfig.parameters),
      `ga4_parameters_${tagConfig.event_name}`,
      `GA4 event tag includes required parameters for ${tagConfig.event_name}`,
      {
        expected: tagConfig.parameters,
        actual: configuredParameters
      }
    ));
    checks.push(check(
      arrayIncludesAll(consentTypes(tag || {}), tagConfig.consent_required),
      `ga4_consent_${tagConfig.event_name}`,
      `GA4 event tag consent is configured for ${tagConfig.event_name}`,
      {
        expected: tagConfig.consent_required,
        actual: consentTypes(tag || {})
      }
    ));
  }

  const ads = tags.find((tag) => tag.name === 'Google Ads - Purchase Conversion');
  const purchaseTrigger = triggerByEvent.get('purchase');
  checks.push(check(Boolean(ads), 'google_ads_purchase_tag', 'Google Ads purchase conversion tag exists'));
  checks.push(check(
    Boolean(ads) && ads.firingTriggerId?.length === 1 && ads.firingTriggerId.includes(purchaseTrigger?.triggerId),
    'google_ads_purchase_trigger',
    'Google Ads purchase conversion fires only on purchase',
    {
      firing_trigger_ids: ads?.firingTriggerId || []
    }
  ));
  checks.push(check(
    arrayIncludesAll(consentTypes(ads || {}), ['ad_storage', 'ad_user_data', 'ad_personalization']),
    'google_ads_consent',
    'Google Ads tag requires ad consent types'
  ));
  checks.push(check(
    paramValue(ads?.parameter, 'orderId') === '{{DLV - ecommerce.transaction_id}}',
    'google_ads_order_id',
    'Google Ads orderId maps to ecommerce.transaction_id'
  ));

  const metaExpectations = [
    { name: 'Meta Pixel - AddToCart', event: 'add_to_cart', fbqEvent: 'AddToCart' },
    { name: 'Meta Pixel - InitiateCheckout', event: 'begin_checkout', fbqEvent: 'InitiateCheckout' },
    { name: 'Meta Pixel - Purchase', event: 'purchase', fbqEvent: 'Purchase' }
  ];
  for (const expectation of metaExpectations) {
    const tag = tags.find((candidate) => candidate.name === expectation.name);
    const trigger = triggerByEvent.get(expectation.event);
    const html = paramValue(tag?.parameter, 'html') || '';

    checks.push(check(Boolean(tag), `meta_tag_${expectation.fbqEvent}`, `${expectation.name} exists`));
    checks.push(check(
      Boolean(tag) && tag.firingTriggerId?.length === 1 && tag.firingTriggerId.includes(trigger?.triggerId),
      `meta_trigger_${expectation.fbqEvent}`,
      `${expectation.name} fires on ${expectation.event}`,
      {
        firing_trigger_ids: tag?.firingTriggerId || []
      }
    ));
    checks.push(check(
      html.includes("{{Meta Pixel ID}}") && html.includes(`fbq('track', '${expectation.fbqEvent}'`),
      `meta_html_${expectation.fbqEvent}`,
      `${expectation.name} initializes pixel and tracks ${expectation.fbqEvent}`
    ));
    checks.push(check(
      arrayIncludesAll(consentTypes(tag || {}), ['ad_storage', 'ad_personalization']),
      `meta_consent_${expectation.fbqEvent}`,
      `${expectation.name} requires ad consent`
    ));
  }

  const serialized = collectDataLayerFieldReferences(version).join('\n');
  const piiMatches = PII_PATTERNS
    .filter((pattern) => pattern.test(serialized))
    .map((pattern) => pattern.toString());
  checks.push(check(piiMatches.length === 0, 'no_contact_pii', 'GTM import does not contain contact PII variables or parameters', {
    matches: piiMatches
  }));

  return {
    ok: checks.every((entry) => entry.ok),
    summary: {
      checks: checks.length,
      passed: checks.filter((entry) => entry.ok).length,
      failed: checks.filter((entry) => !entry.ok).length,
      tags: tags.length,
      triggers: triggers.length,
      variables: variables.length
    },
    checks
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function parseArgs(args) {
  const parsed = {
    input: DEFAULT_IMPORT,
    blueprint: DEFAULT_BLUEPRINT
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      parsed.input = arg;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : args[index + 1];

    if (key === 'help') {
      parsed.help = true;
      continue;
    }

    if (equalsIndex < 0) {
      index += 1;
    }

    if (key === 'input') {
      parsed.input = value;
    }
    if (key === 'blueprint') {
      parsed.blueprint = value;
    }
  }

  parsed.input = path.resolve(parsed.input);
  parsed.blueprint = path.resolve(parsed.blueprint);
  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  npm run verify:gtm -- --input dist/gtm-container-import.json',
    '',
    'Options:',
    '  --input FILE      GTM import JSON. Default: dist/gtm-container-import.json',
    '  --blueprint FILE  Expected GTM blueprint. Default: config/gtm-workspace-blueprint.json'
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(usage());
    return;
  }

  const [containerImport, blueprint] = await Promise.all([
    readJson(args.input),
    readJson(args.blueprint)
  ]);
  const report = validateGtmImport(containerImport, blueprint);

  console.log(JSON.stringify({
    ...report,
    input: args.input,
    blueprint: args.blueprint,
    next_step: report.ok
      ? 'GTM import 구조가 계획과 일치합니다. GTM Admin에서 가져온 뒤 운영 ID placeholder를 교체하세요.'
      : '실패한 GTM import check를 수정한 뒤 generate:gtm과 verify:gtm을 다시 실행하세요.'
  }, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  REQUIRED_EVENTS,
  validateGtmImport
};

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BLUEPRINT = path.join(ROOT, 'config', 'gtm-workspace-blueprint.json');
const DEFAULT_OUTPUT = path.join(ROOT, 'dist', 'gtm-container-import.json');

const BUILT_IN_INITIALIZATION_TRIGGER_ID = '2147479553';
const DEFAULT_ACCOUNT_ID = '0';
const DEFAULT_CONTAINER_ID = '0';

function template(key, value) {
  return { type: 'TEMPLATE', key, value: String(value) };
}

function valueTemplate(value) {
  return { type: 'TEMPLATE', value: String(value) };
}

function booleanParam(key, value) {
  return { type: 'BOOLEAN', key, value: value ? 'true' : 'false' };
}

function integerParam(key, value) {
  return { type: 'INTEGER', key, value: String(value) };
}

function listParam(key, list) {
  return { type: 'LIST', key, list };
}

function mapParam(key, map) {
  return { type: 'MAP', key, map };
}

function consentSettings(consentTypes) {
  return {
    consentStatus: 'NEEDED',
    consentType: {
      type: 'LIST',
      list: consentTypes.map((type) => valueTemplate(type))
    }
  };
}

function customEventFilter(eventName) {
  return [
    {
      type: 'EQUALS',
      parameter: [
        template('arg0', '{{_event}}'),
        template('arg1', eventName)
      ]
    }
  ];
}

function dataLayerVariable(id, name, pathName) {
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    containerId: DEFAULT_CONTAINER_ID,
    variableId: String(id),
    name,
    type: 'v',
    parameter: [
      integerParam('dataLayerVersion', 2),
      booleanParam('setDefaultValue', false),
      template('name', pathName)
    ]
  };
}

function constantVariable(id, name, value) {
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    containerId: DEFAULT_CONTAINER_ID,
    variableId: String(id),
    name,
    type: 'c',
    parameter: [template('value', value)]
  };
}

function customEventTrigger(id, name, eventName) {
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    containerId: DEFAULT_CONTAINER_ID,
    triggerId: String(id),
    name,
    type: 'CUSTOM_EVENT',
    customEventFilter: customEventFilter(eventName)
  };
}

function eventParameter(name, value) {
  return mapParam('', [
    template('name', name),
    template('value', value)
  ]);
}

function ga4EventTag(id, name, eventName, triggerId, parameterNames, consentTypes) {
  const eventParameters = parameterNames.map((parameterName) => {
    const ecommerceValue = parameterName === 'transaction_id'
      ? '{{DLV - ecommerce.transaction_id}}'
      : parameterName === 'items'
        ? '{{DLV - ecommerce.items}}'
        : parameterName === 'currency'
          ? '{{DLV - ecommerce.currency}}'
          : parameterName === 'value'
            ? '{{DLV - ecommerce.value}}'
            : parameterName === 'tax'
              ? '{{DLV - ecommerce.tax}}'
              : parameterName === 'shipping'
                ? '{{DLV - ecommerce.shipping}}'
                : parameterName === 'coupon'
                  ? '{{DLV - ecommerce.coupon}}'
                  : `{{DLV - ${parameterName}}}`;

    return eventParameter(parameterName, ecommerceValue);
  });

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    containerId: DEFAULT_CONTAINER_ID,
    tagId: String(id),
    name,
    type: 'gaawe',
    parameter: [
      template('measurementId', '{{GA4 Measurement ID}}'),
      template('eventName', eventName),
      listParam('eventParameters', eventParameters)
    ],
    firingTriggerId: [String(triggerId)],
    consentSettings: consentSettings(consentTypes)
  };
}

function googleTag(id) {
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    containerId: DEFAULT_CONTAINER_ID,
    tagId: String(id),
    name: 'GA4 - Config',
    type: 'googtag',
    parameter: [template('tagId', '{{GA4 Measurement ID}}')],
    firingTriggerId: [BUILT_IN_INITIALIZATION_TRIGGER_ID],
    consentSettings: consentSettings(['analytics_storage'])
  };
}

function googleAdsPurchaseTag(id, triggerId) {
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    containerId: DEFAULT_CONTAINER_ID,
    tagId: String(id),
    name: 'Google Ads - Purchase Conversion',
    type: 'awct',
    parameter: [
      template('conversionId', '{{Google Ads Conversion ID}}'),
      template('conversionLabel', '{{Google Ads Purchase Label}}'),
      template('conversionValue', '{{DLV - ecommerce.value}}'),
      template('currencyCode', '{{DLV - ecommerce.currency}}'),
      template('orderId', '{{DLV - ecommerce.transaction_id}}')
    ],
    firingTriggerId: [String(triggerId)],
    consentSettings: consentSettings(['ad_storage', 'ad_user_data', 'ad_personalization'])
  };
}

function metaPixelTag(id, name, triggerId, eventName) {
  const html = [
    '<script>',
    '(function () {',
    "  if (typeof fbq !== 'function') {",
    '    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?',
    '    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;',
    '    n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;',
    '    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}',
    "    (window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');",
    "    fbq('init', '{{Meta Pixel ID}}');",
    '  }',
    `  fbq('track', '${eventName}', {`,
    "    currency: '{{DLV - ecommerce.currency}}',",
    "    value: '{{DLV - ecommerce.value}}'",
    '  });',
    '}());',
    '</script>'
  ].join('\n');

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    containerId: DEFAULT_CONTAINER_ID,
    tagId: String(id),
    name,
    type: 'html',
    parameter: [template('html', html)],
    firingTriggerId: [String(triggerId)],
    consentSettings: consentSettings(['ad_storage', 'ad_personalization'])
  };
}

function buildContainerImport(blueprint, { publicId = 'GTM-XXXXXXX', name } = {}) {
  const variable = [];
  const trigger = [];
  const tag = [];

  let variableId = 1;
  variable.push(constantVariable(variableId++, 'GA4 Measurement ID', blueprint.required_ids.ga4_measurement_id));
  variable.push(constantVariable(variableId++, 'Google Ads Conversion ID', blueprint.required_ids.google_ads_conversion_id));
  variable.push(constantVariable(variableId++, 'Google Ads Purchase Label', blueprint.required_ids.google_ads_purchase_label));
  variable.push(constantVariable(variableId++, 'Meta Pixel ID', blueprint.required_ids.meta_pixel_id));

  for (const variableConfig of blueprint.data_layer_variables) {
    variable.push(dataLayerVariable(variableId++, variableConfig.name, variableConfig.path));
  }

  let triggerId = 100;
  const triggerByEvent = new Map();
  for (const eventTrigger of blueprint.custom_event_triggers) {
    const id = triggerId++;
    triggerByEvent.set(eventTrigger.event_name, id);
    trigger.push(customEventTrigger(id, eventTrigger.name, eventTrigger.event_name));
  }

  let tagId = 200;
  tag.push(googleTag(tagId++));

  for (const blueprintTag of blueprint.tags) {
    if (blueprintTag.type !== 'GA4 Event') {
      continue;
    }

    tag.push(ga4EventTag(
      tagId++,
      blueprintTag.name,
      blueprintTag.event_name,
      triggerByEvent.get(blueprintTag.event_name),
      blueprintTag.parameters,
      blueprintTag.consent_required
    ));
  }

  tag.push(googleAdsPurchaseTag(tagId++, triggerByEvent.get('purchase')));
  tag.push(metaPixelTag(tagId++, 'Meta Pixel - AddToCart', triggerByEvent.get('add_to_cart'), 'AddToCart'));
  tag.push(metaPixelTag(tagId++, 'Meta Pixel - InitiateCheckout', triggerByEvent.get('begin_checkout'), 'InitiateCheckout'));
  tag.push(metaPixelTag(tagId++, 'Meta Pixel - Purchase', triggerByEvent.get('purchase'), 'Purchase'));

  return {
    exportFormatVersion: 2,
    exportTime: new Date().toISOString(),
    containerVersion: {
      path: `accounts/${DEFAULT_ACCOUNT_ID}/containers/${DEFAULT_CONTAINER_ID}/versions/0`,
      accountId: DEFAULT_ACCOUNT_ID,
      containerId: DEFAULT_CONTAINER_ID,
      containerVersionId: '0',
      name: name || blueprint.workspace_name,
      container: {
        path: `accounts/${DEFAULT_ACCOUNT_ID}/containers/${DEFAULT_CONTAINER_ID}`,
        accountId: DEFAULT_ACCOUNT_ID,
        containerId: DEFAULT_CONTAINER_ID,
        name: name || blueprint.workspace_name,
        publicId,
        usageContext: ['WEB'],
        fingerprint: '0',
        tagManagerUrl: ''
      },
      tag,
      trigger,
      variable,
      builtInVariable: [
        {
          accountId: DEFAULT_ACCOUNT_ID,
          containerId: DEFAULT_CONTAINER_ID,
          type: 'PAGE_URL',
          name: 'Page URL'
        },
        {
          accountId: DEFAULT_ACCOUNT_ID,
          containerId: DEFAULT_CONTAINER_ID,
          type: 'EVENT',
          name: 'Event'
        }
      ],
      fingerprint: '0',
      tagManagerUrl: ''
    }
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const publicIdIndex = args.indexOf('--public-id');
  const inputIndex = args.indexOf('--input');
  const output = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : DEFAULT_OUTPUT;
  const input = inputIndex >= 0 ? path.resolve(args[inputIndex + 1]) : DEFAULT_BLUEPRINT;
  const publicId = publicIdIndex >= 0 ? args[publicIdIndex + 1] : 'GTM-XXXXXXX';

  const blueprint = await readJson(input);
  const containerImport = buildContainerImport(blueprint, { publicId });

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(containerImport, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    output,
    tags: containerImport.containerVersion.tag.length,
    triggers: containerImport.containerVersion.trigger.length,
    variables: containerImport.containerVersion.variable.length,
    next_step: 'GTM Admin > Import Container에서 이 JSON을 가져온 뒤 placeholder 변수 값을 운영 ID로 교체하세요.'
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { buildContainerImport };

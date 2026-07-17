import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const RESEND_API_URL = 'https://api.resend.com/emails';
const SOLAPI_API_URL = 'https://api.solapi.com/messages/v4';
const JOB_TTL_SECONDS = 60 * 60 * 24 * 35;
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24 * 35;

const MESSAGE_TEMPLATES = {
  welcome_coupon: {
    subject: '가입을 환영합니다',
    heading: '가입을 환영합니다',
    body: '첫 구매에 사용할 수 있는 웰컴 혜택을 확인해 보세요.',
    cta: '웰컴 혜택 보기'
  },
  cart_abandonment_reminder: {
    subject: '장바구니에 담아둔 상품이 있어요',
    heading: '장바구니를 확인해 주세요',
    body: '담아둔 상품이 기다리고 있습니다. 품절되기 전에 쇼핑을 이어가세요.',
    cta: '장바구니로 이동'
  },
  checkout_abandonment_reminder: {
    subject: '결제를 이어서 완료해 주세요',
    heading: '결제가 아직 완료되지 않았어요',
    body: '선택한 상품의 결제를 안전하게 이어서 완료할 수 있습니다.',
    cta: '결제 계속하기'
  },
  first_purchase_thank_you: {
    subject: '첫 구매 감사합니다',
    heading: '첫 구매를 완료해 주셔서 감사합니다',
    body: '주문을 확인하고 있습니다. 새로운 상품과 혜택도 함께 살펴보세요.',
    cta: '쇼핑 계속하기'
  },
  review_request: {
    subject: '구매한 상품은 어떠셨나요?',
    heading: '상품 후기를 들려주세요',
    body: '사용 경험을 남겨주시면 더 나은 상품을 준비하는 데 도움이 됩니다.',
    cta: '후기 작성하기'
  },
  repurchase_due: {
    subject: '다시 필요할 때가 되었어요',
    heading: '즐겨 찾는 상품을 다시 만나보세요',
    body: '이전에 구매한 상품과 함께 잘 맞는 추천 상품을 준비했습니다.',
    cta: '추천 상품 보기'
  },
  lead_followup: {
    subject: '문의해 주셔서 감사합니다',
    heading: '문의 내용을 확인했습니다',
    body: '요청하신 내용을 확인하고 필요한 안내를 이어서 전달드리겠습니다.',
    cta: '사이트 방문하기'
  },
  dormant_reactivation_60: {
    subject: '오랜만이에요. 새로운 혜택을 확인해 보세요',
    heading: '다시 만나 반갑습니다',
    body: '최근 추가된 상품과 다시 방문한 고객을 위한 혜택을 확인해 보세요.',
    cta: '새로운 상품 보기'
  },
  dormant_reactivation_90: {
    subject: '다시 방문해 주실 때 사용할 혜택이 있어요',
    heading: '고객님을 위한 혜택을 준비했습니다',
    body: '지금 돌아오시면 새로운 상품과 맞춤 혜택을 한 번에 확인할 수 있습니다.',
    cta: '혜택 확인하기'
  },
  vip_benefit: {
    subject: 'VIP 고객 전용 혜택을 확인해 주세요',
    heading: 'VIP 고객님을 위한 특별 혜택',
    body: '감사의 마음을 담아 전용 혜택과 추천 상품을 준비했습니다.',
    cta: 'VIP 혜택 보기'
  }
};

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length > 0 &&
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('82')) {
    return `0${digits.slice(2)}`;
  }
  return digits;
}

function normalizeRecipient(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  if (normalized.includes('@')) {
    return normalized;
  }
  const phone = normalizePhone(normalized);
  return phone.length >= 9 ? phone : normalized;
}

function parseTestRecipients(value) {
  return new Set(String(value || '')
    .split(',')
    .map(normalizeRecipient)
    .filter(Boolean));
}

function testRecipientAllowed(payload, channel, env = process.env) {
  if ((env.CRM_DELIVERY_MODE || 'test') === 'live') {
    return true;
  }

  const allowlist = parseTestRecipients(env.CRM_TEST_RECIPIENTS);
  const recipient = channel === 'email' ? payload.email : payload.phone;
  const candidates = [recipient, payload.user_id ? `user:${payload.user_id}` : '']
    .map(normalizeRecipient)
    .filter(Boolean);

  return candidates.some((candidate) => allowlist.has(candidate));
}

function gatewayAuthorized(authorization, expectedToken) {
  const match = String(authorization || '').match(/^Bearer\s+(.+)$/i);
  return Boolean(match && safeEqual(match[1], expectedToken));
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function appUrl(env) {
  const value = String(env.NEXT_PUBLIC_APP_URL || env.MARKETING_APP_URL || '').trim();
  return /^https:\/\//i.test(value) ? value.replace(/\/+$/, '') : '';
}

function renderMessage(flow, payload, env = process.env) {
  const template = MESSAGE_TEMPLATES[flow];
  if (!template) {
    throw new Error('unsupported_message_flow');
  }

  const destination = appUrl(env);
  const context = payload.product_id
    ? `\n상품 코드: ${payload.product_id}`
    : payload.order_id
      ? `\n주문 번호: ${payload.order_id}`
      : '';
  const text = `${template.heading}\n\n${template.body}${context}${destination ? `\n\n${template.cta}: ${destination}` : ''}`;
  const html = `<!doctype html><html lang="ko"><body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#171717"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e5e5"><tr><td style="padding:32px"><h1 style="margin:0 0 16px;font-size:24px;line-height:1.35">${escapeHtml(template.heading)}</h1><p style="margin:0 0 20px;font-size:16px;line-height:1.65">${escapeHtml(template.body)}</p>${context ? `<p style="margin:0 0 20px;color:#666666;font-size:14px;line-height:1.5">${escapeHtml(context.trim())}</p>` : ''}${destination ? `<a href="${escapeHtml(destination)}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:12px 18px;font-size:15px">${escapeHtml(template.cta)}</a>` : ''}</td></tr></table></td></tr></table></body></html>`;

  return {
    subject: template.subject,
    text,
    html,
    kakaoText: text.slice(0, 1000),
    destination,
    cta: template.cta
  };
}

function scheduling(rawScheduledAt, now, maximumDays) {
  const scheduledAt = new Date(rawScheduledAt || '');
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now.getTime() + 60_000) {
    return { scheduled: false };
  }

  if (scheduledAt.getTime() - now.getTime() > maximumDays * 24 * 60 * 60 * 1000) {
    return { scheduled: false, error: 'schedule_window_exceeded' };
  }

  return { scheduled: true, scheduledAt: scheduledAt.toISOString() };
}

function deliveryId(payload, action, channel) {
  return sha256(JSON.stringify({
    event_name: payload.event_name,
    occurred_at: payload.occurred_at,
    user_id: payload.user_id || '',
    cart_id: payload.cart_id || '',
    order_id: payload.order_id || '',
    flow: action.flow,
    scheduled_at: action.scheduled_at || '',
    channel
  }));
}

function buildResendPayload(payload, action, env = process.env, now = new Date()) {
  const message = renderMessage(action.flow, payload, env);
  const schedule = scheduling(action.scheduled_at, now, 30);
  if (schedule.error) {
    return { error: schedule.error };
  }

  return {
    request: {
      from: env.RESEND_FROM_EMAIL,
      to: [payload.email],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(schedule.scheduled ? { scheduled_at: schedule.scheduledAt } : {})
    },
    scheduled: schedule.scheduled
  };
}

function buildSolapiPayload(payload, action, env = process.env, now = new Date()) {
  const message = renderMessage(action.flow, payload, env);
  const schedule = scheduling(action.scheduled_at, now, 180);
  if (schedule.error) {
    return { error: schedule.error };
  }

  return {
    request: {
      messages: [{
        to: normalizePhone(payload.phone),
        text: message.kakaoText,
        kakaoOptions: {
          pfId: env.SOLAPI_KAKAO_PF_ID,
          bms: {
            targeting: env.SOLAPI_KAKAO_TARGETING || 'I',
            chatBubbleType: 'TEXT',
            adult: false,
            ...(message.destination ? {
              buttons: [{
                name: message.cta,
                linkType: 'WL',
                linkMobile: message.destination,
                linkPc: message.destination
              }]
            } : {})
          }
        }
      }],
      ...(schedule.scheduled ? { scheduledDate: schedule.scheduledAt } : {})
    },
    scheduled: schedule.scheduled
  };
}

function solapiAuthorization(apiKey, apiSecret, options = {}) {
  const date = options.date || new Date().toISOString();
  const salt = options.salt || randomUUID();
  const signature = createHmac('sha256', apiSecret).update(`${date}${salt}`).digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function redisCommand(args, env, fetchImpl) {
  const response = await fetchImpl(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  const body = await responseJson(response);
  if (!response.ok || body.error) {
    throw new Error('redis_command_failed');
  }
  return body.result;
}

function identityIndexKeys(payload) {
  return [
    ['user', payload.user_id],
    ['email', String(payload.email || '').toLowerCase()],
    ['phone', normalizePhone(payload.phone)],
    ['cart', payload.cart_id]
  ]
    .filter(([, value]) => Boolean(value))
    .map(([kind, value]) => `ma:cancel:${kind}:${sha256(value)}`);
}

async function claimDelivery(id, env, fetchImpl) {
  const result = await redisCommand(
    ['SET', `ma:idempotency:${id}`, 'pending', 'NX', 'EX', IDEMPOTENCY_TTL_SECONDS],
    env,
    fetchImpl
  );
  return result === 'OK';
}

async function releaseDelivery(id, env, fetchImpl) {
  await redisCommand(['DEL', `ma:idempotency:${id}`], env, fetchImpl);
}

async function rememberCancelableJob({ id, provider, providerId, payload, action }, env, fetchImpl) {
  const indexes = identityIndexKeys(payload);
  const key = `ma:job:${id}`;
  const record = JSON.stringify({ provider, providerId, indexes });

  await redisCommand(['SET', key, record, 'EX', JOB_TTL_SECONDS], env, fetchImpl);
  for (const index of indexes) {
    await redisCommand(['SADD', index, key], env, fetchImpl);
    await redisCommand(['EXPIRE', index, JOB_TTL_SECONDS], env, fetchImpl);
  }

  return { key, indexes, cancelOnEvent: action.cancel_on_event };
}

async function sendResend(payload, action, id, env, fetchImpl, now) {
  const built = buildResendPayload(payload, action, env, now);
  if (built.error) {
    return { status: 'failed', channel: 'email', reason: built.error };
  }

  const response = await fetchImpl(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': id
    },
    body: JSON.stringify(built.request)
  });
  const body = await responseJson(response);
  if (!response.ok || !body.id) {
    return { status: 'failed', channel: 'email', reason: 'resend_request_failed', provider_status: response.status };
  }

  return {
    status: built.scheduled ? 'scheduled' : 'sent',
    channel: 'email',
    provider: 'resend',
    providerId: body.id,
    scheduled: built.scheduled
  };
}

async function sendSolapi(payload, action, id, env, fetchImpl, now) {
  const built = buildSolapiPayload(payload, action, env, now);
  if (built.error) {
    return { status: 'failed', channel: 'kakao', reason: built.error };
  }

  const response = await fetchImpl(`${SOLAPI_API_URL}/send-many/detail`, {
    method: 'POST',
    headers: {
      Authorization: solapiAuthorization(env.SOLAPI_API_KEY, env.SOLAPI_API_SECRET),
      'Content-Type': 'application/json',
      'X-Automation-Id': id
    },
    body: JSON.stringify(built.request)
  });
  const body = await responseJson(response);
  const providerId = body.groupId || body.groupInfo?.groupId || body.group?.groupId;
  if (!response.ok || !providerId) {
    return { status: 'failed', channel: 'kakao', reason: 'solapi_request_failed', provider_status: response.status };
  }

  return {
    status: built.scheduled ? 'scheduled' : 'sent',
    channel: 'kakao',
    provider: 'solapi',
    providerId,
    scheduled: built.scheduled
  };
}

async function cancelProviderJob(record, env, fetchImpl) {
  if (record.provider === 'resend') {
    const response = await fetchImpl(`${RESEND_API_URL}/${encodeURIComponent(record.providerId)}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }
    });
    return response.ok || response.status === 404;
  }

  if (record.provider === 'solapi') {
    const response = await fetchImpl(`${SOLAPI_API_URL}/groups/${encodeURIComponent(record.providerId)}/schedule`, {
      method: 'DELETE',
      headers: { Authorization: solapiAuthorization(env.SOLAPI_API_KEY, env.SOLAPI_API_SECRET) }
    });
    return response.ok || response.status === 404;
  }

  return false;
}

async function cancelPendingJobs(payload, env, fetchImpl) {
  const keys = new Set();
  for (const index of identityIndexKeys(payload)) {
    const members = await redisCommand(['SMEMBERS', index], env, fetchImpl);
    for (const key of members || []) {
      keys.add(key);
    }
  }

  let cancelled = 0;
  let failed = 0;
  for (const key of keys) {
    const serialized = await redisCommand(['GET', key], env, fetchImpl);
    if (!serialized) {
      continue;
    }

    const record = JSON.parse(serialized);
    if (await cancelProviderJob(record, env, fetchImpl)) {
      for (const index of record.indexes || []) {
        await redisCommand(['SREM', index, key], env, fetchImpl);
      }
      await redisCommand(['DEL', key], env, fetchImpl);
      cancelled += 1;
    } else {
      failed += 1;
    }
  }

  return { found: keys.size, cancelled, failed };
}

function providerConfigured(channel, env) {
  if (channel === 'email') {
    return Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL);
  }
  return Boolean(env.SOLAPI_API_KEY && env.SOLAPI_API_SECRET && env.SOLAPI_KAKAO_PF_ID);
}

function deliveryReadiness(env = process.env) {
  const mode = env.CRM_DELIVERY_MODE || 'test';
  const missing = [];
  const required = [
    'DOWNSTREAM_CRM_API_KEY',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
    'SOLAPI_API_KEY',
    'SOLAPI_API_SECRET',
    'SOLAPI_KAKAO_PF_ID'
  ];

  for (const key of required) {
    if (!env[key]) {
      missing.push(key);
    }
  }
  if (!['test', 'live'].includes(mode)) {
    missing.push('CRM_DELIVERY_MODE');
  }
  if (mode === 'test' && parseTestRecipients(env.CRM_TEST_RECIPIENTS).size === 0) {
    missing.push('CRM_TEST_RECIPIENTS');
  }

  return {
    ready: missing.length === 0,
    mode,
    missing,
    providers: {
      email: providerConfigured('email', env),
      kakao: providerConfigured('kakao', env),
      scheduler: Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN)
    },
    test_recipient_count: parseTestRecipients(env.CRM_TEST_RECIPIENTS).size
  };
}

function validateGatewayPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['invalid_payload'];
  }
  if (!payload.event_name) {
    errors.push('event_name_required');
  }
  if (!payload.occurred_at) {
    errors.push('occurred_at_required');
  }
  if (!Array.isArray(payload.automation_actions)) {
    errors.push('automation_actions_required');
  }
  if ((payload.email || payload.phone) && payload.marketing_consent !== true) {
    errors.push('marketing_consent_required');
  }
  return errors;
}

async function processDelivery(payload, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || new Date();
  const readiness = deliveryReadiness(env);
  if (!fetchImpl) {
    throw new Error('fetch_unavailable');
  }

  const cancellation = payload.event_name === 'purchase' && readiness.providers.scheduler
    ? await cancelPendingJobs(payload, env, fetchImpl)
    : { found: 0, cancelled: 0, failed: 0 };
  const results = [];
  const actions = (payload.automation_actions || [])
    .filter((action) => action.action_type === 'message');

  for (const action of actions) {
    for (const channel of action.channels || []) {
      if (!['email', 'kakao'].includes(channel)) {
        continue;
      }
      if (action.status !== 'ready' || payload.marketing_consent !== true) {
        results.push({ flow: action.flow, channel, status: 'suppressed', reason: 'marketing_consent_required' });
        continue;
      }

      const recipient = channel === 'email' ? payload.email : payload.phone;
      if (!recipient) {
        results.push({ flow: action.flow, channel, status: 'skipped', reason: 'recipient_missing' });
        continue;
      }
      if (!testRecipientAllowed(payload, channel, env)) {
        results.push({ flow: action.flow, channel, status: 'suppressed', reason: 'test_recipient_not_allowed' });
        continue;
      }
      if (!providerConfigured(channel, env)) {
        results.push({ flow: action.flow, channel, status: 'skipped', reason: 'provider_not_configured' });
        continue;
      }
      if (!readiness.providers.scheduler) {
        results.push({ flow: action.flow, channel, status: 'failed', reason: 'scheduler_not_configured' });
        continue;
      }

      const id = deliveryId(payload, action, channel);
      let claimed;
      try {
        claimed = await claimDelivery(id, env, fetchImpl);
      } catch {
        results.push({ flow: action.flow, channel, status: 'failed', reason: 'idempotency_store_failed' });
        continue;
      }
      if (!claimed) {
        results.push({ flow: action.flow, channel, status: 'skipped', reason: 'duplicate_delivery' });
        continue;
      }

      let result;
      try {
        result = channel === 'email'
          ? await sendResend(payload, action, id, env, fetchImpl, now)
          : await sendSolapi(payload, action, id, env, fetchImpl, now);

        if (result.status === 'scheduled' && action.cancel_on_event) {
          try {
            await rememberCancelableJob({ id, provider: result.provider, providerId: result.providerId, payload, action }, env, fetchImpl);
          } catch (error) {
            await cancelProviderJob(result, env, fetchImpl);
            throw error;
          }
        }
      } catch {
        result = { status: 'failed', channel, reason: 'delivery_request_failed' };
      }

      if (result.status === 'failed') {
        try {
          await releaseDelivery(id, env, fetchImpl);
        } catch {
          // The original provider failure remains the actionable error.
        }
      }

      results.push({
        flow: action.flow,
        channel,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.provider_status ? { provider_status: result.provider_status } : {})
      });
    }
  }

  const failed = results.filter((result) => result.status === 'failed').length + cancellation.failed;
  return {
    ok: failed === 0,
    mode: readiness.mode,
    cancellation,
    summary: {
      sent: results.filter((result) => result.status === 'sent').length,
      scheduled: results.filter((result) => result.status === 'scheduled').length,
      suppressed: results.filter((result) => result.status === 'suppressed').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      failed
    },
    results
  };
}

export {
  buildResendPayload,
  buildSolapiPayload,
  deliveryReadiness,
  gatewayAuthorized,
  normalizePhone,
  parseTestRecipients,
  processDelivery,
  renderMessage,
  solapiAuthorization,
  testRecipientAllowed,
  validateGatewayPayload
};

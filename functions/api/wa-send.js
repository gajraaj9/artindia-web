/**
 * POST /api/wa-send   { "to": "+32...", "text": "..." }
 *
 * How a person answers an escalation. Plain text, straight to the number, no
 * template — which is exactly why it only works inside WhatsApp's 24 hour
 * customer service window: outside it Meta requires an approved template, and
 * says so with error 131047.
 *
 *   curl -X POST https://diwali.artindia.be/api/wa-send \
 *     -H "X-Admin-Token: $WA_ADMIN_TOKEN" \
 *     -H 'content-type: application/json' \
 *     -d '{"to":"+32474919900","text":"Hello, the fireworks are at 21:00."}'
 *
 * Env: WA_ADMIN_TOKEN, WA_TOKEN, WA_PHONE_ID.
 */

import { json, safeEqual, normalisePhone } from './_shared.js';
import { sendText, logMessage } from './_bot.js';

/* Outside the 24h window. Meta will not deliver a free-form message and the
   sender needs to know that rather than assuming it went. */
const WINDOW_CLOSED = 131047;

export async function onRequestPost({ request, env }) {
  if (!env.WA_ADMIN_TOKEN) {
    console.error('wa-send: WA_ADMIN_TOKEN unset, refusing every request');
    return json(503, { ok: false, error: 'not_configured' });
  }
  if (!safeEqual(request.headers.get('x-admin-token') || '', env.WA_ADMIN_TOKEN)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  let payload;
  try { payload = await request.json(); }
  catch { return json(400, { ok: false, error: 'bad_json' }); }

  const to = normalisePhone(payload && payload.to);
  const body = String((payload && payload.text) || '').trim();

  if (!to) {
    return json(400, { ok: false, error: 'bad_number', hint: 'pass "to" in E.164, e.g. +32474919900' });
  }
  if (!body) return json(400, { ok: false, error: 'empty_text' });
  if (body.length > 4096) return json(400, { ok: false, error: 'too_long', max: 4096 });

  const res = await sendText(env, to, body);

  if (res.ok) {
    /* Into the same transcript as everything else, so the dashboard shows a
       team reply in line rather than a gap in the conversation. */
    if (env.REFERRALS) {
      await logMessage(env.REFERRALS, to, { dir: 'out', kind: 'admin', text: body });
    }
    console.log('wa-send ok', to, res.messageId);
    return json(200, { ok: true, to, message_id: res.messageId });
  }

  if (res.code === WINDOW_CLOSED) {
    return json(409, {
      ok: false, error: 'window_closed', to,
      message: 'The 24 hour customer service window for this number has closed. '
        + 'A free-form message cannot be delivered; they have to write in again first, '
        + 'or the reply has to go out as an approved template.',
      meta_error: res.error,
    });
  }

  console.error('wa-send failed', to, res.status, JSON.stringify(res.error));
  return json(502, { ok: false, error: 'send_failed', to, status: res.status, meta_error: res.error });
}

export const onRequestGet = () => json(405, { ok: false, error: 'method_not_allowed' });

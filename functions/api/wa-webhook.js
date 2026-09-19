/**
 * /api/wa-webhook   Meta WhatsApp Cloud API callbacks
 *
 * Two jobs, both about keeping the opt-in list honest:
 *
 *   inbound STOP        someone replies stop / arrêt — WA_OPTIN goes false
 *   delivery failures   Meta says the number is not on WhatsApp, or that we
 *                       are outside the re-engagement window — WA_OPTIN goes
 *                       false rather than being retried for ever
 *
 * Register it in Meta -> App -> WhatsApp -> Configuration:
 *   callback  https://diwali.artindia.be/api/wa-webhook
 *   token     WA_VERIFY_TOKEN
 *   subscribe messages
 *
 * Env:
 *   WA_VERIFY_TOKEN   the string pasted into Meta's callback settings
 *   WA_APP_SECRET     optional. When set, every POST body is checked against
 *                     X-Hub-Signature-256 — this endpoint is public and can
 *                     turn consent flags off, so it is worth setting.
 *   BREVO_API_KEY     already set
 */

import {
  json, truthy, normalisePhone, getContact, upsertContact,
  safeEqual, statusKey, STATUS_TTL_SECONDS,
} from './_shared.js';

const text = (status, body) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });

/* ----------------------------------------------------------- verification */

/** Meta's handshake: echo the challenge back in plain text, or refuse. */
export function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const mode = q.get('hub.mode');
  const token = q.get('hub.verify_token');
  const challenge = q.get('hub.challenge') || '';

  if (!env.WA_VERIFY_TOKEN) {
    console.error('wa-webhook: WA_VERIFY_TOKEN unset, cannot verify');
    return text(500, 'not_configured');
  }
  if (mode === 'subscribe' && token === env.WA_VERIFY_TOKEN) return text(200, challenge);

  console.warn('wa-webhook: verification refused, mode=', mode);
  return text(403, 'forbidden');
}

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Meta signs the raw body with the app secret as sha256=<hex>. */
async function verifySignature(request, rawBody, secret) {
  const header = request.headers.get('x-hub-signature-256') || '';
  const sig = header.startsWith('sha256=') ? header.slice(7).toLowerCase() : '';
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  return safeEqual(hex(mac), sig);
}

/* ---------------------------------------------------------------- status */

/* Meta sends timestamps as unix seconds in a string. */
function when(raw) {
  const n = Number(raw);
  const dt = Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
  return isNaN(dt) ? new Date().toISOString() : dt.toISOString();
}

const errorsOf = s =>
  (s.errors || []).map(e => ({
    code: Number(e.code) || null,
    title: e.title || e.message || '',
  }));

/**
 * Keep every delivery report against its message id.
 *
 * One message produces several — sent, then delivered, then read — so the
 * record carries a history as well as the latest, and /api/wa-status hands
 * the whole thing back. Read-then-write, so two reports landing in the same
 * instant could lose one; at this volume that is a missing line in a delivery
 * trail, and the alternative is a lock. Meta can also redeliver a callback it
 * thinks we missed, so an identical entry is not appended twice.
 *
 * Out-of-order arrival is possible and is not corrected: history is the order
 * we were told, which is what you want when the question is "what did Meta
 * actually say and when".
 */
async function recordStatus(kv, s) {
  const wamid = String(s.id || '');
  if (!wamid) return;

  const entry = {
    status: String(s.status || 'unknown'),
    at: when(s.timestamp),
    ...(errorsOf(s).length ? { errors: errorsOf(s) } : {}),
  };

  let record = null;
  try {
    record = await kv.get(statusKey(wamid), 'json');
  } catch (e) {
    console.error('wa-webhook: status read failed', wamid, String(e));
  }

  const history = Array.isArray(record && record.history) ? record.history : [];
  const last = history[history.length - 1];
  if (!last || last.status !== entry.status || last.at !== entry.at) history.push(entry);

  const next = {
    id: wamid,
    recipient: String(s.recipient_id || (record && record.recipient) || ''),
    status: entry.status,
    timestamp: entry.at,
    errors: entry.errors || [],
    history: history.slice(-20),
    firstSeenAt: (record && record.firstSeenAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await kv.put(statusKey(wamid), JSON.stringify(next),
      { expirationTtl: STATUS_TTL_SECONDS });
  } catch (e) {
    console.error('wa-webhook: status write failed', wamid, String(e));
  }
}

/* ---------------------------------------------------------------- opt-out */

/* Meta sends numbers as E.164 without the plus. Putting it back before
   normalising matters: a bare 33… is a French number, not a Belgian one
   missing its trunk zero, and only the plus says so. */
const fromMeta = n => normalisePhone('+' + String(n || '').replace(/\D/g, ''));

const STOP_RE = /^\s*(stop|arrêt|arret)\s*$/i;

/* Meta error codes that mean the number will never receive this message:
   131026 the recipient is not a WhatsApp user, 131047 the 24-hour window has
   closed and re-engagement was refused. Either way, stop trying. */
const DEAD_CODES = new Set([131026, 131047]);

/**
 * Turn WA_OPTIN off for whoever owns this number.
 *
 * Brevo can look a contact up by its WhatsApp identity directly; older keys
 * fall back to the SMS one. The update is then done by email, which is the
 * identifier Brevo is happiest with.
 */
async function optOut(env, phone, why) {
  if (!phone || !env.BREVO_API_KEY) return false;

  let contact = null;
  for (const type of ['whatsapp_id', 'phone_id']) {
    try {
      contact = await getContact(env, phone, type);
      if (contact) break;
    } catch (e) {
      console.error('wa-webhook: lookup by', type, 'failed', String(e));
    }
  }
  if (!contact || !contact.email) {
    console.warn('wa-webhook: no Brevo contact for', phone, '(', why, ')');
    return false;
  }

  const res = await upsertContact(env, contact.email, { WA_OPTIN: false });
  if (!res.ok) {
    console.error('wa-webhook: opt-out write failed', contact.email, res.status, res.detail);
    return false;
  }
  console.log('wa-webhook: WA_OPTIN false for', contact.email, why);
  return true;
}

/* ---------------------------------------------------------------- handler */

/* Everything Meta sends is handled after the 200 has gone out. Meta retries a
   callback it does not get an answer to within seconds, and a Brevo lookup is
   not something to make it wait for. */
async function process(env, body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      for (const m of value.messages || []) {
        const bodyText = (m.text && m.text.body) || '';
        if (!STOP_RE.test(bodyText)) continue;
        /* Nothing is sent back. This is a marketing opt-out, and a reply to it
           would itself be a message they just told us to stop sending. */
        await optOut(env, fromMeta(m.from), 'stop reply');
      }

      for (const s of value.statuses || []) {
        const errors = errorsOf(s);
        console.log('wa status', JSON.stringify({
          id: s.id, status: s.status, recipient_id: s.recipient_id, errors,
        }));
        /* Stored whatever it says. A delivered is as much a part of the trail
           as a failure, and /api/wa-status is the only way to read it back
           without the log stream. */
        if (env.REFERRALS) await recordStatus(env.REFERRALS, s);
        else console.warn('wa-webhook: REFERRALS KV not bound, status not stored');

        if (s.status !== 'failed') continue;
        if (!errors.some(e => DEAD_CODES.has(Number(e.code)))) continue;
        await optOut(env, fromMeta(s.recipient_id), 'delivery failed');
      }
    }
  }
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  const rawBody = await request.text();

  if (env.WA_APP_SECRET) {
    if (!await verifySignature(request, rawBody, env.WA_APP_SECRET)) {
      console.error('wa-webhook: bad signature');
      return text(401, 'bad_signature');
    }
  } else {
    console.warn('wa-webhook: WA_APP_SECRET unset, signature NOT verified');
  }

  let body;
  try { body = JSON.parse(rawBody); }
  catch { return text(200, 'bad_json'); }

  if (truthy(env.WA_LOG_PAYLOAD)) console.log('wa-webhook raw', rawBody.slice(0, 4000));

  waitUntil(process(env, body).catch(e => console.error('wa-webhook: threw', String(e))));
  return text(200, 'ok');
}

export const onRequestPut = () => json(405, { ok: false, error: 'method_not_allowed' });

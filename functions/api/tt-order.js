/**
 * POST /api/tt-order   Ticket Tailor order.created  ->  Brevo  ->  WhatsApp
 *
 * Ticket Tailor posts every new order here. We turn it into a Brevo contact on
 * the buyers list carrying how many tickets they bought, what they paid, which
 * campaign sent them and their own referral code — and, if they said yes to
 * WhatsApp at checkout, send them the welcome template with that code in it.
 *
 * Set these in Cloudflare -> Workers & Pages -> the project -> Settings ->
 * Variables and Secrets:
 *
 *   TT_WEBHOOK_SECRET      secret, from Ticket Tailor -> Settings -> API ->
 *                          Webhooks. Without it signatures are NOT checked and
 *                          anyone who finds this URL can write to your list.
 *   BREVO_API_KEY          secret, already set for /api/register
 *   BREVO_BUYERS_LIST_ID   numeric id of "Diwali 2026 Buyers" (12)
 *   BREVO_LIST_ID          the waitlist (9), already set. Used only to spot a
 *                          waitlist signup who has now bought.
 *   WA_TOKEN               secret, permanent system-user token
 *   WA_PHONE_ID            WhatsApp sender phone number id
 *   WA_DRY_RUN             "true" logs the WhatsApp payload instead of sending
 *   WA_WABA_ID             the WhatsApp Business Account id, used to read the
 *                          approved template's language and button shape
 *   WA_TEMPLATE            default diwali_welcome_en_v2
 *   WA_TEMPLATE_FALLBACK   default diwali_welcome_en, sent when v2 is refused
 *   WA_HEADER_IMAGE_URL    the v2 header image. Must be publicly fetchable by
 *                          Meta. Default https://diwali.artindia.be/img/wa-header.jpg
 *   TT_LOG_PAYLOAD         "true" logs the raw order once per delivery, for
 *                          reading the real field names out of the tail
 *
 * and bind the KV namespace REFERRALS. Without it the order still reaches
 * Brevo; only the referral code and the WhatsApp send are skipped.
 *
 * Envelope, per Ticket Tailor's webhook docs:
 *   { id, created_at, event, resource_url, payload }
 * where payload is the order.
 *
 * FIELD NAMES. Confirmed against a real order.created delivery (or_83266022,
 * 19 September 2026), not against the published spec, which renders client
 * side and could not be read. Two notes worth keeping:
 *
 *   - the custom questions hang off buyer_details, not off the order
 *   - there is no utm_* anywhere and meta_data comes back empty; referral_tag
 *     is the only campaign signal, and it is whatever arrived as ?ref=
 *
 * Anything still unconfirmed is marked STILL A GUESS where it is read.
 * TT_LOG_PAYLOAD stays for the next time the shape moves.
 */

import {
  json, pick, truthy, isEmail, normalisePhone, referralCode, CODE_RE,
  getContact, ensureAttributes, upsertContact, codeKey, orderKey, refcountKey,
} from './_shared.js';
import { botKey, logMessage, LOG_SECONDS } from './_bot.js';

/* ------------------------------------------------------------------ crypto */

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Workers has no timingSafeEqual. Compare every byte regardless of mismatch so
   the duration of the comparison says nothing about how much of the signature
   was right. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Ticket Tailor signs `timestamp + rawBody` with HMAC-SHA256, hex encoded, and
 * sends it as `TicketTailor-Webhook-Signature: t=<unix>,v1=<hex>`. A signature
 * older than five minutes is refused so a captured request cannot be replayed.
 */
async function verify(request, rawBody, secret) {
  const header =
    request.headers.get('tickettailor-webhook-signature') ||
    request.headers.get('x-tt-signature') || '';
  if (!header) return { ok: false, reason: 'missing_signature' };

  const parts = Object.fromEntries(
    header.split(',').map(p => {
      const i = p.indexOf('=');
      return i === -1 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }));
  const ts = parts.t;
  const sig = parts.v1 || parts.s;
  if (!ts || !sig) return { ok: false, reason: 'malformed_signature' };

  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: 'stale_timestamp' };

  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(ts + rawBody));
  return safeEqual(hex(mac), sig.toLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}

/* ------------------------------------------------------------- extraction */

/* FIELD NAMES ARE CONFIRMED. Read out of a real order.created delivery
   (or_83266022) on 19 September 2026, so the defensive lists of candidate
   spellings this function used to carry are gone. Where a name below is still
   a guess it says so. TT_LOG_PAYLOAD is kept for the next time the shape
   moves. */

/* Ticket Tailor returns money in minor units as a string, so "1000" is ten
   euros. A value that already carries a decimal point is taken at face value. */
function money(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'object') return money(raw.value ?? raw.amount);
  const s = String(raw).trim();
  if (s === '') return 0;
  const n = Number(s.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return s.includes('.') ? n : n / 100;
}

/* Which line items are children. Ticket Tailor has no "this is a child ticket"
   flag, so it comes down to what the ticket type is called. The site sells
   "Children under 12", and the box office may one day be renamed in French or
   Dutch, so enfant and kind are matched too: a trilingual rename should not
   quietly stop counting children. A free line counts as well, the child ticket
   being the only free one. */
const CHILD_RE =
  /child|children|enfant|enfants|kind|kinderen|kid|under\s*12|moins\s*de\s*12|onder\s*12/i;

/* line_items[] { quantity, total, description } */
function countTickets(order) {
  const lines = Array.isArray(order.line_items) ? order.line_items : [];
  let total = 0, child = 0;
  for (const li of lines) {
    const qty = Number(li.quantity ?? 1) || 1;
    const name = String(li.description || '');
    total += qty;
    if (CHILD_RE.test(name) || money(li.total) === 0) child += qty;
  }
  return { total, child };
}

/**
 * The order's custom question answers, as [{label, answer}].
 *
 * They live on buyer_details, not on the order. Reading them off the order was
 * the reason the first live buyer who said yes to WhatsApp was logged as
 * not_eligible: the list came back empty, so their Yes read as a No. Anything
 * that consumes this is a consent decision, so when it comes back empty the
 * caller says so in the log rather than quietly treating it as a refusal.
 */
function questions(order) {
  const qs = (order.buyer_details || {}).custom_questions;
  return (Array.isArray(qs) ? qs : []).map(q => ({
    label: String(q.question || ''),
    answer: q.answer,
  }));
}

/**
 * Where this order came from. Ticket Tailor puts whatever arrived as ?ref= on
 * the box office URL into referral_tag — "event_page_widget" for the site's own
 * checkout, a referral code for anyone who came through /r/<CODE>. meta_data
 * came back empty on the real payload and no utm_* field survives checkout at
 * all, so referral_tag is the only campaign signal there is.
 */
const referralTag = order => String(order.referral_tag || '').trim().slice(0, 120);

/**
 * Tags that name a channel rather than a person.
 *
 * /i/<n> mints ig-<n>, one per Instagram post, so a campaign can be read per
 * post instead of as one lump. These must never be looked up as referral
 * codes: there is nobody behind them to credit, and a KV read per order for a
 * key that cannot exist is a round trip spent on nothing.
 */
const CHANNEL_TAGS = [[/^ig-/i, 'instagram']];

function channelOf(tag) {
  for (const [re, source] of CHANNEL_TAGS) if (re.test(tag)) return source;
  return '';
}

/* The same tag, when it is one of our referral codes rather than a channel
   name. A channel tag is ruled out before the shape is even checked, and
   anything else that is not six characters of the code alphabet is somebody
   else's campaign and credits nobody. */
function findCampaign(order) {
  const raw = referralTag(order);
  if (channelOf(raw)) return '';
  const tag = raw.toUpperCase();
  return CODE_RE.test(tag) ? tag : '';
}

/* Marketing consent, sent at the order's top level as the string "true". Absent
   means false: an unanswered question is not consent, and treating it as one
   would put non-consenting buyers on a marketing list. */
const findOptIn = order => truthy(order.marketing_opt_in);

/* WhatsApp consent, asked at checkout as the lucky draw question and answered
   "Yes" or "No". Same rule as above: anything but a yes is a no. This is the
   flag that decides whether we are allowed to message someone, so it is never
   inferred from anything but the answer. */
const WA_QUESTION_RE = /lucky\s*draw|whatsapp|tirage|loterij|trekking/i;

function findWaOptIn(order) {
  for (const { label, answer } of questions(order)) {
    if (WA_QUESTION_RE.test(label)) return truthy(answer);
  }
  return false;
}

/* buyer_details.phone arrives already in E.164 ("+32474919900"). It still goes
   through normalisePhone, which leaves a good number alone and is the only
   thing standing between a hand-typed one and a failed send. */
const findPhone = order => normalisePhone((order.buyer_details || {}).phone);

const LANGS = ['en', 'fr', 'nl'];

/* STILL A GUESS. The real payload carried no language field anywhere, so this
   returns 'en' for every order today. It is stored rather than dropped because
   the moment Ticket Tailor exposes the checkout locale — or the /r/ link starts
   carrying one — the FR and NL templates become a one-line change. */
function findLang(order) {
  const raw = String(order.locale || order.language
    || (order.buyer_details || {}).locale || '').trim().toLowerCase().slice(0, 2);
  return LANGS.includes(raw) ? raw : 'en';
}

/**
 * Everyone named on a ticket who is not the buyer and gave their own address.
 * They go on the buyers list so they get the practical emails, but they never
 * get a WhatsApp: the opt-in question was answered by whoever paid, and it was
 * answered about themselves.
 *
 * issued_tickets[] { id, first_name, last_name, email, description,
 *                    listed_price, ticket_type_id }
 */
function findAttendees(order, buyerEmail) {
  const tickets = Array.isArray(order.issued_tickets) ? order.issued_tickets : [];
  const out = new Map();
  for (const t of tickets) {
    const email = String(t.email || '').trim().toLowerCase();
    if (!isEmail(email) || email === buyerEmail || out.has(email)) continue;
    out.set(email, {
      email,
      firstName: String(t.first_name || '').trim(),
      lastName: String(t.last_name || '').trim(),
      ticketId: String(t.id || '').trim(),
    });
  }
  return [...out.values()];
}

/* ------------------------------------------------------------- referrals */

/**
 * The buyer's own referral code, stored in KV so /r/<CODE> can resolve it.
 *
 * The code is derived from the address, so the usual path is one read and, the
 * first time, one write. A collision with a *different* address is rare but has
 * to be handled or two people would share a link and the credit would go to
 * whoever was written first; walking the attempt counter gives the second
 * person a different code deterministically.
 */
async function claimCode(kv, email, firstname) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = await referralCode(email, attempt);
    const held = await kv.get(codeKey(code), 'json');
    if (held && held.email === email) return code;
    if (!held) {
      await kv.put(codeKey(code), JSON.stringify({
        email, firstname, createdAt: new Date().toISOString(),
      }));
      return code;
    }
  }
  console.error('tt-order: no free referral code after 8 attempts for', email);
  return '';
}

/**
 * Credit the person whose link this order came in on.
 *
 * Read-add-write, so two orders landing on the same referrer in the same second
 * could lose a count. At this volume that is a rounding error on a leaderboard,
 * not money, and the alternative is a lock we would have to maintain.
 */
async function creditReferrer(env, kv, code, buyerEmail, adults) {
  if (!code || adults < 1) return null;
  const entry = await kv.get(codeKey(code), 'json');
  if (!entry || !entry.email || entry.email === buyerEmail) return null;

  const contact = await getContact(env, entry.email);
  if (!contact) return null;
  const before = Number((contact.attributes || {}).REFERRED_BY);
  const after = (Number.isFinite(before) ? before : 0) + adults;

  const res = await upsertContact(env, entry.email, { REFERRED_BY: after });
  if (!res.ok) {
    console.error('tt-order: referrer credit failed', res.status, res.detail);
    return null;
  }

  /* The same number again in KV. Brevo is where the marketing list lives;
     refcount: is what the WhatsApp bot reads when somebody taps "My chances",
     and reaching for Brevo on every button tap would put a third-party API in
     front of a chat reply. Written after Brevo, so the counter can only lag,
     never lead. */
  try {
    const before = Number(await kv.get(refcountKey(code))) || 0;
    await kv.put(refcountKey(code), String(before + adults));
  } catch (e) {
    console.error('tt-order: refcount write failed', code, String(e));
  }

  return { email: entry.email, code, credited: adults, total: after };
}

/* ------------------------------------------------------------- whatsapp */

const WA_API = 'https://graph.facebook.com/v21.0';

/* The approved template, and the one to fall back to. Both in env so a new
   approval does not need a deploy. */
const templateName = env => env.WA_TEMPLATE || 'diwali_welcome_en_v2';
const fallbackName = env => env.WA_TEMPLATE_FALLBACK || 'diwali_welcome_en';

/**
 * The header image.
 *
 * A media header is NOT baked into the approved template — the sample supplied
 * at approval time is only for Meta's reviewers, and the header_handle on the
 * template definition is an upload handle from that review, not something a
 * send can use. Every send has to supply the image itself, as a public https
 * link or an uploaded media id. So this URL has to resolve, publicly, for v2
 * to work at all.
 */
const headerImage = env =>
  env.WA_HEADER_IMAGE_URL || 'https://diwali.artindia.be/img/wa-header.jpg';

/* Meta's codes for "this template cannot be sent as asked". Template shape
   problems, and the two media errors, because a header image Meta cannot fetch
   fails the whole v2 send and the plain v1 template will still go out. */
const TEMPLATE_ERROR_CODES = new Set([
  132000, // parameter count mismatch
  132001, // template does not exist in this language
  132005, // translated text too long
  132007, // format mismatch
  132012, // parameter format mismatch
  132015, 132016, // paused
  132068, 132069,
  131052, 131053, // media could not be downloaded / uploaded
]);

/**
 * What the approved template actually looks like, straight from the WABA.
 *
 * Worth one call per isolate because two things about a template are invisible
 * from here and both fail the send outright: the language code it was approved
 * under (en and en_US are different templates as far as sending is concerned),
 * and whether it carries a URL button at all. Everything is optional — if the
 * lookup cannot be made, the caller assumes the full shape and lets the
 * fallback catch it.
 */
/* Keyed by account as well as name, and held for ten minutes rather than for
   the life of the isolate: a template that gets edited and re-approved should
   start being sent correctly within the quarter hour, not whenever Cloudflare
   happens to recycle the worker. */
const shapeCache = new Map();
const SHAPE_TTL_MS = 10 * 60 * 1000;

async function templateShape(env, name) {
  if (!env.WA_WABA_ID || !env.WA_TOKEN) return null;
  const key = `${env.WA_WABA_ID}:${name}`;
  const hit = shapeCache.get(key);
  if (hit && Date.now() - hit.at < SHAPE_TTL_MS) return hit.shape;

  let shape = null;
  try {
    const res = await fetch(
      `${WA_API}/${env.WA_WABA_ID}/message_templates?name=${encodeURIComponent(name)}`,
      { headers: { authorization: `Bearer ${env.WA_TOKEN}` } });
    const body = await res.text();
    if (!res.ok) {
      console.error('wa template lookup failed', name, res.status, body);
    } else {
      const found = (JSON.parse(body).data || []).find(t => t.name === name);
      if (found) {
        const components = found.components || [];
        const header = components.find(c => String(c.type).toUpperCase() === 'HEADER');
        const buttons = components.find(c => String(c.type).toUpperCase() === 'BUTTONS');
        const urlIndex = (buttons && buttons.buttons || [])
          .findIndex(b => String(b.type).toUpperCase() === 'URL' && /\{\{\d+\}\}/.test(b.url || ''));
        shape = {
          language: found.language || 'en',
          status: found.status || '',
          headerFormat: header ? String(header.format || '').toUpperCase() : '',
          urlButtonIndex: urlIndex >= 0 ? urlIndex : null,
        };
        console.log('wa template', name, JSON.stringify(shape));
      } else {
        console.error('wa template not found on the WABA:', name);
      }
    }
  } catch (e) {
    console.error('wa template lookup threw', name, String(e));
  }

  shapeCache.set(key, { at: Date.now(), shape });
  return shape;
}

/**
 * The v2 message: an image header, the name and link in the body, and the
 * referral code on its own in the dynamic part of the URL button — the button
 * already carries the rest of the link, so it takes the code alone, not the
 * whole URL.
 */
function buildV2(name, shape, { phone, firstName, code, image }) {
  const components = [];

  /* Only when the template really has a media header. Sending a header
     parameter to a template without one is a parameter-count error. */
  if (!shape || shape.headerFormat === 'IMAGE') {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: image } }],
    });
  }

  components.push({
    type: 'body',
    parameters: [
      { type: 'text', text: firstName || 'there' },
      { type: 'text', text: `https://diwali.artindia.be/r/${code}` },
    ],
  });

  const index = shape ? shape.urlButtonIndex : 0;
  if (index !== null && index !== undefined) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(index),
      parameters: [{ type: 'text', text: code }],
    });
  }

  return {
    messaging_product: 'whatsapp',
    to: phone.replace(/^\+/, ''),
    type: 'template',
    template: {
      name,
      language: { code: (shape && shape.language) || 'en' },
      components,
    },
  };
}

/* The original template: no header, no button, the link spelled out in the
   body. Deliberately the simplest thing that can still go out. */
const buildV1 = (name, { phone, firstName, code }) => ({
  messaging_product: 'whatsapp',
  to: phone.replace(/^\+/, ''),
  type: 'template',
  template: {
    name,
    language: { code: 'en' },
    components: [{
      type: 'body',
      parameters: [
        { type: 'text', text: firstName || 'there' },
        { type: 'text', text: `https://diwali.artindia.be/r/${code}` },
      ],
    }],
  },
});

/** One POST to Meta, with the body kept as text so it can be logged as sent. */
async function postToMeta(env, payload) {
  const res = await fetch(`${WA_API}/${env.WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.WA_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* kept as text below */ }
  return {
    ok: res.ok,
    status: res.status,
    messageId: (parsed && parsed.messages && parsed.messages[0] && parsed.messages[0].id) || '',
    error: (parsed && parsed.error) || body.slice(0, 1000),
    code: Number(parsed && parsed.error && parsed.error.code) || null,
  };
}

/**
 * The welcome message, with the buyer's first name, their referral link and
 * their code on the button.
 *
 * Best effort, always. A WhatsApp that does not go out is a missed nudge; a
 * webhook that 500s because Meta was slow is an order Ticket Tailor keeps
 * redelivering, so every failure here is logged and swallowed.
 *
 * When v2 comes back with something wrong about the template itself — the
 * wrong number of parameters, a language that does not exist, a header image
 * Meta could not fetch — the older template goes out instead rather than the
 * buyer getting nothing. That is logged loudly: a fallback that nobody notices
 * is a v2 that is quietly never used.
 */
async function sendWelcome(env, kv, { orderId, phone, firstName, code }) {
  const already = await kv.get(orderKey(orderId), 'json');
  if (already) {
    return {
      sent: false, reason: 'already_sent', to: phone,
      messageId: already.waMessageId, template: already.template,
    };
  }

  const name = templateName(env);
  const shape = await templateShape(env, name);
  const payload = buildV2(name, shape, {
    phone, firstName, code, image: headerImage(env),
  });

  if (truthy(env.WA_DRY_RUN)) {
    /* Nothing is written to KV on a dry run, so the same order can be replayed
       as often as it takes to get the mapping right. Only the v2 attempt is
       previewed: whether Meta would have refused it is exactly the thing a dry
       run cannot tell you. */
    console.log('wa dry-run', orderId, JSON.stringify(payload));
    return { sent: false, reason: 'dry_run', to: phone, template: name, preview: payload };
  }

  let used = name;
  let fellBack = false;
  let res = await postToMeta(env, payload);

  if (!res.ok && TEMPLATE_ERROR_CODES.has(res.code)) {
    const older = fallbackName(env);
    console.error('wa template', name, 'refused with', res.code,
      JSON.stringify(res.error), '— falling back to', older);
    used = older;
    fellBack = true;
    res = await postToMeta(env, buildV1(older, { phone, firstName, code }));
  }

  if (!res.ok) {
    console.error('wa send failed', orderId, used, res.status, JSON.stringify(res.error));
    return {
      sent: false, reason: 'send_failed', to: phone,
      status: res.status, error: res.error, template: used, fellBack,
    };
  }

  const sentAt = new Date().toISOString();
  await kv.put(orderKey(orderId), JSON.stringify({
    sentAt, waMessageId: res.messageId, template: used,
  }));

  /* The dashboard's welcome tab. Keyed by phone so a delivery report, which
     only carries the number, can find it again; the message id is kept so a
     report for some later message cannot overwrite this one's status. */
  try {
    await kv.put(botKey.welcome(phone), JSON.stringify({
      phone, ts: sentAt, name: firstName, template: used,
      waMessageId: res.messageId, orderId,
      status: 'sent', last_status_ts: sentAt,
    }), { expirationTtl: LOG_SECONDS });
    await logMessage(kv, phone,
      { dir: 'out', kind: 'template', text: `${used} (welcome)` },
      { name: firstName, buyer: true });
  } catch (e) {
    console.error('tt-order: welcome log failed', String(e));
  }

  console.log('wa sent', orderId, used, res.messageId, fellBack ? '(fallback)' : '');
  return { sent: true, to: phone, messageId: res.messageId, template: used, fellBack };
}

/**
 * Why this order is not getting a WhatsApp, or '' if it is.
 *
 * One reason at a time, most specific first. It exists because the single
 * not_eligible this used to log covered six unrelated causes, and the first
 * live buyer who hit it cost a payload dump to explain.
 */
function waBlocker(env, { kv, waOptIn, phone, code }) {
  if (!kv) return 'no_kv_binding';
  if (!waOptIn) return 'no_optin';
  if (!phone) return 'no_phone';
  if (!code) return 'no_referral_code';
  if (!env.WA_PHONE_ID) return 'no_wa_phone_id';
  if (!env.WA_TOKEN && !truthy(env.WA_DRY_RUN)) return 'no_wa_token';
  return '';
}

/* ---------------------------------------------------------------- handler */

export async function onRequestPost({ request, env }) {
  /* The signature covers the bytes as sent, so the body is read as text and
     only parsed afterwards. */
  const rawBody = await request.text();

  if (env.TT_WEBHOOK_SECRET) {
    const v = await verify(request, rawBody, env.TT_WEBHOOK_SECRET);
    if (!v.ok) {
      console.error('tt-order rejected:', v.reason);
      return json(401, { ok: false, error: v.reason });
    }
  } else {
    /* Deliberately not fatal, so the webhook can be pointed here and proved
       before the secret is pasted in. It is not a state to leave it in. */
    console.warn('tt-order: TT_WEBHOOK_SECRET unset, signature NOT verified');
  }

  let body;
  try { body = JSON.parse(rawBody); }
  catch { return json(400, { ok: false, error: 'bad_json' }); }

  /* One flag, one real delivery, one look at the log — rather than a
     console.log someone has to remember to take back out. */
  if (truthy(env.TT_LOG_PAYLOAD)) console.log('tt-order raw payload', rawBody.slice(0, 8000));

  const event = body.event || '';
  const order = body.payload || body.data || body;

  /* Only new orders. Everything else is acknowledged so Ticket Tailor does not
     retry a delivery we are never going to act on. */
  if (event && !/^order\.created$/i.test(event)) {
    return json(200, { ok: true, ignored: event });
  }

  const orderId = String(order.id || '');
  const email = String((order.buyer_details || {}).email || '').trim().toLowerCase();

  if (!orderId || !email) {
    /* Nothing retryable about a payload we cannot read, so this is a 200 with
       a loud log rather than an endless retry loop. */
    console.error('tt-order: unmapped payload. envelope keys=', Object.keys(body),
      'order keys=', Object.keys(order || {}));
    return json(200, { ok: false, error: 'unmapped_payload' });
  }

  if (!env.BREVO_API_KEY || !env.BREVO_BUYERS_LIST_ID) {
    console.error('tt-order: BREVO_API_KEY or BREVO_BUYERS_LIST_ID missing, order', orderId);
    return json(500, { ok: false, error: 'not_configured' });
  }

  const buyersList = Number(env.BREVO_BUYERS_LIST_ID);
  const waitlist = env.BREVO_LIST_ID ? Number(env.BREVO_LIST_ID) : null;
  const kv = env.REFERRALS || null;
  if (!kv) console.warn('tt-order: REFERRALS KV not bound, no referral code and no WhatsApp');

  await ensureAttributes(env);

  const firstName = String((order.buyer_details || {}).first_name || '').trim();
  const lastName = String((order.buyer_details || {}).last_name || '').trim();
  const { total: ticketCount, child: childCount } = countTickets(order);
  /* STILL A GUESS: the logged payload was not read for the order total, so the
     plausible spellings stay until one of them is confirmed. */
  const orderValue = money(pick(order, 'total_paid', 'total', 'subtotal', 'amount'));
  const orderDate = (() => {
    const raw = order.created_at || body.created_at;
    const dt = new Date(typeof raw === 'number' ? raw * 1000 : raw);
    return isNaN(dt) ? new Date().toISOString().slice(0, 10) : dt.toISOString().slice(0, 10);
  })();
  const ref = referralTag(order);
  const campaign = findCampaign(order);
  const optIn = findOptIn(order);
  const waOptIn = findWaOptIn(order);
  const phone = findPhone(order);
  const lang = findLang(order);

  /* Look the contact up first, for three reasons: to skip a delivery we have
     already processed, to add this order to the running totals rather than
     replacing them, and to notice a waitlist signup who has now bought. */
  let existing = null;
  try {
    existing = await getContact(env, email);
  } catch (e) {
    console.error('tt-order: brevo lookup failed', String(e));
    return json(500, { ok: false, error: 'brevo_lookup' });
  }

  const attrs = (existing && existing.attributes) || {};
  const seen = String(attrs.ORDER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

  /* Idempotency. Ticket Tailor retries until it gets a 2xx, so the same order
     will arrive more than once whenever Brevo is slow. The order id is kept on
     the contact and a repeat does not touch the totals — but it still falls
     through to the WhatsApp step, which has an idempotency key of its own, so
     a delivery that reached Brevo and then failed at Meta can still be retried. */
  const duplicate = seen.includes(orderId);
  let phoneDropped = false;

  /* The referral code is the buyer's own, and it is the same code every time,
     so an existing one is reused rather than reissued. */
  let code = String(attrs.REFERRAL_CODE || '').trim().toUpperCase();
  if (kv) {
    try {
      if (!CODE_RE.test(code)) code = await claimCode(kv, email, firstName);
      else await kv.put(codeKey(code), JSON.stringify({
        email, firstname: firstName, createdAt: new Date().toISOString(),
      }));
    } catch (e) {
      console.error('tt-order: referral code failed', String(e));
      code = CODE_RE.test(code) ? code : '';
    }
  }

  if (!duplicate) {
    const inWaitlist = Boolean(waitlist) && Array.isArray(existing && existing.listIds)
      && existing.listIds.includes(waitlist);

    const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const attributes = {
      TICKET_COUNT: num(attrs.TICKET_COUNT) + ticketCount,
      CHILD_COUNT: num(attrs.CHILD_COUNT) + childCount,
      ORDER_VALUE: Math.round((num(attrs.ORDER_VALUE) + orderValue) * 100) / 100,
      ORDER_DATE: orderDate,
      MARKETING_OPTIN: optIn,
      WA_OPTIN: waOptIn,
      LANG: lang,
      TICKET_ID: orderId,
      /* Capped: Brevo text attributes are not a log, and a buyer with more than
         twenty orders is a data problem rather than a customer. */
      ORDER_IDS: [...seen, orderId].slice(-20).join(','),
    };
    if (firstName) attributes.FIRSTNAME = firstName;
    if (lastName) attributes.LASTNAME = lastName;
    /* A channel tag is filed as the channel it names, with the tag itself as
       the campaign, so Brevo can segment on "came from Instagram" and on
       which post. Anything else is recorded as it arrived. */
    const channel = channelOf(ref);
    if (channel) {
      attributes.UTM_SOURCE = channel;
      attributes.UTM_CAMPAIGN = ref;
    } else if (ref) {
      attributes.UTM_SOURCE = ref;
    }
    if (code) attributes.REFERRAL_CODE = code;
    /* SMS and WHATSAPP are the same number. Brevo keeps them apart because one
       is billed per message and the other is a channel identity. */
    if (phone) { attributes.SMS = phone; attributes.WHATSAPP = phone; }
    /* Only ever set to true, and only for someone who was already waiting. It is
       a fact about them, not a flag to toggle off later. */
    if (inWaitlist) attributes.CONVERTED = true;

    /* updateEnabled upserts, and listIds only adds. The waitlist membership is
       left exactly as it was: someone who bought is still someone who waited. */
    let res;
    try {
      res = await upsertContact(env, email, attributes, [buyersList]);
    } catch (e) {
      console.error('tt-order: brevo upsert threw', String(e), 'order', orderId);
      return json(500, { ok: false, error: 'brevo_upsert' });
    }
    phoneDropped = Boolean(res.droppedPhone);
    if (res.droppedPhone) {
      console.warn('tt-order: contact written WITHOUT the phone for', email,
        'order', orderId, '— Brevo said', res.why);
    }
    if (!res.ok) {
      console.error('tt-order: brevo upsert failed', res.status, res.detail, 'order', orderId);
      /* 500 so Ticket Tailor retries. The order id is only recorded as part of a
         successful write, so the retry is not treated as a duplicate. */
      return json(500, { ok: false, error: 'brevo_upsert' });
    }

    /* Everyone else named on the order. Separate contacts, no WhatsApp, and
       MARKETING_OPTIN inherited from whoever paid — one order, one consent. */
    for (const a of findAttendees(order, email)) {
      const r = await upsertContact(env, a.email, {
        ...(a.firstName ? { FIRSTNAME: a.firstName } : {}),
        ...(a.lastName ? { LASTNAME: a.lastName } : {}),
        MARKETING_OPTIN: optIn,
        WA_OPTIN: false,
        LANG: lang,
        TICKET_ID: a.ticketId || orderId,
      }, [buyersList]);
      if (!r.ok) console.error('tt-order: attendee upsert failed', a.email, r.status, r.detail);
    }

    if (kv && campaign) {
      try {
        const credit = await creditReferrer(env, kv, campaign, email, ticketCount - childCount);
        if (credit) console.log('tt-order referral credit', credit.code, '->', credit.email,
          '+' + credit.credited, '=', credit.total);
      } catch (e) {
        console.error('tt-order: referral credit threw', String(e));
      }
    }
  }

  /* The WhatsApp. Everything above has already been written, so from here on
     nothing is allowed to change the response Ticket Tailor gets. */
  const blocked = waBlocker(env, { kv, waOptIn, phone, code });
  let wa = { sent: false, reason: blocked };
  if (!blocked) {
    try {
      wa = await sendWelcome(env, kv, { orderId, phone, firstName, code });
    } catch (e) {
      console.error('wa send threw', orderId, String(e));
      wa = { sent: false, reason: 'threw' };
    }
  }
  /* A no that came from an empty question list is a parsing failure, not a
     refusal, and the two used to look identical in the log. Print what the
     buyer was actually asked so the next time the payload moves it is one
     glance rather than another live order. */
  if (blocked === 'no_optin') {
    console.log('wa skipped: no_optin', orderId,
      'questions asked:', JSON.stringify(questions(order).map(q => q.label)));
  }

  /* Keys only when there is something in them — a response full of nulls is
     harder to read than a short one. */
  const whatsapp = { sent: wa.sent };
  if (!wa.sent) whatsapp.reason = wa.reason;
  if (wa.to) whatsapp.to = wa.to;
  if (wa.messageId) whatsapp.message_id = wa.messageId;
  if (wa.status) whatsapp.status = wa.status;
  if (wa.error) whatsapp.error = wa.error;
  if (wa.template) whatsapp.template = wa.template;
  if (wa.fellBack) whatsapp.fell_back = true;
  if (wa.preview) whatsapp.preview = wa.preview;

  console.log('tt-order ok', orderId, email, 'tickets', ticketCount,
    'child', childCount, 'value', orderValue, 'ref', ref || '-',
    'code', code || '-', 'wa', wa.sent ? 'sent' : `skipped:${wa.reason}`,
    duplicate ? 'duplicate' : '');
  return json(200, {
    ok: true, order_id: orderId, duplicate,
    tickets: ticketCount, children: childCount, value: orderValue,
    referral_code: code || null,
    phone_dropped: phoneDropped,
    /* The whole WhatsApp outcome, so a replay never has to go to the log
       stream: whether it went, why it did not, the number it was addressed to,
       Meta's message id, and Meta's own error body when it refused. */
    whatsapp,
  });
}

export const onRequestGet = () => json(405, { ok: false, error: 'method_not_allowed' });

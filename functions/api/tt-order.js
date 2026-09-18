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
 * NOTE ON FIELD NAMES. Ticket Tailor's docs render their schema client side,
 * so the order field names below could not be read from the published spec and
 * are matched defensively across the plausible spellings. Set TT_LOG_PAYLOAD
 * on one real delivery, read the keys out of the Cloudflare log, and tighten
 * pick() once rather than guessing twice.
 */

import {
  json, pick, truthy, isEmail, normalisePhone, referralCode, CODE_RE,
  getContact, ensureAttributes, upsertContact,
} from './_shared.js';

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

/* Ticket Tailor returns money in minor units as a string, so "1000" is ten
   euros. A value that already carries a decimal point is taken at face value.
   Both are logged on the first order so the assumption can be checked against
   a real one rather than trusted. */
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

function countTickets(order) {
  const lines = pick(order, 'line_items', 'issued_tickets', 'tickets', 'items') || [];
  let total = 0, child = 0;
  for (const li of Array.isArray(lines) ? lines : []) {
    const qty = Number(pick(li, 'quantity', 'qty') ?? 1) || 1;
    const name = String(pick(li, 'description', 'ticket_type.name', 'name', 'ticket_type') || '');
    const price = money(pick(li, 'total', 'price', 'total_paid', 'amount'));
    total += qty;
    if (CHILD_RE.test(name) || price === 0) child += qty;
  }
  return { total, child };
}

/** The order's custom question answers, as [{label, answer}]. */
function questions(order) {
  const qs = pick(order, 'custom_questions', 'questions', 'answers') || [];
  return (Array.isArray(qs) ? qs : []).map(q => ({
    label: String(pick(q, 'question', 'label', 'name') || ''),
    answer: pick(q, 'answer', 'value', 'response'),
  }));
}

/* The campaign origin. The widget is given data-inline-ref, which Ticket
   Tailor carries on the order; the spelling varies by integration so several
   are tried, including the custom question answers. */
function findRef(order) {
  const direct = pick(order, 'referral', 'ref', 'referrer', 'meta_data.ref',
    'metadata.ref', 'meta.ref', 'utm_source', 'meta_data.utm_source');
  if (direct) return String(direct).slice(0, 120);
  for (const { label, answer } of questions(order)) {
    if (/ref|utm|source|how did you hear/i.test(label) && answer) {
      return String(answer).slice(0, 120);
    }
  }
  return '';
}

/**
 * The referral code this order came in on, if any.
 *
 * /r/<CODE> sends buyers to the box office with both ?ref=<CODE> and
 * ?utm_campaign=<CODE>, because the site's own checkout only ever passed
 * utm_source through to Ticket Tailor — utm_campaign reaching the order is not
 * something we can assume. Whichever of the two survives, the code is a
 * six-character string out of a known alphabet, so anything that is not one is
 * some other campaign tag and is ignored.
 */
function findCampaign(order) {
  const candidates = [
    pick(order, 'utm_campaign', 'meta_data.utm_campaign', 'metadata.utm_campaign',
      'meta.utm_campaign'),
    pick(order, 'referral', 'ref', 'meta_data.ref', 'metadata.ref'),
  ];
  for (const { label, answer } of questions(order)) {
    if (/campaign|utm/i.test(label)) candidates.push(answer);
  }
  for (const c of candidates) {
    const code = String(c || '').trim().toUpperCase();
    if (CODE_RE.test(code)) return code;
  }
  return '';
}

/* Marketing consent. Absent means false: an unanswered question is not
   consent, and treating it as one would put non-consenting buyers on a
   marketing list. The live question reads "Send me news about Art India", so
   plain "news" is matched as well as the newsletter wording. */
function findOptIn(order) {
  const direct = pick(order, 'marketing_opt_in', 'opt_in', 'marketing_consent',
    'buyer_details.marketing_opt_in', 'accepts_marketing');
  if (direct !== undefined) return truthy(direct);
  for (const { label, answer } of questions(order)) {
    if (/marketing|newsletter|news|updates|mailing|opt.?in|nieuws|actualit/i.test(label)) {
      return truthy(answer);
    }
  }
  return false;
}

/* WhatsApp consent, asked at checkout as the lucky draw question. Same rule as
   above: unanswered is no. This is the flag that decides whether we are allowed
   to message someone, so it is never inferred from anything but the answer. */
function findWaOptIn(order) {
  for (const { label, answer } of questions(order)) {
    if (/lucky\s*draw|whatsapp|tirage|loterij|trekking/i.test(label)) return truthy(answer);
  }
  return false;
}

function findPhone(order) {
  const raw = pick(order, 'buyer_details.phone', 'buyer_details.mobile',
    'buyer_details.phone_number', 'phone', 'mobile', 'phone_number',
    'buyer.phone', 'buyer.mobile');
  if (raw) return normalisePhone(raw);
  for (const { label, answer } of questions(order)) {
    if (/phone|mobile|whatsapp|gsm|t[ée]l|nummer/i.test(label) && answer) {
      const p = normalisePhone(answer);
      if (p) return p;
    }
  }
  return '';
}

const LANGS = ['en', 'fr', 'nl'];

/* Checkout language, when Ticket Tailor gives us one. Only stored, never acted
   on in phase 1 — the welcome template is English for everyone — but storing it
   now is what makes the FR and NL templates a one-line change later. */
function findLang(order) {
  const raw = String(pick(order, 'locale', 'language', 'lang',
    'buyer_details.locale', 'buyer_details.language', 'meta_data.lang') || '')
    .trim().toLowerCase().slice(0, 2);
  return LANGS.includes(raw) ? raw : 'en';
}

/**
 * Everyone named on a ticket who is not the buyer and gave their own address.
 * They go on the buyers list so they get the practical emails, but they never
 * get a WhatsApp: the opt-in question was answered by whoever paid, and it was
 * answered about themselves.
 */
function findAttendees(order, buyerEmail) {
  const lines = pick(order, 'issued_tickets', 'line_items', 'tickets') || [];
  const out = new Map();
  for (const t of Array.isArray(lines) ? lines : []) {
    const email = String(pick(t, 'email', 'attendee.email', 'buyer_details.email') || '')
      .trim().toLowerCase();
    if (!isEmail(email) || email === buyerEmail || out.has(email)) continue;
    out.set(email, {
      email,
      firstName: String(pick(t, 'first_name', 'attendee.first_name', 'full_name') || '').trim(),
      lastName: String(pick(t, 'last_name', 'attendee.last_name') || '').trim(),
      ticketId: String(pick(t, 'id', 'barcode', 'ticket_id', 'reference') || '').trim(),
    });
  }
  return [...out.values()];
}

/* ------------------------------------------------------------- referrals */

const codeKey = code => `code:${code}`;
const orderKey = id => `order:${id}`;

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
  return { email: entry.email, code, credited: adults, total: after };
}

/* ------------------------------------------------------------- whatsapp */

const WA_API = 'https://graph.facebook.com/v21.0';

/**
 * The approved welcome template, with the buyer's first name and their own
 * referral link in the body.
 *
 * Best effort, always. A WhatsApp that does not go out is a missed nudge; a
 * webhook that 500s because Meta was slow is an order Ticket Tailor keeps
 * redelivering, so every failure here is logged and swallowed.
 */
async function sendWelcome(env, kv, { orderId, phone, firstName, code }) {
  const already = await kv.get(orderKey(orderId));
  if (already) return { sent: false, reason: 'already_sent' };

  const payload = {
    messaging_product: 'whatsapp',
    to: phone.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: 'diwali_welcome_en',
      language: { code: 'en' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: firstName || 'there' },
          { type: 'text', text: `https://diwali.artindia.be/r/${code}` },
        ],
      }],
    },
  };

  if (truthy(env.WA_DRY_RUN)) {
    /* Nothing is written to KV on a dry run, so the same order can be replayed
       as often as it takes to get the mapping right. */
    console.log('wa dry-run', orderId, JSON.stringify(payload));
    return { sent: false, reason: 'dry_run' };
  }

  const res = await fetch(`${WA_API}/${env.WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.WA_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  if (!res.ok) {
    console.error('wa send failed', orderId, res.status, body);
    return { sent: false, reason: 'send_failed' };
  }

  let messageId = '';
  /* An accepted send with a body we cannot read still happened, so the order is
     claimed either way — an empty message id only costs us the status match. */
  try { messageId = (JSON.parse(body).messages || [])[0]?.id || ''; } catch { /* ignored */ }
  await kv.put(orderKey(orderId), JSON.stringify({
    sentAt: new Date().toISOString(), waMessageId: messageId,
  }));
  console.log('wa sent', orderId, messageId);
  return { sent: true, messageId };
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

  const orderId = String(pick(order, 'id', 'order_id', 'reference') || body.id || '');
  const email = String(pick(order, 'buyer_details.email', 'email', 'buyer.email') || '')
    .trim().toLowerCase();

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

  const firstName = String(pick(order, 'buyer_details.first_name', 'first_name',
    'buyer.first_name') || '').trim();
  const lastName = String(pick(order, 'buyer_details.last_name', 'last_name',
    'buyer.last_name') || '').trim();
  const { total: ticketCount, child: childCount } = countTickets(order);
  const orderValue = money(pick(order, 'total_paid', 'total', 'subtotal', 'amount'));
  const orderDate = (() => {
    const raw = pick(order, 'created_at', 'created', 'date') || body.created_at;
    const dt = new Date(typeof raw === 'number' ? raw * 1000 : raw);
    return isNaN(dt) ? new Date().toISOString().slice(0, 10) : dt.toISOString().slice(0, 10);
  })();
  const ref = findRef(order);
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
    if (ref) attributes.UTM_SOURCE = ref;
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
  let wa = { sent: false, reason: 'not_eligible' };
  if (kv && waOptIn && phone && code && env.WA_PHONE_ID && (env.WA_TOKEN || truthy(env.WA_DRY_RUN))) {
    try {
      wa = await sendWelcome(env, kv, { orderId, phone, firstName, code });
    } catch (e) {
      console.error('wa send threw', orderId, String(e));
      wa = { sent: false, reason: 'threw' };
    }
  }

  console.log('tt-order ok', orderId, email, 'tickets', ticketCount,
    'child', childCount, 'value', orderValue, 'ref', ref || '-',
    'code', code || '-', 'wa', wa.sent ? 'sent' : wa.reason,
    duplicate ? 'duplicate' : '');
  return json(200, {
    ok: true, order_id: orderId, duplicate,
    tickets: ticketCount, children: childCount, value: orderValue,
    referral_code: code || null, whatsapp: wa.sent,
  });
}

export const onRequestGet = () => json(405, { ok: false, error: 'method_not_allowed' });

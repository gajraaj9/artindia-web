/**
 * POST /api/tt-order   Ticket Tailor order.created  ->  Brevo
 *
 * Ticket Tailor posts every new order here. We turn it into a Brevo contact on
 * the buyers list, carrying how many tickets they bought, what they paid, and
 * which campaign sent them.
 *
 * Set these in Cloudflare -> Workers & Pages -> the project -> Settings ->
 * Variables and Secrets:
 *
 *   TT_WEBHOOK_SECRET      secret, from Ticket Tailor -> Settings -> API ->
 *                          Webhooks. Without it signatures are NOT checked and
 *                          anyone who finds this URL can write to your list.
 *   BREVO_API_KEY          secret, already set for /api/register
 *   BREVO_BUYERS_LIST_ID   numeric id of "Diwali 2026 Buyers"
 *   BREVO_LIST_ID          the waitlist, already set. Used only to spot a
 *                          waitlist signup who has now bought.
 *
 * Envelope, per Ticket Tailor's webhook docs:
 *   { id, created_at, event, resource_url, payload }
 * where payload is the order.
 *
 * NOTE ON FIELD NAMES. Ticket Tailor's docs render their schema client side,
 * so the order field names below could not be read from the published spec and
 * are matched defensively across the plausible spellings. The first real
 * delivery logs the payload's top level keys (see UNMAPPED below); read them
 * out of the Cloudflare log and tighten pick() once, rather than guessing
 * twice.
 */

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

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

/** First present value among several candidate paths. */
function pick(obj, ...paths) {
  for (const p of paths) {
    let v = obj;
    for (const k of p.split('.')) v = v == null ? undefined : v[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

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
   flag, so it comes down to what the ticket type is called; the site sells
   "Children under 12" and the French box office would say "enfants". A free
   line counts too, since the child ticket is the only free one. */
const CHILD_RE = /child|children|enfant|kid|under\s*12|moins\s*de\s*12/i;

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

/* The campaign origin. The widget is given data-inline-ref, which Ticket
   Tailor carries on the order; the spelling varies by integration so several
   are tried, including the custom question answers. */
function findRef(order) {
  const direct = pick(order, 'referral', 'ref', 'referrer', 'meta_data.ref',
    'metadata.ref', 'meta.ref', 'utm_source', 'meta_data.utm_source');
  if (direct) return String(direct).slice(0, 120);
  const qs = pick(order, 'custom_questions', 'questions', 'answers') || [];
  for (const q of Array.isArray(qs) ? qs : []) {
    const label = String(pick(q, 'question', 'label', 'name') || '');
    if (/ref|utm|source|how did you hear/i.test(label)) {
      const a = pick(q, 'answer', 'value', 'response');
      if (a) return String(a).slice(0, 120);
    }
  }
  return '';
}

/* Marketing consent. Absent means false: an unanswered question is not
   consent, and treating it as one would put non-consenting buyers on a
   marketing list. */
function findOptIn(order) {
  const direct = pick(order, 'marketing_opt_in', 'opt_in', 'marketing_consent',
    'buyer_details.marketing_opt_in', 'accepts_marketing');
  if (direct !== undefined) return truthy(direct);
  const qs = pick(order, 'custom_questions', 'questions', 'answers') || [];
  for (const q of Array.isArray(qs) ? qs : []) {
    const label = String(pick(q, 'question', 'label', 'name') || '');
    if (/marketing|newsletter|updates|mailing|opt.?in/i.test(label)) {
      return truthy(pick(q, 'answer', 'value', 'response'));
    }
  }
  return false;
}

const truthy = v =>
  v === true || /^(true|yes|y|1|on|oui)$/i.test(String(v ?? '').trim());

/* ------------------------------------------------------------------ brevo */

const brevo = (env, path, init = {}) =>
  fetch(`https://api.brevo.com/v3${path}`, {
    ...init,
    headers: {
      'api-key': env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers || {}),
    },
  });

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
  const optIn = findOptIn(order);

  /* Look the contact up first, for three reasons: to skip a delivery we have
     already processed, to add this order to the running totals rather than
     replacing them, and to notice a waitlist signup who has now bought. */
  let existing = null;
  try {
    const r = await brevo(env, `/contacts/${encodeURIComponent(email)}`);
    if (r.ok) existing = await r.json();
    else if (r.status !== 404) {
      const detail = await r.text();
      console.error('tt-order: brevo lookup failed', r.status, detail);
      return json(500, { ok: false, error: 'brevo_lookup' });
    }
  } catch (e) {
    console.error('tt-order: brevo lookup threw', String(e));
    return json(500, { ok: false, error: 'brevo_lookup' });
  }

  const attrs = (existing && existing.attributes) || {};
  const seen = String(attrs.ORDER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

  /* Idempotency. Ticket Tailor retries until it gets a 2xx, so the same order
     will arrive more than once whenever Brevo is slow. The order id is kept on
     the contact and a repeat is acknowledged without touching the totals. */
  if (seen.includes(orderId)) {
    return json(200, { ok: true, duplicate: true, order_id: orderId });
  }

  const inWaitlist = Boolean(waitlist) && Array.isArray(existing && existing.listIds)
    && existing.listIds.includes(waitlist);

  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const attributes = {
    TICKET_COUNT: num(attrs.TICKET_COUNT) + ticketCount,
    CHILD_COUNT: num(attrs.CHILD_COUNT) + childCount,
    ORDER_VALUE: Math.round((num(attrs.ORDER_VALUE) + orderValue) * 100) / 100,
    ORDER_DATE: orderDate,
    MARKETING_OPTIN: optIn,
    /* Capped: Brevo text attributes are not a log, and a buyer with more than
       twenty orders is a data problem rather than a customer. */
    ORDER_IDS: [...seen, orderId].slice(-20).join(','),
  };
  if (firstName) attributes.FIRSTNAME = firstName;
  if (lastName) attributes.LASTNAME = lastName;
  if (ref) attributes.UTM_SOURCE = ref;
  /* Only ever set to true, and only for someone who was already waiting. It is
     a fact about them, not a flag to toggle off later. */
  if (inWaitlist) attributes.CONVERTED = true;

  /* updateEnabled upserts, and listIds only adds. The waitlist membership is
     left exactly as it was: someone who bought is still someone who waited. */
  let res;
  try {
    res = await brevo(env, '/contacts', {
      method: 'POST',
      body: JSON.stringify({ email, attributes, listIds: [buyersList], updateEnabled: true }),
    });
  } catch (e) {
    console.error('tt-order: brevo upsert threw', String(e), 'order', orderId);
    return json(500, { ok: false, error: 'brevo_upsert' });
  }

  if (!res.ok && res.status !== 204) {
    const detail = await res.text();
    console.error('tt-order: brevo upsert failed', res.status, detail, 'order', orderId);
    /* 500 so Ticket Tailor retries. The order id is only recorded as part of a
       successful write, so the retry is not treated as a duplicate. */
    return json(500, { ok: false, error: 'brevo_upsert' });
  }

  console.log('tt-order ok', orderId, email, 'tickets', ticketCount,
    'child', childCount, 'value', orderValue, 'ref', ref || '-',
    inWaitlist ? 'converted' : '');
  return json(200, {
    ok: true, order_id: orderId,
    tickets: ticketCount, children: childCount, value: orderValue,
    converted: inWaitlist,
  });
}

export const onRequestGet = () => json(405, { ok: false, error: 'method_not_allowed' });

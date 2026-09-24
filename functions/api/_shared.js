/**
 * Shared helpers for the buyer enrolment functions.
 *
 * Underscore-prefixed, so Pages treats it as a module to import rather than a
 * route to serve. It is imported by /api/tt-order, /api/wa-webhook and
 * /r/[code]; nothing in here reads the request, so everything below is a pure
 * function or a thin wrapper around one HTTP call.
 *
 * The phone and referral-code logic lives here rather than in the webhook
 * because two functions have to agree on it: tt-order writes the number onto
 * the contact, wa-webhook looks the contact up by that number when a STOP
 * arrives. If the two normalised differently, an opt-out would silently fail
 * to find anyone.
 */

export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** First present value among several candidate paths. */
export function pick(obj, ...paths) {
  for (const p of paths) {
    let v = obj;
    for (const k of p.split('.')) v = v == null ? undefined : v[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export const truthy = v =>
  v === true || /^(true|yes|y|1|on|oui|ja)$/i.test(String(v ?? '').trim());

export const isEmail = v =>
  /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(v || '')) && String(v).length <= 254;

/* ------------------------------------------------------------------ phones */

/* Country codes after which a leading 0 is a national trunk prefix and must be
   dropped, so that "+32 (0)490 …" and "0490 …" land on the same E.164 number.
   Italy is deliberately absent: +39 06 is a correct Rome landline and stripping
   that zero would break the number. Longest first, so 353 is tested before 35
   would be if one were ever added. */
const TRUNK_ZERO_CC = ['353', '32', '33', '31', '49', '44', '41', '43', '46'];

/**
 * A phone number as typed by a human, in E.164.
 *
 * Belgian by default because that is who buys these tickets, but anything
 * written internationally keeps its own country: a French mobile stays +33.
 * Returns '' when the result is not a plausible E.164 number, and the callers
 * treat '' as "no number" rather than sending to it.
 */
export function normalisePhone(raw, defaultCc = '32') {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';

  /* A leading + is the only punctuation that carries meaning. Everything else
     goes, including the bracketed trunk zero Belgians write as +32 (0)490. */
  const international = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';

  let e164;
  if (international) e164 = digits;
  else if (digits.startsWith('00')) e164 = digits.slice(2);
  else if (digits.startsWith('0')) e164 = defaultCc + digits.slice(1);
  else if (digits.startsWith(defaultCc)) e164 = digits;
  /* No +, no 00, no trunk 0: a national number with the zero left off. */
  else e164 = defaultCc + digits;

  for (const cc of TRUNK_ZERO_CC) {
    if (e164.startsWith(cc) && e164[cc.length] === '0') {
      e164 = cc + e164.slice(cc.length + 1);
      break;
    }
  }

  const out = '+' + e164;
  return /^\+[1-9]\d{7,14}$/.test(out) ? out : '';
}

/* --------------------------------------------------------- referral codes */

/* Base32 with the four characters that get misread out loud or in print
   removed: 0/O and 1/I. Exactly 32 long, so one byte masked to 5 bits picks a
   character with no modulo bias. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

/**
 * The referral code for an address. Derived from the address rather than
 * random, so the same buyer gets the same code every time without us having to
 * have stored it — a second order, or a KV wipe, still resolves to one code.
 *
 * `attempt` is only for the caller to walk past a collision with a different
 * address; see claimCode in tt-order.
 */
export async function referralCode(email, attempt = 0) {
  const seed = String(email).trim().toLowerCase() + (attempt ? '#' + attempt : '');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const bytes = new Uint8Array(buf);
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] & 31];
  return code;
}

/* --------------------------------------------------------------- kv keys */

/* One shape, one place. tt-order writes code: and order:, wa-webhook writes
   status:, and wa-status reads all three — a key format that drifted between
   them would fail by finding nothing, which is the hardest kind to notice. */
export const codeKey = code => `code:${code}`;
export const orderKey = id => `order:${id}`;
export const statusKey = wamid => `status:${wamid}`;
/* How many paid adult tickets came in on someone's referral link. Kept beside
   Brevo's REFERRED_BY so the WhatsApp bot can answer "my chances" from KV
   rather than calling Brevo on every button tap. */
export const refcountKey = code => `refcount:${code}`;

/* Delivery reports are operational, not a record we owe anyone. Ninety days
   covers the festival and the weeks either side of it, and then they age out
   rather than growing without limit. */
export const STATUS_TTL_SECONDS = 90 * 24 * 60 * 60;

/* Workers has no timingSafeEqual. Compare every byte regardless of mismatch so
   the duration of the comparison says nothing about how much was right. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Every key under a prefix, following the cursor to the end. */
export async function listAll(kv, prefix, cap = 1000) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) keys.push(k.name);
    cursor = page.list_complete || keys.length >= cap ? null : page.cursor;
  } while (cursor);
  return keys.slice(0, cap);
}

/* --------------------------------------------------------------- clicks */

export const BOX_OFFICE = 'https://tickets.artindia.be/events/artindia/2392534';

/* Coarse on purpose. A bucket is enough to see that the phones convert
   differently from the desktops; anything finer is fingerprinting. */
export function deviceOf(ua) {
  const s = String(ua || '');
  if (/\b(iPad|Tablet)\b/i.test(s)) return 'tablet';
  if (/\b(Mobi|Android|iPhone|iPod)\b/i.test(s)) return 'mobile';
  if (!s) return 'unknown';
  return 'desktop';
}

/* Tag classes, so an order can be read back as "came from the site" without
   re-parsing every possible tag shape twice. */
export function tagClass(ref) {
  const r = String(ref || '').trim();
  if (!r) return 'untagged';
  if (/^site-/i.test(r)) return 'site';
  if (/^ig-/i.test(r)) return 'ig';
  if (/^(vb|fb|metro|wa|qr)$/i.test(r)) return r.toLowerCase();
  if (/^[A-HJ-NP-Z2-9]{6}$/i.test(r)) return 'referral';
  return 'other';
}

export const clicksKey = (day, cta, lang, source) =>
  `clicks:${day}:${cta}:${lang}:${source || 'direct'}`;
export const ordersKey = (day, cls) => `orders:${day}:${cls}`;

/* Ninety days: long enough to read a campaign after the festival, short
   enough that the namespace does not grow for ever. */
const COUNT_TTL = 90 * 24 * 60 * 60;

async function bumpCounter(kv, key) {
  /* Read then write, so two clicks in the same instant can lose one. At this
     volume that is a rounding error on a funnel, and the alternative is a
     lock on the hot path of a redirect somebody is waiting for. */
  const now = Number(await kv.get(key)) || 0;
  await kv.put(key, String(now + 1), { expirationTtl: COUNT_TTL });
}

/**
 * One click on a link that leaves for the box office.
 *
 * Analytics Engine when the dataset is bound, which keeps the whole row and
 * costs nothing to query later. Otherwise daily counters in KV, which is
 * enough for the funnel and needs no binding anyone has to create first.
 *
 * Never throws and never delays the redirect by more than the write: a
 * measurement layer that can break a ticket sale is not worth having.
 */
export async function logClick(env, click) {
  const row = {
    ts: new Date().toISOString(),
    cta: String(click.cta || 'unknown').slice(0, 32),
    lang: String(click.lang || '').slice(0, 5),
    referrer: String(click.referrer || '').slice(0, 300),
    utm_source: String(click.utm_source || '').slice(0, 64),
    utm_medium: String(click.utm_medium || '').slice(0, 64),
    utm_campaign: String(click.utm_campaign || '').slice(0, 64),
    ref: String(click.ref || '').slice(0, 64),
    device: String(click.device || '').slice(0, 16),
    country: String(click.country || '').slice(0, 4),
  };

  const ds = env.DIWALI_CLICKS;
  if (ds && typeof ds.writeDataPoint === 'function') {
    try {
      ds.writeDataPoint({
        indexes: [row.cta],
        blobs: [row.cta, row.lang, row.referrer, row.utm_source, row.utm_medium,
          row.utm_campaign, row.ref, row.device, row.country],
        doubles: [1],
      });
      console.log('click', JSON.stringify(row));
      return 'analytics_engine';
    } catch (e) {
      console.error('logClick: analytics engine write failed', String(e));
    }
  }

  if (!env.REFERRALS) {
    console.warn('logClick: no dataset and no KV, click not counted', row.cta);
    return 'none';
  }
  try {
    await bumpCounter(env.REFERRALS,
      clicksKey(row.ts.slice(0, 10), row.cta, row.lang || 'xx', row.utm_source));
    console.log('click', JSON.stringify(row));
    return 'kv';
  } catch (e) {
    console.error('logClick: kv write failed', String(e));
    return 'none';
  }
}

/** Everything a redirect needs to read off the incoming request. */
export function clickFrom(request, extra = {}) {
  const url = new URL(request.url);
  const q = url.searchParams;
  return {
    cta: q.get('cta') || extra.cta || '',
    lang: q.get('lang') || extra.lang || '',
    referrer: request.headers.get('referer') || '',
    utm_source: q.get('utm_source') || extra.utm_source || '',
    utm_medium: q.get('utm_medium') || extra.utm_medium || '',
    utm_campaign: q.get('utm_campaign') || extra.utm_campaign || '',
    ref: q.get('ref') || extra.ref || '',
    device: deviceOf(request.headers.get('user-agent')),
    country: (request.cf && request.cf.country) || '',
  };
}

/* ------------------------------------------------------------------ brevo */

export const brevo = (env, path, init = {}) =>
  fetch(`https://api.brevo.com/v3${path}`, {
    ...init,
    headers: {
      'api-key': env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers || {}),
    },
  });

/** The contact, or null when Brevo has never heard of them. Throws on anything else. */
export async function getContact(env, identifier, identifierType) {
  const q = identifierType ? `?identifierType=${identifierType}` : '';
  const r = await brevo(env, `/contacts/${encodeURIComponent(identifier)}${q}`);
  if (r.ok) return r.json();
  if (r.status === 404) return null;
  throw new Error(`brevo lookup ${r.status} ${await r.text()}`);
}

/* Brevo drops attributes it has never been told about instead of failing the
   call, so a missing attribute looks exactly like a successful write and the
   value is simply lost. These are created once per isolate on first use. */
const ATTRIBUTES = {
  WA_OPTIN: 'boolean',
  REFERRAL_CODE: 'text',
  REFERRED_BY: 'float',
  LANG: 'text',
  TICKET_ID: 'text',
  MARKETING_OPTIN: 'boolean',
  UTM_SOURCE: 'text',
  UTM_CAMPAIGN: 'text',
};

/* SMS and WHATSAPP are Brevo's own reserved contact fields. Creating them is an
   error, so they are never in the list above. */
let attributesReady = null;

export function ensureAttributes(env) {
  if (attributesReady) return attributesReady;
  attributesReady = (async () => {
    try {
      const r = await brevo(env, '/contacts/attributes');
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const have = new Set(((await r.json()).attributes || []).map(a => String(a.name).toUpperCase()));
      for (const [name, type] of Object.entries(ATTRIBUTES)) {
        if (have.has(name)) continue;
        const c = await brevo(env, `/contacts/attributes/normal/${name}`, {
          method: 'POST',
          body: JSON.stringify({ type }),
        });
        if (c.ok || c.status === 204) console.log('brevo: created attribute', name, type);
        else console.error('brevo: could not create attribute', name, c.status, await c.text());
      }
    } catch (e) {
      /* Not fatal. A missing attribute costs us a field; a thrown webhook
         costs us the order. Retried on the next cold start. */
      console.error('brevo: attribute check failed', String(e));
      attributesReady = null;
    }
  })();
  return attributesReady;
}

/* One POST to /contacts, with the response kept as text so it can be logged
   whatever it turned out to be. */
async function postContact(env, email, attributes, listIds) {
  const res = await brevo(env, '/contacts', {
    method: 'POST',
    body: JSON.stringify({ email, attributes, listIds, updateEnabled: true }),
  });
  const body = await res.text();
  return { ok: res.ok || res.status === 204, status: res.status, body };
}

/* SMS and WHATSAPP are unique across the whole Brevo account. A number that
   already sits on somebody else's contact — a test contact, an earlier order
   under a different address — makes Brevo reject the ENTIRE upsert with
   duplicate_parameter, not just the phone field. That used to be read as
   success, which is how an order could be logged ok while the contact kept its
   old number and none of the other attributes moved. */
const PHONE_CONFLICT = /duplicate_parameter|invalid_parameter/;

/**
 * Upsert. `listIds` only ever adds: nothing here removes anyone from a list.
 *
 * Every response is logged with its status and body. When the phone fields are
 * what Brevo objected to, the write is retried without them so the rest of the
 * attributes still land, and the fallback says so in the log — a contact with
 * the right ticket count and a stale number is worth having; a contact that
 * silently took none of the update is not.
 */
export async function upsertContact(env, email, attributes = {}, listIds) {
  const first = await postContact(env, email, attributes, listIds);
  console.log('brevo upsert', email, first.status, first.body || '(empty body)');
  if (first.ok) return { ok: true, status: first.status };

  const hasPhone = 'SMS' in attributes || 'WHATSAPP' in attributes;

  if (hasPhone && PHONE_CONFLICT.test(first.body)) {
    const { SMS, WHATSAPP, ...withoutPhone } = attributes;
    const retry = await postContact(env, email, withoutPhone, listIds);
    console.warn('brevo upsert: retried without SMS/WHATSAPP for', email,
      '— first attempt', first.status, first.body,
      '— retry', retry.status, retry.body || '(empty body)',
      '— dropped', JSON.stringify({ SMS, WHATSAPP }));
    if (retry.ok) {
      return { ok: true, status: retry.status, droppedPhone: true, why: first.body };
    }
    return { ok: false, status: retry.status, detail: retry.body };
  }

  /* No phone in play: a duplicate here only ever meant "already on the list",
     which is the state we wanted. */
  if (!hasPhone && first.body.includes('duplicate_parameter')) {
    return { ok: true, status: first.status };
  }
  return { ok: false, status: first.status, detail: first.body };
}

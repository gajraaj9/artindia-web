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

/** Upsert. `listIds` only ever adds: nothing here removes anyone from a list. */
export async function upsertContact(env, email, attributes, listIds) {
  const res = await brevo(env, '/contacts', {
    method: 'POST',
    body: JSON.stringify({ email, attributes, listIds, updateEnabled: true }),
  });
  if (res.ok || res.status === 204) return { ok: true };
  const detail = await res.text();
  /* An address already on the list comes back as a 400 duplicate, which from
     our side is the state we wanted. */
  if (detail.includes('duplicate_parameter')) return { ok: true };
  return { ok: false, status: res.status, detail };
}

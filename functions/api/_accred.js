/**
 * Accreditation: everyone who gets a free pass.
 *
 * Underscore-prefixed so Pages treats it as a module rather than a route.
 * Imported by team-form, team-register, team-admin and the WhatsApp bot.
 *
 * Nothing here reads the request. The HTTP shells do that and hand values in,
 * so every function below can be called from a test with a fake KV and a fake
 * fetch and no Request object at all.
 *
 * Personal data lives in the ACCRED namespace and nowhere else, so that the
 * whole module can be exported and then deleted as a block after the festival.
 * A child's date of birth never leaves it: not to Brevo, not to Ticket Tailor,
 * not into a WhatsApp template, an email body or a log line.
 */

import {
  CODE_ALPHABET, listAll, safeEqual, upsertContact, brevo, getContact,
  isEmail, normalisePhone,
} from './_shared.js';
import { TEAMS, COPY } from './_teams.js';

/* ------------------------------------------------------------------- keys */

export const linkKey = t => `link:${t}`;
export const personKey = id => `person:${id}`;
export const phoneKey = e164 => `phone:${e164}`;
export const emailKey = addr => `email:${String(addr).toLowerCase()}`;
export const promoKey = code => `promo:${code}`;
export const plus1Key = t => `plus1:${t}`;
export const teamCfgKey = k => `teamcfg:${k}`;
export const rejectedPhoneKey = e164 => `rejected:phone:${e164}`;
export const rejectedEmailKey = a => `rejected:email:${String(a).toLowerCase()}`;
export const ipKey = (ip, day) => `ipcap:${day}:${ip}`;
export const salesKey = id => `codesales:${id}`;
export const resendKey = (id, step) => `resent:${id}:${step}`;
export const logKey = (ts, n) => `sub:${ts}:${n}`;
export const refusalKey = (ts, n) => `refused:${ts}:${n}`;
export const flagCapKey = (ip, day) => `flagcap:${day}:${ip}`;

/* A day of submits from one address. The cap exists to stop a script, not to
   stop a team lead entering twelve people in a row. */
export const IP_CAP_PER_DAY = 40;
export const SALES_CACHE_SECONDS = 600;

/* Two approvers on the same card, or one finger twice. Twenty seconds is long
   enough that neither sends the same message twice, and short enough that
   somebody who meant it can try again almost at once. */
export const RESEND_LOCK_SECONDS = 20;

/* The submission log. Sixty days covers the whole run-up to the festival, so
   a question in October about a form filled in in August still has an answer.
   The cap keeps the list readable; the TTL keeps it from becoming a record. */
export const LOG_CAP = 600;
export const LOG_TTL_SECONDS = 60 * 24 * 3600;

/* Legacy: the refusal-only list this log grew out of. Entries written before
   the change are still read, and still expire on their own. */
export const REFUSAL_CAP = 200;
export const REFUSAL_TTL_SECONDS = 14 * 24 * 3600;

/* A hidden-field submission is stored now rather than dropped, which means a
   script could fill the queue with them. Five a day from one address: a real
   person tripping over autofill is one, not six. */
export const FLAG_CAP_PER_DAY = 5;

/* ----------------------------------------------------------------- random */

/** n characters from the alphabet the referral codes use. */
export function token(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += CODE_ALPHABET[bytes[i] & 31];
  return out;
}

export const newPersonId = () => `p_${token(16)}`;

/* ------------------------------------------------------------------ teams */

export const teamOf = key => TEAMS.find(t => t.key === key) || null;
export const teamKeys = () => TEAMS.map(t => t.key);

/** The expected number, with the KV override winning over the seed. */
export async function expectedFor(kv, key) {
  const t = teamOf(key);
  if (!t) return 0;
  /* Written by the admin page as `{ expected }`, which is what a later
     override will want room in; a bare number is read too, because that is
     what a hand-written KV value looks like. */
  const raw = await kv.get(teamCfgKey(key));
  let n = NaN;
  if (raw) {
    try { n = Number(JSON.parse(raw).expected); } catch { n = Number(raw); }
    if (!Number.isFinite(n)) n = Number(raw);
  }
  return Number.isFinite(n) && n > 0 ? n : t.expected;
}

/**
 * The Ticket Tailor type id for a team, or null.
 *
 * A team whose id has not been filled in yet cannot be approved, and the queue
 * says so rather than failing at the moment somebody presses the button.
 */
export const ticketTypeFor = (env, key) => {
  const t = teamOf(key);
  return t && env[t.env] ? String(env[t.env]) : null;
};

/* --------------------------------------------------------------- switches */

export const regEnabled = env => String(env.TEAM_REG_ENABLED) === 'true';
export const dryRun = env => String(env.TEAM_DRY_RUN) !== 'false';
export const wallEnabled = env => String(env.WALL_ENABLED) === 'true';

export const closeAt = env =>
  new Date(env.TEAM_CLOSE_AT || '2026-10-18T23:59:00+02:00');

export const registrationClosed = (env, now = new Date()) => now > closeAt(env);

/* The special guests' form. One team (vip) with a form of its own at /guest/,
   switched and closed independently of the team form: the invitations went
   out on their own timetable, and a guest can still register after the
   artists' deadline has passed. */
export const vipEnabled = env => String(env.VIP_REG_ENABLED) === 'true';
export const vipCloseAt = env =>
  new Date(env.VIP_CLOSE_AT || '2026-10-20T23:59:00+02:00');

/** The team behind /guest/, or null. One flag in data/teams.json says which. */
export const isGuestForm = team => Boolean(team && team.guestForm);

/** Is this team's form switched on? The vip form has its own switch. */
export const formEnabledFor = (env, team) =>
  (isGuestForm(team) ? vipEnabled(env) : regEnabled(env));

export const closeAtFor = (env, team) =>
  (isGuestForm(team) ? vipCloseAt(env) : closeAt(env));

export const closedFor = (env, team, now = new Date()) => now > closeAtFor(env, team);

/* A team that has a form at all. Invite-only teams have none, except the one
   whose invitations point at /guest/. */
export const hasForm = team => Boolean(team) && (!team.inviteOnly || isGuestForm(team));

/** The accompanying guest of a special guest, as opposed to the guest themself. */
export const isCompanion = person => Boolean(person && person.vip && person.vip.guestOf);

/** Addresses that may receive real mail while the module is in dry run. */
export function isTestAddress(env, email) {
  const list = String(env.TEAM_TEST_EMAILS || '')
    .split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(email || '').toLowerCase());
}

/* ------------------------------------------------------------ admin token */

/**
 * The approver's name for a token, or null.
 *
 * Every decision is recorded against a person, so the token has to resolve to
 * one. Compared with safeEqual against each in turn rather than by lookup, so
 * the time taken says nothing about which name matched or how much of the
 * token was right.
 */
export function approverFor(env, presented) {
  if (!env.TEAM_ADMIN_TOKENS || !presented) return '';
  let map;
  try { map = JSON.parse(env.TEAM_ADMIN_TOKENS); } catch { return ''; }
  let found = '';
  for (const [name, tok] of Object.entries(map || {})) {
    if (safeEqual(String(tok), String(presented))) found = name;
  }
  return found;
}

/* ----------------------------------------------------------- ticket tailor */

/**
 * One call to the Ticket Tailor API.
 *
 * Both endpoints this module uses take application/x-www-form-urlencoded, not
 * JSON, and authenticate with HTTP Basic using the API key as the username and
 * an empty password. That is what their OpenAPI document says; it is not the
 * shape most APIs use and it is not a guess.
 *
 * Arrays go out as repeated `name[]=value` pairs, which is how PHP style form
 * encoding carries a list and what ticket_types expects.
 */
export async function tt(env, path, { method = 'GET', form = null, query = null, raw = false } = {}) {
  if (!env.TT_API_KEY) throw new Error('TT_API_KEY is not set');
  const url = new URL(`https://api.tickettailor.com${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let body;
  if (form) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach(one => p.append(`${k}[]`, String(one)));
      else p.append(k, typeof v === 'boolean' ? String(v) : String(v));
    }
    body = p.toString();
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      authorization: 'Basic ' + btoa(`${env.TT_API_KEY}:`),
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body } : {}),
  });
  /* `raw` is for the two calls that have to explain a 2xx they could not read.
     Everyone else gets the parsed body and nothing to think about. */

  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* kept as text below */ }
  if (!res.ok) {
    const e = new Error(`ticket tailor ${method} ${path} -> ${res.status} ${ttMessage(parsed, text)}`);
    e.status = res.status;
    e.detail = ttMessage(parsed, text);
    e.where = path;
    throw e;
  }
  return raw ? { status: res.status, body: parsed } : parsed;
}

/**
 * What Ticket Tailor actually said, in words an approver can act on.
 *
 * Their errors come back as `{ errors: [{ message }] }` most of the time and
 * as a bare string the rest of it, so both are read and the raw body is the
 * last resort. Capped at 300 characters: this ends up on a card on a phone.
 *
 * The request is never quoted back, only the response, so there is no path by
 * which the API key or the Authorization header reaches a screen or a record.
 */
export function ttMessage(parsed, text = '') {
  const list = parsed && Array.isArray(parsed.errors) ? parsed.errors : null;
  const words = list
    ? list.map(e => String((e && (e.message || e.description || e.code)) || '')).filter(Boolean).join('; ')
    : String((parsed && (parsed.message || parsed.error)) || '');
  return (words || String(text || '')).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Belt and braces: nothing that looks like a credential leaves this module. */
export const scrubSecret = v => String(v || '')
  .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
  .replace(/\bsk_[A-Za-z0-9_-]{6,}/g, 'sk_[redacted]');

/* POST /v1/issued_tickets answers { data: [ticket] }; POST /v1/discounts
   answers the discount object itself. The asymmetry is theirs, so it is
   absorbed here rather than at every call site. */
/**
 * The one object in a Ticket Tailor response, whichever way they wrapped it.
 *
 * Three shapes are in the wild and we have now met all three:
 *   { data: [ticket] }   the documented issued_tickets 201
 *   { data: ticket }
 *   ticket               a bare object with a top-level id
 *
 * The first live approval failed on the third. The ticket had been created and
 * a credit spent; the reader looked for `data`, found nothing, and reported
 * that Ticket Tailor had returned no id. Anything that costs money on the way
 * in has to be read generously on the way out.
 */
export function oneOf(r) {
  if (!r || typeof r !== 'object') return null;
  if (Array.isArray(r)) return r.find(x => x && x.id) || null;
  if (Array.isArray(r.data)) return r.data.find(x => x && x.id) || null;
  if (r.data && typeof r.data === 'object' && r.data.id) return r.data;
  return r.id ? r : null;
}

/**
 * What came back, for an error message: the status and the names of the
 * top-level keys. Never a value. A response we could not read may still hold
 * somebody's email address or a barcode, and this string ends up on a card,
 * in a log and in a report.
 */
export function describeBody(status, parsed) {
  if (parsed === null || parsed === undefined) return `${status}, no JSON body`;
  if (Array.isArray(parsed)) return `${status}, array of ${parsed.length}`;
  if (typeof parsed !== 'object') return `${status}, a ${typeof parsed}`;
  const keys = Object.keys(parsed);
  return `${status}, keys: ${keys.length ? keys.join(', ') : '(none)'}`;
}

/**
 * An unvoided ticket already issued against this person, or null.
 *
 * The reference is checked here as well as asked for. There used to be a
 * `|| list[0]` behind the match, which meant that if Ticket Tailor ever
 * ignored the filter we would adopt whatever came back first and hand a
 * paying buyer's ticket to a member of the team. A missed adoption costs one
 * spare ticket; a wrong one costs somebody their seat.
 */
export async function findIssuedTicket(env, reference) {
  const r = await tt(env, '/v1/issued_tickets', { query: { reference, status: 'valid' } });
  const list = Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : (oneOf(r) ? [oneOf(r)] : []));
  const mine = list.filter(t => t && String(t.reference || '') === String(reference));
  if (mine.length !== list.length) {
    console.warn('accred: Ticket Tailor returned tickets for another reference, ignored',
      list.length - mine.length);
  }
  return mine.find(t => !t.voided_at) || null;
}

/**
 * The four things we keep off an issued ticket.
 *
 * `qr_code_url` and `barcode_url` are both in the schema's required list, so
 * a real response always carries them and the approved email can show the
 * pass itself rather than promising one. A dry run has neither, and the email
 * then falls back to the barcode text alone.
 */
export const ticketFacts = t => ({
  issuedTicketId: t.id,
  barcode: t.barcode || '',
  qrUrl: t.qr_code_url || t.barcode_url || '',
});

export async function issueTicket(env, { eventId, ticketTypeId, fullName, email, reference }) {
  const r = await tt(env, '/v1/issued_tickets', {
    method: 'POST',
    form: {
      event_id: eventId,
      ticket_type_id: ticketTypeId,
      full_name: fullName,
      email,
      /* Ticket Tailor only actually sends this if the box office is set to use
         separate event confirmation emails and the series is approved by their
         staff. Both are settings on their side, so a true here is a request,
         not a guarantee. It stays on anyway: our own email carries the QR, and
         theirs arriving as well costs nothing. The copy says "may also send it
         to you separately" for exactly that reason. */
      send_email: true,
      reference,
    },
    raw: true,
  });
  const ticket = oneOf(r.body);
  if (!ticket || !ticket.id) throw ttUnreadable('issued ticket', r);
  return ticket;
}

/**
 * A 2xx we could not find an id in.
 *
 * Carries the shape of what came back so the card can say it, and keeps the
 * HTTP status so the queue reads the same as a refusal does.
 */
function ttUnreadable(what, r) {
  const e = new Error(`no ${what} id in the response (${describeBody(r.status, r.body)})`);
  e.status = r.status;
  e.detail = `Ticket Tailor answered without a usable ${what} id. `
    + `It returned ${describeBody(r.status, r.body)}.`;
  return e;
}

export const voidTicket = (env, id) =>
  tt(env, `/v1/issued_tickets/${encodeURIComponent(id)}/void`, { method: 'POST' });

/**
 * A ten percent code for one person.
 *
 * Restricted to the single adult online types in TT_DISCOUNT_TICKET_TYPES: the
 * Family and Friends tickets are already discounted and must never take a
 * second cut.
 */
export async function createDiscount(env, { code, name, ticketTypes, maxRedemptions, expiresUnix }) {
  const r = await tt(env, '/v1/discounts', {
    method: 'POST',
    form: {
      code,
      name,
      type: 'percentage',
      price_percent: 10,
      max_redemptions: maxRedemptions,
      expires: expiresUnix,
      ticket_types: ticketTypes,
    },
    raw: true,
  });
  /* The discounts endpoint answers with the object itself where
     issued_tickets wraps it in an array. Read both, the same way. */
  const discount = oneOf(r.body);
  if (!discount || !discount.id) throw ttUnreadable('discount', r);
  return discount;
}

export const getDiscount = async (env, id) =>
  oneOf(await tt(env, `/v1/discounts/${encodeURIComponent(id)}`));

export const deleteDiscount = (env, id) =>
  tt(env, `/v1/discounts/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const discountTicketTypes = env =>
  String(env.TT_DISCOUNT_TICKET_TYPES || '').split(/[,\s]+/).filter(Boolean);

export const codeExpiryUnix = env =>
  Math.floor(new Date(env.TEAM_CODE_EXPIRES_AT || '2026-10-23T23:59:00+02:00').getTime() / 1000);

/* ------------------------------------------------------------ promo codes */

/**
 * SHREYA-7KQ4: the first name in ASCII capitals so it is recognisably theirs,
 * then four random characters so two Shreyas never collide.
 */
/** Digits only, for the tail of a promo code. */
export function digits(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  /* 250 is the largest multiple of 10 under 256, so anything above it is
     thrown away rather than making 0 to 5 more likely than 6 to 9. */
  for (let i = 0; i < n; i++) {
    let b = bytes[i];
    while (b >= 250) { const one = new Uint8Array(1); crypto.getRandomValues(one); b = one[0]; }
    out += String(b % 10);
  }
  return out;
}

/**
 * The code a person reads out: their own first name and three digits.
 *
 * No dash, because this gets spelled down a phone and typed into a checkout
 * by somebody's aunt. RAVI123 survives that; RAVI-7KQ4 does not.
 */
export function promoCodeFor(firstName, n = 3) {
  const base = String(firstName || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 10) || 'TEAM';
  return `${base}${digits(n)}`;
}

/* Both shapes are live. RAVI123 is what this mints now; SHREYA-7KQ4 is what
   it minted before, and those codes are in people's hands, in Ticket Tailor
   and in Brevo. Anything that asks "is this one of ours" has to say yes to
   both, for as long as a 2026 code can be redeemed. */
export const isTeamCode = v =>
  /^[A-Z]{1,10}[0-9]{3,4}$/.test(String(v || ''))
  || /^[A-Z]{1,10}-[A-Z0-9]{4}$/.test(String(v || ''));

/**
 * A code an approver typed, cleaned up, or '' with a reason.
 *
 * Deliberately stricter than isTeamCode: a person choosing a code by hand gets
 * letters and digits only. The old dashed shape still works everywhere it
 * already exists, but nobody is going to be handed a new one.
 */
export function cleanCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!code) return { ok: false, reason: 'Enter a code.' };
  if (!/^[A-Z0-9]+$/.test(code)) {
    return { ok: false, reason: 'Letters A to Z and digits only, with no spaces or dashes.' };
  }
  if (code.length < 4 || code.length > 16) {
    return { ok: false, reason: 'Between 4 and 16 characters.' };
  }
  return { ok: true, code };
}

/* ------------------------------------------------------------------ people */

export async function getPerson(kv, id) {
  const raw = await kv.get(personKey(id));
  return raw ? JSON.parse(raw) : null;
}

/* How long to wait between attempts at the same key. KV allows about one
   write per second per key, so the first wait clears the usual case. */
const WRITE_WAITS = [1100, 2200, 4000];
const nap = ms => new Promise(r => setTimeout(r, ms));

/**
 * Write a person, and know that it landed.
 *
 * Every write raises `rev`, so a page that is holding an older copy can tell
 * which of two versions is the later one rather than guessing from the order
 * the answers arrived in.
 *
 * KV allows roughly one write per second per key. Two writes in the same
 * millisecond is how four people were approved at 09:04 and two of them
 * stayed at "approving" with every step done: the second write was refused
 * and nobody noticed, because nothing was looking. This throws when the write
 * does not land, so a caller can say so instead of reporting success.
 */
export async function putPerson(kv, p) {
  p.rev = (Number(p.rev) || 0) + 1;
  p.savedAt = new Date().toISOString();
  const body = JSON.stringify(p);

  let last = null;
  for (let attempt = 0; attempt <= WRITE_WAITS.length; attempt++) {
    try {
      await kv.put(personKey(p.id), body);
      if (attempt) console.warn('accred: person write landed on attempt', attempt + 1, p.id);
      return p;
    } catch (e) {
      last = e;
      console.error('accred: person write failed', p.id, 'attempt', attempt + 1,
        String(e.message || e).slice(0, 160));
      if (attempt < WRITE_WAITS.length) await nap(WRITE_WAITS[attempt]);
    }
  }
  /* Put the revision back, so a caller that carries on with this object in
     memory does not think it is newer than what is actually stored. */
  p.rev = Math.max(0, (Number(p.rev) || 1) - 1);
  const err = new Error(`could not save ${p.id}: ${String(last && (last.message || last)).slice(0, 160)}`);
  err.code = 'write_failed';
  throw err;
}

/** Ids already seen for a phone or an email, for the duplicate flags. */
export async function idsFor(kv, key) {
  const raw = await kv.get(key);
  return raw ? JSON.parse(raw) : [];
}

export async function addIdTo(kv, key, id) {
  const ids = await idsFor(kv, key);
  if (!ids.includes(id)) {
    ids.push(id);
    await kv.put(key, JSON.stringify(ids));
  }
  return ids;
}

export async function allPeople(kv, cap = 4000) {
  const keys = await listAll(kv, 'person:', cap);
  const out = [];
  for (const k of keys) {
    const raw = await kv.get(k);
    if (raw) out.push(JSON.parse(raw));
  }
  return out;
}

export async function allLinks(kv, cap = 500) {
  const keys = await listAll(kv, 'link:', cap);
  const out = [];
  for (const k of keys) {
    const raw = await kv.get(k);
    if (raw) out.push({ token: k.slice('link:'.length), ...JSON.parse(raw) });
  }
  return out;
}

/** Age in whole years on the day of the festival. */
export function ageOnFestival(dob, on = '2026-10-24') {
  const d = new Date(`${dob}T00:00:00Z`);
  const f = new Date(`${on}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  let age = f.getUTCFullYear() - d.getUTCFullYear();
  const m = f.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && f.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

export function validDob(dob) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dob || ''))) return false;
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  /* The three selects can make 31 February; the round trip catches it. */
  if (d.toISOString().slice(0, 10) !== dob) return false;
  const age = ageOnFestival(dob);
  return age !== null && age >= 0 && age < 18;
}

/* -------------------------------------------------------------- the strings */

/* Section 9 of the brief lives in data/team-copy.json and is compiled into
   _teams.js by the build, so the form page, the emails and the bot read one
   table. Visitor-facing copy is never assembled from fragments at runtime: a
   string is either in that file or it does not exist. */

export { TEAMS, COPY };

export const say = (key, lang) => (COPY[key] || {})[lang] || (COPY[key] || {}).en || '';

export const LANGS = ['en', 'fr', 'nl'];
export const langOf = v => (LANGS.includes(String(v)) ? String(v) : 'en');

/* ------------------------------------------------------------------ origin */

/* The same list /api/chat uses. A form on a page nobody links to is still a
   form on the open internet, so the only thing allowed to post to it is a
   page on one of our own hosts. */
const ALLOWED_ORIGINS = [
  'https://diwali.artindia.be',
  'https://artindia.be',
  'https://www.artindia.be',
];

export function allowedOrigin(origin) {
  if (!origin) return true;              // same-origin fetches send no Origin
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/* --------------------------------------------------------------- the pass */

/* What the person is told they have. The team name in their own language,
   which is the only description of a pass this module ever makes. */
export const passName = (team, lang) =>
  (team && team.name && (team.name[lang] || team.name.en)) || '';

export const arrivalLine = (team, lang) =>
  (team && team.arrival && (team.arrival[lang] || team.arrival.en)) || '';

/* ---------------------------------------------------------------- the mail */

const SIGNATURE = 'Brussels Diwali Festival, Art India ASBL';

/**
 * One transactional email through Brevo, text only.
 *
 * Returns a plain result rather than throwing: an email that does not go out
 * must not undo a ticket that did.
 */
/* Brevo caps an attachment well above a QR, but a URL that answers with a web
   page instead of an image would still be worth catching before it is posted
   as one. */
const QR_MAX_BYTES = 256 * 1024;

/**
 * The pass as a file, fetched from Ticket Tailor at send time.
 *
 * The inline image is the nice version and the one most people will see. This
 * is the one that survives: a mail client with remote images off shows nothing
 * for an `<img>`, and an attachment is still an attachment. Both, plus the
 * barcode text, so there are three ways to get through the gate.
 *
 * Never throws. A pass somebody can still read off the screen is worth more
 * than an email that did not go out, so a failure here is returned and the
 * send carries on without it.
 */
export async function fetchQrAttachment(url, name) {
  if (!url) return { ok: false, reason: 'no_qr_url' };
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };

    const type = String(res.headers.get('content-type') || '');
    if (type && !/^image\//i.test(type)) return { ok: false, reason: 'not_an_image' };

    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) return { ok: false, reason: 'empty' };
    if (buf.length > QR_MAX_BYTES) return { ok: false, reason: 'too_big' };

    /* btoa wants a binary string, and a QR is small enough to build one in a
       single pass without worrying about the argument limit. */
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return { ok: true, attachment: { name, content: btoa(bin) } };
  } catch (e) {
    console.error('accred qr fetch threw', String(e).slice(0, 160));
    return { ok: false, reason: 'threw' };
  }
}

/** What the file is called once it is sitting in somebody's downloads. */
export const qrFileName = firstName =>
  `Brussels Diwali Festival pass - ${String(firstName || '').trim() || 'guest'}.png`;

/** A line list as plain text: a heading is just its words. */
export const asText = lines => lines
  .filter(l => l !== null && l !== undefined)
  .map(l => (l && typeof l === 'object' && l.h ? l.h : l));

export async function sendMail(env, { to, subject, lines, qr = null, signature = true, replyTo = '' }) {
  const clean = lines.filter(l => l !== null && l !== undefined);
  /* The barcode is printed under the QR in the HTML, so it would read as a
     stray line if it were also in `lines`. The text half has no QR to print it
     under, so it gets it here: whatever strips the HTML, the number that opens
     the gate survives. */
  const flat = asText(clean);
  const text = qr && qr.barcode ? [...flat, '', qr.barcode] : flat;
  const body = [...text, ...(signature ? ['', SIGNATURE] : [])].join('\n');

  /* Fetched now rather than stored on the record: it is a few hundred bytes of
     PNG that only matters for the seconds it takes to post this message. */
  let attached = null;
  let attachmentFailed = '';
  if (qr && qr.url && qr.fileName) {
    const got = await fetchQrAttachment(qr.url, qr.fileName);
    if (got.ok) attached = [got.attachment];
    else attachmentFailed = got.reason;
  }

  try {
    const res = await brevo(env, '/smtp/email', {
      method: 'POST',
      body: JSON.stringify({
        sender: {
          email: env.BREVO_SENDER_EMAIL,
          name: 'Brussels Diwali Festival',
        },
        to: [{ email: to }],
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        subject,
        textContent: body,
        ...(attached ? { attachment: attached } : {}),
        /* Both halves, always. The HTML is what carries the QR; the text is
           what a reader with images off, or a client that refuses HTML, still
           gets, and it names the barcode so a human on the gate can type it. */
        htmlContent: htmlMail(clean, qr, signature),
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      console.error('accred mail failed', res.status, detail);
      return { ok: false, reason: `brevo_${res.status}` };
    }
    if (attachmentFailed) {
      console.warn('accred mail: sent without the QR attachment:', attachmentFailed);
      return { ok: true, attachmentFailed };
    }
    return { ok: true, attached: Boolean(attached) };
  } catch (e) {
    console.error('accred mail threw', String(e));
    return { ok: false, reason: 'threw' };
  }
}

const escHtml = v => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* A bare link becomes a real one. Written against the whole line rather than
   per word so a trailing full stop does not end up inside the href. */
const linkify = line => escHtml(line)
  .replace(/(https?:\/\/[^\s<]+?)([.,;:)]?)(?=\s|$)/g,
    (_, url, tail) => `<a href="${url}" style="color:#b4381f">${url}</a>${tail}`);

/**
 * The email as HTML.
 *
 * Tables and inline styles, because this is email: a mail client is a browser
 * from 2003 with the stylesheet support removed. Nothing here needs to be
 * pretty, it needs to arrive legible in Outlook.
 *
 * The QR block is the point of it. `qr.url` is Ticket Tailor's own image, so
 * a reader with remote images blocked sees the barcode text instead, which is
 * why the text is always printed under the image and never only inside it.
 */
export function htmlMail(lines, qr = null, signature = true) {
  const body = lines.map(l => {
    if (l === '') return '<tr><td style="height:14px"></td></tr>';
    /* A heading, which is a section title in bold and nothing cleverer: a
       mail client is a browser from 2003 and <strong> is the part of it that
       has never been in doubt. */
    if (l && typeof l === 'object' && l.h) {
      return '<tr><td style="padding:6px 0 4px">'
        + `<strong style="font-size:16px">${escHtml(l.h)}</strong></td></tr>`;
    }
    return `<tr><td style="padding:0 0 4px">${linkify(l)}</td></tr>`;
  }).join('');

  const pass = qr && (qr.url || qr.barcode)
    ? `<tr><td style="padding:22px 0 6px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"
          style="border:1px solid #e4ddd3;border-radius:10px"><tr>
          <td align="center" style="padding:18px 22px">
            ${qr.url
              ? `<img src="${escHtml(qr.url)}" width="180" height="180" alt="QR"
                   style="display:block;width:180px;height:180px;border:0">`
              : ''}
            ${qr.barcode
              ? `<div style="padding-top:10px;font:600 15px/1.3 ui-monospace,Menlo,Consolas,monospace;
                   letter-spacing:.08em;color:#1b1714">${escHtml(qr.barcode)}</div>`
              : ''}
          </td></tr></table></td></tr>`
    : '';

  return `<!doctype html><html><body style="margin:0;padding:0;background:#faf7f2">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
  style="background:#faf7f2"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
  style="max-width:520px;background:#ffffff;border-radius:12px;padding:26px 24px;
  font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1714">
${body}${pass}
${signature ? `<tr><td style="height:22px"></td></tr>
<tr><td style="border-top:1px solid #e4ddd3;padding-top:14px;font-size:13px;color:#6b625a">
${escHtml(SIGNATURE)}</td></tr>` : ''}
</table></td></tr></table></body></html>`;
}

/** The link a team member shares: short, and the code is the whole of it. */
export const shareLink = code => `https://diwali.artindia.be/c/${encodeURIComponent(code)}`;

/* A fill-in that leaves nothing behind when there is nothing to put in. */
const fill = (key, lang, vars) => Object.entries(vars)
  .reduce((out, [k, v]) => out.split(`{${k}}`).join(v), say(key, lang));

/**
 * The "we have you" email, sent the moment a form is submitted.
 *
 * The code line only goes to a team that gets a code. Everyone else is told
 * what will happen to them and nothing that will not.
 */
export function receivedMail(person, team) {
  const lang = person.lang;
  const lines = [
    fill('mail_greeting', lang, { FIRST: person.firstName }),
    '',
    say('mail_received_body', lang),
  ];
  if (team && team.promoCode) lines.push('', say('mail_received_code', lang));
  return { to: person.email, subject: say('mail_received_subject', lang), lines };
}

/**
 * Everything after the letter: the pass, the code, the guest, the practical
 * lines. Shared by both approved emails, because the practical half of a
 * message does not change with who it is from.
 */
function practicalLines(env, person, team, { pass = true } = {}) {
  const lang = person.lang;
  const child = person.child ? person.child.firstName : '';
  const lines = [];

  /* Email B says where the QR is in its own opening, so it asks for no pass
     block and does not end up saying it twice. */
  if (pass) {
    lines.push({ h: say('pass_heading', lang) });
    lines.push(person.child
      ? fill('pass_line_child', lang, { CHILD: child })
      : fill('pass_line', lang, { TEAM: passName(team, lang) }));
  }

  if (person.promo && person.promo.code) {
    const code = person.promo.code;
    if (lines.length) lines.push('');
    lines.push({ h: fill('code_heading', lang, { CODE: code }) });
    lines.push(say('code_line', lang));
    lines.push(fill('link_line', lang, { LINK: shareLink(code) }));
  }

  if (person.plus1Token) {
    if (lines.length) lines.push('');
    lines.push({ h: say('guest_heading', lang) });
    lines.push(fill('guest_line', lang, {
      LINK: `https://diwali.artindia.be/team/plus1/?k=${person.plus1Token}`,
    }));
  }

  const arrival = arrivalLine(team, lang);
  if (arrival) lines.push('', arrival);

  if (wallEnabled(env) && person.wallToken && env.WALL_URL) {
    lines.push('', fill('wall_invite', lang, { LINK: `${env.WALL_URL}?k=${person.wallToken}` }));
  }

  if (lines.length) lines.push('');
  lines.push(say('questions', lang));
  return lines;
}

/* Whose letter this person gets, or '' for the practical email. The field is
   per team in data/teams.json, so who gets a letter is Ravi's to change
   without a deploy of anything but the data. */
export const letterOf = team => (team && team.letter) || '';

/**
 * Email A: a letter from Shreya, then the practical part.
 *
 * It opens as a letter and signs as one, and the festival's own sign-off is
 * left off: a letter that ends with a person's name and then an organisation's
 * reads like a form that was pretending.
 */
export function letterMail(env, person, team) {
  const lang = person.lang;
  const kind = letterOf(team);
  const child = person.child ? person.child.firstName : '';

  const lines = [
    fill('mail_greeting', lang, { FIRST: person.firstName }),
    '',
    fill(`letter_${kind}`, lang, { CHILD: child }),
    '',
    kind === 'parent'
      ? fill('letter_close_parent', lang, { CHILD: child })
      : say('letter_close', lang),
    '',
    say('sign_thanks', lang),
    'Shreya',
    say('sign_role', lang),
    '',
    ...practicalLines(env, person, team),
  ];

  return {
    to: person.email,
    subject: fill('mail_a_subject', lang, { FIRST: person.firstName }),
    lines,
    signature: false,
    qr: qrFor(person),
  };
}

/** Email B: the practical one, for the teams with no letter. */
export function practicalMail(env, person, team) {
  const lang = person.lang;
  const lines = [
    fill('mail_greeting', lang, { FIRST: person.firstName }),
    '',
    fill('mail_b_confirm', lang, { TEAM: passName(team, lang) }),
    '',
    say('mail_b_when', lang),
    '',
    ...practicalLines(env, person, team, { pass: false }),
  ];
  return {
    to: person.email,
    subject: say('mail_approved_subject', lang),
    lines,
    qr: qrFor(person),
  };
}

/* Named after whoever the pass is for, which on the child team is the child
   and not the parent reading the email: a mother of three should not end up
   with three files called after herself. */
const qrFor = person => ({
  url: (person.tt && person.tt.qrUrl) || '',
  barcode: (person.tt && person.tt.barcode) || '',
  fileName: qrFileName(person.child ? person.child.firstName : person.firstName),
});

/* ------------------------------------------------- the special guest mails */

/**
 * "Dear Mr Kumar," when a salutation was given, "Dear Anil Kumar," when not.
 *
 * Dutch says "Geachte heer Peeters", not "Geachte de heer Peeters": the
 * article belongs to the salutation on an envelope and not in a greeting.
 */
export function vipGreeting(lang, { salutation = '', firstName = '', lastName = '' } = {}) {
  let sal = String(salutation || '').trim();
  if (lang === 'nl') sal = sal.replace(/^de\s+/i, '');
  const name = sal ? `${sal} ${lastName}` : `${firstName} ${lastName}`;
  return fill('vip_mail_greeting', lang, { NAME: name.trim() });
}

/* Where a special guest writes back to. The sender stays BREVO_SENDER_EMAIL;
   answers go to the guests' own address, which Ravi reads. */
export const GUEST_CONTACT = 'guests@artindia.be';

/** Who a special guest email is written to: the registrant, always. */
const vipAddressee = person => (isCompanion(person) && person.vip.host) || {
  salutation: (person.vip && person.vip.salutation) || '',
  firstName: person.firstName,
  lastName: person.lastName,
};

/** The formal "we have it", one paragraph, for the special guest form. */
export function vipReceivedMail(person) {
  const lang = person.lang;
  return {
    to: person.email,
    subject: say('vip_mail_received_subject', lang),
    replyTo: GUEST_CONTACT,
    lines: [
      vipGreeting(lang, vipAddressee(person)),
      '',
      say('vip_mail_received_body', lang),
      '',
      say('vip_mail_regards', lang),
    ],
  };
}

/**
 * The pass, formally. One per person, each in that person's own name, and
 * every one of them to the registrant's address: the registrant's own pass,
 * and then a second email with their guest's.
 */
export function vipApprovedMail(env, person, team) {
  const lang = person.lang;
  const companion = isCompanion(person);
  const guest = companion
    ? `${person.firstName} ${person.lastName}`
    : (person.vip && person.vip.guestName) || '';

  const lines = [vipGreeting(lang, vipAddressee(person)), ''];
  if (companion) {
    lines.push(fill('vip_mail_guest_pass', lang, { GUEST: guest }));
  } else {
    lines.push(say('vip_mail_approved_body', lang), '', say('vip_mail_pass_own', lang));
    if (guest) lines.push('', fill('vip_mail_guest_follows', lang, { GUEST: guest }));
  }
  const arrival = arrivalLine(team, lang);
  if (arrival) lines.push('', arrival);
  lines.push('', say('vip_mail_look_forward', lang), '', say('vip_mail_questions', lang),
    '', say('vip_mail_regards', lang));

  return {
    to: person.email,
    subject: companion
      ? fill('vip_mail_guest_subject', lang, { GUEST: guest })
      : say('vip_mail_approved_subject', lang),
    replyTo: GUEST_CONTACT,
    lines,
    qr: qrFor(person),
  };
}

/** The one a person actually gets. */
export const approvedMail = (env, person, team) =>
  (team && team.formal ? vipApprovedMail
    : letterOf(team) ? letterMail : practicalMail)(env, person, team);


/* --------------------------------------------------------------- the brevo */

/**
 * The accreditation contact.
 *
 * Section 7. The buyers list is never named here, and no buyer attribute is
 * written: a person who happens to have bought a ticket keeps their buyer
 * record exactly as it was.
 *
 * A child's date of birth is not in this object and must never be added to it.
 */
export function brevoAttributesFor(person, team) {
  const attrs = {
    FIRSTNAME: person.child ? person.firstName : person.firstName,
    LASTNAME: person.lastName,
    LANG: person.lang,
    TEAM: person.team,
    REG_STATUS: person.status,
    ACT_OR_ROLE: person.child
      ? `Parent of ${person.child.firstName}`
      : person.role || '',
    INVITED_BY: person.label || '',
    PROMO_CODE: (person.promo && person.promo.code) || '',
    TT_TICKET_ID: (person.tt && person.tt.issuedTicketId) || '',
    PLUS_ONE_LINK: person.plus1Token
      ? `https://diwali.artindia.be/team/plus1/?k=${person.plus1Token}`
      : '',
  };
  /* The same number on both attributes, the way the buyer flow writes it, so
     one person is one contact however they arrived. */
  if (person.phone) { attrs.SMS = person.phone; attrs.WHATSAPP = person.phone; }
  /* Section 7's VIP attributes, from the special guest form. */
  if (person.vip) {
    attrs.SALUTATION = person.vip.salutation || '';
    attrs.ORGANISATION = person.vip.organisation || '';
    attrs.JOB_TITLE = person.vip.jobTitle || '';
  }
  return attrs;
}

export async function pushToBrevo(env, person, team) {
  const list = env.BREVO_ACCRED_LIST_ID ? [Number(env.BREVO_ACCRED_LIST_ID)] : undefined;
  try {
    const res = await upsertContact(env, person.email, brevoAttributesFor(person, team), list);
    return res.ok ? { ok: true } : { ok: false, reason: `brevo_${res.status}` };
  } catch (e) {
    console.error('accred brevo threw', String(e));
    return { ok: false, reason: 'threw' };
  }
}

/* ------------------------------------------------------------- the whatsapp */

const WA_API = 'https://graph.facebook.com/v21.0';

export const teamTemplate = (env, withCode) => (withCode
  ? env.WA_TEMPLATE_TEAM || 'diwali_team_pass_en'
  : env.WA_TEMPLATE_TEAM_PLAIN || 'diwali_team_pass_plain_en');

/* The one with a button on it, tried first for anybody who has a code. Its
   button URL is https://diwali.artindia.be/c/{{1}} and the code fills the
   placeholder, so the person taps rather than copies. */
export const teamLinkTemplate = env =>
  env.WA_TEMPLATE_TEAM_LINK || 'diwali_team_pass_en_v2';

/* Meta's way of saying "not that template": it does not exist here, it is not
   approved, it is paused, or the parameters do not fit it. Every one of these
   means try the older one rather than leave somebody with no message. The
   same list the buyer welcome falls back on. */
export const TEMPLATE_ERROR_CODES = new Set([
  132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069, 133010,
]);

/**
 * The pass message.
 *
 * Deliberately the same POST, the same message-id capture and the same
 * bot:welcome log entry as the buyer welcome in tt-order, so a delivery report
 * from Meta, which carries only a phone number, lands on this message too and
 * the status shows in /api/wa-status and on the dashboard.
 *
 * Best effort. A WhatsApp that does not arrive is a person who still has a
 * ticket and an email, so every failure is recorded as a step and swallowed.
 */
/** The body parameters both pass templates take, in order. */
const passParams = (person, team) => {
  const code = (person.promo && person.promo.code) || '';
  const out = [{ type: 'text', text: person.firstName || 'there' },
    { type: 'text', text: passName(team, person.lang) }];
  if (code) out.push({ type: 'text', text: code });
  return out;
};

const passPayload = (person, team, name, { button = '' } = {}) => {
  const components = [{ type: 'body', parameters: passParams(person, team) }];
  if (button) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: button }],
    });
  }
  return {
    messaging_product: 'whatsapp',
    to: String(person.phone).replace(/^\+/, ''),
    type: 'template',
    template: { name, language: { code: 'en' }, components },
  };
};

/** One POST to Meta, with the answer read the way the buyer welcome reads it. */
async function postPass(env, payload) {
  const r = await fetch(`${WA_API}/${env.WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.WA_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* kept as text */ }
  return {
    ok: r.ok,
    status: r.status,
    messageId: (parsed?.messages?.[0]?.id) || '',
    error: parsed?.error || text.slice(0, 400),
    code: Number(parsed?.error?.code) || null,
  };
}

export async function sendTeamPass(env, kv, person, team, { log } = {}) {
  const code = (person.promo && person.promo.code) || '';

  /* With a code, the template with a button on it first: a person who taps
     does not retype the code wrong. Without one there is no button to fill,
     so the plain template is the only one. */
  const first = code ? teamLinkTemplate(env) : teamTemplate(env, false);
  const payload = passPayload(person, team, first, { button: code });

  if (dryRun(env)) {
    console.log('accred wa dry-run', person.id, first, JSON.stringify(payload));
    return { ok: true, dry: true, template: first, messageId: `dry_${token(10)}` };
  }
  if (!env.WA_PHONE_ID || !env.WA_TOKEN) return { ok: false, reason: 'no_wa_credentials' };

  let used = first;
  let fellBack = false;
  let res;
  try {
    res = await postPass(env, payload);

    /* The v2 template is not there, not approved, or does not fit. The older
       one has no button and goes out instead: a pass with no button beats no
       pass at all. Logged loudly, because a fallback nobody notices is a v2
       that is quietly never used. */
    if (!res.ok && code && TEMPLATE_ERROR_CODES.has(res.code)) {
      const older = teamTemplate(env, true);
      console.error('accred wa template', first, 'refused with', res.code,
        JSON.stringify(res.error), '- falling back to', older);
      used = older;
      fellBack = true;
      res = await postPass(env, passPayload(person, team, older));
    }
  } catch (e) {
    return { ok: false, reason: 'threw' };
  }

  if (!res.ok) {
    console.error('accred wa failed', person.id, used, res.status, JSON.stringify(res.error));
    return { ok: false, reason: `wa_${res.status}`, template: used };
  }

  if (log) await log(res.messageId, used);
  return { ok: true, messageId: res.messageId, template: used, fellBack };
}

/* ------------------------------------------------------------ the pipeline */

export const LOCK_STALE_MS = 2 * 60 * 1000;
export const STEPS = ['ticket', 'discount', 'brevo', 'email', 'whatsapp'];

const nowIso = () => new Date().toISOString();
const failed = reason => `failed:${scrubSecret(reason)}`;

/* A step that a dry run did not really perform. Said out loud rather than
   recorded as "done", because a dry run that reads like a success is how a
   fake ticket ends up believed. */
export const SKIPPED = 'skipped (dry run)';

/** Anything made up by a dry run, which a live approval must not believe. */
export const isDryId = v => /^dry_/.test(String(v || ''));

/** True when a step still has to run: never run, run and failed, or skipped. */
const todo = (person, step, only, force = false) => {
  if (only && !only.includes(step)) return false;
  if (force && only) return true;          // Resend: run it again anyway
  return person.steps[step] !== 'done';
};

/** When each step last ran. Older records have none, and show blank. */
function markStep(person, step, result) {
  person.steps[step] = result;
  person.stepAt = person.stepAt || {};
  person.stepAt[step] = nowIso();
}

/**
 * Throw away anything a dry run invented, so a live approval starts clean.
 *
 * A record approved while TEAM_DRY_RUN was true holds a ticket id that no
 * box office has ever heard of. Approving it again for real must issue a real
 * ticket, not look at the fake one and decide there is nothing to do.
 */
export async function clearDryResults(kv, person) {
  let changed = false;
  if (person.tt && isDryId(person.tt.issuedTicketId)) {
    person.tt = null;
    person.steps.ticket = null;
    changed = true;
  }
  if (person.promo && isDryId(person.promo.discountId)) {
    if (person.promo.code) await kv.delete(promoKey(person.promo.code));
    person.promo = null;
    person.steps.discount = null;
    changed = true;
  }
  /* Brevo, the email and the WhatsApp leave nothing behind to inspect, so a
     dry run's word for them is all there is, and it is not good enough. */
  for (const step of ['brevo', 'email', 'whatsapp']) {
    if (person.steps[step] === SKIPPED) { person.steps[step] = null; changed = true; }
  }
  return changed;
}

/**
 * Why this person cannot be approved at all, or '' when they can.
 *
 * Checked before the lock, so a team with no ticket type id configured shows
 * one clear line in the queue instead of a locked record and a Ticket Tailor
 * error.
 */
export function approvalBlocker(env, person, team) {
  if (!team) return 'unknown_team';
  if (!env.TT_EVENT_ID) return 'no_tt_event_id';
  if (!ticketTypeFor(env, person.team)) return `no_ticket_type_for_${person.team}`;
  if (!dryRun(env) && !env.TT_API_KEY) return 'no_tt_api_key';
  return '';
}

/**
 * The same thing as a sentence, because the code goes in the record and this
 * goes on the card. A reason an approver cannot act on is not a reason.
 */
export function blockerText(code, team = null) {
  const name = (team && team.name && team.name.en) || 'this team';
  if (/^no_ticket_type_for_/.test(code)) {
    const key = code.replace('no_ticket_type_for_', '');
    return `No ticket type is set for ${name}. Set TT_TYPE_${key.toUpperCase()} in Cloudflare.`;
  }
  return {
    unknown_team: 'This person is on a team that no longer exists.',
    no_tt_event_id: 'TT_EVENT_ID is not set, so there is no event to issue against.',
    no_tt_api_key: 'TT_API_KEY is not set, so nothing can be issued.',
  }[code] || code;
}

/**
 * Which steps still have something to do for this person.
 *
 * A step counts as finished when it says done, or when a dry run said it was
 * skipped, or when the team was never going to have one: the technical crew
 * has no discount code, so an empty discount step is not an unfinished one.
 */
export function stepsOutstanding(person, team) {
  const steps = person.steps || {};
  const out = [];
  for (const name of STEPS) {
    if (name === 'discount' && !(team && team.promoCode)) continue;
    if (name === 'whatsapp' && team && team.whatsapp === false) continue;
    const v = steps[name];
    if (typeof v === 'string' && (v === SKIPPED || v.indexOf('done') === 0)) continue;
    out.push(name);
  }
  return out;
}

/**
 * Finish a record that is already finished.
 *
 * Four people were approved at 09:04 and two of them stayed at "approving"
 * with every step done, because the last write was refused and nothing was
 * looking. The work had happened; only the word for it was missing. This puts
 * the word there and runs nothing again.
 *
 * Returns the healed person, or null when there was nothing to heal.
 */
export async function finishIfDone(env, kv, person, approver = '') {
  if (!person || person.status !== 'approving') return null;
  const team = teamOf(person.team);
  if (!team) return null;
  if (stepsOutstanding(person, team).length) return null;
  if (!(person.tt && person.tt.issuedTicketId)) return null;

  person.status = 'approved';
  person.lockedAt = null;
  /* The approver who started it, if the record remembers one. Otherwise
     whoever is here now, because somebody has to be answerable for it. */
  person.decidedBy = person.decidedBy || approver || 'unknown';
  person.decidedAt = person.decidedAt || nowIso();
  person.healedAt = nowIso();
  try {
    await putPerson(kv, person);
  } catch (e) {
    console.error('accred: could not finish', person.id, String(e.message || e).slice(0, 160));
    return null;
  }
  console.log('accred: finished a record that was already done', person.id);
  return person;
}

/**
 * Issue the pass, then everything that hangs off it.
 *
 * The order is the brief's order and it matters: rule 3 says a person is never
 * marked approved unless Ticket Tailor returned an issued ticket id, so the
 * ticket is first and a failure there stops the whole thing and puts the record
 * back in the queue. Everything after it is a nice-to-have that can be retried
 * on its own; none of it can take the ticket away.
 *
 * `only` retries a subset of steps on an already-approved record.
 */
export async function approve(env, kv, opts) {
  try {
    return await runApproval(env, kv, opts);
  } catch (e) {
    if (e && e.code === 'write_failed') {
      /* Whatever was done has been done; the record does not say so. Calling
         this a success is how somebody comes to believe a pass went out when
         the only honest answer is "try again". */
      console.error('accred: approval could not be saved', String(e.message || e).slice(0, 200));
      const person = await getPerson(kv, opts && opts.id).catch(() => null);
      return {
        ok: false, error: 'write_failed', person,
        detail: 'The work was done but the record could not be saved. '
          + 'Press Approve again: nothing will be sent twice.',
      };
    }
    throw e;
  }
}

async function runApproval(env, kv, { id, approver, only = null, log = null, force = false }) {
  const person = await getPerson(kv, id);
  if (!person) return { ok: false, error: 'unknown_person' };

  const team = teamOf(person.team);
  const retrying = Boolean(only);

  if (!retrying) {
    /* The second click. Whoever gets here first owns the record; everyone else
       is told what it already says. A lock left behind by a request that died
       between the stamp and the ticket is reclaimed after two minutes. */
    if (person.status === 'approving') {
      /* Everything already done, and only the last write missing: finish it
         rather than running anything again. */
      const healed = await finishIfDone(env, kv, person, approver);
      if (healed) return { ok: true, person: healed, healed: true };

      /* A lock older than two minutes belongs to a request that died. It is
         reclaimed whether or not a ticket exists: the per-step guard below is
         what stops anything being done twice, and refusing to reclaim a
         locked record that has a ticket left it stuck for ever. */
      const age = Date.now() - Date.parse(person.lockedAt || 0);
      if (!(age > LOCK_STALE_MS)) {
        return { ok: true, person, skipped: 'in_progress' };
      }
      console.warn('accred: reclaiming a stale lock on', person.id, 'after', Math.round(age / 1000), 's');
    } else if (person.status !== 'pending') {
      return { ok: true, person, skipped: `status_${person.status}` };
    }
  }

  const dryRunNow = dryRun(env);
  /* Live now, and this record remembers a dry run. Nothing it was told then
     is true, so it is forgotten before any step decides it has been done. */
  if (!dryRunNow) await clearDryResults(kv, person);

  const blocked = approvalBlocker(env, person, team);
  if (blocked) {
    const detail = blockerText(blocked, team);
    markStep(person, 'ticket', failed(detail));
    person.ttError = { where: 'setup', status: 0, detail, at: nowIso() };
    person.status = 'pending';
    person.lockedAt = null;
    await putPerson(kv, person);
    return { ok: false, error: blocked, detail, person };
  }

  if (!retrying) {
    person.status = 'approving';
    person.lockedAt = nowIso();
    await putPerson(kv, person);
  }

  const dry = dryRunNow;
  /* On a dry run Brevo and the email are the two steps that reach a real
     person, so they run only for an address Ravi has listed as his own. */
  const mayReachOut = !dry || isTestAddress(env, person.email);

  /* 2. The ticket. The child's own name is on the child's pass; the parent is
        only the contact. The date of birth is not sent. */
  if (todo(person, 'ticket', only, force)) {
    const fullName = person.child
      ? `${person.child.firstName} ${person.child.lastName}`.trim()
      : `${person.firstName} ${person.lastName}`.trim();
    try {
      if (dry) {
        /* No QR on a dry run: Ticket Tailor is the only thing that can make
           one, and nothing was asked of it. The email shows the barcode text
           alone, which is what a missing image looks like in the real thing. */
        person.tt = { issuedTicketId: `dry_tkt_${token(10)}`, barcode: `dry_${token(8)}`, qrUrl: '' };
        markStep(person, 'ticket', SKIPPED);
      } else {
        const existing = await findIssuedTicket(env, person.id);
        const issued = existing || await issueTicket(env, {
          eventId: env.TT_EVENT_ID,
          ticketTypeId: ticketTypeFor(env, person.team),
          fullName,
          email: person.email,
          reference: person.id,
        });
        /* issueTicket and findIssuedTicket both answer with a ticket that has
           an id, or they throw with what came back. Nothing reaches here
           without one. */
        person.tt = ticketFacts(issued);
        markStep(person, 'ticket', 'done');
        person.ttError = null;
        if (existing) person.adoptedTicket = true;
      }
    } catch (e) {
      /* What they said, kept apart from the word "failed" so the page can
         print it as a sentence instead of a parse. */
      const status = Number(e.status) || 0;
      const detail = scrubSecret(e.detail || e.message || e);
      person.ttError = { where: 'ticket', status, detail: String(detail).slice(0, 300), at: nowIso() };
      markStep(person, 'ticket', failed(status ? `${status} ${detail}` : detail));
      person.status = 'pending';
      person.lockedAt = null;
      await putPerson(kv, person);
      return {
        ok: false, error: 'ticket_failed', status,
        detail: person.ttError.detail, ttError: person.ttError, person,
      };
    }
    await putPerson(kv, person);
  }

  /* 3. The code, on the teams that have one. A collision is a new four
        characters, not an error: the first part is their own first name and
        there are only so many Shreyas. */
  if (team.promoCode && todo(person, 'discount', only, force)) {
    try {
      if (dry) {
        person.promo = { code: promoCodeFor(person.firstName), discountId: `dry_dsc_${token(10)}` };
        markStep(person, 'discount', SKIPPED);
      } else {
        /* Three digits give a thousand codes per first name, so twenty tries
           is plenty until a name is genuinely crowded. When it is, a fourth
           digit buys ten times the room rather than failing the approval. */
        let made = null;
        for (const [tries, n] of [[20, 3], [20, 4]]) {
          for (let attempt = 0; attempt < tries && !made; attempt++) {
            const code = promoCodeFor(person.firstName, n);
            if (await kv.get(promoKey(code))) continue;
            const d = await createDiscount(env, {
              code,
              name: `${person.firstName} ${person.lastName} (${person.team})`,
              ticketTypes: discountTicketTypes(env),
              maxRedemptions: Number(env.TEAM_CODE_MAX_ORDERS) || 10,
              expiresUnix: codeExpiryUnix(env),
            });
            made = { code, discountId: d.id };
          }
          if (made) break;
        }
        if (!made) throw new Error('no free code for this first name after forty tries');
        person.promo = made;
        await kv.put(promoKey(made.code), JSON.stringify({ id: person.id, discountId: made.discountId }));
        markStep(person, 'discount', 'done');
      }
    } catch (e) {
      const status = Number(e.status) || 0;
      const detail = scrubSecret(e.detail || e.message || e);
      person.ttError = { where: 'discount', status, detail: String(detail).slice(0, 300), at: nowIso() };
      markStep(person, 'discount', failed(status ? `${status} ${detail}` : detail));
    }
    await putPerson(kv, person);
  }

  /* 4. The +1, for a main artist only. One token, created once: a second
        approval of the same artist must not hand out a second guest. */
  if (team.plusOne && !person.plus1Token && !person.plusOneOf) {
    person.plus1Token = token(20);
    await kv.put(plus1Key(person.plus1Token), JSON.stringify({ artistId: person.id, used: false }));
    /* No write of its own: the next step writes, and two writes to one key
       in the same millisecond is how a record ends up stuck. */
  }

  /* 6A. The photo wall. A token now so the other brief has something to find;
         never for a child, whose record holds a date of birth and whose photo
         is not ours to ask for. */
  if (team.wall && person.team !== 'child' && !person.wallToken) {
    person.wallToken = token(24);
    /* Carried by the next write, for the same reason. */
  }

  /* 5. Brevo. The accreditation list and nothing else. A special guest's
        companion has the registrant's address, and one address is one Brevo
        contact: writing the guest's name onto it would overwrite the
        registrant's. The registrant's own approval keeps the contact. */
  if (todo(person, 'brevo', only, force) && isCompanion(person)) {
    markStep(person, 'brevo', 'done:not needed, shares the contact of ' + person.vip.guestOfName);
  } else if (todo(person, 'brevo', only, force)) {
    if (!mayReachOut) {
      markStep(person, 'brevo', SKIPPED);
      console.log('accred dry-run: skipped brevo for', person.id);
    } else {
      const r = await pushToBrevo(env, { ...person, status: 'approved' }, team);
      markStep(person, 'brevo', r.ok ? 'done' : failed(r.reason));
    }
    await putPerson(kv, person);
  }

  /* 6. The email. */
  if (todo(person, 'email', only, force)) {
    if (!mayReachOut) {
      markStep(person, 'email', SKIPPED);
      console.log('accred dry-run: skipped email for', person.id);
    } else {
      const r = await sendMail(env, approvedMail(env, person, team));
      /* The email went out, the pass did not come with it. Not a failure: they
         have the inline image and the barcode. Said out loud all the same, and
         left retryable, because a retry is how it gets fixed. */
      markStep(person, 'email', r.ok
        ? (r.attachmentFailed ? `done:no_attachment:${r.attachmentFailed}` : 'done')
        : failed(r.reason));
    }
    await putPerson(kv, person);
  }

  /* 7. The WhatsApp, on the teams that have one. The special guests do not:
        their pass is an email, and a marketing template is not the tone. */
  if (team.whatsapp !== false && todo(person, 'whatsapp', only, force)) {
    const r = await sendTeamPass(env, kv, person, team, { log });
    markStep(person, 'whatsapp', r.ok
      ? (r.dry ? SKIPPED : `done:${r.template}${r.fellBack ? ' (fallback)' : ''}`)
      : failed(r.reason));
    if (r.messageId) person.waMessageId = r.messageId;
    if (r.template) person.waTemplate = r.template;
    /* Not written here. The next line is the only thing left to do, and a
       write immediately followed by another write to the same key is the
       whole of the bug this fold exists for. */
  }

  /* 8. Approved, and by whom. One write, carrying everything above it. */
  person.status = 'approved';
  person.lockedAt = null;
  if (approver) { person.decidedBy = approver; person.decidedAt = nowIso(); }
  await putPerson(kv, person);
  return { ok: true, person };
}

/* What a rejection remembers.
 *
 * The id alone was not enough: it blocked the whole phone number, and on the
 * child team one number is a family. A mother whose eldest was turned down
 * could then register none of the others. So the name goes in the key too,
 * and the match has to be the same person, not the same household.
 *
 * Older keys hold a bare person id. They are read by looking the person up,
 * so nothing written before this change stops working. */
const rejectedMark = person => JSON.stringify({
  id: person.id,
  name: `${person.firstName} ${person.lastName}`.trim().toLowerCase(),
  child: person.child ? `${person.child.firstName} ${person.child.lastName}`.trim().toLowerCase() : '',
});

async function readRejected(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (o && o.id) return o;
  } catch { /* an id written before the name was kept */ }
  const p = await getPerson(kv, String(raw));
  if (!p) return { id: String(raw), name: '', child: '' };
  return rejectedMark(p) && JSON.parse(rejectedMark(p));
}

/**
 * Is this submission the person who was turned down, or just their phone?
 *
 * The name has to match as well. On the child team it is the child's name that
 * decides, because the parent's is the same on every form they fill in.
 */
export async function blockedAsRejected(kv, { phone, email, firstName, lastName, child, childTeam }) {
  const want = `${firstName} ${lastName}`.trim().toLowerCase();
  const wantChild = child ? `${child.firstName} ${child.lastName}`.trim().toLowerCase() : '';
  for (const key of [phone && rejectedPhoneKey(phone), email && rejectedEmailKey(email)]) {
    if (!key) continue;
    const mark = await readRejected(kv, key);
    if (!mark) continue;
    /* A record from before the name was kept blocks on the contact alone,
       which is the old behaviour and the safe side of the change. */
    if (!mark.name && !mark.child) return true;
    if (childTeam) { if (mark.child && mark.child === wantChild) return true; continue; }
    if (mark.name === want) return true;
  }
  return false;
}

/** A special guest's companion, from the registrant's record, or null. */
export async function companionOf(kv, person) {
  const id = person && person.vip && person.vip.guestId;
  return id ? getPerson(kv, id) : null;
}

/**
 * Not coming.
 *
 * The phone and the email are remembered so the same person filling the same
 * form again lands nowhere. Nothing is sent to them: a rejection by email is a
 * conversation somebody then has to have, and that conversation belongs to the
 * person who invited them.
 */
export async function reject(env, kv, { id, approver, note = '' }) {
  const person = await getPerson(kv, id);
  if (!person) return { ok: false, error: 'unknown_person' };

  person.status = 'rejected';
  person.note = String(note).slice(0, 500);
  person.decidedBy = approver;
  person.decidedAt = nowIso();
  person.lockedAt = null;
  await putPerson(kv, person);

  if (person.phone) await kv.put(rejectedPhoneKey(person.phone), rejectedMark(person));
  /* A companion's address is the registrant's. Remembering it under the
     companion's name would replace the registrant's own mark, and the key
     holds one. */
  if (person.email && !isCompanion(person)) {
    await kv.put(rejectedEmailKey(person.email), rejectedMark(person));
  }

  /* A rejected +1 reopens the artist's token, so the artist can name somebody
     else rather than losing the guest. */
  if (person.plusOneOf && person.plus1TokenUsed) {
    const entry = await kv.get(plus1Key(person.plus1TokenUsed), 'json');
    if (entry) await kv.put(plus1Key(person.plus1TokenUsed), JSON.stringify({ ...entry, used: false }));
  }

  return { ok: true, person };
}

/**
 * Was this exact message sent a moment ago?
 *
 * Returns the number of seconds since, or 0. The guard is on the server
 * because the page cannot see another person's clicks, and a pass arriving
 * twice reads as a mistake by the festival rather than by the button.
 */
export async function recentlySent(kv, id, step) {
  if (!kv) return null;
  const at = Number(await kv.get(resendKey(id, step))) || 0;
  if (!at) return null;
  const since = Math.round((Date.now() - at) / 1000);
  /* A stamp from the future is a clock that has gone backwards, not a send,
     and it must not lock anybody out until it catches up. */
  if (since < 0 || since >= RESEND_LOCK_SECONDS) return null;
  /* An object, not a number: zero seconds ago is the commonest case of all,
     and a zero that means "just now" reads as "nothing happened". */
  return { since, wait: Math.max(1, RESEND_LOCK_SECONDS - since) };
}

export async function markSent(kv, id, step) {
  if (!kv) return;
  try {
    await kv.put(resendKey(id, step), String(Date.now()),
      { expirationTtl: Math.max(60, RESEND_LOCK_SECONDS * 3) });
  } catch (e) {
    console.error('accred: resend stamp failed', String(e).slice(0, 120));
  }
}

/**
 * Give somebody a different code.
 *
 * People ask. A code minted from a nickname, a code somebody has already
 * printed on a flyer, a code that reads badly out loud. The order below is
 * chosen so that the worst outcome is two working codes rather than none:
 *
 *   1. read the old one, to find out how many orders it has already taken
 *   2. mint the new one, with the remaining orders as its ceiling
 *   3. only then delete the old one
 *
 * If step 3 fails, the new code still works and the old one still works. That
 * is said out loud on the card rather than quietly undone: deleting a code
 * somebody is holding, to recover from a delete that did not happen, is how
 * you end up with neither.
 *
 * Nothing is sent. The approver decides whether to tell them, with the Resend
 * buttons, which read the record and so carry the new code.
 */
export async function changeCode(env, kv, { id, code: raw, approver }) {
  const person = await getPerson(kv, id);
  if (!person) return { ok: false, error: 'unknown_person' };
  if (person.status !== 'approved') {
    return { ok: false, error: 'not_approved', detail: 'Only an approved person has a code.', person };
  }
  if (!person.promo || !person.promo.discountId) {
    return { ok: false, error: 'no_code', detail: 'This person has no code to change.', person };
  }
  if (isDryId(person.promo.discountId)) {
    return {
      ok: false, error: 'dry_code', person,
      detail: 'That code was invented by a dry run. Approve them for real first.',
    };
  }

  const clean = cleanCode(raw);
  if (!clean.ok) return { ok: false, error: 'bad_code', detail: clean.reason, person };
  const code = clean.code;
  if (code === person.promo.code) {
    return { ok: true, person, skipped: 'same_code' };
  }

  /* Ours, on somebody else. Ticket Tailor would refuse it too, but this
     answer names the problem instead of quoting theirs. */
  const held = await kv.get(promoKey(code), 'json');
  if (held && held.id && held.id !== person.id) {
    return { ok: false, error: 'code_taken', detail: 'Another person already has that code.', person };
  }

  const oldCode = person.promo.code;
  const oldId = person.promo.discountId;

  /* a. What the old one has already taken. Unknown counts as nought used, so
        the new ceiling is generous rather than short: a code that stops
        working early is a sale lost. */
  const used = await ordersOn(env, kv, oldId);
  const cap = Number(env.TEAM_CODE_MAX_ORDERS) || 10;
  const left = Math.max(1, cap - (Number.isFinite(used) && used !== null ? used : 0));

  /* b. The new one. A refusal here changes nothing at all. */
  let made;
  try {
    made = await createDiscount(env, {
      code,
      name: `${person.firstName} ${person.lastName} (${person.team})`,
      ticketTypes: discountTicketTypes(env),
      maxRedemptions: left,
      expiresUnix: codeExpiryUnix(env),
    });
  } catch (e) {
    const status = Number(e.status) || 0;
    const detail = scrubSecret(e.detail || e.message || e);
    person.ttError = { where: 'code_change', status, detail: String(detail).slice(0, 300), at: nowIso() };
    await putPerson(kv, person);
    return { ok: false, error: 'tt_refused', status, detail: person.ttError.detail, person };
  }

  /* c. The old one goes, and if it will not go it stays live and says so. */
  let staleCode = '';
  try {
    await deleteDiscount(env, oldId);
  } catch (e) {
    staleCode = oldCode;
    console.error('accred: old discount not deleted', oldId, String(e).slice(0, 160));
  }

  /* d. The record, the keys and Brevo. The old code keeps its place in the
        history with what it sold, so "tickets sold" stays honest. */
  person.promoHistory = [...codeHistoryOf(person), {
    code: oldCode,
    discountId: oldId,
    orders: Number.isFinite(used) && used !== null ? used : null,
    stillLive: Boolean(staleCode),
    changedBy: approver,
    changedAt: nowIso(),
  }];
  person.promo = { code, discountId: made.id };
  person.codeChangedBy = approver;
  person.codeChangedAt = nowIso();
  person.staleCode = staleCode || null;
  person.ttError = null;
  await putPerson(kv, person);

  await kv.put(promoKey(code), JSON.stringify({ id: person.id, discountId: made.id }));
  /* The old key only goes when the old code really went with it. */
  if (!staleCode) await kv.delete(promoKey(oldCode));

  const team = teamOf(person.team);
  const brevo = await pushToBrevo(env, person, team);
  if (!brevo.ok) markStep(person, 'brevo', failed(brevo.reason));
  else markStep(person, 'brevo', 'done');
  await putPerson(kv, person);

  return { ok: true, person, oldCode, staleCode, maxRedemptions: left };
}

/**
 * Rejected by mistake, or rejected and then argued about and won.
 *
 * Back into the queue, and the two "never again" keys are released so they can
 * fill the form in again if they need to. Each key is only released when it
 * still points at this person: on the child team one phone covers a family,
 * and un-remembering a sibling's rejection because this one was restored
 * would be wrong.
 *
 * The note stays. Why somebody was turned down is worth keeping even after
 * the decision is reversed.
 */
export async function restore(env, kv, { id, approver }) {
  const person = await getPerson(kv, id);
  if (!person) return { ok: false, error: 'unknown_person' };
  if (person.status !== 'rejected') {
    return { ok: true, person, skipped: `status_${person.status}` };
  }

  for (const key of [person.phone && rejectedPhoneKey(person.phone),
    person.email && rejectedEmailKey(person.email)]) {
    if (!key) continue;
    const mark = await readRejected(kv, key);
    if (mark && mark.id === person.id) await kv.delete(key);
  }

  person.status = 'pending';
  person.restoredBy = approver;
  person.restoredAt = nowIso();
  /* No decision stands on them any more. */
  person.decidedBy = null;
  person.decidedAt = null;
  person.lockedAt = null;
  await putPerson(kv, person);
  return { ok: true, person };
}

/** Approved by mistake: take the pass back and say so in Brevo. */
export async function revoke(env, kv, { id, approver, note = '' }) {
  const person = await getPerson(kv, id);
  if (!person) return { ok: false, error: 'unknown_person' };
  const team = teamOf(person.team);
  const dry = dryRun(env);

  if (person.tt && person.tt.issuedTicketId && !String(person.tt.issuedTicketId).startsWith('dry_')) {
    try { if (!dry) await voidTicket(env, person.tt.issuedTicketId); } catch (e) {
      console.error('accred revoke: void failed', person.id, String(e));
    }
  }
  if (person.promo && person.promo.discountId && !String(person.promo.discountId).startsWith('dry_')) {
    try { if (!dry) await deleteDiscount(env, person.promo.discountId); } catch (e) {
      console.error('accred revoke: discount delete failed', person.id, String(e));
    }
    await kv.delete(promoKey(person.promo.code));
  }

  person.status = 'revoked';
  person.note = String(note).slice(0, 500);
  person.decidedBy = approver;
  person.decidedAt = nowIso();
  await putPerson(kv, person);

  if (person.email && (!dry || isTestAddress(env, person.email))) {
    await pushToBrevo(env, person, team);
  }
  return { ok: true, person };
}

/* ------------------------------------------------------- submission log */

/* What each outcome means, and the whole set of them. One POST to the form
   writes exactly one of these, always. */
export const LOG_OUTCOMES = ['stored', 'flagged', 'repeat', 'refused'];

/**
 * One line per submitted form, whatever became of it.
 *
 * This exists because of what it replaced. The log used to be refusals only,
 * and a submission that was silently discarded appeared nowhere at all: the
 * person saw the thank-you screen and left no trace, and nobody could answer
 * "I filled your form in last week" with anything. Now every POST writes a
 * line, so that question always has an answer.
 *
 * Enough to recognise a person and not enough to contact them: name, link,
 * team, outcome. No date of birth, no email, no phone number. It expires on
 * its own after sixty days.
 */
export async function logSubmission(kv, {
  outcome, reason = '', team = '', label = '',
  firstName = '', lastName = '', personId = '', matched = '', hidden = '',
}) {
  if (!kv) return;
  const at = new Date().toISOString();
  try {
    /* Eight characters, not four. Two forms submitted in the same
       millisecond must not land on the same key: one of them would be
       overwritten, which is the whole thing this log exists to prevent. */
    await kv.put(logKey(at, token(8)), JSON.stringify({
      at,
      outcome: LOG_OUTCOMES.includes(outcome) ? outcome : 'refused',
      reason,
      team,
      label,
      firstName: String(firstName || '').trim().slice(0, 60),
      lastName: String(lastName || '').trim().slice(0, 60),
      personId,
      matched,
      hidden,
    }), { expirationTtl: LOG_TTL_SECONDS });
  } catch (e) {
    console.error('accred: submission log failed', String(e).slice(0, 120));
  }
}

/* The visitor's own message never changes, whatever the reason. This is the
   other half of that: somebody has to be able to see that eleven people hit a
   closed link this morning without reading a log stream. */
export const logRefusal = (kv, o) => logSubmission(kv, { ...o, outcome: 'refused' });

/* An entry from the refusal-only list, read in the shape the log uses. Those
   kept a last initial rather than a last name, so that is what shows. */
const fromRefusal = r => ({
  ...r,
  outcome: 'refused',
  lastName: r.lastName || (r.lastInitial ? `${r.lastInitial}.` : ''),
  personId: '', matched: '', hidden: '',
});

/** Newest first, and trimmed to the cap on the way out. */
export async function allSubmissions(kv, cap = LOG_CAP) {
  const out = [];
  for (const k of (await listAll(kv, 'sub:', cap * 4)).sort().reverse().slice(0, cap)) {
    const raw = await kv.get(k);
    if (raw) out.push({ key: k, ...JSON.parse(raw) });
  }
  for (const k of (await listAll(kv, 'refused:', REFUSAL_CAP * 4)).sort().reverse()) {
    const raw = await kv.get(k);
    if (raw) out.push({ key: k, ...fromRefusal(JSON.parse(raw)) });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, cap);
}

/* Past the cap, the oldest go. The TTL would get them eventually; this keeps
   the list from being a thousand rows long in the meantime. */
export async function trimSubmissions(kv, cap = LOG_CAP) {
  const keys = (await listAll(kv, 'sub:', cap * 4)).sort();
  const over = keys.length - cap;
  for (let i = 0; i < over; i++) await kv.delete(keys[i]);
  return Math.max(0, over);
}

/* ----------------------------------------------------------- registration */

/* Twice what a team expects, never fewer than ten. Not a quota: it is the
   ceiling that stops a leaked link from filling the queue with a thousand
   rows overnight. The real number is settled by approving or not approving. */
export const hardCap = expected => Math.max(10, 2 * Number(expected || 0));

export const sameName = (a, b) =>
  `${a.firstName} ${a.lastName}`.trim().toLowerCase()
  === `${b.firstName} ${b.lastName}`.trim().toLowerCase();

/**
 * Everything wrong with this submission that the person is allowed to know
 * about, as a copy key, or '' when there is nothing.
 *
 * Validation errors name the field. Refusals all answer with the same two
 * polite lines, because the difference between "that link is closed" and "you
 * were turned down last week" is not something a form should explain.
 */
export function validate(body, team) {
  if (isGuestForm(team)) return validateVip(body);
  if (!truthyConsent(body.consent)) return 'consent';
  if (!isEmail(body.email)) return 'email';
  if (!normalisePhone(body.phone)) return 'phone';
  if (!String(body.firstName || '').trim() || !String(body.lastName || '').trim()) return 'name';
  if (team.key !== 'plus1' && team.key !== 'child') {
    const role = String(body.role || '').trim();
    if (role.length < 2 || role.length > 60) return 'role';
  }
  if (team.childTeam) {
    const child = body.child || {};
    if (!String(child.firstName || '').trim() || !String(child.lastName || '').trim()) return 'child';
    if (!validDob(child.dob)) return 'dob_invalid';
  }
  return '';
}

/**
 * The special guest form. No consent box (nothing here is marketing), no role,
 * and the mobile number is optional: an ambassador's office gives an email.
 * A number that is given still has to be one.
 */
export function validateVip(body) {
  if (!String(body.firstName || '').trim() || !String(body.lastName || '').trim()) return 'name';
  if (!String(body.organisation || '').trim()) return 'organisation';
  if (!isEmail(body.email)) return 'email';
  if (String(body.phone || '').trim() && !normalisePhone(body.phone)) return 'phone';
  if (!['alone', 'guest'].includes(String(body.attending || ''))) return 'attending';
  if (body.attending === 'guest') {
    const g = body.guest || {};
    if (!String(g.firstName || '').trim() || !String(g.lastName || '').trim()) return 'guest';
  }
  return '';
}

const truthyConsent = v => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';

/**
 * The flags on a new row.
 *
 * None of them refuses anybody. They exist so that whoever approves can see
 * in one glance that this phone has been here before, or that this person is
 * already on another team, and decide. A machine deciding that would be wrong
 * about an entire family sharing one phone.
 */
export async function flagsFor(kv, env, draft, team, link = null) {
  const flags = [];
  const byPhone = draft.phone ? await idsFor(kv, phoneKey(draft.phone)) : [];
  const byEmail = await idsFor(kv, emailKey(draft.email));

  const others = [];
  for (const id of new Set([...byPhone, ...byEmail])) {
    const p = await getPerson(kv, id);
    if (p && p.status !== 'rejected') others.push(p);
  }

  if (byPhone.length) {
    /* On the child team one parent's phone covers every one of their children,
       which is the normal case and not worth a chip. It is only interesting
       when the child's name matches too, because that is a double entry. */
    if (!team.childTeam) flags.push('dup_phone');
    else if (others.some(p => p.child && draft.child
      && sameName(p.child, draft.child))) flags.push('dup_phone');
  }
  if (byEmail.length && !team.childTeam) flags.push('dup_email');
  else if (byEmail.length && others.some(p => p.child && draft.child
    && sameName(p.child, draft.child))) flags.push('dup_email');

  if (others.some(p => p.team !== draft.team)) flags.push('other_team');

  /* The link's own number first: a teacher's link for eight is over at nine
     even though the child team expects fifty. */
  const expected = Number(link && link.expected) || Number(await expectedFor(kv, draft.team));
  const onLink = (await allPeople(kv)).filter(p =>
    p.linkToken === draft.linkToken && p.status !== 'rejected' && !isCompanion(p));
  if (onLink.length >= expected) flags.push('over_expected');

  if (env.BREVO_BUYERS_LIST_ID && env.BREVO_API_KEY) {
    try {
      const c = await getContact(env, draft.email);
      const buyers = Number(env.BREVO_BUYERS_LIST_ID);
      if (c && Array.isArray(c.listIds) && c.listIds.includes(buyers)) flags.push('already_buyer');
    } catch (e) {
      console.warn('accred: buyer check failed', String(e).slice(0, 120));
    }
  }
  return flags;
}

/**
 * One person, from one form.
 *
 * Returns `{ ok: true, person }`, `{ ok: true, repeat: true }` when this is the
 * same person submitting twice, or `{ ok: false, message: <copy key> }`.
 *
 * No person is stored on a refusal, so a leaked link costs KV one log line.
 * Every outcome writes that line: nothing a visitor submits disappears.
 */
export async function register(env, kv, body, { ip = '', plus1 = null } = {}) {
  const lang = langOf(body.lang);

  /* Every no is written down on the way out, so the people who have to answer
     for a link can see what it is doing. The visitor's own message never
     changes: one neutral line, whatever the reason. */
  let about = { team: '', label: '', firstName: body.firstName, lastName: body.lastName };
  /* On the special guest form the same refusals speak in the formal register
     and point at an address rather than at a team lead nobody has. */
  let vipMode = false;
  const no = async (message, reason) => {
    await logSubmission(kv, { ...about, outcome: 'refused', reason: reason || message });
    const said = vipMode
      ? ({ inactive: 'vip_inactive', closed: 'vip_closed' }[message] || message)
      : message;
    return { ok: false, message: said, why: reason || message };
  };

  /* The trap field.
   *
   * It used to be enough to answer a filled one with success and store
   * nothing: an error is feedback, and feedback is how the next attempt gets
   * past. Then a password manager filled it in, because the field was
   * labelled Company, and real team members vanished into it. They saw the
   * thank-you screen and left no trace anywhere.
   *
   * So a filled field no longer decides anything. The person is stored like
   * anybody else, flagged, with the first of what was typed in it, and the
   * approver reads both. Nothing is sent to them until somebody has looked.
   * Every pass on this festival is issued by hand, so a robot that gets this
   * far has reached a queue, not a ticket. */
  const hidden = String(body.hp || '').trim().slice(0, 40);

  const link = plus1
    ? { team: 'plus1', label: plus1.label || '', open: true, expected: 1, token: body.k }
    : await kv.get(linkKey(String(body.k || '')), 'json');

  /* Which switch applies depends on whose link this is: the special guest
     form has its own. With no link at all it is the team form's switch, so a
     module that is off says so before it says anything about the token. */
  vipMode = Boolean(link) && isGuestForm(teamOf(link.team));
  if (!formEnabledFor(env, link ? teamOf(link.team) : null)) {
    return no('inactive', 'registration_off');
  }

  if (!link) return no('inactive', 'unknown_link');
  about = { ...about, team: link.team, label: link.label || '' };
  if (!link.open) return no('inactive', 'link_closed');

  const team = teamOf(link.team);
  if (!hasForm(team)) return no('inactive', 'no_form_for_team');

  if (closedFor(env, team)) return no('closed', 'closed');

  const bad = validate(body, team);
  if (bad) {
    const r = await no(bad === 'dob_invalid' ? 'dob_invalid' : (vipMode ? 'vip_check' : 'inactive'), bad);
    return { ...r, field: bad };
  }

  /* Optional on the special guest form only, and then simply absent. */
  const phone = vipMode && !String(body.phone || '').trim() ? null : normalisePhone(body.phone);
  const email = String(body.email).trim().toLowerCase();

  if (await blockedAsRejected(kv, {
    phone, email, firstName: body.firstName, lastName: body.lastName,
    child: team.childTeam ? body.child : null, childTeam: Boolean(team.childTeam),
  })) return no('inactive', 'rejected_match');

  /* The same phone and the same name on the same link: a second tap on a
     slow button, or a form resubmitted by a back arrow. Success, nothing
     stored, no second row for somebody to notice and reject. */
  const draftName = { firstName: body.firstName, lastName: body.lastName };
  /* A special guest may have given no number, so on that form the email is
     what recognises them. The companion shares it and is never the match. */
  const seen = phone ? await idsFor(kv, phoneKey(phone)) : [];
  if (vipMode) seen.push(...await idsFor(kv, emailKey(email)));
  for (const id of new Set(seen)) {
    const p = await getPerson(kv, id);
    if (!p || p.linkToken !== String(body.k) || !sameName(p, draftName)) continue;
    if (isCompanion(p)) continue;
    /* A pass that was taken back is not a second row waiting to be noticed.
       Somebody whose accreditation was revoked and who fills the form in
       again is asking to be considered again, so they are stored fresh and
       the approver decides a second time. */
    if (p.status === 'revoked') continue;
    /* On the child team the parent is the same person every time, by design:
       one mother entering three dancers types her own name three times. It is
       the child that makes it a different registration, so only a matching
       child makes it a repeat. */
    if (team.childTeam && !(p.child && body.child && sameName(p.child, body.child))) continue;
    await logSubmission(kv, {
      ...about, outcome: 'repeat', personId: p.id,
      matched: `${p.firstName} ${p.lastName}`.trim(),
      reason: p.status,
    });
    return { ok: true, repeat: true, person: p };
  }

  const expected = await expectedFor(kv, link.team);
  /* The cap counts registrations, not seats: a special guest bringing one
     person is still one invitation answered. */
  const onLink = (await allPeople(kv)).filter(p =>
    p.linkToken === String(body.k) && p.status !== 'rejected' && !isCompanion(p));
  if (onLink.length >= hardCap(link.expected || expected)) return no('inactive', 'cap');

  /* Forty a day from one address. High enough that a team lead typing in
     thirty children from one laptop never notices it. */
  if (ip) {
    const day = new Date().toISOString().slice(0, 10);
    const used = Number(await kv.get(ipKey(ip, day))) || 0;
    if (used >= IP_CAP_PER_DAY) return no('inactive', 'ip_cap');
    await kv.put(ipKey(ip, day), String(used + 1), { expirationTtl: 2 * 24 * 3600 });

    /* Flagged ones have their own, much lower ceiling. Past it the submission
       is refused rather than stored, and the refusal is logged like any
       other, so a script cannot fill the queue by tripping the trap. */
    if (hidden) {
      const flagged = Number(await kv.get(flagCapKey(ip, day))) || 0;
      if (flagged >= FLAG_CAP_PER_DAY) return no('inactive', 'flag_cap');
      await kv.put(flagCapKey(ip, day), String(flagged + 1), { expirationTtl: 2 * 24 * 3600 });
    }
  }

  const person = {
    id: newPersonId(),
    team: link.team,
    linkToken: String(body.k),
    label: link.label || '',
    firstName: String(body.firstName).trim().slice(0, 60),
    lastName: String(body.lastName).trim().slice(0, 60),
    email,
    phone,
    role: String(body.role || '').trim().slice(0, 60),
    lang,
    child: team.childTeam ? {
      firstName: String(body.child.firstName).trim().slice(0, 60),
      lastName: String(body.child.lastName).trim().slice(0, 60),
      dob: String(body.child.dob),
    } : null,
    plusOneOf: plus1 ? plus1.artistId : null,
    plus1TokenUsed: plus1 ? String(body.k) : null,
    vip: vipMode ? {
      salutation: String(body.salutation || '').trim().slice(0, 40),
      organisation: String(body.organisation || '').trim().slice(0, 120),
      jobTitle: String(body.jobTitle || '').trim().slice(0, 120),
      bringsGuest: body.attending === 'guest',
      guestId: null,
      guestName: '',
      guestOf: null,
      guestOfName: '',
    } : null,
    wallToken: null,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    note: '',
    flags: [],
    hiddenField: hidden || null,
    tt: null,
    promo: null,
    plus1Token: null,
    steps: { ticket: null, discount: null, brevo: null, email: null, whatsapp: null },
    createdAt: nowIso(),
    ip,
  };

  person.flags = await flagsFor(kv, env, person, team, link);
  if (hidden) person.flags.unshift('hidden_field_filled');

  /* The person they bring. A person of their own, because the pass is in
     their own name, and pending like anybody else: an approver decides, and
     by default decides for both at once. Same email, because the pass goes
     to whoever registered them. No phone, no organisation. */
  let companion = null;
  if (vipMode && person.vip.bringsGuest) {
    const g = body.guest || {};
    companion = {
      ...person,
      id: newPersonId(),
      firstName: String(g.firstName).trim().slice(0, 60),
      lastName: String(g.lastName).trim().slice(0, 60),
      phone: null,
      vip: {
        salutation: '', organisation: '', jobTitle: '', bringsGuest: false,
        guestId: null, guestName: '',
        guestOf: person.id,
        guestOfName: `${person.firstName} ${person.lastName}`,
        /* Who the emails about this pass are addressed to. */
        host: {
          salutation: person.vip.salutation,
          firstName: person.firstName,
          lastName: person.lastName,
        },
      },
      flags: hidden ? ['hidden_field_filled'] : [],
      steps: { ticket: null, discount: null, brevo: null, email: null, whatsapp: null },
    };
    person.vip.guestId = companion.id;
    person.vip.guestName = `${companion.firstName} ${companion.lastName}`;
  }

  await putPerson(kv, person);
  if (phone) await addIdTo(kv, phoneKey(phone), person.id);
  await addIdTo(kv, emailKey(email), person.id);
  if (companion) {
    await putPerson(kv, companion);
    await addIdTo(kv, emailKey(email), companion.id);
  }

  /* The +1 token burns at submit, not at approval: the link is the artist's
     one guest, and the guest is now named. A rejection puts it back. */
  if (plus1) {
    await kv.put(plus1Key(String(body.k)),
      JSON.stringify({ artistId: plus1.artistId, used: true, personId: person.id }));
  }

  await logSubmission(kv, {
    ...about, outcome: hidden ? 'flagged' : 'stored', personId: person.id,
    hidden,
    reason: hidden ? 'hidden_field_filled' : (companion ? `with guest ${person.vip.guestName}` : ''),
  });

  /* Both of these reach a real person, so on a dry run they only reach Ravi.
     A flagged one reaches nobody and goes into no mailing list until an
     approver has read it: if it is a robot, it was never a contact, and if it
     is a team member, approval sends them everything a moment later. */
  if (hidden) {
    console.log('accred: held mail and brevo for flagged', person.id);
  } else if (!dryRun(env) || isTestAddress(env, email)) {
    await sendMail(env, vipMode ? vipReceivedMail(person) : receivedMail(person, team));
    await pushToBrevo(env, person, team);
  } else {
    console.log('accred dry-run: skipped received mail and brevo for', person.id);
  }

  return { ok: true, person, companion, flagged: Boolean(hidden) };
}

/* ------------------------------------------------------------------- diya */

/**
 * Who this number is, as far as accreditation is concerned.
 *
 * Returns `{ person, team }` for an approved person, `{ pending: true }` for
 * one still in the queue, and null for everybody else. A rejected or revoked
 * number is nobody: the bot treats them as an ordinary visitor and never
 * mentions that a registration exists.
 *
 * VIPs get no team menu. They were invited, they did not register, and Diya
 * volunteering a menu at them is not the tone of that relationship.
 */
export async function teamMemberFor(kv, phone) {
  if (!kv || !phone) return null;
  const ids = await idsFor(kv, phoneKey(phone));
  if (!ids.length) return null;

  let pending = false;
  for (const id of ids) {
    const person = await getPerson(kv, id);
    if (!person) continue;
    const team = teamOf(person.team);
    /* Not even "waiting for approval": a special guest who writes to Diya
       is an ordinary visitor as far as she is concerned. */
    if (!team || team.inviteOnly) continue;
    if (person.status === 'approved') return { person, team };
    if (person.status === 'pending' || person.status === 'approving') pending = true;
  }
  return pending ? { pending: true } : null;
}

/** "My pass": what they have, where the QR is, and the state of their +1. */
export async function passAnswer(env, kv, { person, team }) {
  const lang = person.lang;
  const lines = [say('bot_pass', lang)
    .replace('{PASS}', passName(team, lang))
    .replace('{EMAIL}', person.email)];

  /* The same image the email shows. Diya links to it rather than describing
     it: a person asking "where is my pass" on a phone wants to open it, and
     WhatsApp will not render one in a reply. */
  if (person.tt && person.tt.qrUrl) lines.push(person.tt.qrUrl);

  const arrival = arrivalLine(team, lang);
  if (arrival) lines.push(arrival);

  if (person.plus1Token) {
    const entry = await kv.get(plus1Key(person.plus1Token), 'json');
    const guest = entry && entry.personId ? await getPerson(kv, entry.personId) : null;
    if (guest && guest.status === 'approved') {
      lines.push(say('bot_plus1_approved', lang).replace('{NAME}', guest.firstName));
    } else if (guest) {
      lines.push(say('bot_plus1_pending', lang));
    } else {
      lines.push(say('bot_plus1_open', lang)
        .replace('{LINK}', `https://diwali.artindia.be/team/plus1/?k=${person.plus1Token}`));
    }
  }

  if (wallEnabled(env) && person.wallToken && env.WALL_URL) {
    lines.push(say('wall_invite', lang).replace('{LINK}', `${env.WALL_URL}?k=${person.wallToken}`));
  }
  return lines.join('\n\n');
}

/** "My code": the code, and one line they can forward without editing it. */
/**
 * "My code": two messages, not one.
 *
 * The first explains. The second is written in their own voice and carries
 * nothing else, so they can hold it down, forward it, and be done. A single
 * message with an explanation on top is a message nobody can forward without
 * editing it first, and nobody edits it: they retype the code wrong instead.
 */
export function codeMessages(person) {
  const lang = person.lang;
  const code = person.promo && person.promo.code;
  if (!code) return [];
  const link = shareLink(code);
  const put = key => say(key, lang).split('{CODE}').join(code).split('{LINK}').join(link);
  return [put('bot_code'), put('bot_code_forward')];
}

/* The same thing as one string, for the web widget and for anything that can
   only say one thing at a time. */
export const codeAnswer = person => codeMessages(person).join('\n\n');

/**
 * "Tickets sold": how far their code has travelled.
 *
 * The discount object carries `times_redeemed`, so that is the source. Cached
 * for ten minutes: this is a vanity number somebody taps four times in a row,
 * and it is not worth a Ticket Tailor call each time.
 */
/**
 * Orders on one discount, cached, or null when we could not find out.
 *
 * A dry-run id counts as nought rather than as unknown: nothing was ever
 * asked of Ticket Tailor, so there is nothing to be uncertain about.
 */
export async function ordersOn(env, kv, discountId) {
  if (!discountId) return 0;
  if (isDryId(discountId)) return 0;

  const cached = await kv.get(salesKey(discountId), 'json');
  if (cached && typeof cached.orders === 'number') return cached.orders;

  try {
    const d = await getDiscount(env, discountId);
    const n = Number(d && d.times_redeemed);
    if (!Number.isFinite(n)) return null;
    await kv.put(salesKey(discountId), JSON.stringify({ orders: n }),
      { expirationTtl: SALES_CACHE_SECONDS });
    return n;
  } catch (e) {
    console.error('accred sales lookup failed', discountId, String(e).slice(0, 160));
    return null;
  }
}

/* Every code this person has held, oldest first. A changed code does not
   erase what the old one sold. */
export const codeHistoryOf = person =>
  (Array.isArray(person.promoHistory) ? person.promoHistory : [])
    .filter(h => h && h.discountId);

/**
 * "Tickets sold": how far their code has travelled.
 *
 * Their codes, plural, once one has been changed. The person asking has one
 * code in their hand and no idea the old one existed, so the number they are
 * told is everything they have ever sold.
 *
 * A code whose count cannot be read makes the whole answer unknown rather
 * than quietly short: an undercount is worse than an apology.
 */
export async function salesAnswer(env, kv, person) {
  const lang = person.lang;
  const current = person.promo && person.promo.discountId;
  const ids = [...codeHistoryOf(person).map(h => h.discountId), current].filter(Boolean);
  if (!ids.length) return say('bot_sales_none', lang);

  let orders = 0;
  for (const id of new Set(ids)) {
    const n = await ordersOn(env, kv, id);
    if (n === null) return say('bot_sales_unknown', lang);
    orders += n;
  }

  if (orders === 0) return say('bot_sales_none', lang);
  return say('bot_sales', lang).replace('{ORDERS}', String(orders));
}

export const pendingAnswer = lang => say('bot_pending', lang);

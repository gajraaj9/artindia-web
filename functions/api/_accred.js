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

/* A day of submits from one address. The cap exists to stop a script, not to
   stop a team lead entering twelve people in a row. */
export const IP_CAP_PER_DAY = 40;
export const SALES_CACHE_SECONDS = 600;

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
export async function tt(env, path, { method = 'GET', form = null, query = null } = {}) {
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

  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* kept as text below */ }
  if (!res.ok) {
    const e = new Error(`ticket tailor ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return parsed;
}

/* POST /v1/issued_tickets answers { data: [ticket] }; POST /v1/discounts
   answers the discount object itself. The asymmetry is theirs, so it is
   absorbed here rather than at every call site. */
const firstOf = r => (Array.isArray(r?.data) ? r.data[0] : r?.data) || null;

/** An unvoided ticket already issued against this person, or null. */
export async function findIssuedTicket(env, reference) {
  const r = await tt(env, '/v1/issued_tickets', { query: { reference, status: 'valid' } });
  const list = Array.isArray(r?.data) ? r.data : [];
  return list.find(t => !t.voided_at) || list[0] || null;
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
  });
  return firstOf(r);
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
  return tt(env, '/v1/discounts', {
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
  });
}

export const getDiscount = (env, id) =>
  tt(env, `/v1/discounts/${encodeURIComponent(id)}`);

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
export function promoCodeFor(firstName) {
  const base = String(firstName || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 10) || 'TEAM';
  return `${base}-${token(4)}`;
}

/* ------------------------------------------------------------------ people */

export async function getPerson(kv, id) {
  const raw = await kv.get(personKey(id));
  return raw ? JSON.parse(raw) : null;
}

export const putPerson = (kv, p) => kv.put(personKey(p.id), JSON.stringify(p));

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
export async function sendMail(env, { to, subject, lines, qr = null }) {
  const clean = lines.filter(l => l !== null && l !== undefined);
  /* The barcode is printed under the QR in the HTML, so it would read as a
     stray line if it were also in `lines`. The text half has no QR to print it
     under, so it gets it here: whatever strips the HTML, the number that opens
     the gate survives. */
  const text = qr && qr.barcode ? [...clean, '', qr.barcode] : clean;
  const body = [...text, '', SIGNATURE].join('\n');
  try {
    const res = await brevo(env, '/smtp/email', {
      method: 'POST',
      body: JSON.stringify({
        sender: {
          email: env.BREVO_SENDER_EMAIL,
          name: 'Brussels Diwali Festival',
        },
        to: [{ email: to }],
        subject,
        textContent: body,
        /* Both halves, always. The HTML is what carries the QR; the text is
           what a reader with images off, or a client that refuses HTML, still
           gets, and it names the barcode so a human on the gate can type it. */
        htmlContent: htmlMail(clean, qr),
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      console.error('accred mail failed', res.status, detail);
      return { ok: false, reason: `brevo_${res.status}` };
    }
    return { ok: true };
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
export function htmlMail(lines, qr = null) {
  const body = lines.map(l => (l === ''
    ? '<tr><td style="height:14px"></td></tr>'
    : `<tr><td style="padding:0 0 4px">${linkify(l)}</td></tr>`)).join('');

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
<tr><td style="height:22px"></td></tr>
<tr><td style="border-top:1px solid #e4ddd3;padding-top:14px;font-size:13px;color:#6b625a">
${escHtml(SIGNATURE)}</td></tr>
</table></td></tr></table></body></html>`;
}

/** The "we have you" email, sent the moment a form is submitted. */
export const receivedMail = (person, team) => ({
  to: person.email,
  subject: say('mail_received_subject', person.lang),
  lines: [say('received', person.lang), '', passName(team, person.lang)],
});

/**
 * The "you are in" email.
 *
 * The QR code is not in here. Ticket Tailor sends that itself, from its own
 * address, and saying so is the difference between a person waiting for one
 * email and a person waiting for two.
 */
export function approvedMail(env, person, team) {
  const lang = person.lang;
  const lines = [
    `${person.firstName},`,
    '',
    passName(team, lang),
    '',
    say('mail_qr', lang),
  ];
  if (person.promo && person.promo.code) {
    lines.push('', say('mail_code', lang).replace('{CODE}', person.promo.code));
  }
  if (person.plus1Token) {
    lines.push('', say('mail_plus1', lang)
      .replace('{LINK}', `https://diwali.artindia.be/team/plus1/?k=${person.plus1Token}`));
  }
  const arrival = arrivalLine(team, lang);
  if (arrival) lines.push('', arrival);
  if (wallEnabled(env) && person.wallToken && env.WALL_URL) {
    lines.push('', say('wall_invite', lang)
      .replace('{LINK}', `${env.WALL_URL}?k=${person.wallToken}`));
  }

  const qr = {
    url: (person.tt && person.tt.qrUrl) || '',
    barcode: (person.tt && person.tt.barcode) || '',
  };
  return { to: person.email, subject: say('mail_approved_subject', lang), lines, qr };
}

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
export async function sendTeamPass(env, kv, person, team, { log } = {}) {
  const code = (person.promo && person.promo.code) || '';
  const name = teamTemplate(env, Boolean(code));
  const params = [{ type: 'text', text: person.firstName || 'there' },
    { type: 'text', text: passName(team, person.lang) }];
  if (code) params.push({ type: 'text', text: code });

  const payload = {
    messaging_product: 'whatsapp',
    to: String(person.phone).replace(/^\+/, ''),
    type: 'template',
    template: { name, language: { code: 'en' }, components: [{ type: 'body', parameters: params }] },
  };

  if (dryRun(env)) {
    console.log('accred wa dry-run', person.id, name, JSON.stringify(payload));
    return { ok: true, dry: true, template: name, messageId: `dry_${token(10)}` };
  }
  if (!env.WA_PHONE_ID || !env.WA_TOKEN) return { ok: false, reason: 'no_wa_credentials' };

  let res;
  try {
    const r = await fetch(`${WA_API}/${env.WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.WA_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* kept as text */ }
    res = {
      ok: r.ok,
      status: r.status,
      messageId: (parsed?.messages?.[0]?.id) || '',
      error: parsed?.error || text.slice(0, 400),
    };
  } catch (e) {
    return { ok: false, reason: 'threw' };
  }

  if (!res.ok) {
    console.error('accred wa failed', person.id, name, res.status, JSON.stringify(res.error));
    return { ok: false, reason: `wa_${res.status}` };
  }

  if (log) await log(res.messageId, name);
  return { ok: true, messageId: res.messageId, template: name };
}

/* ------------------------------------------------------------ the pipeline */

export const LOCK_STALE_MS = 2 * 60 * 1000;
export const STEPS = ['ticket', 'discount', 'brevo', 'email', 'whatsapp'];

const nowIso = () => new Date().toISOString();
const failed = reason => `failed:${reason}`;

/** True when a step still has to run: never run, or run and failed. */
const todo = (person, step, only) =>
  (!only || only.includes(step)) && person.steps[step] !== 'done';

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
export async function approve(env, kv, { id, approver, only = null, log = null }) {
  const person = await getPerson(kv, id);
  if (!person) return { ok: false, error: 'unknown_person' };

  const team = teamOf(person.team);
  const retrying = Boolean(only);

  if (!retrying) {
    /* The second click. Whoever gets here first owns the record; everyone else
       is told what it already says. A lock left behind by a request that died
       between the stamp and the ticket is reclaimed after two minutes. */
    if (person.status === 'approving') {
      const age = Date.now() - Date.parse(person.lockedAt || 0);
      if (!(age > LOCK_STALE_MS && !(person.tt && person.tt.issuedTicketId))) {
        return { ok: true, person, skipped: 'in_progress' };
      }
    } else if (person.status !== 'pending') {
      return { ok: true, person, skipped: `status_${person.status}` };
    }
  }

  const blocked = approvalBlocker(env, person, team);
  if (blocked) {
    person.steps.ticket = failed(blocked);
    person.status = 'pending';
    await putPerson(kv, person);
    return { ok: false, error: blocked, person };
  }

  if (!retrying) {
    person.status = 'approving';
    person.lockedAt = nowIso();
    await putPerson(kv, person);
  }

  const dry = dryRun(env);
  /* On a dry run Brevo and the email are the two steps that reach a real
     person, so they run only for an address Ravi has listed as his own. */
  const mayReachOut = !dry || isTestAddress(env, person.email);

  /* 2. The ticket. The child's own name is on the child's pass; the parent is
        only the contact. The date of birth is not sent. */
  if (todo(person, 'ticket', only)) {
    const fullName = person.child
      ? `${person.child.firstName} ${person.child.lastName}`.trim()
      : `${person.firstName} ${person.lastName}`.trim();
    try {
      if (dry) {
        /* No QR on a dry run: Ticket Tailor is the only thing that can make
           one, and nothing was asked of it. The email shows the barcode text
           alone, which is what a missing image looks like in the real thing. */
        person.tt = { issuedTicketId: `dry_tkt_${token(10)}`, barcode: `dry_${token(8)}`, qrUrl: '' };
        person.steps.ticket = 'done';
      } else {
        const existing = await findIssuedTicket(env, person.id);
        const issued = existing || await issueTicket(env, {
          eventId: env.TT_EVENT_ID,
          ticketTypeId: ticketTypeFor(env, person.team),
          fullName,
          email: person.email,
          reference: person.id,
        });
        if (!issued || !issued.id) throw new Error('no issued ticket id in the response');
        person.tt = ticketFacts(issued);
        person.steps.ticket = 'done';
        if (existing) person.adoptedTicket = true;
      }
    } catch (e) {
      person.steps.ticket = failed(String(e.message || e).slice(0, 200));
      person.status = 'pending';
      person.lockedAt = null;
      await putPerson(kv, person);
      return { ok: false, error: 'ticket_failed', detail: person.steps.ticket, person };
    }
    await putPerson(kv, person);
  }

  /* 3. The code, on the teams that have one. A collision is a new four
        characters, not an error: the first part is their own first name and
        there are only so many Shreyas. */
  if (team.promoCode && todo(person, 'discount', only)) {
    try {
      if (dry) {
        person.promo = { code: promoCodeFor(person.firstName), discountId: `dry_dsc_${token(10)}` };
        person.steps.discount = 'done';
      } else {
        let made = null;
        for (let attempt = 0; attempt < 5 && !made; attempt++) {
          const code = promoCodeFor(person.firstName);
          if (await kv.get(promoKey(code))) continue;
          const d = await createDiscount(env, {
            code,
            name: `${person.firstName} ${person.lastName} (${person.team})`,
            ticketTypes: discountTicketTypes(env),
            maxRedemptions: Number(env.TEAM_CODE_MAX_ORDERS) || 10,
            expiresUnix: codeExpiryUnix(env),
          });
          if (!d || !d.id) throw new Error('no discount id in the response');
          made = { code, discountId: d.id };
        }
        if (!made) throw new Error('could not find a free code in five tries');
        person.promo = made;
        await kv.put(promoKey(made.code), JSON.stringify({ id: person.id, discountId: made.discountId }));
        person.steps.discount = 'done';
      }
    } catch (e) {
      person.steps.discount = failed(String(e.message || e).slice(0, 200));
    }
    await putPerson(kv, person);
  }

  /* 4. The +1, for a main artist only. One token, created once: a second
        approval of the same artist must not hand out a second guest. */
  if (team.plusOne && !person.plus1Token && !person.plusOneOf) {
    person.plus1Token = token(20);
    await kv.put(plus1Key(person.plus1Token), JSON.stringify({ artistId: person.id, used: false }));
    await putPerson(kv, person);
  }

  /* 6A. The photo wall. A token now so the other brief has something to find;
         never for a child, whose record holds a date of birth and whose photo
         is not ours to ask for. */
  if (team.wall && person.team !== 'child' && !person.wallToken) {
    person.wallToken = token(24);
    await putPerson(kv, person);
  }

  /* 5. Brevo. The accreditation list and nothing else. */
  if (todo(person, 'brevo', only)) {
    if (!mayReachOut) {
      person.steps.brevo = 'done';
      console.log('accred dry-run: skipped brevo for', person.id);
    } else {
      const r = await pushToBrevo(env, { ...person, status: 'approved' }, team);
      person.steps.brevo = r.ok ? 'done' : failed(r.reason);
    }
    await putPerson(kv, person);
  }

  /* 6. The email. */
  if (todo(person, 'email', only)) {
    if (!mayReachOut) {
      person.steps.email = 'done';
      console.log('accred dry-run: skipped email for', person.id);
    } else {
      const r = await sendMail(env, approvedMail(env, person, team));
      person.steps.email = r.ok ? 'done' : failed(r.reason);
    }
    await putPerson(kv, person);
  }

  /* 7. The WhatsApp. */
  if (todo(person, 'whatsapp', only)) {
    const r = await sendTeamPass(env, kv, person, team, { log });
    person.steps.whatsapp = r.ok ? 'done' : failed(r.reason);
    if (r.messageId) person.waMessageId = r.messageId;
    await putPerson(kv, person);
  }

  /* 8. Approved, and by whom. */
  person.status = 'approved';
  person.lockedAt = null;
  if (approver) { person.decidedBy = approver; person.decidedAt = nowIso(); }
  await putPerson(kv, person);
  return { ok: true, person };
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

  if (person.phone) await kv.put(rejectedPhoneKey(person.phone), person.id);
  if (person.email) await kv.put(rejectedEmailKey(person.email), person.id);

  /* A rejected +1 reopens the artist's token, so the artist can name somebody
     else rather than losing the guest. */
  if (person.plusOneOf && person.plus1TokenUsed) {
    const entry = await kv.get(plus1Key(person.plus1TokenUsed), 'json');
    if (entry) await kv.put(plus1Key(person.plus1TokenUsed), JSON.stringify({ ...entry, used: false }));
  }

  return { ok: true, person };
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
    if (await kv.get(key) === person.id) await kv.delete(key);
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
  const byPhone = await idsFor(kv, phoneKey(draft.phone));
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
    p.linkToken === draft.linkToken && p.status !== 'rejected');
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
 * Writes nothing at all on any refusal, so a leaked link costs KV nothing.
 */
export async function register(env, kv, body, { ip = '', plus1 = null } = {}) {
  if (!regEnabled(env)) return { ok: false, message: 'inactive' };

  const lang = langOf(body.lang);

  /* The honeypot. A filled one is a bot, and a bot is told everything went
     fine: an error is feedback, and feedback is how the next attempt gets
     past. */
  if (String(body.hp || '').trim()) return { ok: true, quiet: true };

  const link = plus1
    ? { team: 'plus1', label: plus1.label || '', open: true, expected: 1, token: body.k }
    : await kv.get(linkKey(String(body.k || '')), 'json');
  if (!link) return { ok: false, message: 'inactive' };
  if (!link.open) return { ok: false, message: 'inactive' };

  const team = teamOf(link.team);
  if (!team || team.inviteOnly) return { ok: false, message: 'inactive' };

  if (registrationClosed(env)) return { ok: false, message: 'closed' };

  const bad = validate(body, team);
  if (bad) return { ok: false, message: bad === 'dob_invalid' ? 'dob_invalid' : 'inactive', field: bad };

  const phone = normalisePhone(body.phone);
  const email = String(body.email).trim().toLowerCase();

  if (await kv.get(rejectedPhoneKey(phone))) return { ok: false, message: 'inactive' };
  if (await kv.get(rejectedEmailKey(email))) return { ok: false, message: 'inactive' };

  /* The same phone and the same name on the same link: a second tap on a
     slow button, or a form resubmitted by a back arrow. Success, nothing
     stored, no second row for somebody to notice and reject. */
  const draftName = { firstName: body.firstName, lastName: body.lastName };
  for (const id of await idsFor(kv, phoneKey(phone))) {
    const p = await getPerson(kv, id);
    if (!p || p.linkToken !== String(body.k) || !sameName(p, draftName)) continue;
    /* On the child team the parent is the same person every time, by design:
       one mother entering three dancers types her own name three times. It is
       the child that makes it a different registration, so only a matching
       child makes it a repeat. */
    if (team.childTeam && !(p.child && body.child && sameName(p.child, body.child))) continue;
    return { ok: true, repeat: true, person: p };
  }

  const expected = await expectedFor(kv, link.team);
  const onLink = (await allPeople(kv)).filter(p =>
    p.linkToken === String(body.k) && p.status !== 'rejected');
  if (onLink.length >= hardCap(link.expected || expected)) return { ok: false, message: 'inactive' };

  /* Forty a day from one address. High enough that a team lead typing in
     thirty children from one laptop never notices it. */
  if (ip) {
    const day = new Date().toISOString().slice(0, 10);
    const used = Number(await kv.get(ipKey(ip, day))) || 0;
    if (used >= IP_CAP_PER_DAY) return { ok: false, message: 'inactive' };
    await kv.put(ipKey(ip, day), String(used + 1), { expirationTtl: 2 * 24 * 3600 });
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
    vip: null,
    wallToken: null,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    note: '',
    flags: [],
    tt: null,
    promo: null,
    plus1Token: null,
    steps: { ticket: null, discount: null, brevo: null, email: null, whatsapp: null },
    createdAt: nowIso(),
    ip,
  };

  person.flags = await flagsFor(kv, env, person, team, link);

  await putPerson(kv, person);
  await addIdTo(kv, phoneKey(phone), person.id);
  await addIdTo(kv, emailKey(email), person.id);

  /* The +1 token burns at submit, not at approval: the link is the artist's
     one guest, and the guest is now named. A rejection puts it back. */
  if (plus1) {
    await kv.put(plus1Key(String(body.k)),
      JSON.stringify({ artistId: plus1.artistId, used: true, personId: person.id }));
  }

  /* Both of these reach a real person, so on a dry run they only reach Ravi. */
  if (!dryRun(env) || isTestAddress(env, email)) {
    await sendMail(env, receivedMail(person, team));
    await pushToBrevo(env, person, team);
  } else {
    console.log('accred dry-run: skipped received mail and brevo for', person.id);
  }

  return { ok: true, person };
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
    if (person.status === 'approved') {
      const team = teamOf(person.team);
      if (!team || team.inviteOnly) continue;
      return { person, team };
    }
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
export function codeAnswer(person) {
  const lang = person.lang;
  const code = person.promo && person.promo.code;
  if (!code) return '';
  return [
    say('bot_code', lang).replace('{CODE}', code),
    say('bot_code_forward', lang)
      .replace('{CODE}', code)
      .replace('{LINK}', 'https://diwali.artindia.be/go/buy?cta=team'),
  ].join('\n\n');
}

/**
 * "Tickets sold": how far their code has travelled.
 *
 * The discount object carries `times_redeemed`, so that is the source. Cached
 * for ten minutes: this is a vanity number somebody taps four times in a row,
 * and it is not worth a Ticket Tailor call each time.
 */
export async function salesAnswer(env, kv, person) {
  const lang = person.lang;
  const id = person.promo && person.promo.discountId;
  if (!id) return say('bot_sales_none', lang);

  let orders = null;
  const cached = await kv.get(salesKey(id), 'json');
  if (cached && typeof cached.orders === 'number') {
    orders = cached.orders;
  } else if (String(id).startsWith('dry_')) {
    orders = 0;
  } else {
    try {
      const d = await getDiscount(env, id);
      const n = Number(d && d.times_redeemed);
      if (Number.isFinite(n)) {
        orders = n;
        await kv.put(salesKey(id), JSON.stringify({ orders }),
          { expirationTtl: SALES_CACHE_SECONDS });
      }
    } catch (e) {
      console.error('accred sales lookup failed', id, String(e).slice(0, 160));
    }
  }

  if (orders === null) return say('bot_sales_unknown', lang);
  if (orders === 0) return say('bot_sales_none', lang);
  return say('bot_sales', lang).replace('{ORDERS}', String(orders));
}

export const pendingAnswer = lang => say('bot_pending', lang);

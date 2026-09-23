/**
 * POST /api/chat   Diya on the website
 *
 * The same host as the WhatsApp bot, the same FAQ, the same persona and the
 * same routing tokens — imported, not copied, so the two cannot drift apart.
 * What differs is what a web page is allowed to know: nothing about who is
 * reading it. So the website never says a referral code out loud, never asks
 * for a phone number, and only writes to Brevo when somebody has ticked the
 * box.
 *
 * Request  { session?, lang?, message } | { …, action } | { …, lead } | { …, identify }
 * Response { reply, buttons[], state{known, askedLead}, session, askLead? }
 *
 * Env:
 *   WEB_BOT_ENABLED         kill switch, separate from WA_BOT_ENABLED
 *   WEB_BOT_DAILY_LIMIT     model calls per session per day, default 30
 *   CHAT_SESSION_SECRET     HMAC key for the session token
 *   BREVO_PROSPECTS_LIST_ID list a webchat lead joins, 9
 *   BREVO_BUYERS_LIST_ID    list 12, already set — membership is what makes
 *                           somebody a buyer
 *   ANTHROPIC_API_KEY, WA_BOT_MODEL  shared with the WhatsApp bot
 */

import {
  json, safeEqual, isEmail, truthy, brevo, getContact, upsertContact,
} from './_shared.js';
import {
  askFaq, readAction, confidentLang, tidyAnswer, botKey, webKey, listAll,
  WEB_GREETING, WEB_MENU, LINK_IS_ELSEWHERE, WEB_MY_TICKETS, NO_TICKET_FOR_EMAIL,
  TICKETS_ANSWER, GETTING_THERE_ANSWER, FOOD_ANSWER, PROGRAMME_ANSWER, DRAW_ANSWER,
  ASK_PROMPT, WEB_FALLBACK, LEAD_PROMPT, LEAD_THANKS, WELCOME_BACK,
  DAY_SECONDS, LOG_SECONDS, utcDay, stamp,
} from './_bot.js';

/* Where the widget is allowed to be running. A chat endpoint that answers
   anybody is a chat endpoint somebody else puts on their own site and bills
   to our Anthropic key. */
const ALLOWED = ['https://diwali.artindia.be', 'https://artindia.be', 'https://www.artindia.be'];
const IP_DAILY_CAP = 200;
const TICKETS_URL = 'https://tickets.artindia.be';
const LOG_MESSAGES = 40;

const allowedOrigin = origin =>
  ALLOWED.includes(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin || '');

const cors = origin => ({
  'access-control-allow-origin': allowedOrigin(origin) ? origin : ALLOWED[0],
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
});

const reply = (status, body, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin) },
  });

/* ------------------------------------------------------------- sessions */

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = str => {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
};

async function mac(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body))));
}

const SESSION_HOURS = 24;

/**
 * A session token.
 *
 * Signed so the browser can hold it without being able to promote itself to
 * buyer, and short-lived so a token left on a shared machine stops working by
 * tomorrow. It carries the id, the state and the counter; the email that made
 * somebody a buyer stays in KV, because a token travels and an address should
 * not.
 */
async function mint(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await mac(secret, body)}`;
}

async function open(secret, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  if (!safeEqual(await mac(secret, body), sig)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

const freshSession = () => ({
  id: crypto.randomUUID(),
  iat: Date.now(),
  exp: Date.now() + SESSION_HOURS * 3600 * 1000,
  st: 'anonymous',
  n: 0,
  al: false,
});

/* --------------------------------------------------------------- limits */

/** A caller's address, hashed: enough to count them, not enough to identify them. */
async function ipKey(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(ip));
  return b64url(new Uint8Array(digest)).slice(0, 16);
}

async function bump(kv, key, cap, ttl) {
  if (!kv) return { ok: true, used: 0 };
  const used = Number(await kv.get(key)) || 0;
  if (used >= cap) return { ok: false, used };
  await kv.put(key, String(used + 1), { expirationTtl: ttl });
  return { ok: true, used: used + 1 };
}

/* ----------------------------------------------------------------- brevo */

/** Who this address is to us: a buyer, somebody we know, or a stranger. */
async function lookup(env, email) {
  const buyers = Number(env.BREVO_BUYERS_LIST_ID) || 12;
  let contact = null;
  try { contact = await getContact(env, email); }
  catch (e) { console.error('chat: brevo lookup failed', String(e)); return { error: true }; }
  if (!contact) return { known: false };
  const lists = Array.isArray(contact.listIds) ? contact.listIds : [];
  return { known: true, contact, buyer: lists.includes(buyers) };
}

const firstNameOf = (contact, fallback) =>
  String((contact && contact.attributes && contact.attributes.FIRSTNAME) || fallback || '').trim();

/* "Welcome back, , you have a ticket" is worse than not using a name at all. */
const named = line => line.replace(/\s+,/g, ',').replace(/,\s*,/g, ',');

/* ------------------------------------------------------------------ log */

async function logTurn(kv, sid, entry, about = {}) {
  if (!kv || !sid) return;
  let record = null;
  try { record = await kv.get(webKey.log(sid), 'json'); } catch { /* first turn */ }
  const messages = Array.isArray(record && record.messages) ? record.messages : [];
  messages.push({ ts: new Date().toISOString(), ...entry });
  const next = {
    id: sid,
    ts: (record && record.ts) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lang: about.lang || (record && record.lang) || 'en',
    state: about.state || (record && record.state) || 'anonymous',
    lead: about.lead === undefined ? Boolean(record && record.lead) : Boolean(about.lead),
    buyer: about.buyer === undefined ? Boolean(record && record.buyer) : Boolean(about.buyer),
    messages: messages.slice(-LOG_MESSAGES),
  };
  try { await kv.put(webKey.log(sid), JSON.stringify(next), { expirationTtl: LOG_SECONDS }); }
  catch (e) { console.error('chat: log write failed', String(e)); }
}

/* -------------------------------------------------------------- answers */

const menuButtons = (lang, buyer) =>
  (WEB_MENU[lang] || WEB_MENU.en)[buyer ? 'buyer' : 'guest'].map(([id, label]) => ({ id, label }));

const WHATSAPP_URL = 'https://wa.me/32490616661?text=Hi';

/* The same bot, on their own phone. Offered in the two places it is actually
   useful — when Diya has just introduced herself, and when she has just said
   she cannot help — rather than as a second permanent button on the page. */
const whatsappChip = lang => ({
  id: 'WHATSAPP',
  label: (WEB_MENU[lang] || WEB_MENU.en).whatsapp,
  href: WHATSAPP_URL,
});

/* The two ways to reach a person, offered together whenever Diya cannot
   help. The WhatsApp label differs from the greeting's: there it is an
   invitation to carry on, here it is a hand-over. */
const helpButtons = lang => {
  const copy = WEB_MENU[lang] || WEB_MENU.en;
  return [
    { id: 'CONTACT', label: copy.contact, href: 'mailto:diwali@artindia.be' },
    { id: 'WHATSAPP', label: copy.whatsappHelp, href: WHATSAPP_URL },
  ];
};

/** One canned answer, or '' when the id is not one of ours. */
function cannedAnswer(id, lang) {
  const pick = table => table[lang] || table.en;
  switch (id) {
    case 'TICKETS': return pick(TICKETS_ANSWER);
    case 'GETTING_THERE': return pick(GETTING_THERE_ANSWER);
    case 'FOOD': return pick(FOOD_ANSWER);
    case 'PROGRAMME': return pick(PROGRAMME_ANSWER);
    case 'DRAW': return pick(DRAW_ANSWER);
    case 'ASK': return pick(ASK_PROMPT);
    default: return '';
  }
}

/* ---------------------------------------------------------------- handler */

export const onRequestOptions = ({ request }) =>
  new Response(null, { status: 204, headers: cors(request.headers.get('origin')) });

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('origin');
  if (!allowedOrigin(origin)) {
    console.warn('chat: refused origin', JSON.stringify(String(origin).slice(0, 80)));
    return reply(403, { error: 'forbidden' }, origin);
  }
  if (!env.CHAT_SESSION_SECRET) {
    console.error('chat: CHAT_SESSION_SECRET unset');
    return reply(503, { error: 'not_configured' }, origin);
  }

  let body;
  try { body = await request.json(); }
  catch { return reply(400, { error: 'bad_json' }, origin); }

  const kv = env.REFERRALS || null;
  const session = (await open(env.CHAT_SESSION_SECRET, body.session)) || freshSession();

  /* <html lang> may be a regional tag: nl-BE is Dutch. */
  const pageLang = String(body.lang || '').slice(0, 2).toLowerCase();
  const message = String(body.message || '').trim().slice(0, 1000);
  const lang = confidentLang(message, pageLang);

  /* Server-side state: the email behind a buyer, which never travels. */
  let saved = null;
  if (kv) { try { saved = await kv.get(webKey.session(session.id), 'json'); } catch { /* new */ } }
  const buyer = session.st === 'buyer';

  const out = async (text, buttons = [], extra = {}) => {
    session.exp = Date.now() + SESSION_HOURS * 3600 * 1000;
    if (text) await logTurn(kv, session.id, { dir: 'out', text }, { lang, state: session.st, buyer });
    return reply(200, {
      reply: text,
      buttons,
      state: { known: session.st, askedLead: Boolean(session.al) },
      session: await mint(env.CHAT_SESSION_SECRET, session),
      ...extra,
    }, origin);
  };

  /* --- picking a conversation back up ---
     The widget already has the transcript; it is asking for the buttons,
     which are not stored with it. No greeting, because it has one. */
  if (body.resume) {
    return out('', menuButtons(lang, buyer));
  }

  /* --- the opening --- */
  if (!body.message && !body.action && !body.lead && !body.identify) {
    await logTurn(kv, session.id, { dir: 'sys', text: 'session opened' }, { lang, state: session.st });
    return out(WEB_GREETING[lang] || WEB_GREETING.en,
      menuButtons(lang, buyer).concat(whatsappChip(lang)));
  }

  /* --- identify: who are you, without joining anything --- */
  if (body.identify) {
    const email = String(body.identify.email || '').trim().toLowerCase();
    if (!isEmail(email)) return out(NO_TICKET_FOR_EMAIL[lang] || NO_TICKET_FOR_EMAIL.en);

    const who = await lookup(env, email);
    if (who.buyer) {
      session.st = 'buyer';
      const name = firstNameOf(who.contact, '');
      if (kv) {
        await kv.put(webKey.session(session.id),
          JSON.stringify({ email, name, lang }), { expirationTtl: DAY_SECONDS });
      }
      await logTurn(kv, session.id, { dir: 'in', text: 'identified as a buyer' },
        { lang, state: 'buyer', buyer: true });
      return out(named(WELCOME_BACK(lang, name)), menuButtons(lang, true));
    }
    /* Never creates a contact. Somebody typing an address into a public page
       is not consent to be on a list. */
    return out(NO_TICKET_FOR_EMAIL[lang] || NO_TICKET_FOR_EMAIL.en, menuButtons(lang, false));
  }

  /* --- lead: the only path that writes to Brevo --- */
  if (body.lead) {
    const { name = '', email = '', consent = false } = body.lead;
    const address = String(email).trim().toLowerCase();
    const given = String(name).trim().slice(0, 80);
    session.al = true;

    if (!isEmail(address)) return out(NO_TICKET_FOR_EMAIL[lang] || NO_TICKET_FOR_EMAIL.en);

    const who = await lookup(env, address);
    if (who.buyer) {
      session.st = 'buyer';
      const first = firstNameOf(who.contact, given);
      if (kv) {
        await kv.put(webKey.session(session.id),
          JSON.stringify({ email: address, name: first, lang }), { expirationTtl: DAY_SECONDS });
      }
      await logTurn(kv, session.id, { dir: 'in', text: 'lead form: already a buyer' },
        { lang, state: 'buyer', buyer: true, lead: true });
      /* Already on the buyers list; joining anything else would be noise. */
      return out(named(WELCOME_BACK(lang, first)), menuButtons(lang, true));
    }

    if (!truthy(consent)) {
      /* No tick, no write. Treated as an identify that found nothing. */
      await logTurn(kv, session.id, { dir: 'in', text: 'lead form without consent' }, { lang });
      return out(NO_TICKET_FOR_EMAIL[lang] || NO_TICKET_FOR_EMAIL.en, menuButtons(lang, false));
    }

    const prospects = Number(env.BREVO_PROSPECTS_LIST_ID) || 9;
    const attributes = { LANG: lang, SOURCE: 'webchat' };
    if (given && !firstNameOf(who.contact, '')) attributes.FIRSTNAME = given;
    if (!who.known) attributes.CONVERTED = false;

    const res = await upsertContact(env, address, attributes, [prospects]);
    if (!res.ok) console.error('chat: lead write failed', res.status, res.detail);

    session.st = 'prospect';
    await logTurn(kv, session.id, { dir: 'in', text: 'lead captured' },
      { lang, state: 'prospect', lead: true });
    return out(named(LEAD_THANKS(lang, given || firstNameOf(who.contact, ''))),
      menuButtons(lang, false));
  }

  /* --- buttons, and the tokens the model routes to them --- */
  const act = async (id) => {
    if (id === 'MENU') return out(ASK_PROMPT[lang] || ASK_PROMPT.en, menuButtons(lang, buyer));

    if (id === 'MY_LINK' || id === 'MY_CHANCES') {
      /* Even for a buyer. See LINK_IS_ELSEWHERE. */
      return out(LINK_IS_ELSEWHERE[lang] || LINK_IS_ELSEWHERE.en, menuButtons(lang, buyer));
    }

    if (id === 'MY_TICKETS') {
      if (!buyer || !saved) {
        return out(NO_TICKET_FOR_EMAIL[lang] || NO_TICKET_FOR_EMAIL.en, menuButtons(lang, false));
      }
      const who = await lookup(env, saved.email);
      const a = (who.contact && who.contact.attributes) || {};
      const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
      const children = n(a.CHILD_COUNT);
      return out(WEB_MY_TICKETS(lang, Math.max(0, n(a.TICKET_COUNT) - children), children),
        menuButtons(lang, true));
    }

    const canned = cannedAnswer(id, lang);
    if (!canned) return out(WEB_FALLBACK[lang] || WEB_FALLBACK.en, helpButtons(lang));

    const buttons = menuButtons(lang, buyer);
    if (id === 'TICKETS' && !buyer) {
      buttons.unshift({ id: 'BUY', label: (WEB_MENU[lang] || WEB_MENU.en).buy, href: TICKETS_URL });
    }
    /* Asked once, after a real answer — never on the greeting. */
    const askLead = !session.al && !buyer && id !== 'ASK';
    if (askLead) session.al = true;
    return out(canned, buttons, askLead ? { askLead: true, leadPrompt: LEAD_PROMPT[lang] } : {});
  };

  if (body.action) {
    await logTurn(kv, session.id, { dir: 'in', text: `[${body.action}]` }, { lang, state: session.st });
    return act(String(body.action).toUpperCase().slice(0, 32));
  }

  /* --- free text --- */
  if (!message) return out(ASK_PROMPT[lang] || ASK_PROMPT.en, menuButtons(lang, buyer));
  await logTurn(kv, session.id, { dir: 'in', text: message }, { lang, state: session.st });

  const fallback = WEB_FALLBACK[lang] || WEB_FALLBACK.en;
  const noteUnanswered = async (reason) => {
    if (!kv) return;
    await kv.put(botKey.unanswered(stamp()), JSON.stringify({
      channel: 'web', phone: '', lang, text: message.slice(0, 500), reason,
      at: new Date().toISOString(),
    }), { expirationTtl: LOG_SECONDS });
  };

  if (!truthy(env.WEB_BOT_ENABLED)) {
    return out(fallback, helpButtons(lang));
  }

  const day = utcDay();
  const limit = Number(env.WEB_BOT_DAILY_LIMIT) || 30;
  const perSession = await bump(kv, webKey.count(session.id, day), limit, 2 * DAY_SECONDS);
  const perIp = perSession.ok
    ? await bump(kv, webKey.ip(await ipKey(request), day), IP_DAILY_CAP, 2 * DAY_SECONDS)
    : { ok: false };
  if (!perSession.ok || !perIp.ok) {
    console.warn('chat: rate limited', session.id, perSession.used);
    return out(fallback, helpButtons(lang));
  }

  const { answer, action, reason } = await askFaq(env, {
    text: message, lang, firstContact: session.n === 0, web: true,
  });
  session.n = (session.n || 0) + 1;

  if (action) return act(action);

  if (!answer) {
    await noteUnanswered(reason);
    return out(fallback, helpButtons(lang));
  }

  const askLead = !session.al && !buyer;
  if (askLead) session.al = true;
  return out(tidyAnswer(answer), menuButtons(lang, buyer),
    askLead ? { askLead: true, leadPrompt: LEAD_PROMPT[lang] } : {});
}

export const onRequestGet = ({ request }) =>
  reply(405, { error: 'method_not_allowed' }, request.headers.get('origin'));

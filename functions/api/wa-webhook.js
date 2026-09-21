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
  json, truthy, normalisePhone, getContact, upsertContact, brevo,
  safeEqual, statusKey, STATUS_TTL_SECONDS, codeKey,
} from './_shared.js';
import {
  STOP_RE, HUMAN_RE, MENU_RE, FALLBACK, OPTOUT_CONFIRM, ESCALATION_REPLY,
  NOT_A_BUYER, TICKETS_ANSWER, INFO_ANSWER, GETTING_THERE_ANSWER,
  myLinkReply, myChancesReply, myTicketsReply,
  buildMenu, pickLang, askFaq, sendText, sendToMeta, botKey, isGreeting,
  DAY_SECONDS, KEEP_SECONDS, utcDay, stamp,
} from './_bot.js';

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
export async function findContact(env, phone) {
  if (!phone || !env.BREVO_API_KEY) return null;
  for (const type of ['whatsapp_id', 'phone_id']) {
    try {
      const contact = await getContact(env, phone, type);
      if (contact) return contact;
    } catch (e) {
      console.error('wa-webhook: lookup by', type, 'failed', String(e));
    }
  }
  return null;
}

async function optOut(env, phone, why) {
  if (!phone || !env.BREVO_API_KEY) return false;

  const contact = await findContact(env, phone);
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

/* ---------------------------------------------------------------- inbound */

const ttl = seconds => ({ expirationTtl: seconds });

/** True the second time Meta delivers the same message, and every time after. */
async function alreadyHandled(kv, id) {
  if (!id) return false;
  const key = botKey.message(id);
  if (await kv.get(key)) return true;
  await kv.put(key, new Date().toISOString(), ttl(DAY_SECONDS));
  return false;
}

/* The last five things this number said, for the escalation email. Whoever
   picks it up needs the conversation, not just the sentence that tripped it. */
async function rememberMessage(kv, phone, body) {
  if (!body) return [];
  let history = [];
  try { history = (await kv.get(botKey.history(phone), 'json')) || []; } catch { /* first one */ }
  history.push({ at: new Date().toISOString(), text: String(body).slice(0, 500) });
  history = history.slice(-5);
  await kv.put(botKey.history(phone), JSON.stringify(history), ttl(DAY_SECONDS));
  return history;
}

/**
 * Draw entries.
 *
 * Adults only. TICKET_COUNT counts everyone on the order and CHILD_COUNT the
 * under-12s, and the FAQ promises "every adult ticket is one entry" — so a
 * family of four with two children has two, not four.
 */
function entriesFor(contact, referred) {
  const a = (contact && contact.attributes) || {};
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return Math.max(0, n(a.TICKET_COUNT) - n(a.CHILD_COUNT)) + Math.max(0, referred);
}

const isBuyer = contact => Boolean(
  contact && contact.attributes
  && (contact.attributes.REFERRAL_CODE || Number(contact.attributes.TICKET_COUNT) > 0));

async function refCount(kv, code) {
  if (!code) return 0;
  try { return Number(await kv.get(botKey.refcount(code))) || 0; } catch { return 0; }
}

/**
 * Hand the conversation to a person.
 *
 * The reply promises office hours rather than a time, the escalation is
 * written to KV so /api/wa-unanswered shows it, and the email carries the
 * conversation plus the exact curl that answers it — an escalation nobody can
 * act on from their phone is an escalation that waits until Monday.
 */
async function escalate(env, kv, { phone, lang, name, history }) {
  await sendText(env, phone, ESCALATION_REPLY[lang] || ESCALATION_REPLY.en);

  const record = {
    phone, name: name || '', lang,
    last_message: (history[history.length - 1] || {}).text || '',
    history,
    at: new Date().toISOString(),
  };
  await kv.put(botKey.escalation(stamp()), JSON.stringify(record), ttl(KEEP_SECONDS));

  const to = env.ESCALATION_EMAIL || 'diwali@artindia.be';
  if (!env.BREVO_API_KEY) {
    console.warn('wa-webhook: no Brevo key, escalation email not sent for', phone);
    return;
  }

  const lines = history.map(h => `  ${h.at}  ${h.text}`).join('\n') || '  (no text messages)';
  /* A link, not a curl. Whoever picks this up is holding a phone, and an
     escalation you cannot act on until you are back at a terminal waits until
     Monday. The page carries the number already filled in. */
  const replyUrl = `https://diwali.artindia.be/admin/reply.html?to=${encodeURIComponent(phone)}`;
  const body = [
    `${name || 'A visitor'} (${phone}) asked to speak to the team.`,
    `Language: ${lang}`,
    '',
    'Last messages:',
    lines,
    '',
    'Reply here:',
    `  ${replyUrl}`,
    '',
    'WhatsApp only allows a free reply within 24 hours of their last message.',
  ].join('\n');

  try {
    const res = await brevo(env, '/smtp/email', {
      method: 'POST',
      body: JSON.stringify({
        sender: { email: env.BREVO_SENDER_EMAIL || to, name: 'Diwali WhatsApp bot' },
        to: [{ email: to }],
        subject: `WhatsApp: ${phone} needs a reply`,
        textContent: body,
      }),
    });
    if (!res.ok) console.error('wa-webhook: escalation email failed', res.status, await res.text());
    else console.log('wa-webhook: escalation emailed to', to, 'for', phone);
  } catch (e) {
    console.error('wa-webhook: escalation email threw', String(e));
  }
}

/** The FAQ path, with the per-number daily ceiling in front of it. */
async function answerQuestion(env, kv, { phone, lang, body }) {
  const fallback = FALLBACK[lang] || FALLBACK.en;

  if (!truthy(env.WA_BOT_ENABLED)) {
    await sendText(env, phone, fallback);
    return;
  }

  const day = utcDay();
  const limit = Number(env.WA_BOT_DAILY_LIMIT) || 20;
  const used = Number(await kv.get(botKey.count(phone, day))) || 0;

  if (used >= limit) {
    /* One fallback, then silence for the rest of the day. Somebody who has
       asked twenty questions is not being helped by a twenty-first copy of
       the same apology. */
    const told = botKey.count(phone, day) + ':limited';
    if (!await kv.get(told)) {
      await sendText(env, phone, fallback);
      await kv.put(told, '1', ttl(2 * DAY_SECONDS));
      console.warn('wa-webhook: daily limit reached for', phone, used, '>=', limit);
    }
    return;
  }

  const { answer, reason } = await askFaq(env, { text: body, lang });

  if (!answer) {
    await sendText(env, phone, fallback);
    await kv.put(botKey.unanswered(stamp()), JSON.stringify({
      phone, lang, text: String(body).slice(0, 500), reason, at: new Date().toISOString(),
    }), ttl(KEEP_SECONDS));
    console.log('wa-webhook: unanswered', reason, JSON.stringify(String(body).slice(0, 120)));
    return;
  }

  await sendText(env, phone, answer);
  await kv.put(botKey.count(phone, day), String(used + 1), ttl(2 * DAY_SECONDS));
}

/**
 * One inbound message, start to finish.
 *
 * Order matters and follows the brief: dedupe, then STOP, then who they are
 * and what language, then buttons, then text. STOP is early on purpose — it is
 * the one message that must never be answered by the bot.
 */
async function handleInbound(env, m, value) {
  const kv = env.REFERRALS;
  if (!kv) {
    console.warn('wa-webhook: REFERRALS KV not bound, inbound message ignored');
    return;
  }

  const phone = fromMeta(m.from);
  if (!phone) return;
  if (await alreadyHandled(kv, m.id)) {
    console.log('wa-webhook: duplicate delivery', m.id);
    return;
  }

  const body = String((m.text && m.text.body) || '').trim();
  const buttonId = String(
    (m.interactive && m.interactive.button_reply && m.interactive.button_reply.id)
    || (m.button && m.button.payload) || '').trim();
  const name = ((value.contacts || [])[0] || {}).profile
    ? value.contacts[0].profile.name : '';

  const history = await rememberMessage(kv, phone, body);

  /* STOP first, and nothing else runs. */
  if (STOP_RE.test(body)) {
    await optOut(env, phone, 'stop reply');
    const contact = await findContact(env, phone);
    const lang = pickLang({
      brevoLang: contact && contact.attributes && contact.attributes.LANG,
      cachedLang: await kv.get(botKey.lang(phone)),
      messageText: body,
    });
    await sendText(env, phone, OPTOUT_CONFIRM[lang] || OPTOUT_CONFIRM.en);
    await kv.put(botKey.optout(phone), new Date().toISOString(), ttl(KEEP_SECONDS));
    return;
  }

  /* Any other message re-opens the conversation. WA_OPTIN stays false — that
     is a marketing consent and only a purchase sets it back — but somebody who
     writes to us after opting out is asking a question, not being marketed to. */
  if (await kv.get(botKey.optout(phone))) {
    await kv.delete(botKey.optout(phone));
    console.log('wa-webhook: opted-out number wrote in, conversation re-opened', phone);
  }

  const contact = await findContact(env, phone);
  const lang = pickLang({
    brevoLang: contact && contact.attributes && contact.attributes.LANG,
    cachedLang: await kv.get(botKey.lang(phone)),
    messageText: body,
  });
  await kv.put(botKey.lang(phone), lang, ttl(KEEP_SECONDS));

  const buyer = isBuyer(contact);
  const code = String((contact && contact.attributes && contact.attributes.REFERRAL_CODE) || '');
  const fallback = FALLBACK[lang] || FALLBACK.en;

  /* The menu leads, on the first message in a day and whenever it is asked
     for. The brief describes it both ways round; this is the order its own
     manual test expects.

     A bare "hello" counts as asking for it. It is an opening, not a question,
     so it gets the menu and stops there — putting "I can't answer that here"
     underneath a greeting is the rudest thing the bot can do. */
  const firstToday = !await kv.get(botKey.seen(phone));
  if (firstToday) await kv.put(botKey.seen(phone), '1', ttl(DAY_SECONDS));
  const greeted = isGreeting(body);
  const wantsMenu = MENU_RE.test(body) || greeted;
  if (firstToday || wantsMenu) {
    /* Diya introduces herself on the menu that opens a window, and whenever
       somebody actually says hello — which is when a host introduces herself.
       Tying it to the window alone meant a visitor whose first message of the
       day was a question, and who said "Bonjour" two hours later, never met
       her at all. */
    await sendToMeta(env, buildMenu(phone, lang, buyer, firstToday || greeted));
    if (wantsMenu) return;
  }

  if (buttonId) {
    const notABuyer = NOT_A_BUYER[lang] || NOT_A_BUYER.en;
    switch (buttonId) {
      case 'MY_TICKETS': {
        if (!buyer) { await sendText(env, phone, notABuyer); return; }
        const a = (contact && contact.attributes) || {};
        const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
        const children = n(a.CHILD_COUNT);
        await sendText(env, phone,
          myTicketsReply(lang, Math.max(0, n(a.TICKET_COUNT) - children), children));
        return;
      }
      case 'MY_LINK':
        await sendText(env, phone, code ? myLinkReply(lang, code) : notABuyer);
        return;
      case 'MY_CHANCES': {
        if (!buyer) { await sendText(env, phone, notABuyer); return; }
        const n = entriesFor(contact, await refCount(kv, code));
        await sendText(env, phone, myChancesReply(lang, n));
        return;
      }
      /* TICKETS and INFO are the ids the first menu shipped with. Kept, because
         a menu already sitting in somebody's chat history is still tappable. */
      case 'BUY_TICKETS':
      case 'TICKETS':
        await sendText(env, phone, TICKETS_ANSWER[lang] || TICKETS_ANSWER.en);
        return;
      case 'FESTIVAL_INFO':
      case 'INFO':
        await sendText(env, phone, INFO_ANSWER[lang] || INFO_ANSWER.en);
        return;
      case 'GETTING_THERE':
        await sendText(env, phone, GETTING_THERE_ANSWER[lang] || GETTING_THERE_ANSWER.en);
        return;
      case 'TALK_HUMAN':
        await escalate(env, kv, { phone, lang, name, history });
        return;
      case 'MENU':
        await sendToMeta(env, buildMenu(phone, lang, buyer, firstToday));
        return;
      default:
        console.warn('wa-webhook: unknown button', buttonId);
        await sendText(env, phone, fallback);
        return;
    }
  }

  if (HUMAN_RE.test(body)) {
    await escalate(env, kv, { phone, lang, name, history });
    return;
  }

  /* Images, audio, stickers, a dropped pin: one fallback per day, so an album
     of twelve photos does not get twelve replies. */
  if (!body) {
    if (firstToday) return;   /* the menu they just got is answer enough */
    const told = botKey.seen(phone) + ':media';
    if (!await kv.get(told)) {
      await sendText(env, phone, fallback);
      await kv.put(told, '1', ttl(DAY_SECONDS));
    }
    return;
  }

  await answerQuestion(env, kv, { phone, lang, body });
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
        await handleInbound(env, m, value).catch(e =>
          console.error('wa-webhook: inbound threw', m && m.id, String(e)));
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

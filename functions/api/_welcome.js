/**
 * The buyer welcome message, and everything that decides what it looks like.
 *
 * It lives on its own because three callers now send one: the Ticket Tailor
 * webhook when an order lands, the WhatsApp status webhook when Meta reports
 * the first attempt failed, and the admin backfill for buyers who never got
 * one at all. One set of rules about templates, header images and fallbacks,
 * in one place.
 *
 * Env: WA_TOKEN, WA_PHONE_ID, WA_WABA_ID, WA_TEMPLATE, WA_TEMPLATE_FALLBACK,
 * WA_HEADER_IMAGE_URL, WA_DRY_RUN.
 */

import { truthy, orderKey, findContact, brevo } from './_shared.js';
import { botKey, logMessage, LOG_SECONDS } from './_bot.js';

export const WA_API = 'https://graph.facebook.com/v21.0';

/* The approved template, and the one to fall back to. Both in env so a new
   approval does not need a deploy. */
export const templateName = env => env.WA_TEMPLATE || 'diwali_welcome_en_v2';
export const fallbackName = env => env.WA_TEMPLATE_FALLBACK || 'diwali_welcome_en';

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
export const headerImage = env =>
  env.WA_HEADER_IMAGE_URL || 'https://diwali.artindia.be/img/wa-header.jpg';

/* Numbers Meta will not deliver to at all: not a WhatsApp account, or outside
   the window for a free-form message. A failure with one of these is not a
   template problem and sending the same thing again changes nothing. The
   webhook already turns WA_OPTIN off for them. */
export const DEAD_CODES = new Set([131026, 131047]);

/* The two media errors, kept by name because they are also what arrives
   asynchronously down the status webhook: a header image Meta cannot fetch
   does not fail the send call, it fails the message, minutes later. */
export const MEDIA_ERROR_CODES = new Set([
  131052, // media download error
  131053, // media upload error
]);

/* Meta's codes for "this template cannot be sent as asked". Template shape
   problems, and the two media errors, because a header image Meta cannot fetch
   fails the whole v2 send and the plain v1 template will still go out. */
export const TEMPLATE_ERROR_CODES = new Set([
  132000, // parameter count mismatch
  132001, // template does not exist in this language
  132005, // translated text too long
  132007, // format mismatch
  132012, // parameter format mismatch
  132015, 132016, // paused
  132068, 132069,
  131052, 131053, // media could not be downloaded / uploaded
]);

/* ------------------------------------------------- is the picture there? */

/* Ten minutes, like the template shape. Long enough that a burst of orders
   costs one HEAD, short enough that putting the file back fixes sending
   within the quarter hour rather than at the next deploy. */
const IMAGE_TTL_MS = 10 * 60 * 1000;
const imageCache = new Map();

/** Only for tests: forget what was checked. */
export const clearImageCache = () => imageCache.clear();

/**
 * Can Meta actually fetch the header image?
 *
 * Meta fetches the URL itself, and when it cannot, the send is accepted and
 * the message fails minutes later down the status webhook. That is how 208
 * buyers got nothing: the file was not in the repo, the URL 404ed, and
 * nothing in the send path ever saw an error.
 *
 * So the URL is checked before it is used. Redirects are not followed, and a
 * redirect is a failure: Meta's fetcher is not promised to follow one, and
 * "200 at the URL we hand over" is the only thing worth knowing.
 *
 * Any doubt counts as usable: this check exists to catch a 404, not to stop
 * the welcome going out because a HEAD request timed out.
 */
export async function headerImageUsable(env, url = headerImage(env)) {
  const hit = imageCache.get(url);
  if (hit && Date.now() - hit.at < IMAGE_TTL_MS) return hit.result;

  let result = { ok: true, why: 'unchecked' };
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (res.status >= 300 && res.status < 400) {
      result = { ok: false, why: `redirect_${res.status}`, status: res.status };
    } else if (!res.ok) {
      result = { ok: false, why: `http_${res.status}`, status: res.status };
    } else if (!type.startsWith('image/')) {
      result = { ok: false, why: `not_an_image:${type.split(';')[0] || 'none'}`, status: res.status };
    } else {
      result = { ok: true, why: '', status: res.status, type };
    }
  } catch (e) {
    /* Could not ask. Not evidence of a bad image, so v2 still goes out and
       the fallback stays where it was: behind Meta's own answer. */
    console.warn('wa header image check threw', url, String(e).slice(0, 120));
    result = { ok: true, why: 'check_failed' };
  }

  if (!result.ok) console.error('wa header image unusable', url, result.why);
  imageCache.set(url, { at: Date.now(), result });
  return result;
}

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

export async function templateShape(env, name) {
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
export function buildV2(name, shape, { phone, firstName, code, image }) {
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
export const buildV1 = (name, { phone, firstName, code }) => ({
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
export async function postToMeta(env, payload) {
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
export async function sendWelcome(env, kv, { orderId, phone, firstName, code }) {
  const already = await kv.get(orderKey(orderId), 'json');
  if (already) {
    return {
      sent: false, reason: 'already_sent', to: phone,
      messageId: already.waMessageId, template: already.template,
    };
  }

  const name = templateName(env);
  const older = fallbackName(env);

  /* Ask about the picture before building a message around it. A v2 send with
     a header Meta cannot fetch is accepted, then fails silently minutes later;
     the older template has no header and always goes. */
  const image = headerImage(env);
  const picture = await headerImageUsable(env, image);

  const shape = picture.ok ? await templateShape(env, name) : null;
  let used = picture.ok ? name : older;
  let skipped = picture.ok ? '' : picture.why;
  let payload = picture.ok
    ? buildV2(name, shape, { phone, firstName, code, image })
    : buildV1(older, { phone, firstName, code });

  if (!picture.ok) {
    console.error('wa welcome: header image', image, 'is unusable (', picture.why,
      ') — sending', older, 'instead of', name);
  }

  if (truthy(env.WA_DRY_RUN)) {
    /* Nothing is written to KV on a dry run, so the same order can be replayed
       as often as it takes to get the mapping right. Only the first attempt is
       previewed: whether Meta would have refused it is exactly the thing a dry
       run cannot tell you. */
    console.log('wa dry-run', orderId, JSON.stringify(payload));
    return {
      sent: false, reason: 'dry_run', to: phone, template: used,
      preview: payload, ...(skipped ? { imageUnusable: skipped } : {}),
    };
  }

  /* Every attempt, in order, kept on the record. "It fell back" is a fact
     somebody needs months later; "it was tried twice and this is what Meta
     said each time" is the one that answers the question. */
  const attempts = [];
  const attempt = async (template, body) => {
    const r = await postToMeta(env, body);
    attempts.push({
      template, at: new Date().toISOString(), ok: r.ok,
      ...(r.messageId ? { messageId: r.messageId } : {}),
      ...(r.ok ? {} : { code: r.code, status: r.status, error: oneLine(r.error) }),
    });
    return r;
  };

  let fellBack = !picture.ok;
  let res = await attempt(used, payload);

  if (!res.ok && used !== older && TEMPLATE_ERROR_CODES.has(res.code)) {
    console.error('wa template', name, 'refused with', res.code,
      JSON.stringify(res.error), '— falling back to', older);
    used = older;
    fellBack = true;
    res = await attempt(older, buildV1(older, { phone, firstName, code }));
  }

  if (!res.ok) {
    console.error('wa send failed', orderId, used, res.status, JSON.stringify(res.error));
    return {
      sent: false, reason: 'send_failed', to: phone,
      status: res.status, error: res.error, template: used, fellBack, attempts,
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
    await putWelcome(kv, {
      phone, ts: sentAt, name: firstName, template: used,
      waMessageId: res.messageId, orderId, code,
      status: 'sent', last_status_ts: sentAt, attempts,
      ...(skipped ? { imageUnusable: skipped } : {}),
    });
    await logMessage(kv, phone,
      { dir: 'out', kind: 'template', text: `${used} (welcome)` },
      { name: firstName, buyer: true });
  } catch (e) {
    console.error('tt-order: welcome log failed', String(e));
  }

  console.log('wa sent', orderId, used, res.messageId, fellBack ? '(fallback)' : '');
  return {
    sent: true, to: phone, messageId: res.messageId, template: used,
    fellBack, attempts, ...(skipped ? { imageUnusable: skipped } : {}),
  };
}

/* -------------------------------------------------------- the second try */

/** Meta's error object, or whatever came back, as one short line. */
export const oneLine = err => (err && err.message
  ? `${err.code || ''} ${err.message}`.trim()
  : String(typeof err === 'string' ? err : JSON.stringify(err || '')).slice(0, 200));

/** One welcome record, written with the log's lifetime. */
export const putWelcome = (kv, record) =>
  kv.put(botKey.welcome(record.phone), JSON.stringify(record),
    { expirationTtl: LOG_SECONDS });

/**
 * Send the plain template to somebody whose welcome failed, once.
 *
 * Used by the status webhook when Meta reports the first attempt dead, and by
 * the backfill for buyers who never got one at all. It is deliberately the v1
 * template every time: this runs because something about v2 did not work, and
 * a second attempt at the thing that just failed helps nobody.
 *
 * `reason` says what sent it, and lands on the record beside the attempts.
 * Returns `{ sent, reason, ... }` and never throws: every caller is already
 * handling something that went wrong.
 */
export async function sendFallbackWelcome(env, kv, { phone, firstName, code, reason }) {
  const older = fallbackName(env);

  if (truthy(env.WA_DRY_RUN)) {
    console.log('wa fallback dry-run', phone, older, reason);
    return { sent: false, reason: 'dry_run', to: phone, template: older };
  }
  if (!env.WA_TOKEN || !env.WA_PHONE_ID) {
    return { sent: false, reason: 'not_configured', to: phone };
  }
  if (!code) return { sent: false, reason: 'no_referral_code', to: phone };

  let res;
  try {
    res = await postToMeta(env, buildV1(older, { phone, firstName, code }));
  } catch (e) {
    console.error('wa fallback threw', phone, String(e).slice(0, 200));
    return { sent: false, reason: 'threw', to: phone, error: String(e).slice(0, 200) };
  }

  const at = new Date().toISOString();
  const entry = {
    template: older, at, ok: res.ok, by: reason,
    ...(res.messageId ? { messageId: res.messageId } : {}),
    ...(res.ok ? {} : { code: res.code, status: res.status, error: oneLine(res.error) }),
  };

  try {
    const held = (await kv.get(botKey.welcome(phone), 'json')) || { phone, ts: at };
    await putWelcome(kv, {
      ...held,
      phone,
      name: held.name || firstName || '',
      attempts: [...(Array.isArray(held.attempts) ? held.attempts : []), entry],
      /* The record now follows the new message: a delivery report carries a
         message id, and the status on this record has to be the status of
         whatever actually went out last. */
      ...(res.ok ? {
        template: older,
        waMessageId: res.messageId,
        status: 'sent',
        last_status_ts: at,
        errors: [],
      } : {}),
      retriedAt: at,
      retriedBy: reason,
    });
    if (res.ok) {
      await logMessage(kv, phone,
        { dir: 'out', kind: 'template', text: `${older} (welcome, second try)` },
        { name: firstName, buyer: true });
    }
  } catch (e) {
    console.error('wa fallback: log failed', phone, String(e).slice(0, 200));
  }

  if (!res.ok) {
    console.error('wa fallback failed', phone, reason, res.status, JSON.stringify(res.error));
    return { sent: false, reason: 'send_failed', to: phone, status: res.status, error: res.error };
  }
  console.log('wa fallback sent', phone, older, res.messageId, 'because', reason);
  return { sent: true, to: phone, messageId: res.messageId, template: older };
}

/**
 * The referral code to put in a second attempt.
 *
 * On the record for anything sent since this was written. The 208 welcomes
 * that failed before it were stored without one, so Brevo is asked: the code
 * is on the contact, and the contact is findable by number.
 */
export async function codeFor(env, held) {
  if (held && held.code) return String(held.code);
  const contact = await findContact(env, held && held.phone);
  const code = contact && contact.attributes && contact.attributes.REFERRAL_CODE;
  return code ? String(code) : '';
}

/**
 * A welcome that Meta has just reported dead, given a second chance.
 *
 * This is the half of the fallback that was missing. The send path falls back
 * when Meta refuses the call; a header image Meta cannot fetch is not refused
 * there at all. The call succeeds, and the failure arrives minutes later down
 * the status webhook, where nothing was listening. That is how 208 welcomes
 * were sent, accepted and never delivered, with the fallback never running.
 *
 * Once per record, whatever happens to the second attempt: a number Meta
 * cannot reach must not become a message every status report sends again.
 */
export async function retryFailedWelcome(env, kv, { phone, status }) {
  if (!kv || !phone) return { sent: false, reason: 'no_kv' };

  const held = await kv.get(botKey.welcome(phone), 'json');
  if (!held) return { sent: false, reason: 'not_a_welcome' };

  /* The report has to be about the message this record is currently waiting
     on. A late report for the first attempt, after the second has gone out,
     is history. */
  if (status.id && held.waMessageId && status.id !== held.waMessageId) {
    return { sent: false, reason: 'older_message' };
  }
  if (held.retriedAt) return { sent: false, reason: 'already_retried' };

  /* A message that was delivered, or read, and is only now being reported as
     failed. Meta does send these, and sending the welcome a second time to
     somebody who has already read it is worse than the bug this fixes. */
  if (!neverArrived({ ...held, status: 'failed' })) {
    return { sent: false, reason: 'already_arrived' };
  }

  const codes = (status.errors || []).map(e => Number(e.code)).filter(Boolean);
  const retryable = codes.some(c => MEDIA_ERROR_CODES.has(c) || TEMPLATE_ERROR_CODES.has(c));
  if (!retryable) return { sent: false, reason: 'not_retryable', codes };

  const code = await codeFor(env, held);
  if (!code) {
    console.error('wa retry: no referral code for', phone, '— nothing to send');
    return { sent: false, reason: 'no_referral_code' };
  }

  console.log('wa retry: welcome to', phone, 'failed with', codes.join(','),
    '— sending the plain template');
  return sendFallbackWelcome(env, kv, {
    phone, firstName: held.name, code,
    reason: `status_${codes[0] || 'failed'}`,
  });
}

/* -------------------------------------------------------------- the state */

/**
 * Did this welcome ever reach the person?
 *
 * The latest status is what Meta last said, and a record that has ever been
 * delivered or read carries the stamp for it, so a late failure report on an
 * old message cannot make a message that arrived look like one that did not.
 */
export function neverArrived(w) {
  if (!w) return false;
  if (w.deliveredAt || w.readAt) return false;
  const st = String(w.status || 'sent');
  if (st === 'delivered' || st === 'read') return false;
  return st === 'failed';
}

/* ------------------------------------------------------------- the alarm */

/* Twenty is enough to tell a broken template from one buyer with a dead
   number, and few enough that a page can read them without a wait. */
export const HEALTH_WINDOW = 20;
export const HEALTH_THRESHOLD = 0.2;

/**
 * How the last few welcomes went, and whether that is worth shouting about.
 *
 * It exists because the failure it reports hid for weeks. Every welcome was
 * failing, the counts said so, and nothing anywhere turned that into a
 * sentence somebody would read. A number in a column is not an alarm.
 */
export function welcomeHealth(welcomes) {
  const recent = [...(welcomes || [])]
    .filter(w => w && w.ts)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, HEALTH_WINDOW);

  const failed = recent.filter(w => String(w.status) === 'failed');
  const reasons = new Map();
  for (const w of failed) {
    for (const e of w.errors || []) {
      const key = `${e.code || '?'}|${e.title || e.message || 'no reason given'}`;
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
  }

  const rate = recent.length ? failed.length / recent.length : 0;
  return {
    window: recent.length,
    failed: failed.length,
    percent: Math.round(rate * 100),
    /* Never on an empty sample: one failure out of one is not a pattern. */
    alarm: recent.length >= 5 && rate > HEALTH_THRESHOLD,
    reasons: [...reasons.entries()]
      .map(([k, count]) => {
        const [code, title] = k.split('|');
        return { code: Number(code) || null, title, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 3),
  };
}

/* ------------------------------------------------------- the daily email */

const alertKey = day => `bot:welcome:alert:${day}`;

/**
 * Once a day, if welcomes are failing, say so to a person.
 *
 * There is no scheduler here — this is a static site with Functions, and
 * nothing runs on its own. So it rides on whatever request comes next: the
 * status webhook, or an admin opening the dashboard. The day key is written
 * before the email is sent, so a burst of webhooks produces one message and
 * not forty.
 */
export async function maybeDailyWelcomeAlert(env, kv, welcomes) {
  if (!kv || !env.BREVO_API_KEY) return { sent: false, reason: 'not_configured' };

  const day = new Date().toISOString().slice(0, 10);
  if (await kv.get(alertKey(day))) return { sent: false, reason: 'already_today' };

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const failed = (welcomes || []).filter(w => w
    && String(w.status) === 'failed'
    && String(w.last_status_ts || w.ts || '') >= since);
  if (!failed.length) return { sent: false, reason: 'nothing_failed' };

  /* Claimed first. An email that goes out twice is worse than one that is
     lost when a write fails, because the second one teaches people to ignore
     the first. */
  try {
    await kv.put(alertKey(day), new Date().toISOString(), { expirationTtl: 3 * 24 * 3600 });
  } catch (e) {
    console.error('wa alert: could not claim the day', String(e).slice(0, 120));
    return { sent: false, reason: 'claim_failed' };
  }

  const health = welcomeHealth(welcomes);
  const reasons = health.reasons.length
    ? health.reasons.map(r => `  ${r.code || ''} ${r.title} (${r.count})`).join('\n')
    : '  Meta gave no reason.';

  const to = env.ESCALATION_EMAIL || 'diwali@artindia.be';
  const body = [
    `${failed.length} buyer welcome message${failed.length === 1 ? '' : 's'} failed in the last 24 hours.`,
    '',
    `Of the last ${health.window} welcomes, ${health.failed} failed (${health.percent}%).`,
    '',
    "What Meta said:",
    reasons,
    '',
    'The list, and the button that sends them again:',
    '  https://diwali.artindia.be/admin/wa',
    '',
    'A welcome that fails for a template or header-image reason is retried once',
    'automatically with the plain template. This email is the ones that are left.',
  ].join('\n');

  try {
    const res = await brevo(env, '/smtp/email', {
      method: 'POST',
      body: JSON.stringify({
        sender: { email: env.BREVO_SENDER_EMAIL || to, name: 'Diwali WhatsApp' },
        to: [{ email: to }],
        subject: `${failed.length} welcome message${failed.length === 1 ? '' : 's'} failed yesterday`,
        textContent: body,
      }),
    });
    if (!res.ok) {
      console.error('wa alert: email failed', res.status, (await res.text()).slice(0, 200));
      return { sent: false, reason: `brevo_${res.status}`, failed: failed.length };
    }
  } catch (e) {
    console.error('wa alert: email threw', String(e).slice(0, 200));
    return { sent: false, reason: 'threw', failed: failed.length };
  }

  console.log('wa alert: emailed', to, 'about', failed.length, 'failed welcomes');
  return { sent: true, to, failed: failed.length };
}

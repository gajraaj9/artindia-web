/**
 * GET /api/wa-admin   everything the dashboard shows, in one call
 *
 * Three lists and a switch position:
 *   conversations  one row per phone, newest activity first
 *   welcomes       one row per buyer the welcome template went to
 *   unanswered     questions the bot could not answer, and escalations
 *
 *   curl -H "X-Admin-Token: $WA_ADMIN_TOKEN" \
 *     https://diwali.artindia.be/api/wa-admin
 *
 * One call rather than three because it is read from a phone, often on 4G at
 * a venue, and three round trips there is three chances to stall.
 *
 * Env: WA_ADMIN_TOKEN. Needs the REFERRALS KV binding.
 */

import { json, truthy, waAdmin, waAdminConfigured } from './_shared.js';
import { botKey, listAll, webKey } from './_bot.js';
import {
  welcomeHealth, maybeDailyWelcomeAlert, neverArrived, DEAD_CODES,
} from './_welcome.js';

/* A dashboard is a glance, not an archive. Past this many conversations the
   page is unreadable anyway and /api/wa-unanswered is the tool for digging. */
const MAX_CONVERSATIONS = 300;
const MAX_WELCOMES = 500;
const MAX_QUESTIONS = 200;
const MAX_WEB_SESSIONS = 300;

/**
 * Read many keys at once. KV is per-key, so this is where the time goes.
 *
 * The key comes back with the value because for the question keys the
 * timestamp only exists in the key — `bot:unanswered:<ISO>-<n>` — and that is
 * what the list is sorted by.
 */
async function getMany(kv, keys) {
  const out = [];
  /* Twenty at a time: enough concurrency to be quick, not so much that a
     large account trips KV's limits. */
  for (let i = 0; i < keys.length; i += 20) {
    const batch = await Promise.all(keys.slice(i, i + 20).map(async key => {
      try { return { key, value: await kv.get(key, 'json') }; } catch { return null; }
    }));
    for (const row of batch) if (row && row.value) out.push(row);
  }
  return out;
}

/** A question row, with its timestamp taken off the key when the value lacks one. */
const question = (kind, prefix) => ({ key, value }) => ({
  kind,
  at: value.at || key.slice(prefix.length),
  ...value,
});

const newestFirst = field => (a, b) =>
  String(b[field] || '').localeCompare(String(a[field] || ''));

export async function onRequestGet({ request, env }) {
  if (!waAdminConfigured(env)) {
    console.error('wa-admin: no admin tokens set, refusing every request');
    return json(503, { ok: false, error: 'not_configured' });
  }
  /* A named admin or the shared WhatsApp token. A view-only token is not an
     admin here and never will be: these endpoints send messages. */
  const who = waAdmin(env, request.headers.get('x-admin-token'));
  if (!who) return json(401, { ok: false, error: 'unauthorized' });
  if (!env.REFERRALS) return json(503, { ok: false, error: 'kv_not_bound' });

  const kv = env.REFERRALS;
  let logs, welcomes, questions, webSessions;
  try {
    const [logKeys, welcomeKeys, unansweredKeys, escalationKeys, webKeys] = await Promise.all([
      listAll(kv, 'bot:log:', MAX_CONVERSATIONS),
      listAll(kv, 'bot:welcome:', MAX_WELCOMES),
      listAll(kv, botKey.unanswered(''), MAX_QUESTIONS),
      listAll(kv, botKey.escalation(''), MAX_QUESTIONS),
      listAll(kv, webKey.log(''), MAX_WEB_SESSIONS),
    ]);
    const [l, w, u, e, wb] = await Promise.all([
      getMany(kv, logKeys),
      getMany(kv, welcomeKeys),
      getMany(kv, unansweredKeys),
      getMany(kv, escalationKeys),
      getMany(kv, webKeys),
    ]);
    webSessions = wb.map(r => r.value);
    logs = l.map(r => r.value);
    welcomes = w.map(r => r.value);
    questions = [
      ...u.map(question('unanswered', botKey.unanswered(''))),
      ...e.map(question('escalation', botKey.escalation(''))),
    ];
  } catch (err) {
    console.error('wa-admin: read failed', String(err));
    return json(500, { ok: false, error: 'kv_read' });
  }

  const conversations = logs
    .map(c => {
      const messages = Array.isArray(c.messages) ? c.messages : [];
      const last = messages[messages.length - 1] || null;
      return {
        phone: c.phone,
        name: c.name || '',
        buyer: Boolean(c.buyer),
        lang: c.lang || '',
        updatedAt: c.updatedAt || (last && last.ts) || '',
        count: messages.length,
        /* The only thing on this page that is a call to action: the last word
           was theirs, so somebody still owes them one. */
        needsReply: Boolean(last && last.dir === 'in'),
        last,
        messages,
      };
    })
    .sort(newestFirst('updatedAt'));

  const counts = { sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const w of welcomes) {
    const st = String(w.status || 'sent');
    if (counts[st] === undefined) counts[st] = 0;
    counts[st] += 1;
  }

  /* Buyers whose welcome never arrived, counted here because the page should
     not have to work it out and because the number is the whole point: a
     column of failures is a statistic, "41 buyers never got it" is a job. */
  const couldRetry = welcomes.filter(w => neverArrived(w)
    && !w.retriedAt
    && !(w.errors || []).some(e => DEAD_CODES.has(Number(e.code))));
  /* Minus anybody who answered STOP. One read each, and there are never many:
     the whole point of the number is that it should be small. */
  const missing = [];
  for (const w of couldRetry) {
    if (!(await kv.get(botKey.optout(w.phone)))) missing.push(w);
  }
  const health = welcomeHealth(welcomes);

  /* Nothing here runs on a schedule, so the alert rides on whoever opens the
     page. It writes the day before it sends, so this costs one email. */
  if (health.failed) {
    await maybeDailyWelcomeAlert(env, kv, welcomes)
      .catch(e => console.error('wa-admin: alert threw', String(e).slice(0, 160)));
  }

  /* The web tab. Counted here rather than in the page, so the phone on 4G is
     handed numbers instead of three hundred transcripts to add up. */
  const now = Date.now();
  const since = days => new Date(now - days * 24 * 3600 * 1000).toISOString();
  const web = {
    sessions_today: webSessions.filter(x => (x.updatedAt || x.ts || '') >= since(1)).length,
    sessions_7d: webSessions.filter(x => (x.updatedAt || x.ts || '') >= since(7)).length,
    leads: webSessions.filter(x => x.lead).length,
    buyers: webSessions.filter(x => x.buyer).length,
    unanswered: questions.filter(q => q.channel === 'web').length,
    sessions: webSessions
      .map(x => ({
        id: x.id,
        ts: x.ts,
        updatedAt: x.updatedAt || x.ts,
        lang: x.lang || '',
        state: x.state || 'anonymous',
        lead: Boolean(x.lead),
        buyer: Boolean(x.buyer),
        count: (x.messages || []).length,
        messages: x.messages || [],
      }))
      .sort(newestFirst('updatedAt')),
  };

  return json(200, {
    ok: true,
    web_bot_enabled: truthy(env.WEB_BOT_ENABLED),
    web,
    /* The switch position, so the page can say so rather than leaving someone
       to wonder why every question is getting the fallback. */
    bot_enabled: truthy(env.WA_BOT_ENABLED),
    model: env.WA_BOT_MODEL || null,
    daily_limit: Number(env.WA_BOT_DAILY_LIMIT) || 20,
    generated_at: new Date().toISOString(),
    conversations,
    welcomes: welcomes.sort(newestFirst('ts')),
    welcome_counts: counts,
    welcome_health: health,
    welcome_missing: missing.length,
    wa_dry_run: truthy(env.WA_DRY_RUN),
    questions: questions.sort(newestFirst('at')),
  });
}

export const onRequestPost = () => json(405, { ok: false, error: 'method_not_allowed' });

/**
 * GET  /api/wa-welcome    who never got their welcome, and how the job is going
 * POST /api/wa-welcome    { action: "start" | "run" | "stop" | "resume" }
 *
 * The repair crew for a welcome that never arrived.
 *
 * 208 buyers were sent a welcome that Meta accepted and never delivered: the
 * template's header image was a 404, which Meta reports through the status
 * webhook minutes later rather than in the answer to the send. Nothing in the
 * send path could have seen it. This is how those buyers get their message.
 *
 *   curl -X POST https://diwali.artindia.be/api/wa-welcome \
 *     -H "X-Admin-Token: $WA_ADMIN_TOKEN" \
 *     -H 'content-type: application/json' -d '{"action":"start"}'
 *
 * It sends in small batches, one request each, because a Worker has a budget
 * for outbound calls and 208 messages is well past it. The page asks for the
 * next batch until the job says it is done, which also makes it stoppable
 * between batches and resumable afterwards.
 *
 * Nobody is sent to twice. The second attempt is recorded on the buyer's own
 * welcome record as `retriedAt`, by this and by the status webhook alike, and
 * a record that carries one is skipped.
 *
 * Env: WA_ADMIN_TOKEN / TEAM_ADMIN_TOKENS, WA_TOKEN, WA_PHONE_ID, WA_DRY_RUN.
 * Needs the REFERRALS KV binding.
 */

import { json, truthy, waAdmin, waAdminConfigured } from './_shared.js';
import { botKey, listAll } from './_bot.js';
import { sendFallbackWelcome, codeFor, neverArrived, DEAD_CODES } from './_welcome.js';

/* The job, under its own prefix. Not `bot:welcome:` anything: that prefix is
   listed to find the buyers, and the job is not a buyer. */
const JOB_KEY = 'bot:wbackfill:job';
const JOB_TTL_SECONDS = 14 * 24 * 3600;

/* Ten a request. Each one costs a KV read, a Meta send and a KV write, and a
   Worker is only promised fifty outbound calls; ten leaves room for the job
   record and for a Brevo lookup where the referral code is not on the record
   yet. Meta's own limit is far higher than anything this reaches. */
export const BATCH = 10;

/* A breath between sends. Not for Meta's sake, which would take this all at
   once, but so a burst of two hundred messages arrives like a person sending
   them rather than like a system discovering a bug. */
const PACE_MS = 150;

const nap = ms => new Promise(r => setTimeout(r, ms));

const blank = () => ({
  running: false, startedAt: '', finishedAt: '', by: '',
  cursor: 0, total: 0, queue: [],
  sent: 0, failed: 0, skipped: 0, dryRun: 0, errors: [],
});

const readJob = async kv => (await kv.get(JOB_KEY, 'json')) || blank();
const writeJob = (kv, job) =>
  kv.put(JOB_KEY, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });

/* What the page shows. The queue itself is two hundred phone numbers and has
   no business crossing the wire. */
const view = job => ({
  running: Boolean(job.running),
  startedAt: job.startedAt || '',
  finishedAt: job.finishedAt || '',
  by: job.by || '',
  done: Math.min(job.cursor || 0, job.total || 0),
  total: job.total || 0,
  sent: job.sent || 0,
  failed: job.failed || 0,
  skipped: job.skipped || 0,
  dry_run: job.dryRun || 0,
  errors: (job.errors || []).slice(-5),
});

/**
 * Every buyer whose welcome never arrived.
 *
 * One record per number by construction: the key is the number. A number that
 * answered STOP is left alone, and so is one Meta says is not on WhatsApp —
 * both are opted out, one by choice and one by fact, and sending again would
 * only fail again.
 */
export async function missingWelcomes(kv) {
  const keys = await listAll(kv, botKey.welcome(''), 4000);
  const out = [];
  const unreachable = [];
  const alreadyRetried = [];

  for (const key of keys) {
    let w = null;
    try { w = await kv.get(key, 'json'); } catch { continue; }
    if (!w || !w.phone) continue;
    if (!neverArrived(w)) continue;

    if ((w.errors || []).some(e => DEAD_CODES.has(Number(e.code)))) {
      unreachable.push(w.phone);
      continue;
    }
    if (w.retriedAt) { alreadyRetried.push(w.phone); continue; }
    if (await kv.get(botKey.optout(w.phone))) continue;

    out.push({ phone: w.phone, name: w.name || '' });
  }
  return { candidates: out, unreachable, alreadyRetried };
}

/* ------------------------------------------------------------------- one */

/**
 * One buyer, if they still need it.
 *
 * The record is read again here rather than trusted from the queue: the queue
 * was built minutes ago, and between then and now the status webhook may have
 * sent this very person their second message.
 */
async function sendOne(env, kv, { phone, name }) {
  let held = null;
  try { held = await kv.get(botKey.welcome(phone), 'json'); } catch { /* below */ }
  if (!held) return { outcome: 'skipped', why: 'no_record' };
  if (held.retriedAt) return { outcome: 'skipped', why: 'already_retried' };
  if (!neverArrived(held)) return { outcome: 'skipped', why: 'arrived' };

  const code = await codeFor(env, held);
  if (!code) return { outcome: 'failed', why: 'no_referral_code' };

  const r = await sendFallbackWelcome(env, kv, {
    phone, firstName: held.name || name, code, reason: 'backfill',
  });
  if (r.sent) return { outcome: 'sent' };
  if (r.reason === 'dry_run') return { outcome: 'dry_run' };
  return { outcome: 'failed', why: r.reason || 'send_failed' };
}

/** One batch, from the cursor. Returns the job as it now stands. */
async function runBatch(env, kv, job) {
  const slice = (job.queue || []).slice(job.cursor, job.cursor + BATCH);

  for (const person of slice) {
    const r = await sendOne(env, kv, person);
    job.cursor += 1;
    if (r.outcome === 'sent') job.sent += 1;
    else if (r.outcome === 'dry_run') job.dryRun += 1;
    else if (r.outcome === 'skipped') job.skipped += 1;
    else {
      job.failed += 1;
      job.errors = [...(job.errors || []), { phone: person.phone, why: r.why }].slice(-20);
    }
    if (job.cursor < job.total) await nap(PACE_MS);
  }

  if (job.cursor >= job.total) {
    job.running = false;
    job.finishedAt = new Date().toISOString();
  }
  await writeJob(kv, job);
  return job;
}

/* --------------------------------------------------------------- handlers */

function guard(request, env) {
  if (!waAdminConfigured(env)) {
    console.error('wa-welcome: no admin tokens set, refusing every request');
    return { res: json(503, { ok: false, error: 'not_configured' }) };
  }
  const who = waAdmin(env, request.headers.get('x-admin-token'));
  if (!who) return { res: json(401, { ok: false, error: 'unauthorized' }) };
  if (!env.REFERRALS) return { res: json(503, { ok: false, error: 'kv_not_bound' }) };
  return { who };
}

export async function onRequestGet({ request, env }) {
  const g = guard(request, env);
  if (g.res) return g.res;

  const kv = env.REFERRALS;
  const [{ candidates, unreachable, alreadyRetried }, job] = await Promise.all([
    missingWelcomes(kv), readJob(kv),
  ]);

  return json(200, {
    ok: true,
    missing: candidates.length,
    unreachable: unreachable.length,
    already_retried: alreadyRetried.length,
    dry_run: truthy(env.WA_DRY_RUN),
    job: view(job),
  });
}

export async function onRequestPost({ request, env }) {
  const g = guard(request, env);
  if (g.res) return g.res;

  const kv = env.REFERRALS;
  let body = {};
  try { body = await request.json(); } catch { /* an empty body is a status call */ }
  const action = String((body && body.action) || 'status');

  let job = await readJob(kv);

  if (action === 'status') return json(200, { ok: true, job: view(job) });

  if (action === 'stop') {
    job.running = false;
    await writeJob(kv, job);
    console.log('wa-welcome: stopped by', g.who.name || 'an admin',
      'at', job.cursor, 'of', job.total);
    return json(200, { ok: true, job: view(job) });
  }

  if (action === 'start') {
    /* A job that is still running is not restarted from the top: that is how
       somebody gets two messages. Press Resume. */
    if (job.running && job.cursor < job.total) {
      return json(409, { ok: false, error: 'already_running', job: view(job) });
    }
    const { candidates } = await missingWelcomes(kv);
    job = {
      ...blank(),
      running: candidates.length > 0,
      startedAt: new Date().toISOString(),
      by: g.who.name || 'admin',
      queue: candidates,
      total: candidates.length,
    };
    if (!candidates.length) {
      job.finishedAt = job.startedAt;
      await writeJob(kv, job);
      return json(200, { ok: true, job: view(job) });
    }
    console.log('wa-welcome: starting', candidates.length, 'for', job.by,
      truthy(env.WA_DRY_RUN) ? '(dry run)' : '');
    await writeJob(kv, job);
    job = await runBatch(env, kv, job);
    return json(200, { ok: true, job: view(job) });
  }

  if (action === 'resume') {
    if (!job.total || job.cursor >= job.total) {
      return json(200, { ok: true, job: view(job) });
    }
    job.running = true;
    job.finishedAt = '';
    await writeJob(kv, job);
    job = await runBatch(env, kv, job);
    return json(200, { ok: true, job: view(job) });
  }

  if (action === 'run') {
    /* Stopped means stopped. The page can be mid-loop when somebody presses
       it, and the batch already in flight is the last one. */
    if (!job.running) return json(200, { ok: true, job: view(job) });
    if (job.cursor >= job.total) {
      job.running = false;
      job.finishedAt = job.finishedAt || new Date().toISOString();
      await writeJob(kv, job);
      return json(200, { ok: true, job: view(job) });
    }
    job = await runBatch(env, kv, job);
    return json(200, { ok: true, job: view(job) });
  }

  return json(400, { ok: false, error: 'unknown_action', action });
}

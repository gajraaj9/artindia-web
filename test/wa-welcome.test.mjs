/**
 * The welcome message: the picture it carries, the second attempt when Meta
 * cannot fetch it, and the button that catches up the buyers who got nothing.
 *
 * All of this exists because of one bug. /img/wa-header.jpg was never in the
 * repo, the build only warned, Meta accepted every send and then failed every
 * message minutes later down the status webhook, where nothing was listening.
 * 208 buyers were welcomed to a festival and heard nothing. Each test below
 * is one of the places that failure was able to pass through.
 *
 * Nothing here touches the network: fetch is replaced in every test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  headerImageUsable, clearImageCache, welcomeHealth, neverArrived,
  maybeDailyWelcomeAlert, sendFallbackWelcome, retryFailedWelcome,
  HEALTH_WINDOW, DEAD_CODES, MEDIA_ERROR_CODES,
} from '../functions/api/_welcome.js';
import { onRequestPost as ttOrder } from '../functions/api/tt-order.js';
import { onRequestPost as waHook } from '../functions/api/wa-webhook.js';
import {
  onRequestGet as backfillGet, onRequestPost as backfillPost, BATCH,
} from '../functions/api/wa-welcome.js';
import { onRequestGet as waAdmin } from '../functions/api/wa-admin.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-diwali');

/* ------------------------------------------------------------------ stubs */

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k, t) {
      const v = store.get(k);
      return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v);
    },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })),
        list_complete: true,
      };
    },
  };
}

const ENV = {
  WA_ADMIN_TOKEN: 'admin-secret',
  WA_TOKEN: 'wa-token',
  WA_PHONE_ID: '1316460834883808',
  BREVO_API_KEY: 'brevo-key',
  BREVO_BUYERS_LIST_ID: '12',
  BREVO_LIST_ID: '9',
  BREVO_SENDER_EMAIL: 'diwali@artindia.be',
  ESCALATION_EMAIL: 'ravi@artindia.be',
};
const AUTH = { 'x-admin-token': 'admin-secret', 'content-type': 'application/json' };

/**
 * Meta, Brevo and the image host, all answering from memory.
 *
 * `header` is the thing under test in half this file: 'ok', 'missing',
 * 'redirect', 'html' or 'throws'.
 */
function world({ header = 'ok', refuse = null, contact = null } = {}) {
  const sends = [];
  const heads = [];
  const mails = [];
  const real = globalThis.fetch;
  clearImageCache();

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;

    if (/wa-header\.jpg$/.test(u.pathname)) {
      heads.push({ method, redirect: init.redirect });
      if (header === 'missing') return new Response('nope', { status: 404 });
      if (header === 'redirect') {
        return new Response(null, { status: 308, headers: { location: 'https://x/y.jpg' } });
      }
      if (header === 'html') {
        return new Response('<!doctype html>', {
          status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (header === 'throws') throw new Error('network down');
      return new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }

    if (u.hostname === 'graph.facebook.com') {
      if (u.pathname.includes('/message_templates')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      sends.push(body);
      if (refuse && sends.length === 1) {
        return new Response(JSON.stringify({
          error: { message: 'media upload error', code: refuse, type: 'OAuthException' },
        }), { status: 400 });
      }
      return new Response(JSON.stringify({ messages: [{ id: `wamid.M${sends.length}` }] }),
        { status: 200 });
    }

    if (u.pathname === '/v3/smtp/email') {
      mails.push(body);
      return new Response(JSON.stringify({ messageId: 'm1' }), { status: 201 });
    }
    if (u.pathname.startsWith('/v3/contacts/attributes')) {
      return new Response(JSON.stringify({ attributes: [] }), { status: 200 });
    }
    if (u.pathname === '/v3/contacts') return new Response(null, { status: 204 });
    if (u.pathname.startsWith('/v3/contacts/')) {
      return contact
        ? new Response(JSON.stringify(contact), { status: 200 })
        : new Response(JSON.stringify({ code: 'document_not_found' }), { status: 404 });
    }
    throw new Error(`unstubbed ${method} ${url}`);
  };

  return { sends, heads, mails, restore() { globalThis.fetch = real; } };
}

const welcome = (over = {}) => ({
  phone: '+32474919900',
  ts: '2026-10-01T10:00:00.000Z',
  name: 'Anouk',
  template: 'diwali_welcome_en_v2',
  waMessageId: 'wamid.FIRST',
  orderId: 'or_1',
  code: 'ABC234',
  status: 'sent',
  last_status_ts: '2026-10-01T10:00:00.000Z',
  ...over,
});

const order = (over = {}) => ({
  event: 'order.created',
  payload: {
    id: 'or_TEST1',
    created_at: '2026-10-01T10:00:00Z',
    total_paid: '2000',
    marketing_opt_in: 'true',
    meta_data: [],
    buyer_details: {
      first_name: 'Anouk', last_name: 'Peeters', email: 'anouk@example.com',
      phone: '+32474919900',
      custom_questions: [{
        question: 'I want to participate in the lucky draw and get festival news on WhatsApp',
        answer: 'Yes',
      }],
    },
    line_items: [{ description: 'Weekend ticket', quantity: 1, total: '2000' }],
    ...over,
  },
});

const postOrder = (env, body) => ttOrder({
  request: new Request('https://diwali.artindia.be/api/tt-order', {
    method: 'POST', body: JSON.stringify(body),
  }),
  env,
  waitUntil: p => p,
});

/**
 * One status callback, as Meta sends it.
 *
 * The webhook answers 200 at once and does the work in waitUntil, so the test
 * has to hold the promise and wait for it; otherwise it reads KV a callback
 * behind and every assertion here is about the wrong moment.
 */
async function statusHook(env, { id = 'wamid.FIRST', status = 'failed', errors = [] } = {}) {
  const pending = [];
  const res = await waHook({
    request: new Request('https://diwali.artindia.be/api/wa-webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entry: [{
          changes: [{
            value: {
              statuses: [{
                id, status, recipient_id: '32474919900',
                timestamp: String(Math.floor(Date.parse('2026-10-01T10:05:00Z') / 1000)),
                ...(errors.length ? { errors } : {}),
              }],
            },
          }],
        }],
      }),
    }),
    env,
    waitUntil: p => pending.push(p),
  });
  await Promise.all(pending);
  return res;
}

const job = (env, action, headers = AUTH) => backfillPost({
  request: new Request('https://diwali.artindia.be/api/wa-welcome', {
    method: 'POST', headers, body: JSON.stringify({ action }),
  }),
  env,
});

const jobList = (env, headers = AUTH) => backfillGet({
  request: new Request('https://diwali.artindia.be/api/wa-welcome', { headers }),
  env,
});

/* ======================================================= 1. the image file */

test('the header image is in the repo, and is what Meta will accept', () => {
  const p = join(ROOT, 'media/wa-header.jpg');
  assert.ok(existsSync(p), 'media/wa-header.jpg must exist: a 404 here is 208 silent failures');

  const bytes = readFileSync(p);
  assert.ok(bytes.length < 1024 * 1024, `under 1 MB, is ${bytes.length}`);
  assert.equal(bytes[0], 0xff, 'a real JPEG, not a renamed PNG');
  assert.equal(bytes[1], 0xd8);

  /* The dimensions, straight out of the first SOF marker. */
  let i = 2, size = null;
  while (i < bytes.length - 9) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      size = { h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7) };
      break;
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  assert.deepEqual(size, { w: 1200, h: 628 });
});

test('the build ships it, and refuses to build without it', () => {
  assert.ok(existsSync(join(DIST, 'img/wa-header.jpg')), 'it reaches /img/wa-header.jpg');
  assert.ok(statSync(join(DIST, 'img/wa-header.jpg')).size
    === statSync(join(ROOT, 'media/wa-header.jpg')).size, 'byte for byte');

  const build = readFileSync(join(ROOT, 'build-diwali.mjs'), 'utf8');
  const block = build.slice(build.indexOf("const p = join(HERE, 'media/wa-header.jpg');"));
  const upTo = block.slice(0, block.indexOf('}\n'));
  assert.ok(/process\.exit\(1\)/.test(upTo), 'a missing header image fails the build');
  assert.ok(!/console\.warn/.test(upTo), 'a warning was what let this happen');
});

/* ================================================== 2. the pre-send check */

test('a header image that 404s is never put in a message', async () => {
  const w = world({ header: 'missing' });
  try {
    const kv = memoryKv();
    const out = await (await postOrder({ ...ENV, REFERRALS: kv }, order())).json();

    assert.equal(w.sends.length, 1, 'one send, not a failed one and a retry');
    assert.equal(w.sends[0].template.name, 'diwali_welcome_en',
      'the plain template went out instead of the one with a picture');
    assert.ok(!w.sends[0].template.components.some(c => c.type === 'header'),
      'and it carries no header at all');
    assert.equal(out.whatsapp.image_unusable, 'http_404', 'the reason is on the answer');
  } finally { w.restore(); }
});

test('the check does not follow a redirect, and a redirect is a failure', async () => {
  const w = world({ header: 'redirect' });
  try {
    await postOrder({ ...ENV, REFERRALS: memoryKv() }, order());
    assert.equal(w.heads[0].method, 'HEAD', 'it costs a HEAD, not a download');
    assert.equal(w.heads[0].redirect, 'manual');
    assert.equal(w.sends[0].template.name, 'diwali_welcome_en');
  } finally { w.restore(); }
});

test('a URL that answers HTML is not an image either', async () => {
  const w = world({ header: 'html' });
  try {
    const r = await headerImageUsable(ENV, 'https://diwali.artindia.be/img/wa-header.jpg');
    assert.equal(r.ok, false);
    assert.match(r.why, /^not_an_image:text\/html$/);
  } finally { w.restore(); }
});

test('a picture that is there is used, and asked about once in ten minutes', async () => {
  const w = world({ header: 'ok' });
  try {
    const kv = memoryKv();
    await postOrder({ ...ENV, REFERRALS: kv }, order());
    await postOrder({ ...ENV, REFERRALS: kv }, order({ id: 'or_TEST2' }));

    assert.equal(w.heads.length, 1, 'the answer is cached between sends');
    assert.equal(w.sends[0].template.name, 'diwali_welcome_en_v2');
    const header = w.sends[0].template.components.find(c => c.type === 'header');
    assert.equal(header.parameters[0].image.link, 'https://diwali.artindia.be/img/wa-header.jpg');
  } finally { w.restore(); }
});

test('a check that cannot be made does not stop the welcome', async () => {
  const w = world({ header: 'throws' });
  try {
    const r = await headerImageUsable(ENV, 'https://diwali.artindia.be/img/wa-header.jpg');
    assert.equal(r.ok, true, 'any doubt counts as usable');
    assert.equal(r.why, 'check_failed');

    await postOrder({ ...ENV, REFERRALS: memoryKv() }, order());
    assert.equal(w.sends[0].template.name, 'diwali_welcome_en_v2');
  } finally { w.restore(); }
});

/* ============================ 3. the failure that arrives after the answer */

test('a welcome Meta fails asynchronously gets the plain template, once', async () => {
  const w = world({ header: 'ok' });
  try {
    const kv = memoryKv();
    await postOrder({ ...ENV, REFERRALS: kv }, order());
    assert.equal(w.sends.length, 1);
    const first = await kv.get('bot:welcome:+32474919900', 'json');
    assert.equal(first.status, 'sent', 'Meta accepted it: nothing looks wrong yet');

    /* Minutes later, down the status webhook. */
    await statusHook({ ...ENV, REFERRALS: kv }, {
      id: first.waMessageId,
      errors: [{ code: 131053, title: 'Media upload error' }],
    });

    assert.equal(w.sends.length, 2, 'the second attempt went out');
    assert.equal(w.sends[1].template.name, 'diwali_welcome_en');

    const after = await kv.get('bot:welcome:+32474919900', 'json');
    assert.equal(after.status, 'sent', 'it follows the message that actually went');
    assert.equal(after.template, 'diwali_welcome_en');
    assert.notEqual(after.waMessageId, first.waMessageId, 'and the new message id');
    assert.equal(after.attempts.length, 2, 'both attempts are on the record');
    assert.deepEqual(after.attempts.map(a => a.template),
      ['diwali_welcome_en_v2', 'diwali_welcome_en']);
    assert.equal(after.retriedBy, 'status_131053');
  } finally { w.restore(); }
});

test('a second report of the same failure sends nothing more', async () => {
  const w = world({ header: 'ok' });
  try {
    const kv = memoryKv();
    await postOrder({ ...ENV, REFERRALS: kv }, order());
    const first = await kv.get('bot:welcome:+32474919900', 'json');
    const fail = { id: first.waMessageId, errors: [{ code: 131053, title: 'Media upload error' }] };

    await statusHook({ ...ENV, REFERRALS: kv }, fail);
    await statusHook({ ...ENV, REFERRALS: kv }, fail);
    await statusHook({ ...ENV, REFERRALS: kv }, fail);

    assert.equal(w.sends.length, 2, 'one welcome and one second try, however often Meta tells us');
  } finally { w.restore(); }
});

test('a failure that a different template cannot fix sends nothing', async () => {
  const w = world({ header: 'ok' });
  try {
    const kv = memoryKv();
    await postOrder({ ...ENV, REFERRALS: kv }, order());
    const first = await kv.get('bot:welcome:+32474919900', 'json');

    /* 131026: there is no WhatsApp account on that number. */
    await statusHook({ ...ENV, REFERRALS: kv }, {
      id: first.waMessageId,
      errors: [{ code: 131026, title: 'Message undeliverable' }],
    });
    assert.equal(w.sends.length, 1, 'sending the same thing again helps nobody');
  } finally { w.restore(); }
});

test('a late report about an older message does not re-send', async () => {
  const w = world();
  try {
    const kv = memoryKv({
      'bot:welcome:+32474919900': JSON.stringify(welcome({ waMessageId: 'wamid.SECOND' })),
    });
    const r = await retryFailedWelcome({ ...ENV, REFERRALS: kv }, kv, {
      phone: '+32474919900',
      status: { id: 'wamid.FIRST', errors: [{ code: 131053 }] },
    });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'older_message');
    assert.equal(w.sends.length, 0);
  } finally { w.restore(); }
});

test('delivered and read are stamped, so a late failure cannot erase them', async () => {
  const w = world();
  try {
    const kv = memoryKv({
      'bot:welcome:+32474919900': JSON.stringify(welcome()),
    });
    const env = { ...ENV, REFERRALS: kv };
    await statusHook(env, { id: 'wamid.FIRST', status: 'delivered' });
    await statusHook(env, { id: 'wamid.FIRST', status: 'read' });

    const after = await kv.get('bot:welcome:+32474919900', 'json');
    assert.ok(after.deliveredAt);
    assert.ok(after.readAt);
    assert.equal(neverArrived(after), false);

    await statusHook(env, {
      id: 'wamid.FIRST', status: 'failed', errors: [{ code: 131053 }],
    });
    const last = await kv.get('bot:welcome:+32474919900', 'json');
    assert.equal(neverArrived(last), false, 'it arrived, whatever arrives afterwards');
    assert.equal(w.sends.length, 0, 'and nothing is sent again');
  } finally { w.restore(); }
});

/* ===================================================== 4. the backfill */

/* One buyer of each kind, so the list is the thing being tested and not the
   order the keys happen to come back in. */
const POPULATION = () => memoryKv({
  'bot:welcome:+32470000001': JSON.stringify(welcome({
    phone: '+32470000001', name: 'Failed', status: 'failed',
    errors: [{ code: 131053, title: 'Media upload error' }],
  })),
  'bot:welcome:+32470000002': JSON.stringify(welcome({
    phone: '+32470000002', name: 'AlsoFailed', status: 'failed',
    errors: [{ code: 131053, title: 'Media upload error' }],
  })),
  'bot:welcome:+32470000003': JSON.stringify(welcome({
    phone: '+32470000003', name: 'Delivered', status: 'delivered',
    deliveredAt: '2026-10-01T10:01:00Z',
  })),
  'bot:welcome:+32470000004': JSON.stringify(welcome({
    phone: '+32470000004', name: 'Read', status: 'read',
    readAt: '2026-10-01T10:02:00Z',
  })),
  'bot:welcome:+32470000005': JSON.stringify(welcome({
    phone: '+32470000005', name: 'NoWhatsApp', status: 'failed',
    errors: [{ code: 131026, title: 'Message undeliverable' }],
  })),
  'bot:welcome:+32470000006': JSON.stringify(welcome({
    phone: '+32470000006', name: 'SaidStop', status: 'failed',
    errors: [{ code: 131053, title: 'Media upload error' }],
  })),
  'bot:optout:+32470000006': '2026-10-02T09:00:00Z',
  'bot:welcome:+32470000007': JSON.stringify(welcome({
    phone: '+32470000007', name: 'AlreadyRetried', status: 'failed',
    errors: [{ code: 131053, title: 'Media upload error' }],
    retriedAt: '2026-10-02T08:00:00Z',
  })),
});

test('the list is buyers who never got it, and nobody else', async () => {
  const w = world();
  try {
    const kv = POPULATION();
    const d = await (await jobList({ ...ENV, REFERRALS: kv })).json();

    assert.equal(d.missing, 2, 'the two media failures, and only those');
    assert.equal(d.unreachable, 1, 'the number with no WhatsApp account is counted apart');
    assert.equal(d.already_retried, 1);
    assert.equal(d.job.total, 0, 'no job has been run');
  } finally { w.restore(); }
});

test('it refuses without an admin token', async () => {
  const w = world();
  try {
    const kv = POPULATION();
    assert.equal((await jobList({ ...ENV, REFERRALS: kv }, {})).status, 401);
    assert.equal((await job({ ...ENV, REFERRALS: kv }, 'start', {
      'x-admin-token': 'wrong', 'content-type': 'application/json',
    })).status, 401);
    assert.equal((await jobList({ REFERRALS: kv })).status, 503, 'and when none is configured');
    assert.equal(w.sends.length, 0);
  } finally { w.restore(); }
});

test('pressing the button sends each of them once, and says so', async () => {
  const w = world();
  try {
    const kv = POPULATION();
    const env = { ...ENV, REFERRALS: kv };
    const d = await (await job(env, 'start')).json();

    assert.equal(d.ok, true);
    assert.equal(d.job.total, 2);
    assert.equal(d.job.done, 2);
    assert.equal(d.job.sent, 2);
    assert.equal(d.job.running, false, 'two fit in one batch, so it is finished');
    assert.ok(d.job.finishedAt);

    assert.equal(w.sends.length, 2);
    assert.deepEqual(w.sends.map(s => s.to).sort(), ['32470000001', '32470000002']);
    assert.ok(w.sends.every(s => s.template.name === 'diwali_welcome_en'),
      'the plain template, because the one with a picture is what failed');

    for (const phone of ['+32470000001', '+32470000002']) {
      const after = await kv.get(`bot:welcome:${phone}`, 'json');
      assert.ok(after.retriedAt, 'the record says it was tried again');
      assert.equal(after.retriedBy, 'backfill');
      assert.equal(after.status, 'sent');
      assert.equal(after.attempts[after.attempts.length - 1].by, 'backfill');
    }
  } finally { w.restore(); }
});

test('nobody is sent to twice, however often the button is pressed', async () => {
  const w = world();
  try {
    const kv = POPULATION();
    const env = { ...ENV, REFERRALS: kv };

    await job(env, 'start');
    assert.equal(w.sends.length, 2);

    const second = await (await job(env, 'start')).json();
    assert.equal(second.job.total, 0, 'there is nobody left to send to');
    assert.equal(w.sends.length, 2, 'and nothing more went out');

    /* Even a run forced against the old queue finds the records marked. */
    const third = await (await job(env, 'resume')).json();
    assert.equal(third.ok, true);
    assert.equal(w.sends.length, 2);
  } finally { w.restore(); }
});

test('a buyer the status webhook already caught up is skipped', async () => {
  const w = world();
  try {
    const kv = POPULATION();
    const env = { ...ENV, REFERRALS: kv };

    /* The queue is built, and then the webhook gets there first. */
    const started = await (await job(env, 'start')).json();
    assert.equal(started.job.total, 2);

    /* A third buyer appears in the queue but is retried before the batch
       reaches them: the record, not the queue, is what decides. */
    const kv2 = POPULATION();
    const env2 = { ...ENV, REFERRALS: kv2 };
    const w2 = world();
    try {
      await kv2.put('bot:welcome:+32470000001', JSON.stringify(welcome({
        phone: '+32470000001', status: 'failed', retriedAt: '2026-10-02T09:30:00Z',
        errors: [{ code: 131053 }],
      })));
      const d = await (await job(env2, 'start')).json();
      assert.equal(d.job.sent, 1);
      assert.equal(d.job.skipped, 0, 'it was never queued in the first place');
      assert.equal(w2.sends.length, 1);
    } finally { w2.restore(); }
  } finally { w.restore(); }
});

test('it goes in batches, and can be stopped and resumed', async () => {
  const w = world();
  try {
    const seed = {};
    const many = BATCH + 4;
    for (let i = 0; i < many; i++) {
      const phone = `+3247100${String(i).padStart(4, '0')}`;
      seed[`bot:welcome:${phone}`] = JSON.stringify(welcome({
        phone, name: `B${i}`, status: 'failed',
        errors: [{ code: 131053, title: 'Media upload error' }],
      }));
    }
    const kv = memoryKv(seed);
    const env = { ...ENV, REFERRALS: kv };

    const first = await (await job(env, 'start')).json();
    assert.equal(first.job.total, many);
    assert.equal(first.job.done, BATCH, 'one batch, not all of them');
    assert.equal(first.job.running, true, 'and it knows there is more to do');
    assert.equal(w.sends.length, BATCH);

    const stopped = await (await job(env, 'stop')).json();
    assert.equal(stopped.job.running, false);

    /* A page still in its loop asks for another batch: a stopped job sends
       nothing. */
    const ignored = await (await job(env, 'run')).json();
    assert.equal(ignored.job.done, BATCH);
    assert.equal(w.sends.length, BATCH, 'stopped means stopped');

    const resumed = await (await job(env, 'resume')).json();
    assert.equal(resumed.job.done, many);
    assert.equal(resumed.job.sent, many);
    assert.equal(resumed.job.running, false);
    assert.equal(w.sends.length, many);
  } finally { w.restore(); }
});

test('a dry run sends nothing and marks nobody', async () => {
  const w = world();
  try {
    const kv = POPULATION();
    const d = await (await job({ ...ENV, REFERRALS: kv, WA_DRY_RUN: 'true' }, 'start')).json();

    assert.equal(d.job.total, 2);
    assert.equal(d.job.dry_run, 2);
    assert.equal(d.job.sent, 0);
    assert.equal(w.sends.length, 0, 'not one message');

    const after = await kv.get('bot:welcome:+32470000001', 'json');
    assert.ok(!after.retriedAt, 'and nobody is marked as done');
  } finally { w.restore(); }
});

test('a buyer whose code is not on the record is found through Brevo', async () => {
  const w = world({ contact: { email: 'a@b.c', attributes: { REFERRAL_CODE: 'XYZ789' } } });
  try {
    const kv = memoryKv({
      'bot:welcome:+32470000001': JSON.stringify(welcome({
        phone: '+32470000001', code: undefined, status: 'failed',
        errors: [{ code: 131053 }],
      })),
    });
    await job({ ...ENV, REFERRALS: kv }, 'start');
    assert.equal(w.sends.length, 1);
    assert.match(w.sends[0].template.components[0].parameters[1].text, /XYZ789$/);
  } finally { w.restore(); }
});

test('a buyer with no code anywhere is counted as failed, not sent blindly', async () => {
  const w = world({ contact: null });
  try {
    const kv = memoryKv({
      'bot:welcome:+32470000001': JSON.stringify(welcome({
        phone: '+32470000001', code: undefined, status: 'failed',
        errors: [{ code: 131053 }],
      })),
    });
    const d = await (await job({ ...ENV, REFERRALS: kv }, 'start')).json();
    assert.equal(d.job.failed, 1);
    assert.equal(d.job.sent, 0);
    assert.equal(w.sends.length, 0);
    assert.equal(d.job.errors[0].why, 'no_referral_code');
  } finally { w.restore(); }
});

/* ============================================== 5. so it cannot hide again */

test('more than a fifth of the last twenty failing is an alarm, with the reason', () => {
  const ok = [];
  for (let i = 0; i < HEALTH_WINDOW; i++) {
    ok.push(welcome({ ts: `2026-10-0${1 + (i % 9)}T10:0${i % 10}:00.000Z`, status: 'delivered' }));
  }
  assert.equal(welcomeHealth(ok).alarm, false);

  const bad = ok.map((w, i) => (i < 5
    ? { ...w, status: 'failed', errors: [{ code: 131053, title: 'Media upload error' }] }
    : w));
  const h = welcomeHealth(bad);
  assert.equal(h.window, HEALTH_WINDOW);
  assert.equal(h.failed, 5);
  assert.equal(h.percent, 25);
  assert.equal(h.alarm, true, '25% is over the fifth');
  assert.deepEqual(h.reasons[0], { code: 131053, title: 'Media upload error', count: 5 });
});

test('one failure out of two is not a pattern', () => {
  const h = welcomeHealth([
    welcome({ status: 'failed', errors: [{ code: 131053 }] }),
    welcome({ ts: '2026-10-02T10:00:00.000Z', status: 'read' }),
  ]);
  assert.equal(h.alarm, false, 'too few to say anything');
});

test('the summary email goes out once a day and names the reason', async () => {
  const w = world();
  try {
    const kv = memoryKv();
    const recent = new Date(Date.now() - 3600 * 1000).toISOString();
    const welcomes = [
      welcome({ status: 'failed', last_status_ts: recent, errors: [{ code: 131053, title: 'Media upload error' }] }),
      welcome({ phone: '+32470000002', status: 'failed', last_status_ts: recent, errors: [{ code: 131053, title: 'Media upload error' }] }),
    ];

    const first = await maybeDailyWelcomeAlert(ENV, kv, welcomes);
    assert.equal(first.sent, true);
    assert.equal(first.to, 'ravi@artindia.be');
    assert.equal(w.mails.length, 1);
    assert.equal(w.mails[0].to[0].email, 'ravi@artindia.be');
    assert.match(w.mails[0].subject, /2 welcome messages failed/);
    assert.match(w.mails[0].textContent, /131053 Media upload error/);
    assert.match(w.mails[0].textContent, /admin\/wa/);

    const second = await maybeDailyWelcomeAlert(ENV, kv, welcomes);
    assert.equal(second.sent, false);
    assert.equal(second.reason, 'already_today');
    assert.equal(w.mails.length, 1, 'one email a day, whatever asks for it');
  } finally { w.restore(); }
});

test('no failures in the last day, no email', async () => {
  const w = world();
  try {
    const kv = memoryKv();
    const old = await maybeDailyWelcomeAlert(ENV, kv, [
      welcome({ status: 'failed', last_status_ts: '2026-01-01T00:00:00.000Z' }),
      welcome({ status: 'read', last_status_ts: new Date().toISOString() }),
    ]);
    assert.equal(old.sent, false);
    assert.equal(old.reason, 'nothing_failed');
    assert.equal(w.mails.length, 0);
  } finally { w.restore(); }
});

test('the WhatsApp dashboard answers with the alarm and the number missing', async () => {
  const w = world();
  try {
    const kv = POPULATION();
    const r = await waAdmin({
      request: new Request('https://diwali.artindia.be/api/wa-admin', { headers: AUTH }),
      env: { ...ENV, REFERRALS: kv },
    });
    const d = await r.json();
    assert.equal(d.welcome_missing, 2);
    assert.equal(d.welcome_health.failed, 5, 'every failed record, including the ones left alone');
    assert.equal(d.welcome_health.alarm, true);
    assert.equal(d.welcome_health.reasons[0].code, 131053);
    assert.equal(d.wa_dry_run, false);
  } finally { w.restore(); }
});

test('the Welcome tab carries the alarm, the count and the button', () => {
  const html = readFileSync(join(ROOT, 'diwali-admin/wa.html'), 'utf8');
  assert.ok(html.includes('never received their welcome'), 'it says how many');
  assert.ok(html.includes('Send their welcome now'), 'and offers the button');
  assert.match(html, /window\.confirm/, 'behind a confirm');
  assert.match(html, /Send the welcome message to ' \+ missing/, 'that states the number');
  assert.match(html, /WA_DRY_RUN is on/, 'and says when nothing will really go');
  assert.match(html, /'\/api\/wa-welcome'/);
  assert.match(html, /action: 'stop'|jobCall\('stop'\)/, 'it can be stopped');
  assert.match(html, /pump\('resume'\)/, 'and resumed');
  assert.match(html, /class="alarm"|'alarm'/, 'the red notice is drawn');
  assert.match(html, /Meta gave no reason/, 'with Meta\'s reason when there is one');
});

test('the dashboard shows the same alarm', () => {
  const html = readFileSync(join(ROOT, 'diwali-admin/dashboard.html'), 'utf8');
  assert.match(html, /function waAlarm/);
  assert.match(html, /notice bad/, 'in red');
  assert.match(html, /welcome messages failed/);
  assert.match(html, /never received theirs/);
});

/* ------------------------------------------------------------ the codes */

test('the codes that mean "try the other template" and the ones that do not', () => {
  for (const code of [131052, 131053]) {
    assert.ok(MEDIA_ERROR_CODES.has(code), `${code} is a media failure`);
  }
  for (const code of [131026, 131047]) {
    assert.ok(DEAD_CODES.has(code), `${code} is a number we cannot reach`);
    assert.ok(!MEDIA_ERROR_CODES.has(code));
  }
});

test('the second try never carries a picture', async () => {
  const w = world({ header: 'ok' });
  try {
    const kv = memoryKv({ 'bot:welcome:+32474919900': JSON.stringify(welcome()) });
    await sendFallbackWelcome({ ...ENV, REFERRALS: kv }, kv, {
      phone: '+32474919900', firstName: 'Anouk', code: 'ABC234', reason: 'test',
    });
    assert.equal(w.sends[0].template.name, 'diwali_welcome_en');
    assert.ok(!w.sends[0].template.components.some(c => c.type === 'header'));
    assert.equal(w.heads.length, 0, 'and does not even ask about the image');
  } finally { w.restore(); }
});

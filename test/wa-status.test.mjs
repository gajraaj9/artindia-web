/**
 * The delivery trail: what the webhook stores against a message id, and the
 * admin endpoint that reads it back. The endpoint is a read over buyer phone
 * numbers, so most of what is tested here is that it refuses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as waWebhook } from '../functions/api/wa-webhook.js';
import { onRequestGet as waStatus, onRequestPost as waStatusPost } from '../functions/api/wa-status.js';

const WAMID = 'wamid.HBgLMzI0NzQ5MTk5MDAVAgARGBIzQTg5OThCMDM1RkI0ODdERkMA';

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const ttls = new Map();
  return {
    store, ttls,
    async get(k, t) {
      const v = store.get(k);
      if (v === undefined) return null;
      return t === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v, opts) { store.set(k, v); if (opts) ttls.set(k, opts.expirationTtl); },
  };
}

const ENV = { BREVO_API_KEY: 'x', WA_VERIFY_TOKEN: 'v', WA_ADMIN_TOKEN: 'admin-secret' };

function noBrevo() {
  globalThis.fetch = async () => new Response('{}', { status: 404 });
}

async function deliver(env, statuses) {
  let work = Promise.resolve();
  await waWebhook({
    request: new Request('https://diwali.artindia.be/api/wa-webhook', {
      method: 'POST',
      body: JSON.stringify({ entry: [{ changes: [{ value: { statuses } }] }] }),
    }),
    env,
    waitUntil: p => { work = p; },
  });
  await work;
}

const ask = (env, qs, headers = {}) => waStatus({
  request: new Request(`https://diwali.artindia.be/api/wa-status?${qs}`, { headers }),
  env,
});

const AUTH = { 'x-admin-token': 'admin-secret' };

/* ----------------------------------------------------------- persistence */

test('every report lands against the message id, newest on top of a history', async () => {
  noBrevo();
  const kv = memoryKv();
  const env = { ...ENV, REFERRALS: kv };

  await deliver(env, [{ id: WAMID, status: 'sent', recipient_id: '32474919900', timestamp: '1789776000' }]);
  await deliver(env, [{ id: WAMID, status: 'delivered', recipient_id: '32474919900', timestamp: '1789776060' }]);
  await deliver(env, [{ id: WAMID, status: 'read', recipient_id: '32474919900', timestamp: '1789776300' }]);

  const rec = await kv.get(`status:${WAMID}`, 'json');
  assert.equal(rec.id, WAMID);
  assert.equal(rec.recipient, '32474919900');
  assert.equal(rec.status, 'read', 'the latest is on top');
  assert.equal(rec.timestamp, '2026-09-19T00:05:00.000Z', 'Meta seconds became an ISO stamp');
  assert.deepEqual(rec.history.map(h => h.status), ['sent', 'delivered', 'read']);
  assert.ok(rec.firstSeenAt && rec.updatedAt);
  assert.equal(kv.ttls.get(`status:${WAMID}`), 90 * 24 * 60 * 60, 'they age out');
});

test('a failure keeps the error code and title', async () => {
  noBrevo();
  const kv = memoryKv();
  await deliver({ ...ENV, REFERRALS: kv }, [{
    id: WAMID, status: 'failed', recipient_id: '32474919900', timestamp: '1789776000',
    errors: [{ code: 131026, title: 'Message undeliverable' }],
  }]);

  const rec = await kv.get(`status:${WAMID}`, 'json');
  assert.equal(rec.status, 'failed');
  assert.deepEqual(rec.errors, [{ code: 131026, title: 'Message undeliverable' }]);
  assert.deepEqual(rec.history[0].errors, [{ code: 131026, title: 'Message undeliverable' }]);
});

test('a callback Meta redelivers does not double the history', async () => {
  noBrevo();
  const kv = memoryKv();
  const env = { ...ENV, REFERRALS: kv };
  const one = [{ id: WAMID, status: 'delivered', recipient_id: '32474919900', timestamp: '1789776060' }];
  await deliver(env, one);
  await deliver(env, one);
  assert.equal((await kv.get(`status:${WAMID}`, 'json')).history.length, 1);
});

test('a report with no message id is dropped rather than stored under nothing', async () => {
  noBrevo();
  const kv = memoryKv();
  await deliver({ ...ENV, REFERRALS: kv }, [{ status: 'sent', recipient_id: '32474919900' }]);
  assert.equal(kv.store.size, 0);
});

/* ------------------------------------------------------------------ auth */

test('it refuses everyone without the right token', async () => {
  const kv = memoryKv({ [`status:${WAMID}`]: JSON.stringify({ id: WAMID }) });
  const env = { ...ENV, REFERRALS: kv };

  assert.equal((await ask(env, `id=${WAMID}`)).status, 401, 'no header');
  assert.equal((await ask(env, `id=${WAMID}`, { 'x-admin-token': '' })).status, 401, 'empty');
  assert.equal((await ask(env, `id=${WAMID}`, { 'x-admin-token': 'wrong' })).status, 401);
  assert.equal((await ask(env, `id=${WAMID}`, { 'x-admin-token': 'admin-secre' })).status, 401,
    'a prefix is not enough');
  assert.equal((await ask(env, `id=${WAMID}`, AUTH)).status, 200);
});

test('an unset admin token refuses everything rather than letting everyone in', async () => {
  const kv = memoryKv({ [`status:${WAMID}`]: JSON.stringify({ id: WAMID }) });
  const env = { REFERRALS: kv };
  assert.equal((await ask(env, `id=${WAMID}`, AUTH)).status, 503);
  assert.equal((await ask(env, `id=${WAMID}`)).status, 503);
});

test('POST is not a way in', async () => {
  assert.equal((await waStatusPost()).status, 405);
});

/* --------------------------------------------------------------- reading */

test('by message id', async () => {
  noBrevo();
  const kv = memoryKv();
  await deliver({ ...ENV, REFERRALS: kv },
    [{ id: WAMID, status: 'delivered', recipient_id: '32474919900', timestamp: '1789776060' }]);

  const out = await (await ask({ ...ENV, REFERRALS: kv }, `id=${WAMID}`, AUTH)).json();
  assert.equal(out.ok, true);
  assert.deepEqual(out.query, { id: WAMID });
  assert.equal(out.status.status, 'delivered');
  assert.equal(out.status.recipient, '32474919900');
});

test('by order id, through the message id the send stored', async () => {
  noBrevo();
  const kv = memoryKv({
    'order:or_83267317': JSON.stringify({ sentAt: '2026-09-19T08:14:30.000Z', waMessageId: WAMID }),
  });
  await deliver({ ...ENV, REFERRALS: kv },
    [{ id: WAMID, status: 'read', recipient_id: '32474919900', timestamp: '1789776300' }]);

  const out = await (await ask({ ...ENV, REFERRALS: kv }, 'order=or_83267317', AUTH)).json();
  assert.equal(out.ok, true);
  assert.deepEqual(out.query, { order: 'or_83267317' });
  assert.equal(out.order.waMessageId, WAMID);
  assert.equal(out.status.status, 'read');
});

test('the gaps each say which gap they are', async () => {
  const kv = memoryKv({
    'order:or_nosend': JSON.stringify({ sentAt: '2026-09-19T08:00:00.000Z' }),
  });
  const env = { ...ENV, REFERRALS: kv };

  const noArgs = await ask(env, '', AUTH);
  assert.equal(noArgs.status, 400);
  assert.equal((await noArgs.json()).error, 'missing_id');

  const noOrder = await ask(env, 'order=or_nothing', AUTH);
  assert.equal(noOrder.status, 404);
  assert.equal((await noOrder.json()).error, 'order_not_found');

  const noSend = await ask(env, 'order=or_nosend', AUTH);
  assert.equal(noSend.status, 200);
  assert.equal((await noSend.json()).status, null, 'the order exists but never produced a message');

  const noReport = await ask(env, 'id=wamid.NEVERSEEN', AUTH);
  assert.equal(noReport.status, 404);
  assert.equal((await noReport.json()).error, 'no_status_yet');
});

test('without the KV binding it says so instead of 500ing', async () => {
  const res = await ask({ ...ENV }, `id=${WAMID}`, AUTH);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'kv_not_bound');
});

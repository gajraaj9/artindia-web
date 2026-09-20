/**
 * The two endpoints a person uses: answering an escalation, and reading what
 * the bot could not answer. Both are guarded by the same admin token and both
 * expose buyer phone numbers, so the refusals matter as much as the answers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as waSend, onRequestGet as waSendGet } from '../functions/api/wa-send.js';
import { onRequestGet as waUnanswered } from '../functions/api/wa-unanswered.js';

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, v); },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })),
        list_complete: true,
      };
    },
  };
}

const ENV = { WA_ADMIN_TOKEN: 'admin-secret', WA_TOKEN: 't', WA_PHONE_ID: 'p' };
const AUTH = { 'x-admin-token': 'admin-secret', 'content-type': 'application/json' };

function stubMeta({ code = null } = {}) {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    sent.push(JSON.parse(init.body));
    if (code) {
      return new Response(JSON.stringify({
        error: { message: 'Re-engagement message', code, type: 'OAuthException' },
      }), { status: 400 });
    }
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.SENT' }] }), { status: 200 });
  };
  return { sent };
}

const send = (env, body, headers = AUTH) => waSend({
  request: new Request('https://diwali.artindia.be/api/wa-send', {
    method: 'POST', headers, body: JSON.stringify(body),
  }),
  env,
});

/* --------------------------------------------------------------- wa-send */

test('it refuses without the token, and when no token is configured', async () => {
  stubMeta();
  assert.equal((await send(ENV, { to: '+32474919900', text: 'hi' }, { 'content-type': 'application/json' })).status, 401);
  assert.equal((await send(ENV, { to: '+32474919900', text: 'hi' }, { 'x-admin-token': 'wrong' })).status, 401);
  assert.equal((await send({ WA_TOKEN: 't' }, { to: '+32474919900', text: 'hi' })).status, 503);
  assert.equal((await waSendGet()).status, 405);
});

test('a reply goes out, with the number normalised on the way', async () => {
  const { sent } = stubMeta();
  const res = await send(ENV, { to: '0474 91 99 00', text: 'The fireworks are at 21:00.' });
  const out = await res.json();

  assert.equal(res.status, 200);
  assert.equal(out.to, '+32474919900', 'typed how a Belgian types it, sent as E.164');
  assert.equal(out.message_id, 'wamid.SENT');
  assert.equal(sent[0].to, '32474919900');
  assert.equal(sent[0].text.body, 'The fireworks are at 21:00.');
  assert.equal(sent[0].text.preview_url, false);
});

test('outside the 24h window it says so instead of pretending', async () => {
  stubMeta({ code: 131047 });
  const res = await send(ENV, { to: '+32474919900', text: 'hello again' });
  const out = await res.json();

  assert.equal(res.status, 409);
  assert.equal(out.error, 'window_closed');
  assert.match(out.message, /24 hour customer service window/);
  assert.equal(out.meta_error.code, 131047);
});

test('any other Meta failure is a 502, not a silent success', async () => {
  stubMeta({ code: 131026 });
  const res = await send(ENV, { to: '+32474919900', text: 'hello' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'send_failed');
});

test('bad input is refused before Meta is called', async () => {
  const { sent } = stubMeta();
  assert.equal((await send(ENV, { to: 'not a number', text: 'hi' })).status, 400);
  assert.equal((await send(ENV, { to: '+32474919900', text: '   ' })).status, 400);
  assert.equal((await send(ENV, { to: '+32474919900', text: 'x'.repeat(5000) })).status, 400);
  assert.equal(sent.length, 0);
});

/* --------------------------------------------------------- wa-unanswered */

const ask = (env, qs, headers = AUTH) => waUnanswered({
  request: new Request(`https://diwali.artindia.be/api/wa-unanswered?${qs}`, { headers }),
  env,
});

const SEEDED = {
  'bot:unanswered:2026-09-19T10:00:00.000Z-001': JSON.stringify({
    phone: '+32470000001', lang: 'en', text: 'Can I bring my drone?', reason: 'not_covered',
  }),
  'bot:unanswered:2026-09-21T09:00:00.000Z-002': JSON.stringify({
    phone: '+32470000002', lang: 'fr', text: 'Puis-je venir en trottinette ?', reason: 'not_covered',
  }),
  'bot:escalation:2026-09-21T11:00:00.000Z-003': JSON.stringify({
    phone: '+32470000003', lang: 'nl', name: 'Sam', last_message: 'mens',
  }),
};

test('it refuses the same way wa-send does', async () => {
  const env = { ...ENV, REFERRALS: memoryKv(SEEDED) };
  assert.equal((await ask(env, '', {})).status, 401);
  assert.equal((await ask({ REFERRALS: memoryKv() }, '', AUTH)).status, 503);
  assert.equal((await ask({ ...ENV }, '', AUTH)).status, 503, 'no KV says so plainly');
});

test('newest first, both kinds together', async () => {
  const out = await (await ask({ ...ENV, REFERRALS: memoryKv(SEEDED) }, '', AUTH)).json();

  assert.equal(out.ok, true);
  assert.equal(out.items.length, 3);
  assert.deepEqual(out.items.map(i => i.kind), ['escalation', 'unanswered', 'unanswered']);
  assert.equal(out.items[0].phone, '+32470000003', 'the most recent thing first');
  assert.deepEqual(out.counts, { unanswered: 2, escalation: 1 });
});

test('since trims it to what has happened lately', async () => {
  const out = await (await ask({ ...ENV, REFERRALS: memoryKv(SEEDED) },
    'since=2026-09-21', AUTH)).json();
  assert.equal(out.items.length, 2, 'the 19th is left behind');
  assert.ok(out.items.every(i => i.at >= '2026-09-21'));
});

test('a plain-text list for a terminal, the same content', async () => {
  const env = { ...ENV, REFERRALS: memoryKv(SEEDED) };
  const res = await ask(env, 'format=text', AUTH);
  const body = await res.text();

  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.match(body, /HUMAN/);
  assert.match(body, /Can I bring my drone\?/);
  assert.equal(body.trim().split('\n').length, 3);
  assert.equal((await (await ask(env, '', AUTH)).json()).text.trim(), body.trim(),
    'the JSON carries the same list');
});

test('nothing to report says so rather than returning an empty page', async () => {
  const out = await (await ask({ ...ENV, REFERRALS: memoryKv() }, 'since=2026-09-21', AUTH)).json();
  assert.deepEqual(out.items, []);
  assert.match(out.text, /nothing since 2026-09-21/);
});

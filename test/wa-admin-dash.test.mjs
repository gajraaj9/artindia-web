/**
 * The dashboard: what gets written down while the bot talks, and what
 * /api/wa-admin makes of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as waWebhook } from '../functions/api/wa-webhook.js';
import { onRequestGet as waAdmin, onRequestPost as waAdminPost } from '../functions/api/wa-admin.js';
import { botKey, logMessage, LOG_MESSAGES } from '../functions/api/_bot.js';

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
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

const BUYER = {
  email: 'ravi@artindia.be',
  attributes: {
    WHATSAPP: '+32474919900', LANG: 'en', REFERRAL_CODE: 'JKRM7W',
    TICKET_COUNT: 4, CHILD_COUNT: 2, WA_OPTIN: true,
  },
};

function world({ contact = null, answer = 'Around 21:00.' } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'graph.facebook.com') {
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), { status: 200 });
    }
    if (u.hostname === 'api.anthropic.com') {
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: answer }], usage: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === '/v3/smtp/email') return new Response('{}', { status: 201 });
    if (u.pathname === '/v3/contacts') return new Response(null, { status: 204 });
    if (u.pathname.startsWith('/v3/contacts/')) {
      return contact ? new Response(JSON.stringify(contact), { status: 200 })
                     : new Response('{}', { status: 404 });
    }
    throw new Error(`unstubbed ${url}`);
  };
}

const ENV = kv => ({
  BREVO_API_KEY: 'k', WA_VERIFY_TOKEN: 'v', WA_TOKEN: 't', WA_PHONE_ID: 'p',
  ANTHROPIC_API_KEY: 'sk-ant-test', WA_BOT_ENABLED: 'true', WA_ADMIN_TOKEN: 'admin-secret',
  REFERRALS: kv,
});

async function inbound(env, message, contacts) {
  let work = Promise.resolve();
  await waWebhook({
    request: new Request('https://diwali.artindia.be/api/wa-webhook', {
      method: 'POST',
      body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [message], contacts } }] }] }),
    }),
    env,
    waitUntil: p => { work = p; },
  });
  await work;
}

async function statusCallback(env, status) {
  let work = Promise.resolve();
  await waWebhook({
    request: new Request('https://diwali.artindia.be/api/wa-webhook', {
      method: 'POST',
      body: JSON.stringify({ entry: [{ changes: [{ value: { statuses: [status] } }] }] }),
    }),
    env,
    waitUntil: p => { work = p; },
  });
  await work;
}

const AUTH = { 'x-admin-token': 'admin-secret' };
const dash = (env, headers = AUTH) => waAdmin({
  request: new Request('https://diwali.artindia.be/api/wa-admin', { headers }),
  env,
});

/* --------------------------------------------------------------- the log */

test('both halves of a conversation are written down', async () => {
  const kv = memoryKv();
  world({ contact: BUYER });
  await inbound(ENV(kv), {
    id: 'wamid.1', from: '32474919900', type: 'text',
    text: { body: 'When are the fireworks?' },
  }, [{ profile: { name: 'Ravi' } }]);

  const log = await kv.get(botKey.log('+32474919900'), 'json');
  assert.equal(log.phone, '+32474919900');
  assert.equal(log.name, 'Ravi');
  assert.equal(log.buyer, true);
  assert.equal(log.lang, 'en');

  assert.deepEqual(log.messages.map(m => [m.dir, m.kind]),
    [['in', 'text'], ['out', 'menu'], ['out', 'answer']]);
  assert.equal(log.messages[0].text, 'When are the fireworks?');
  assert.equal(log.messages[2].text, 'Around 21:00.');
  assert.ok(log.messages.every(m => m.ts), 'every line is stamped');
});

test('a button tap and its canned reply are both in the log', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  world({ contact: BUYER });
  await inbound(ENV(kv), {
    id: 'wamid.2', from: '32474919900', type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'MY_TICKETS', title: 'My tickets' } },
  });

  const log = await kv.get(botKey.log('+32474919900'), 'json');
  assert.deepEqual(log.messages.map(m => [m.dir, m.kind]), [['in', 'button'], ['out', 'canned']]);
  assert.equal(log.messages[0].text, 'MY_TICKETS');
  assert.match(log.messages[1].text, /^You have 2 adult and 2 child tickets/);
});

test('a fallback is labelled as one, so it reads differently from an answer', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  world({ contact: BUYER, answer: 'NOT_COVERED' });
  await inbound(ENV(kv), {
    id: 'wamid.3', from: '32474919900', type: 'text', text: { body: 'drone?' },
  });
  const log = await kv.get(botKey.log('+32474919900'), 'json');
  assert.deepEqual(log.messages.map(m => m.kind), ['text', 'fallback']);
});

test('the log keeps the last forty lines and no more', async () => {
  const kv = memoryKv();
  for (let i = 0; i < 45; i++) {
    await logMessage(kv, '+32400000000', { dir: 'in', kind: 'text', text: `line ${i}` });
  }
  const log = await kv.get(botKey.log('+32400000000'), 'json');
  assert.equal(log.messages.length, LOG_MESSAGES);
  assert.equal(log.messages[0].text, 'line 5', 'oldest dropped first');
  assert.equal(log.messages.at(-1).text, 'line 44');
});

/* ---------------------------------------------------------- the dashboard */

test('it refuses without the token, and says when it cannot work', async () => {
  const kv = memoryKv();
  assert.equal((await dash(ENV(kv), {})).status, 401);
  assert.equal((await dash(ENV(kv), { 'x-admin-token': 'wrong' })).status, 401);
  assert.equal((await dash({ REFERRALS: kv })).status, 503, 'no admin token configured');
  assert.equal((await dash({ WA_ADMIN_TOKEN: 'admin-secret' })).status, 503, 'no KV');
  assert.equal((await waAdminPost()).status, 405);
});

test('conversations come back newest first, flagged when the last word was theirs', async () => {
  const kv = memoryKv();
  world({ contact: BUYER });
  await inbound(ENV(kv), {
    id: 'wamid.A', from: '32474919900', type: 'text', text: { body: 'fireworks?' },
  }, [{ profile: { name: 'Ravi' } }]);

  /* A second number whose last line is their own: nobody has answered it. */
  await logMessage(kv, '+32470000002',
    { dir: 'in', kind: 'text', text: 'is there parking' }, { name: 'Sam', buyer: false, lang: 'nl' });

  const out = await (await dash(ENV(kv))).json();
  assert.equal(out.ok, true);
  assert.equal(out.conversations.length, 2);

  const sam = out.conversations.find(c => c.phone === '+32470000002');
  assert.equal(sam.name, 'Sam');
  assert.equal(sam.buyer, false);
  assert.equal(sam.lang, 'nl');
  assert.equal(sam.needsReply, true, 'they spoke last');
  assert.equal(sam.last.text, 'is there parking');

  const ravi = out.conversations.find(c => c.phone === '+32474919900');
  assert.equal(ravi.needsReply, false, 'the bot answered');
  assert.equal(ravi.buyer, true);
  assert.equal(ravi.count, ravi.messages.length);
});

test('the switch position comes back with the data', async () => {
  const kv = memoryKv();
  assert.equal((await (await dash(ENV(kv))).json()).bot_enabled, true);
  const off = await (await dash({ ...ENV(kv), WA_BOT_ENABLED: 'false' })).json();
  assert.equal(off.bot_enabled, false);
  assert.equal(off.daily_limit, 20);
});

test('welcome sends are counted by what Meta last said about them', async () => {
  const kv = memoryKv({
    [botKey.welcome('+32470000001')]: JSON.stringify({
      phone: '+32470000001', name: 'A', ts: '2026-09-20T10:00:00Z',
      template: 'diwali_welcome_en_v2', waMessageId: 'wamid.W1', status: 'read',
    }),
    [botKey.welcome('+32470000002')]: JSON.stringify({
      phone: '+32470000002', name: 'B', ts: '2026-09-21T10:00:00Z',
      template: 'diwali_welcome_en_v2', waMessageId: 'wamid.W2', status: 'failed',
      errors: [{ code: 131026, title: 'Message undeliverable' }],
    }),
  });
  const out = await (await dash(ENV(kv))).json();

  assert.deepEqual(out.welcome_counts, { sent: 0, delivered: 0, read: 1, failed: 1 });
  assert.equal(out.welcomes[0].phone, '+32470000002', 'newest first');
  assert.equal(out.welcomes[0].errors[0].code, 131026);
});

test('a delivery report moves its own welcome on, and nobody else\'s', async () => {
  const kv = memoryKv({
    [botKey.welcome('+32474919900')]: JSON.stringify({
      phone: '+32474919900', ts: '2026-09-21T10:00:00Z',
      waMessageId: 'wamid.WELCOME', status: 'sent',
    }),
  });
  world({ contact: BUYER });

  await statusCallback(ENV(kv), {
    id: 'wamid.WELCOME', status: 'read', recipient_id: '32474919900', timestamp: '1790000000',
  });
  let w = await kv.get(botKey.welcome('+32474919900'), 'json');
  assert.equal(w.status, 'read');
  assert.ok(w.last_status_ts);

  /* A report for some other message to the same number must not touch it. */
  await statusCallback(ENV(kv), {
    id: 'wamid.SOMETHING_ELSE', status: 'failed', recipient_id: '32474919900',
    timestamp: '1790000100', errors: [{ code: 131026, title: 'nope' }],
  });
  w = await kv.get(botKey.welcome('+32474919900'), 'json');
  assert.equal(w.status, 'read', 'still read');
});

test('unanswered questions and escalations arrive together, newest first', async () => {
  const kv = memoryKv({
    'bot:unanswered:2026-09-20T10:00:00.000Z-001': JSON.stringify({
      phone: '+32470000001', lang: 'en', text: 'drone?', reason: 'not_covered',
    }),
    'bot:escalation:2026-09-21T10:00:00.000Z-002': JSON.stringify({
      phone: '+32470000002', lang: 'fr', name: 'Sam', last_message: 'humain',
    }),
  });
  const out = await (await dash(ENV(kv))).json();
  assert.deepEqual(out.questions.map(q => q.kind), ['escalation', 'unanswered']);
  assert.equal(out.questions[0].name, 'Sam');
});

test('an empty account answers with empty lists rather than an error', async () => {
  const out = await (await dash(ENV(memoryKv()))).json();
  assert.equal(out.ok, true);
  assert.deepEqual(out.conversations, []);
  assert.deepEqual(out.welcomes, []);
  assert.deepEqual(out.questions, []);
  assert.deepEqual(out.welcome_counts, { sent: 0, delivered: 0, read: 0, failed: 0 });
});

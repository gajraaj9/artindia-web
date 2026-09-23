/**
 * Diya on the website.
 *
 * Most of what is checked here is what the web is *not* allowed to do: answer
 * a request from somebody else's site, promote itself to buyer, write to a
 * marketing list without a tick, or say a referral code out loud on a page
 * anyone can be looking at.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost, onRequestGet, onRequestOptions } from '../functions/api/chat.js';
import { webKey, botKey, stripFaq, LINK_IS_ELSEWHERE, FALLBACK, FALLBACK_BASE } from '../functions/api/_bot.js';
import { FAQ_RAW } from '../functions/api/_faq.js';

const ORIGIN = 'https://diwali.artindia.be';

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true };
    },
  };
}

const BUYER = {
  email: 'gajraaj@gmail.com', listIds: [9, 12],
  attributes: { FIRSTNAME: 'Ravi', REFERRAL_CODE: 'JKRM7W', TICKET_COUNT: 4, CHILD_COUNT: 2 },
};
const PROSPECT = { email: 'sam@example.com', listIds: [9], attributes: { FIRSTNAME: 'Sam' } };

/** Brevo and Anthropic, with `answer` deciding what the model says. */
function world({ contacts = {}, answer = 'Around 21:00, weather permitting.' } = {}) {
  const db = new Map(Object.entries(contacts));
  const writes = [];
  const prompts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.hostname === 'api.anthropic.com') {
      prompts.push(body);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: answer }], usage: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === '/v3/contacts' && (init.method || '').toUpperCase() === 'POST') {
      writes.push(body);
      const key = body.email.toLowerCase();
      const prev = db.get(key) || { email: key, attributes: {}, listIds: [] };
      db.set(key, {
        email: key,
        attributes: { ...prev.attributes, ...body.attributes },
        listIds: [...new Set([...prev.listIds, ...(body.listIds || [])])],
      });
      return new Response(null, { status: 204 });
    }
    if (u.pathname === '/v3/contacts/attributes') return new Response(JSON.stringify({ attributes: [] }), { status: 200 });
    if (u.pathname.startsWith('/v3/contacts/')) {
      const key = decodeURIComponent(u.pathname.slice('/v3/contacts/'.length)).toLowerCase();
      const hit = db.get(key);
      return hit ? new Response(JSON.stringify(hit), { status: 200 })
                 : new Response('{}', { status: 404 });
    }
    throw new Error(`unstubbed ${url}`);
  };
  return { db, writes, prompts };
}

const ENV = kv => ({
  CHAT_SESSION_SECRET: 'test-secret', BREVO_API_KEY: 'k',
  BREVO_BUYERS_LIST_ID: '12', BREVO_PROSPECTS_LIST_ID: '9',
  ANTHROPIC_API_KEY: 'sk-ant-test', WEB_BOT_ENABLED: 'true', WEB_BOT_DAILY_LIMIT: '30',
  REFERRALS: kv,
});

async function chat(env, payload, origin = ORIGIN) {
  const res = await onRequestPost({
    request: new Request('https://diwali.artindia.be/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': '1.2.3.4' },
      body: JSON.stringify(payload),
    }),
    env,
  });
  return { status: res.status, body: await res.json() };
}

/* ------------------------------------------------------------- the door */

test('only our own pages may talk to it', async () => {
  const env = ENV(memoryKv());
  world();
  for (const origin of ['https://evil.example', 'https://diwali.artindia.be.evil.com', 'null', '']) {
    const r = await chat(env, {}, origin);
    assert.equal(r.status, 403, origin);
    assert.equal(r.body.error, 'forbidden');
  }
  for (const origin of ['https://diwali.artindia.be', 'https://artindia.be', 'http://localhost:8788']) {
    assert.equal((await chat(env, {}, origin)).status, 200, origin);
  }
});

test('it will not run without a session secret, and GET is not a way in', async () => {
  world();
  assert.equal((await chat({ REFERRALS: memoryKv() }, {})).status, 503);
  const get = await onRequestGet({ request: new Request('https://x/api/chat', { headers: { origin: ORIGIN } }) });
  assert.equal(get.status, 405);
  const opt = await onRequestOptions({ request: new Request('https://x/api/chat', { headers: { origin: ORIGIN } }) });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), ORIGIN);
});

test('a session token cannot be forged or edited', async () => {
  const env = ENV(memoryKv());
  world();
  const first = await chat(env, {});
  const token = first.body.session;
  assert.ok(token && token.includes('.'));

  /* Flip the payload to claim buyer; the signature no longer matches, so the
     server throws it away and starts a clean anonymous session. */
  const [payload, sig] = token.split('.');
  const edited = Buffer.from(payload, 'base64url').toString().replace('"anonymous"', '"buyer"');
  const forged = `${Buffer.from(edited).toString('base64url')}.${sig}`;

  const after = await chat(env, { session: forged, message: 'hello' });
  assert.equal(after.body.state.known, 'anonymous', 'a forged state is discarded');

  const tampered = await chat(env, { session: `${payload}.AAAA` });
  assert.equal(tampered.body.state.known, 'anonymous');
});

/* ------------------------------------------------------------ the limits */

test('past the daily limit it answers without calling the model', async () => {
  const kv = memoryKv();
  const env = { ...ENV(kv), WEB_BOT_DAILY_LIMIT: '2' };
  const { prompts } = world();

  let session = (await chat(env, {})).body.session;
  for (let i = 0; i < 2; i++) {
    const r = await chat(env, { session, message: `question ${i}` });
    session = r.body.session;
  }
  assert.equal(prompts.length, 2);

  const over = await chat(env, { session, message: 'one more' });
  assert.equal(prompts.length, 2, 'the third question is not sent anywhere');
  assert.equal(over.body.reply, FALLBACK_BASE.en);
  assert.ok(over.body.buttons.some(b => b.id === 'WHATSAPP'));
});

test('with the kill switch off nothing reaches the model', async () => {
  const { prompts } = world();
  const r = await chat({ ...ENV(memoryKv()), WEB_BOT_ENABLED: 'false' }, { message: 'how much are tickets' });
  assert.equal(prompts.length, 0);
  assert.equal(r.body.reply, FALLBACK_BASE.en);
});

/* ------------------------------------------------------------ the answers */

test('it opens with the greeting and a menu', async () => {
  world();
  const r = await chat(ENV(memoryKv()), {});
  assert.match(r.body.reply, /^Namaste, I'm Diya/);
  assert.deepEqual(r.body.buttons.map(b => b.id),
    ['TICKETS', 'GETTING_THERE', 'FOOD', 'ASK']);
  assert.equal(r.body.state.known, 'anonymous');
});

test('the page language is followed, and a message in another one overrides it', async () => {
  world({ answer: 'Rond 21:00.' });
  const fr = await chat(ENV(memoryKv()), { lang: 'fr' });
  assert.match(fr.body.reply, /^Namaste, je suis Diya/);

  const { prompts } = world({ answer: 'Rond 21:00.' });
  await chat(ENV(memoryKv()), { lang: 'fr', message: 'Wanneer is het vuurwerk?' });
  assert.match(prompts[0].system[1].text, /^Reply in Dutch\./);
});

test('the web rules ride on the prompt, and the FAQ prefix is still shared', async () => {
  const { prompts } = world();
  await chat(ENV(memoryKv()), { message: 'where is it' });
  assert.match(prompts[0].system[1].text, /You are on the festival website\./);
  assert.match(prompts[0].system[1].text, /Never reveal a referral link, referral code, or draw entries/);
  assert.equal(prompts[0].system[0].cache_control.type, 'ephemeral');
  assert.ok(prompts[0].system[0].text.includes('===== EN ====='), 'the same FAQ prefix');
});

test('the dated price reaches the web too', async () => {
  const { prompts } = world();
  await chat(ENV(memoryKv()), { message: 'how much are tickets' });
  const faq = prompts[0].system[0].text;
  const today = stripFaq(FAQ_RAW, new Date());
  assert.ok(faq.includes(today.slice(0, 200)), 'the same filtered FAQ the WhatsApp bot gets');
  assert.ok(!/\[UNTIL 30 SEP\]|\[1 OCT\]/.test(faq));
  const before = stripFaq(FAQ_RAW, new Date('2026-09-23T12:00:00Z'));
  const after = stripFaq(FAQ_RAW, new Date('2026-10-02T12:00:00Z'));
  assert.ok(before.includes('10 EUR') && !before.includes('12 EUR'));
  assert.ok(after.includes('12 EUR') && !after.includes('10 EUR'));
});

test('the lamp is stripped from a web answer', async () => {
  world({ answer: 'The fireworks are around 21:00. 🪔' });
  const r = await chat(ENV(memoryKv()), { message: 'fireworks?' });
  assert.equal(r.body.reply, 'The fireworks are around 21:00.');
});

test('an unanswered question is logged against the web channel', async () => {
  const kv = memoryKv();
  world({ answer: 'NOT_COVERED' });
  const r = await chat(ENV(kv), { message: 'can I bring a drone' });
  assert.equal(r.body.reply, FALLBACK_BASE.en);
  assert.ok(!r.body.reply.includes('Type HUMAN'), 'the WhatsApp-only line is dropped');
  assert.deepEqual(r.body.buttons.map(b => b.id), ['CONTACT', 'WHATSAPP']);

  const key = [...kv.store.keys()].find(k => k.startsWith('bot:unanswered:'));
  const row = JSON.parse(kv.store.get(key));
  assert.equal(row.channel, 'web');
  assert.equal(row.text, 'can I bring a drone');
});

/* ------------------------------------------------ never the referral code */

test('the web never says a referral code, even to a buyer', async () => {
  const kv = memoryKv();
  world({ contacts: { 'gajraaj@gmail.com': BUYER } });
  const id = await chat(ENV(kv), { identify: { email: 'gajraaj@gmail.com' } });
  assert.equal(id.body.state.known, 'buyer');

  for (const action of ['MY_LINK', 'MY_CHANCES']) {
    const r = await chat(ENV(kv), { session: id.body.session, action });
    assert.equal(r.body.reply, LINK_IS_ELSEWHERE.en, action);
    assert.ok(!r.body.reply.includes('JKRM7W'), `${action}: the code never leaves the server`);
    assert.ok(!r.body.reply.includes('/r/'), `${action}: nor the link`);
  }
});

test('a routed MY_LINK is answered the same way, not by the model', async () => {
  const kv = memoryKv();
  world({ contacts: { 'gajraaj@gmail.com': BUYER }, answer: 'ACTION:MY_LINK' });
  const id = await chat(ENV(kv), { identify: { email: 'gajraaj@gmail.com' } });
  const r = await chat(ENV(kv), { session: id.body.session, message: 'what is my link' });
  assert.equal(r.body.reply, LINK_IS_ELSEWHERE.en);
  assert.ok(!r.body.reply.includes('JKRM7W'));
});

test('a buyer can see how many tickets they have', async () => {
  const kv = memoryKv();
  world({ contacts: { 'gajraaj@gmail.com': BUYER } });
  const id = await chat(ENV(kv), { identify: { email: 'gajraaj@gmail.com' } });
  assert.match(id.body.reply, /^Welcome back, Ravi, you have a ticket/);

  const r = await chat(ENV(kv), { session: id.body.session, action: 'MY_TICKETS' });
  assert.match(r.body.reply, /^You have 2 adult and 2 child tickets, valid on both days\./);
  assert.match(r.body.reply, /Ticket Tailor email/);
});

/* -------------------------------------------------------------- identify */

test('identify never creates a contact', async () => {
  const { db, writes } = world();
  const r = await chat(ENV(memoryKv()), { identify: { email: 'stranger@example.com' } });
  assert.match(r.body.reply, /can't find a ticket for this email/);
  assert.equal(r.body.state.known, 'anonymous');
  assert.equal(writes.length, 0, 'nothing written');
  assert.equal(db.size, 0);
});

test('identify on a known prospect still does not make them a buyer', async () => {
  const { writes } = world({ contacts: { 'sam@example.com': PROSPECT } });
  const r = await chat(ENV(memoryKv()), { identify: { email: 'sam@example.com' } });
  assert.equal(r.body.state.known, 'anonymous');
  assert.equal(writes.length, 0);
});

/* ------------------------------------------------------------------ lead */

test('no tick, no write', async () => {
  const { db, writes } = world();
  const r = await chat(ENV(memoryKv()),
    { lead: { name: 'Sam', email: 'sam@example.com', consent: false } });
  assert.equal(writes.length, 0, 'consent is what makes it a marketing list');
  assert.equal(db.size, 0);
  assert.match(r.body.reply, /can't find a ticket for this email/);
});

test('a consented lead joins list 9 with the webchat source', async () => {
  const { db, writes } = world();
  const r = await chat(ENV(memoryKv()),
    { lang: 'fr', lead: { name: 'Sam', email: 'Sam@Example.com', consent: true } });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].listIds, [9]);
  assert.equal(writes[0].attributes.SOURCE, 'webchat');
  assert.equal(writes[0].attributes.FIRSTNAME, 'Sam');
  assert.equal(writes[0].attributes.LANG, 'fr');
  assert.equal(writes[0].attributes.CONVERTED, false);
  assert.equal(db.get('sam@example.com').listIds[0], 9);
  assert.match(r.body.reply, /^Merci Sam/);
  assert.equal(r.body.state.known, 'prospect');
});

test('a lead who turns out to be a buyer is welcomed, not added to anything', async () => {
  const { writes } = world({ contacts: { 'gajraaj@gmail.com': BUYER } });
  const r = await chat(ENV(memoryKv()),
    { lead: { name: 'Ravi', email: 'gajraaj@gmail.com', consent: true } });
  assert.equal(writes.length, 0, 'already on the buyers list');
  assert.equal(r.body.state.known, 'buyer');
  assert.match(r.body.reply, /^Welcome back, Ravi/);
});

test('a known prospect keeps the name Brevo already has', async () => {
  const { writes } = world({ contacts: { 'sam@example.com': PROSPECT } });
  await chat(ENV(memoryKv()), { lead: { name: 'Samuel', email: 'sam@example.com', consent: true } });
  assert.equal(writes[0].attributes.FIRSTNAME, undefined,
    'the name on file is not overwritten by whatever was typed into a chat box');
  assert.equal(writes[0].attributes.CONVERTED, undefined, 'and they are not reset');
});

/* -------------------------------------------------------------- askLead */

test('the lead prompt comes after an answer, exactly once', async () => {
  const env = ENV(memoryKv());
  world();

  const open = await chat(env, {});
  assert.ok(!open.body.askLead, 'never on the greeting');

  const first = await chat(env, { session: open.body.session, message: 'when is it' });
  assert.equal(first.body.askLead, true);
  assert.equal(first.body.leadPrompt, 'Want me to keep you posted on the festival? Leave your name and email.');

  const second = await chat(env, { session: first.body.session, message: 'and parking' });
  assert.ok(!second.body.askLead, 'asked once a session and no more');
  const third = await chat(env, { session: second.body.session, action: 'FOOD' });
  assert.ok(!third.body.askLead);
});

test('a FAQ button also earns the prompt, but Ask me anything does not', async () => {
  world();
  const ask = await chat(ENV(memoryKv()), { action: 'ASK' });
  assert.ok(!ask.body.askLead, 'inviting a question is not an answer');

  const tickets = await chat(ENV(memoryKv()), { action: 'TICKETS' });
  assert.equal(tickets.body.askLead, true);
  assert.ok(tickets.body.buttons.some(b => b.id === 'BUY' && b.href.includes('tickets.artindia.be')),
    'and somewhere to buy');
});

test('a buyer is never asked for their details', async () => {
  const kv = memoryKv();
  world({ contacts: { 'gajraaj@gmail.com': BUYER } });
  const id = await chat(ENV(kv), { identify: { email: 'gajraaj@gmail.com' } });
  const r = await chat(ENV(kv), { session: id.body.session, action: 'GETTING_THERE' });
  assert.ok(!r.body.askLead);
  assert.deepEqual(r.body.buttons.map(b => b.id),
    ['GETTING_THERE', 'PROGRAMME', 'DRAW', 'ASK'], 'and gets the buyer menu');
});

/* ------------------------------------------------------------------- log */

test('the session transcript is kept for the dashboard', async () => {
  const kv = memoryKv();
  world();
  const open = await chat(ENV(kv), {});
  await chat(ENV(kv), { session: open.body.session, message: 'when is it' });

  const key = [...kv.store.keys()].find(k => k.startsWith('web:log:'));
  const row = JSON.parse(kv.store.get(key));
  assert.equal(row.lang, 'en');
  assert.ok(row.messages.some(m => m.dir === 'in' && m.text === 'when is it'));
  assert.ok(row.messages.some(m => m.dir === 'out'));
});

test('no phone number is ever asked for or stored', async () => {
  const kv = memoryKv();
  const { writes } = world();
  await chat(ENV(kv), { lead: { name: 'Sam', email: 'sam@example.com', consent: true } });
  const blob = JSON.stringify(writes) + [...kv.store.values()].join('');
  assert.ok(!/SMS|WHATSAPP|phone/i.test(blob), 'the web has no business with a phone number');
});

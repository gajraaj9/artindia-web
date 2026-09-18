/**
 * The order webhook end to end, with Brevo, Meta and KV replaced by stubs.
 *
 * This is where the wiring is checked — that a Yes to the lucky draw question
 * becomes WA_OPTIN true, that the phone lands on both SMS and WHATSAPP, that a
 * second delivery of the same order neither double-counts the tickets nor
 * sends a second WhatsApp, and that a referred order credits the referrer.
 *
 * The payload below is the shape /api/tt-order expects. Ticket Tailor's real
 * field names are still unconfirmed (see TT_LOG_PAYLOAD in the function), so
 * treat this fixture as the assumption, not as evidence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/tt-order.js';

/* ------------------------------------------------------------------ stubs */

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
  };
}

/** A Brevo that remembers contacts, plus a Meta that always accepts. */
function stubWorld({ contacts = {} } = {}) {
  const calls = [];
  const db = new Map(Object.entries(contacts));

  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, body });

    if (u.hostname === 'graph.facebook.com') {
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }), { status: 200 });
    }

    if (u.pathname === '/v3/contacts/attributes' && method === 'GET') {
      return new Response(JSON.stringify({ attributes: [] }), { status: 200 });
    }
    if (u.pathname.startsWith('/v3/contacts/attributes/') && method === 'POST') {
      return new Response(null, { status: 204 });
    }
    if (u.pathname === '/v3/contacts' && method === 'POST') {
      const key = body.email.toLowerCase();
      const prev = db.get(key) || { email: key, attributes: {}, listIds: [] };
      db.set(key, {
        email: key,
        attributes: { ...prev.attributes, ...body.attributes },
        listIds: [...new Set([...prev.listIds, ...(body.listIds || [])])],
      });
      return new Response(null, { status: 204 });
    }
    if (u.pathname.startsWith('/v3/contacts/') && method === 'GET') {
      const key = decodeURIComponent(u.pathname.slice('/v3/contacts/'.length)).toLowerCase();
      const hit = db.get(key);
      return hit
        ? new Response(JSON.stringify(hit), { status: 200 })
        : new Response(JSON.stringify({ code: 'document_not_found' }), { status: 404 });
    }
    throw new Error(`unstubbed call ${method} ${url}`);
  };

  return { calls, db };
}

const ENV = {
  BREVO_API_KEY: 'test-key',
  BREVO_BUYERS_LIST_ID: '12',
  BREVO_LIST_ID: '9',
  WA_TOKEN: 'test-token',
  WA_PHONE_ID: '1316460834883808',
};

function order(overrides = {}) {
  return {
    event: 'order.created',
    payload: {
      id: 'or_TEST1',
      created_at: '2026-09-19T10:00:00Z',
      total_paid: '2000',
      buyer_details: {
        first_name: 'Anouk',
        last_name: 'Peeters',
        email: 'Anouk@Example.com',
        phone: '0490 61 66 61',
      },
      line_items: [
        { description: 'Weekend ticket', quantity: 2, total: '2000' },
        { description: 'Children under 12', quantity: 1, total: '0' },
      ],
      custom_questions: [
        { question: 'I want to participate in the lucky draw and get festival news on WhatsApp',
          answer: 'Yes' },
        { question: 'Send me news about Art India', answer: 'Yes' },
      ],
      ...overrides,
    },
  };
}

const post = (env, body) => onRequestPost({
  request: new Request('https://diwali.artindia.be/api/tt-order', {
    method: 'POST', body: JSON.stringify(body),
  }),
  env,
  waitUntil: p => p,
});

/* ------------------------------------------------------------------ tests */

test('a buyer who said yes gets the attributes, a code and a WhatsApp', async () => {
  const { db, calls } = stubWorld();
  const kv = memoryKv();
  const res = await post({ ...ENV, REFERRALS: kv }, order());
  const out = await res.json();

  assert.equal(res.status, 200);
  assert.equal(out.ok, true);

  const c = db.get('anouk@example.com');
  assert.equal(c.attributes.FIRSTNAME, 'Anouk');
  assert.equal(c.attributes.SMS, '+32490616661');
  assert.equal(c.attributes.WHATSAPP, '+32490616661', 'phone lands on both channels');
  assert.equal(c.attributes.WA_OPTIN, true);
  assert.equal(c.attributes.MARKETING_OPTIN, true, '"Send me news about…" is the live wording');
  assert.equal(c.attributes.LANG, 'en');
  assert.equal(c.attributes.TICKET_ID, 'or_TEST1');
  assert.equal(c.attributes.TICKET_COUNT, 3);
  assert.equal(c.attributes.CHILD_COUNT, 1);
  assert.equal(c.attributes.ORDER_VALUE, 20);
  assert.ok(c.listIds.includes(12));
  assert.match(c.attributes.REFERRAL_CODE, /^[A-HJ-NP-Z2-9]{6}$/);

  const sent = calls.find(x => x.path.endsWith('/messages'));
  assert.ok(sent, 'the WhatsApp went out');
  assert.equal(sent.body.to, '32490616661', 'E.164 without the plus');
  assert.equal(sent.body.template.name, 'diwali_welcome_en');
  assert.deepEqual(sent.body.template.components[0].parameters.map(p => p.text), [
    'Anouk',
    `https://diwali.artindia.be/r/${c.attributes.REFERRAL_CODE}`,
  ]);

  assert.ok(await kv.get(`code:${c.attributes.REFERRAL_CODE}`, 'json'));
  assert.equal((await kv.get('order:or_TEST1', 'json')).waMessageId, 'wamid.TEST');
});

test('a redelivery of the same order neither recounts nor re-sends', async () => {
  const { db } = stubWorld();
  const kv = memoryKv();
  await post({ ...ENV, REFERRALS: kv }, order());
  const after = { ...db.get('anouk@example.com') };

  const world = stubWorld({ contacts: { 'anouk@example.com': after } });
  const res = await post({ ...ENV, REFERRALS: kv }, order());
  const out = await res.json();

  assert.equal(out.duplicate, true);
  assert.equal(out.whatsapp, false);
  assert.equal(world.db.get('anouk@example.com').attributes.TICKET_COUNT, 3, 'not 6');
  assert.ok(!world.calls.some(x => x.path.endsWith('/messages')), 'no second WhatsApp');
});

test('no is no: nothing is sent and the flag is stored false', async () => {
  const { db, calls } = stubWorld();
  const res = await post({ ...ENV, REFERRALS: memoryKv() }, order({
    custom_questions: [
      { question: 'I want to participate in the lucky draw…', answer: 'No' },
      { question: 'Send me news about Art India', answer: 'No' },
    ],
  }));

  assert.equal((await res.json()).whatsapp, false);
  assert.equal(db.get('anouk@example.com').attributes.WA_OPTIN, false);
  assert.equal(db.get('anouk@example.com').attributes.MARKETING_OPTIN, false);
  assert.ok(!calls.some(x => x.path.endsWith('/messages')));
});

test('a dry run writes Brevo, logs the payload and sends nothing', async () => {
  const { db, calls } = stubWorld();
  const kv = memoryKv();
  const res = await post({ ...ENV, REFERRALS: kv, WA_DRY_RUN: 'true' }, order());

  assert.equal((await res.json()).whatsapp, false);
  assert.ok(db.get('anouk@example.com').attributes.WA_OPTIN, 'the contact is still written');
  assert.ok(!calls.some(x => x.path.endsWith('/messages')), 'Meta is never called');
  assert.equal(await kv.get('order:or_TEST1'), null,
    'nothing is claimed, so the same order can be replayed');
});

test('a referred order credits the referrer by its adult tickets', async () => {
  const kv = memoryKv({
    'code:ABC234': JSON.stringify({ email: 'ravi@artindia.be', firstname: 'Ravi' }),
  });
  const { db } = stubWorld({
    contacts: {
      'ravi@artindia.be': {
        email: 'ravi@artindia.be', listIds: [12], attributes: { REFERRED_BY: 4 },
      },
    },
  });

  await post({ ...ENV, REFERRALS: kv }, order({ referral: 'ABC234' }));

  assert.equal(db.get('ravi@artindia.be').attributes.REFERRED_BY, 6, '4 + 2 adults');
});

test('a buyer cannot credit themselves', async () => {
  const kv = memoryKv({
    'code:ABC234': JSON.stringify({ email: 'anouk@example.com', firstname: 'Anouk' }),
  });
  const { db } = stubWorld({
    contacts: {
      'anouk@example.com': {
        email: 'anouk@example.com', listIds: [12], attributes: { REFERRED_BY: 1 },
      },
    },
  });

  await post({ ...ENV, REFERRALS: kv }, order({ referral: 'ABC234' }));

  assert.equal(db.get('anouk@example.com').attributes.REFERRED_BY, 1, 'unchanged');
});

test('attendees with their own address join the list but are never messaged', async () => {
  const { db, calls } = stubWorld();
  await post({ ...ENV, REFERRALS: memoryKv() }, order({
    issued_tickets: [
      { id: 'ti_1', email: 'anouk@example.com', first_name: 'Anouk' },
      { id: 'ti_2', email: 'sam@example.com', first_name: 'Sam', last_name: 'De Vos' },
      { id: 'ti_3', email: '', first_name: 'Guest' },
    ],
  }));

  const sam = db.get('sam@example.com');
  assert.equal(sam.attributes.FIRSTNAME, 'Sam');
  assert.equal(sam.attributes.TICKET_ID, 'ti_2');
  assert.equal(sam.attributes.WA_OPTIN, false, 'they never answered the question');
  assert.equal(sam.attributes.MARKETING_OPTIN, true, 'inherited from the order');
  assert.ok(sam.listIds.includes(12));
  assert.equal(calls.filter(x => x.path.endsWith('/messages')).length, 1, 'only the buyer');
});

test('without the KV binding the order still reaches Brevo', async () => {
  const { db, calls } = stubWorld();
  const res = await post({ ...ENV }, order());

  assert.equal((await res.json()).ok, true);
  assert.equal(db.get('anouk@example.com').attributes.TICKET_COUNT, 3);
  assert.ok(!calls.some(x => x.path.endsWith('/messages')), 'no code means no link to send');
});

test('a non-order event is acknowledged and ignored', async () => {
  stubWorld();
  const res = await post({ ...ENV, REFERRALS: memoryKv() },
    { event: 'order.updated', payload: { id: 'or_X' } });
  assert.deepEqual(await res.json(), { ok: true, ignored: 'order.updated' });
});

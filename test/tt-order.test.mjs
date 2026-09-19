/**
 * The order webhook end to end, with Brevo, Meta and KV replaced by stubs.
 *
 * This is where the wiring is checked — that a Yes to the lucky draw question
 * becomes WA_OPTIN true, that the phone lands on both SMS and WHATSAPP, that a
 * second delivery of the same order neither double-counts the tickets nor
 * sends a second WhatsApp, and that a referred order credits the referrer.
 *
 * The fixture is the shape of a real order.created delivery (or_83266022,
 * 19 September 2026): custom questions on buyer_details, consent answers as
 * the string "Yes", marketing_opt_in as the string "true" at the top level,
 * and referral_tag carrying whatever arrived as ?ref=.
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

const QUESTIONS = [
  { question: 'I want to participate in the lucky draw and get festival news on WhatsApp',
    answer: 'Yes' },
  { question: 'Send me news about Art India', answer: 'Yes' },
];

function order({ buyer = {}, ...overrides } = {}) {
  return {
    event: 'order.created',
    payload: {
      id: 'or_TEST1',
      created_at: '2026-09-19T10:00:00Z',
      total_paid: '2000',
      marketing_opt_in: 'true',
      referral_tag: 'event_page_widget',
      meta_data: [],
      buyer_details: {
        first_name: 'Anouk',
        last_name: 'Peeters',
        email: 'Anouk@Example.com',
        phone: '+32474919900',
        custom_questions: QUESTIONS,
        ...buyer,
      },
      line_items: [
        { description: 'Weekend ticket', quantity: 2, total: '2000' },
        { description: 'Children under 12', quantity: 1, total: '0' },
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
  assert.equal(c.attributes.SMS, '+32474919900');
  assert.equal(c.attributes.WHATSAPP, '+32474919900', 'phone lands on both channels');
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
  assert.equal(sent.body.to, '32474919900', 'E.164 without the plus');
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
  assert.equal(out.whatsapp.sent, false);
  assert.equal(out.whatsapp.reason, 'already_sent');
  assert.equal(world.db.get('anouk@example.com').attributes.TICKET_COUNT, 3, 'not 6');
  assert.ok(!world.calls.some(x => x.path.endsWith('/messages')), 'no second WhatsApp');
});

test('no is no: nothing is sent and the flag is stored false', async () => {
  const { db, calls } = stubWorld();
  const res = await post({ ...ENV, REFERRALS: memoryKv() }, order({
    marketing_opt_in: 'false',
    buyer: {
      custom_questions: [
        { question: 'I want to participate in the lucky draw…', answer: 'No' },
        { question: 'Send me news about Art India', answer: 'No' },
      ],
    },
  }));

  assert.equal((await res.json()).whatsapp.sent, false);
  assert.equal(db.get('anouk@example.com').attributes.WA_OPTIN, false);
  assert.equal(db.get('anouk@example.com').attributes.MARKETING_OPTIN, false);
  assert.ok(!calls.some(x => x.path.endsWith('/messages')));
});

test('a dry run writes Brevo, logs the payload and sends nothing', async () => {
  const { db, calls } = stubWorld();
  const kv = memoryKv();
  const res = await post({ ...ENV, REFERRALS: kv, WA_DRY_RUN: 'true' }, order());

  const dry = (await res.json()).whatsapp;
  assert.equal(dry.sent, false);
  assert.equal(dry.reason, 'dry_run');
  assert.equal(dry.to, '+32474919900');
  assert.equal(dry.preview.template.name, 'diwali_welcome_en',
    'the payload comes back so a replay needs no log stream');
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

  await post({ ...ENV, REFERRALS: kv }, order({ referral_tag: 'ABC234' }));

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

  await post({ ...ENV, REFERRALS: kv }, order({ referral_tag: 'ABC234' }));

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

/* --------------------------------------------------- confirmed-shape guards */

test('the lucky draw answer is read off buyer_details, not the order', async () => {
  /* The regression. When questions() looked at the order's top level this came
     back empty, a Yes read as a No, and the first live buyer who opted in was
     logged as not_eligible with nothing to say why. */
  const { db, calls } = stubWorld();
  const res = await post({ ...ENV, REFERRALS: memoryKv() }, order());

  assert.equal(db.get('anouk@example.com').attributes.WA_OPTIN, true);
  assert.equal((await res.json()).whatsapp.sent, true);
  assert.ok(calls.some(x => x.path.endsWith('/messages')));
});

test('questions in the old place are not consent, and say so', async () => {
  const { db } = stubWorld();
  const payload = order();
  payload.payload.custom_questions = payload.payload.buyer_details.custom_questions;
  delete payload.payload.buyer_details.custom_questions;

  const out = await (await post({ ...ENV, REFERRALS: memoryKv() }, payload)).json();

  assert.equal(out.whatsapp.sent, false);
  assert.equal(out.whatsapp.reason, 'no_optin', 'the reason is named, not "not_eligible"');
  assert.equal(db.get('anouk@example.com').attributes.WA_OPTIN, false, 'fails closed');
});

test('every skip names its own reason', async () => {
  const cases = [
    ['no_kv_binding', {}, order()],
    ['no_optin', { REFERRALS: memoryKv() },
      order({ buyer: { custom_questions: [{ question: 'Lucky draw?', answer: 'No' }] } })],
    ['no_phone', { REFERRALS: memoryKv() }, order({ buyer: { phone: '' } })],
    ['no_wa_phone_id', { REFERRALS: memoryKv(), WA_PHONE_ID: '' }, order()],
    ['no_wa_token', { REFERRALS: memoryKv(), WA_TOKEN: '' }, order()],
  ];
  for (const [expected, envPatch, payload] of cases) {
    stubWorld();
    const out = await (await post({ ...ENV, ...envPatch }, payload)).json();
    assert.equal(out.whatsapp.reason, expected);
  }
});

test('the widget tag is a channel name, not a referral code', async () => {
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

  await post({ ...ENV, REFERRALS: kv }, order());  /* referral_tag: event_page_widget */

  assert.equal(db.get('ravi@artindia.be').attributes.REFERRED_BY, 4, 'nobody credited');
  assert.equal(db.get('anouk@example.com').attributes.UTM_SOURCE, 'event_page_widget',
    'but it is still recorded as where the order came from');
});

/* ------------------------------------------------- the Brevo phone conflict */

/**
 * SMS and WHATSAPP are unique across a Brevo account, and a collision makes
 * Brevo reject the whole upsert rather than just the phone. A real order hit
 * this: the contact kept a stale +91 number and took none of the rest of the
 * update, while the log said the order was fine.
 */
function stubPhoneConflict() {
  const db = new Map();
  const bodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;

    if (u.hostname === 'graph.facebook.com') {
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }), { status: 200 });
    }
    if (u.pathname === '/v3/contacts/attributes') return new Response(JSON.stringify({ attributes: [] }), { status: 200 });
    if (u.pathname.startsWith('/v3/contacts/attributes/')) return new Response(null, { status: 204 });

    if (u.pathname === '/v3/contacts' && method === 'POST') {
      bodies.push(body);
      const attrs = body.attributes || {};
      if ('SMS' in attrs || 'WHATSAPP' in attrs) {
        return new Response(JSON.stringify({
          code: 'duplicate_parameter',
          message: 'SMS is already associated with another Contact',
        }), { status: 400 });
      }
      db.set(body.email.toLowerCase(), { email: body.email, attributes: attrs, listIds: body.listIds || [] });
      return new Response(null, { status: 204 });
    }
    if (u.pathname.startsWith('/v3/contacts/')) return new Response('{}', { status: 404 });
    throw new Error(`unstubbed ${method} ${url}`);
  };
  return { db, bodies };
}

test('a phone Brevo will not take is dropped, and the rest of the update lands', async () => {
  const { db, bodies } = stubPhoneConflict();
  const out = await (await post({ ...ENV, REFERRALS: memoryKv() }, order())).json();

  assert.equal(out.ok, true);
  assert.equal(out.phone_dropped, true, 'the caller is told');

  assert.equal(bodies.length, 2, 'one attempt with the phone, one without');
  assert.ok('SMS' in bodies[0].attributes);
  assert.ok(!('SMS' in bodies[1].attributes), 'SMS stripped on the retry');
  assert.ok(!('WHATSAPP' in bodies[1].attributes), 'WHATSAPP stripped too');

  const c = db.get('anouk@example.com');
  assert.equal(c.attributes.TICKET_COUNT, 3, 'the numbers still landed');
  assert.equal(c.attributes.WA_OPTIN, true);
  assert.equal(c.attributes.MARKETING_OPTIN, true);
  assert.match(c.attributes.REFERRAL_CODE, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(c.listIds.includes(12));
});

test('a rejected upsert is never reported as ok', async () => {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/v3/contacts/attributes') return new Response(JSON.stringify({ attributes: [] }), { status: 200 });
    if (u.pathname.startsWith('/v3/contacts/attributes/')) return new Response(null, { status: 204 });
    if (u.pathname === '/v3/contacts' && (init.method || '').toUpperCase() === 'POST') {
      return new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 });
    }
    if (u.pathname.startsWith('/v3/contacts/')) return new Response('{}', { status: 404 });
    throw new Error(`unstubbed ${url}`);
  };

  const res = await post({ ...ENV, REFERRALS: memoryKv() }, order());
  assert.equal(res.status, 500, 'Ticket Tailor should retry this one');
  assert.equal((await res.json()).error, 'brevo_upsert');
});

test('Meta\'s own refusal comes back on the response', async () => {
  const { } = stubWorld();
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).hostname === 'graph.facebook.com') {
      return new Response(JSON.stringify({
        error: {
          message: '(#132001) Template name does not exist in the translation',
          type: 'OAuthException', code: 132001,
        },
      }), { status: 400 });
    }
    return base(url, init);
  };

  const out = await (await post({ ...ENV, REFERRALS: memoryKv() }, order())).json();

  assert.equal(out.ok, true, 'a refused WhatsApp never fails the webhook');
  assert.equal(out.whatsapp.sent, false);
  assert.equal(out.whatsapp.reason, 'send_failed');
  assert.equal(out.whatsapp.status, 400);
  assert.equal(out.whatsapp.error.code, 132001, 'Meta\'s error body, not a summary');
  assert.equal(out.whatsapp.to, '+32474919900');
});

test('a successful send hands back the Meta message id', async () => {
  stubWorld();
  const out = await (await post({ ...ENV, REFERRALS: memoryKv() }, order())).json();
  assert.equal(out.whatsapp.sent, true);
  assert.equal(out.whatsapp.message_id, 'wamid.TEST');
  assert.equal(out.whatsapp.reason, undefined, 'no reason when it went');
});

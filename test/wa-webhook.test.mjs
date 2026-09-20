/**
 * The WhatsApp callback. Both halves matter for consent: the handshake has to
 * accept only the right token, and a STOP has to actually reach the flag —
 * silently failing to find the contact would leave someone who asked to be left
 * alone still on the list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../functions/api/wa-webhook.js';

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '', cursor } = {}) {
      return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
  };
}

const BASE_ENV = {
  BREVO_API_KEY: 'test-key', WA_VERIFY_TOKEN: 'sekrit',
  WA_TOKEN: 'wa-token', WA_PHONE_ID: '1316460834883808',
};
/* Each test gets its own KV: the inbound path dedupes on message id and
   remembers who it has already greeted, so a shared store would make the
   second test in a file behave like a returning visitor. */
const ENV = () => ({ ...BASE_ENV, REFERRALS: memoryKv() });

function stubBrevo(contacts = {}) {
  const db = new Map(Object.entries(contacts));
  const calls = [];
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, search: u.search, body });

    if (u.hostname === 'graph.facebook.com') {
      sent.push(body);
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), { status: 200 });
    }

    if (u.pathname === '/v3/contacts' && method === 'POST') {
      const key = body.email.toLowerCase();
      const prev = db.get(key) || { email: key, attributes: {} };
      db.set(key, { ...prev, attributes: { ...prev.attributes, ...body.attributes } });
      return new Response(null, { status: 204 });
    }
    if (u.pathname.startsWith('/v3/contacts/') && method === 'GET') {
      const id = decodeURIComponent(u.pathname.slice('/v3/contacts/'.length));
      const type = u.searchParams.get('identifierType');
      /* The stub only answers the WhatsApp identity, so the fallback path is
         exercised too. */
      if (type !== 'whatsapp_id') return new Response('{}', { status: 404 });
      const hit = [...db.values()].find(c => c.attributes.WHATSAPP === id);
      return hit ? new Response(JSON.stringify(hit), { status: 200 })
                 : new Response('{}', { status: 404 });
    }
    throw new Error(`unstubbed ${method} ${url}`);
  };
  return { db, calls, sent };
}

const get = (env, qs) => onRequestGet({
  request: new Request(`https://diwali.artindia.be/api/wa-webhook?${qs}`), env,
});

async function post(env, body) {
  let work = Promise.resolve();
  const res = await onRequestPost({
    request: new Request('https://diwali.artindia.be/api/wa-webhook', {
      method: 'POST', body: JSON.stringify(body),
    }),
    env,
    waitUntil: p => { work = p; },
  });
  await work;
  return res;
}

const contact = {
  'anouk@example.com': {
    email: 'anouk@example.com',
    attributes: { WHATSAPP: '+32490616661', WA_OPTIN: true },
  },
};

const change = value => ({ entry: [{ changes: [{ value }] }] });

/* ------------------------------------------------------------------ tests */

test('the handshake echoes the challenge only for the right token', async () => {
  const ok = await get(ENV(), 'hub.mode=subscribe&hub.verify_token=sekrit&hub.challenge=12345');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  assert.match(ok.headers.get('content-type'), /text\/plain/);

  const wrong = await get(ENV(), 'hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345');
  assert.equal(wrong.status, 403);

  const notSubscribe = await get(ENV(), 'hub.mode=unsubscribe&hub.verify_token=sekrit');
  assert.equal(notSubscribe.status, 403);

  const unconfigured = await get({}, 'hub.mode=subscribe&hub.verify_token=sekrit');
  assert.equal(unconfigured.status, 500, 'an unset token never accepts anything');
});

test('a STOP reply turns the flag off', async () => {
  const { db } = stubBrevo(structuredClone(contact));
  const res = await post(ENV(), change({
    messages: [{ from: '32490616661', text: { body: 'STOP' } }],
  }));

  assert.equal(res.status, 200);
  assert.equal(db.get('anouk@example.com').attributes.WA_OPTIN, false);
});

test('arrêt works too, and an ordinary message is left alone', async () => {
  for (const word of ['arrêt', ' arret ', 'Stop']) {
    const { db } = stubBrevo(structuredClone(contact));
    await post(ENV(), change({ messages: [{ from: '32490616661', text: { body: word } }] }));
    assert.equal(db.get('anouk@example.com').attributes.WA_OPTIN, false, word);
  }

  const { db, calls } = stubBrevo(structuredClone(contact));
  await post(ENV(), change({
    messages: [{ id: 'wamid.Q1', from: '32490616661', text: { body: 'where do I park?' } }],
  }));
  assert.equal(db.get('anouk@example.com').attributes.WA_OPTIN, true,
    'a question is not an opt-out');
  assert.ok(!calls.some(c => c.path === '/v3/contacts' && c.body
    && 'WA_OPTIN' in (c.body.attributes || {})), 'nothing touched the consent flag');
});

test('a delivery that can never succeed opts the number out', async () => {
  for (const code of [131026, 131047]) {
    const { db } = stubBrevo(structuredClone(contact));
    await post(ENV(), change({
      statuses: [{
        id: 'wamid.X', status: 'failed', recipient_id: '32490616661',
        errors: [{ code, title: 'undeliverable' }],
      }],
    }));
    assert.equal(db.get('anouk@example.com').attributes.WA_OPTIN, false, String(code));
  }
});

test('an ordinary status, or a failure we can retry, changes nothing', async () => {
  for (const status of [
    { id: 'wamid.X', status: 'delivered', recipient_id: '32490616661' },
    { id: 'wamid.X', status: 'read', recipient_id: '32490616661' },
    { id: 'wamid.X', status: 'failed', recipient_id: '32490616661',
      errors: [{ code: 131000, title: 'something temporary' }] },
  ]) {
    const { db, calls } = stubBrevo(structuredClone(contact));
    await post(ENV(), change({ statuses: [status] }));
    assert.equal(db.get('anouk@example.com').attributes.WA_OPTIN, true, status.status);
    assert.equal(calls.length, 0);
  }
});

test('a body Meta could not have sent is still answered 200', async () => {
  stubBrevo();
  const res = await onRequestPost({
    request: new Request('https://diwali.artindia.be/api/wa-webhook', {
      method: 'POST', body: 'not json',
    }),
    env: ENV(),
    waitUntil: () => {},
  });
  assert.equal(res.status, 200, 'never give Meta a reason to retry');
});

test('with an app secret set, an unsigned callback is refused', async () => {
  stubBrevo(structuredClone(contact));
  const res = await onRequestPost({
    request: new Request('https://diwali.artindia.be/api/wa-webhook', {
      method: 'POST', body: JSON.stringify(change({ messages: [] })),
    }),
    env: { ...ENV(), WA_APP_SECRET: 'app-secret' },
    waitUntil: () => {},
  });
  assert.equal(res.status, 401);
});

test('with an app secret set, a correctly signed callback is accepted', async () => {
  const { db } = stubBrevo(structuredClone(contact));
  const payload = JSON.stringify(change({
    messages: [{ from: '32490616661', text: { body: 'stop' } }],
  }));

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('app-secret'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sig = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');

  let work = Promise.resolve();
  const res = await onRequestPost({
    request: new Request('https://diwali.artindia.be/api/wa-webhook', {
      method: 'POST', body: payload, headers: { 'x-hub-signature-256': `sha256=${sig}` },
    }),
    env: { ...ENV(), WA_APP_SECRET: 'app-secret' },
    waitUntil: p => { work = p; },
  });
  await work;

  assert.equal(res.status, 200);
  assert.equal(db.get('anouk@example.com').attributes.WA_OPTIN, false);
});

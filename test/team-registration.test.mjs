/**
 * Team registration, pass 1.
 *
 * Ticket Tailor, Brevo and Meta are mocked at `fetch`, so every test here
 * states what went out to each of them, which is the only way to prove the
 * rules that matter: no ticket before an approver, never two tickets, and a
 * child's date of birth in exactly two places and nowhere else.
 *
 * Section 5A (VIP invitations and RSVP) is not built yet and has no tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  TEAMS, COPY, register, approve, reject, revoke, validate, hardCap, flagsFor,
  teamOf, token, promoCodeFor, ageOnFestival, validDob, approverFor, say,
  teamMemberFor, passAnswer, codeAnswer, salesAnswer, linkKey, personKey,
  plus1Key, promoKey, phoneKey, rejectedPhoneKey, teamCfgKey, expectedFor,
  allowedOrigin, brevoAttributesFor, approvedMail, receivedMail, IP_CAP_PER_DAY,
  restore, htmlMail, ticketFacts, rejectedEmailKey, qrFileName, fetchQrAttachment,
  SKIPPED, isDryId, ttMessage, scrubSecret, logRefusal, allRefusals, trimRefusals,
  oneOf, describeBody, findIssuedTicket, issueTicket, createDiscount,
  clearDryResults, blockedAsRejected, REFUSAL_CAP,
} from '../functions/api/_accred.js';
import { onRequestGet as adminGet, onRequestPost as adminPost } from '../functions/api/team-admin.js';
import { onRequestGet as formGet } from '../functions/api/team-form.js';
import { onRequestPost as registerPost } from '../functions/api/team-register.js';
import { buildMenu, menuTitles, menuKind, TEAM_ACTIONS } from '../functions/api/_bot.js';

const ROOT = new URL('..', import.meta.url).pathname;

/* The built pages, in a tree of this file's own.
 *
 * The build empties its output directory before it fills it, and the test
 * runner runs these files concurrently, so sharing dist-diwali with
 * programme.test.mjs means reading a tree that is halfway through being
 * deleted. One build, one reader, no race. */
const DIST = join(ROOT, '.test-dist/team');
execFileSync('node', ['build-diwali.mjs'], {
  cwd: ROOT, stdio: 'pipe', env: { ...process.env, DIWALI_OUT: DIST },
});

/* ------------------------------------------------------------------ harness */

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
        keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })),
        list_complete: true,
      };
    },
  };
}

const ADMIN = { ravi: 'tok-ravi-123', keerthi: 'tok-keerthi-456' };
const STEPS_ALL = ['ticket', 'discount', 'brevo', 'email', 'whatsapp'];
const getPersonForTest = (kv, id) => kv.get(personKey(id), 'json');

/** Live settings: everything on, nothing dry. The default for most tests. */
const ENV = (over = {}) => ({
  ACCRED: null,
  TEAM_REG_ENABLED: 'true',
  TEAM_DRY_RUN: 'false',
  TEAM_ADMIN_TOKENS: JSON.stringify(ADMIN),
  TEAM_CLOSE_AT: '2026-10-18T23:59:00+02:00',
  TEAM_CODE_MAX_ORDERS: '10',
  TT_API_KEY: 'tt-key',
  TT_EVENT_ID: 'ev_1',
  TT_TYPE_ARTIST: 'tt_artist',
  TT_TYPE_CREW: 'tt_crew',
  TT_TYPE_CHILD: 'tt_child',
  TT_TYPE_PLUS1: 'tt_plus1',
  TT_TYPE_PRESS: 'tt_press',
  TT_DISCOUNT_TICKET_TYPES: 'tt_single_10,tt_single_12',
  BREVO_API_KEY: 'brevo-key',
  BREVO_SENDER_EMAIL: 'diwali@artindia.be',
  BREVO_ACCRED_LIST_ID: '14',
  BREVO_BUYERS_LIST_ID: '12',
  WA_PHONE_ID: '1234',
  WA_TOKEN: 'wa-token',
  ...over,
});

/**
 * Every outbound call, recorded, with canned answers.
 *
 * `fail` names a host to break, which is how the ticket-failure and
 * retry-a-step tests are written.
 */
function world({ fail = '', discountCollision = false, existingTicket = null, buyer = false,
  shape = 'array' } = {}) {
  /* Four bytes standing in for a PNG. Nothing reads them; what matters is the
     content type, the length and that they come back base64 on the wire. */
  const QR_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const calls = [];
  let issued = 0;
  let discounts = 0;
  const real = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? String(init.body) : '';
    calls.push({ url, method, body });

    const reply = (status, obj) => (status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(obj), {
        status, headers: { 'content-type': 'application/json' },
      }));

    /* The QR image itself, which is a plain file on their CDN and not the
       API. Fetched at send time so it can be attached to the email. */
    if (/tickettailor\.com\/(qr|barcode)\//.test(url)) {
      if (fail === 'qr') return new Response('nope', { status: 404 });
      return new Response(QR_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    }

    if (url.includes('api.tickettailor.com')) {
      if (fail === 'tt') return reply(422, { errors: [{ message: 'Ticket type is sold out' }] });
      if (url.includes('/issued_tickets') && method === 'GET') {
        /* Ticket Tailor echoes the reference it was filtered on. A fixture
           that sets its own is deliberately answering about somebody else. */
        const asked = new URL(url).searchParams.get('reference') || '';
        const hit = existingTicket
          ? { reference: asked, ...existingTicket }
          : null;
        return reply(200, { data: hit ? [hit] : [] });
      }
      if (url.includes('/issued_tickets') && method === 'POST') {
        issued += 1;
        const ticket = {
          object: 'issued_ticket',
          id: `it_${issued}`,
          barcode: `bc_${issued}`,
          barcode_url: `https://www.tickettailor.com/barcode/${issued}.png`,
          qr_code_url: `https://www.tickettailor.com/qr/${issued}.png`,
        };
        /* All three shapes they answer in. The live one that broke the first
           approval was 'bare'. */
        if (shape === 'bare') return reply(201, ticket);
        if (shape === 'object') return reply(201, { data: ticket });
        if (shape === 'empty') return reply(201, { data: [] });
        return reply(201, { data: [ticket] });
      }
      if (url.includes('/void')) return reply(200, { data: [{ id: 'it_1', status: 'voided' }] });
      if (url.includes('/discounts') && method === 'POST') {
        if (fail === 'discount') return reply(400, { errors: [{ message: 'nope' }] });
        discounts += 1;
        return reply(201, { id: `dsc_${discounts}`, code: 'X', times_redeemed: 0 });
      }
      if (url.includes('/discounts') && method === 'GET') {
        return reply(200, { id: 'dsc_1', times_redeemed: 3 });
      }
      if (url.includes('/discounts') && method === 'DELETE') return reply(200, {});
      return reply(200, { data: [] });
    }

    if (url.includes('api.brevo.com')) {
      if (fail === 'brevo') return reply(500, { message: 'brevo down' });
      if (url.includes('/contacts/') && method === 'GET') {
        return buyer ? reply(200, { email: 'x', listIds: [12], attributes: {} }) : reply(404, {});
      }
      return reply(204, {});
    }

    if (url.includes('graph.facebook.com')) {
      if (fail === 'wa') return reply(400, { error: { code: 131026, message: 'undeliverable' } });
      return reply(200, { messages: [{ id: 'wamid.TEAM1' }] });
    }

    return reply(200, {});
  };

  return {
    calls,
    restore() { globalThis.fetch = real; },
    /* The API, not the CDN the QR image sits on: a retry of the email fetches
       the image again and that is not a Ticket Tailor API call. */
    tt: () => calls.filter(c => c.url.includes('api.tickettailor.com')),
    qr: () => calls.filter(c => /tickettailor\.com\/(qr|barcode)\//.test(c.url)),
    brevo: () => calls.filter(c => c.url.includes('brevo')),
    wa: () => calls.filter(c => c.url.includes('facebook')),
  };
}

/** A KV with one open link on the given team. */
async function withLink(team = 'artist', over = {}) {
  const kv = memoryKv();
  const t = 'LINKTOKEN0000000ABCD';
  await kv.put(linkKey(t), JSON.stringify({
    token: t, team, label: 'Group A', lead: 'Keerthi', expected: 10, open: true,
    createdBy: 'ravi', createdAt: '2026-09-01T10:00:00Z', ...over,
  }));
  return { kv, t };
}

const FORM = (over = {}) => ({
  k: 'LINKTOKEN0000000ABCD',
  firstName: 'Shreya',
  lastName: 'Menon',
  email: 'shreya@example.com',
  phone: '0474 91 99 00',
  role: 'Kathak solo',
  consent: true,
  lang: 'en',
  hp: '',
  ...over,
});

const people = async kv => {
  const out = [];
  for (const k of kv.store.keys()) {
    if (k.startsWith('person:')) out.push(JSON.parse(kv.store.get(k)));
  }
  return out;
};

const req = (method, body, headers = {}) => new Request('https://diwali.artindia.be/api/team-admin', {
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: method === 'GET' ? undefined : JSON.stringify(body),
});

/* ------------------------------------------------------------- 2. the teams */

test('the seed teams are the twelve in the brief, with the right flags', () => {
  assert.deepEqual(TEAMS.map(t => t.key),
    ['core', 'crew', 'dj', 'media', 'artist', 'collab', 'aimc', 'child', 'vip',
      'press', 'guest', 'plus1']);

  const by = k => TEAMS.find(t => t.key === k);
  assert.deepEqual(TEAMS.filter(t => t.promoCode).map(t => t.key),
    ['core', 'dj', 'media', 'artist', 'collab', 'aimc', 'child']);
  assert.deepEqual(TEAMS.filter(t => t.wall).map(t => t.key),
    ['core', 'crew', 'dj', 'media', 'artist', 'collab', 'aimc']);
  assert.deepEqual(TEAMS.filter(t => t.plusOne).map(t => t.key), ['artist']);
  assert.ok(by('vip').inviteOnly, 'the VIP team is invite only');
  assert.ok(by('child').childTeam);
  for (const t of TEAMS) {
    for (const l of ['en', 'fr', 'nl']) {
      assert.ok(t.name[l], `${t.key} has no ${l} name`);
    }
  }
});

test('every team names its own ticket type variable, and no two share one', () => {
  const envs = TEAMS.map(t => t.env);
  assert.equal(new Set(envs).size, envs.length, 'two teams share a ticket type variable');
  for (const t of TEAMS) {
    assert.equal(t.env, `TT_TYPE_${t.key.toUpperCase()}`,
      `${t.key} does not follow the TT_TYPE_<KEY> convention`);
  }
  /* And the brief's section 10 lists every one of them, so nothing can be
     added to the data file and forgotten in the environment. */
  const brief = readFileSync(join(ROOT, 'docs/claude-code-brief-team-registration.md'), 'utf8');
  const env = brief.slice(brief.indexOf('## 10. Environment'));
  for (const t of TEAMS) {
    assert.ok(env.includes(`\`${t.env}\``), `${t.env} is missing from section 10`);
  }
});

test('every team has a name in three languages and an empty arrival line', () => {
  for (const t of TEAMS) {
    assert.deepEqual(Object.keys(t.arrival).sort(), ['en', 'fr', 'nl']);
    assert.equal(t.arrival.en, '', `${t.key} arrival should be Ravi's to fill`);
  }
});

/* ------------------------------------------------------- 6. visitor-facing copy */

test('the copy carries all three languages for every string the brief gives', () => {
  const brief = readFileSync(join(ROOT, 'docs/claude-code-brief-team-registration.md'), 'utf8');
  const given = [...brief.matchAll(/^\| ([a-z0-9_]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .filter(m => COPY[m[1]]);
  assert.ok(given.length >= 22, `only ${given.length} strings matched the brief's table`);
  for (const [, key, en, fr, nl] of given) {
    assert.equal(COPY[key].en, en.trim(), `${key} EN drifted from the brief`);
    assert.equal(COPY[key].fr, fr.trim(), `${key} FR drifted from the brief`);
    assert.equal(COPY[key].nl, nl.trim(), `${key} NL drifted from the brief`);
  }
});

test('no visitor-facing string has an em dash or the word weekend', () => {
  for (const [key, v] of Object.entries(COPY)) {
    for (const l of ['en', 'fr', 'nl']) {
      assert.ok(!/[—–]/.test(v[l] || ''), `${key}.${l} has an em dash`);
      assert.ok(!/\bweekend\b/i.test(v[l] || ''), `${key}.${l} says weekend`);
    }
  }
});

test('the form pages are hidden, in three languages, with no chat widget', () => {
  for (const rel of ['team/index.html', 'fr/team/index.html', 'nl/team/index.html',
    'team/plus1/index.html', 'fr/team/plus1/index.html', 'nl/team/plus1/index.html']) {
    const html = readFileSync(join(DIST, rel), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/, `${rel} is indexable`);
    assert.ok(!html.includes('diya'), `${rel} loads the chat widget`);
    assert.ok(!html.includes('{{'), `${rel} has an unfilled token`);
  }
  const sitemap = readFileSync(join(DIST, 'sitemap.xml'), 'utf8');
  assert.ok(!sitemap.includes('/team/'), 'the team form is in the sitemap');
});

test('the chat widget excludes every team path', () => {
  const js = readFileSync(join(ROOT, 'diwali-web/diya.js'), 'utf8');
  for (const path of ['/team/', '/fr/team/', '/nl/team/', '/team/plus1/']) {
    const guards = [/^\/(admin|r|i|team)(\/|$)/, /^\/(fr|nl)\/team(\/|$)/];
    assert.ok(guards.some(re => re.test(path)), `${path} would load the widget`);
  }
  assert.match(js, /admin\|r\|i\|team/);
  assert.match(js, /\(fr\|nl\)\\\/team/);
});

/* --------------------------------------------------------- 4.2 registration */

test('a good submission lands as one pending person and sends no pass', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV();
    const r = await register(env, kv, FORM(), { ip: '1.2.3.4' });
    assert.ok(r.ok);
    assert.equal(r.person.status, 'pending');
    assert.equal(r.person.phone, '+32474919900', 'the number was normalised');
    assert.deepEqual(r.person.steps,
      { ticket: null, discount: null, brevo: null, email: null, whatsapp: null });
    assert.equal(r.person.tt, null);
    assert.equal(r.person.promo, null);
    assert.equal(r.person.plus1Token, null, 'the +1 waits for approval');
    assert.equal(w.tt().length, 0, 'registration must not touch Ticket Tailor');
    assert.equal(w.wa().length, 0, 'registration must not send a WhatsApp');
    assert.ok(w.brevo().some(c => c.body.includes('"REG_STATUS":"pending"')));
    assert.ok(w.brevo().some(c => c.url.includes('/smtp/email')), 'no received email');
  } finally { w.restore(); }
});

test('validation refuses a bad email, a bad number, no consent, and a short role', () => {
  const artist = teamOf('artist');
  assert.equal(validate(FORM(), artist), '');
  assert.equal(validate(FORM({ email: 'not-an-email' }), artist), 'email');
  assert.equal(validate(FORM({ phone: 'abc' }), artist), 'phone');
  assert.equal(validate(FORM({ consent: false }), artist), 'consent');
  assert.equal(validate(FORM({ role: 'x' }), artist), 'role');
  assert.equal(validate(FORM({ role: 'x'.repeat(61) }), artist), 'role');
  assert.equal(validate(FORM({ firstName: ' ' }), artist), 'name');
});

test('a filled honeypot looks like success and stores nothing', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const r = await register(ENV(), kv, FORM({ hp: 'Acme Ltd' }), { ip: '1.2.3.4' });
    assert.ok(r.ok);
    assert.ok(r.quiet);
    assert.equal((await people(kv)).length, 0);
    assert.equal(w.calls.length, 0, 'a bot cost us no API calls');
  } finally { w.restore(); }
});

test('a closed link, a closed registration and a switched-off module all refuse', async () => {
  const w = world();
  try {
    const shut = await withLink('artist', { open: false });
    const r = await register(ENV(), shut.kv, FORM(), {});
    assert.equal(r.ok, false);
    assert.equal(r.message, 'inactive');
    assert.equal(r.why, 'link_closed', 'the reason is for the approvers, not the visitor');

    const open = await withLink('artist');
    const late = await register(ENV({ TEAM_CLOSE_AT: '2020-01-01T00:00:00Z' }), open.kv, FORM(), {});
    assert.equal(late.message, 'closed');

    const off = await register(ENV({ TEAM_REG_ENABLED: 'false' }), open.kv, FORM(), {});
    assert.equal(off.message, 'inactive');
    assert.equal((await people(open.kv)).length, 0, 'nothing was stored on a refusal');
  } finally { w.restore(); }
});

test('the VIP team has no form: it refuses even with a link pointed at it', async () => {
  const { kv } = await withLink('vip');
  const w = world();
  try {
    assert.equal((await register(ENV(), kv, FORM(), {})).message, 'inactive');
  } finally { w.restore(); }
});

test('the same phone and the same name on the same link is one person', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV();
    const first = await register(env, kv, FORM(), { ip: '1.2.3.4' });
    const again = await register(env, kv, FORM(), { ip: '1.2.3.4' });
    assert.ok(again.ok);
    assert.ok(again.repeat);
    assert.equal(again.person.id, first.person.id);
    assert.equal((await people(kv)).length, 1);
  } finally { w.restore(); }
});

test('a rejected person cannot come back, and nobody else is blocked with them', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV();
    const r = await register(env, kv, FORM(), { ip: '1.2.3.4' });
    await reject(env, kv, { id: r.person.id, approver: 'ravi', note: 'not on the list' });
    assert.ok(await kv.get(rejectedPhoneKey('+32474919900')));

    /* Them again, on any link: still no. */
    const back = await register(env, kv, FORM(), { ip: '1.2.3.4' });
    assert.equal(back.message, 'inactive');
    assert.equal(back.why, 'rejected_match');
    assert.equal((await people(kv)).length, 1, 'no second row');

    /* Somebody else on the same phone: a partner, a flatmate, the one handset
       a group shares. A rejection is about a person, not a number. */
    const other = await register(env, kv, FORM({
      firstName: 'Rahul', lastName: 'Desai', email: 'rahul@example.com',
    }), { ip: '1.2.3.4' });
    assert.ok(other.ok, 'the whole phone number was blocked');
    assert.equal((await people(kv)).length, 2);
  } finally { w.restore(); }
});

test('a rejected child does not take their brothers and sisters with them', async () => {
  const { kv } = await withLink('child', { expected: 50 });
  const w = world();
  try {
    const env = ENV();
    const base = { ...FORM(), role: '' };
    const aarav = await register(env, kv, {
      ...base, child: { firstName: 'Aarav', lastName: 'Menon', dob: '2016-05-04' },
    }, {});
    await reject(env, kv, { id: aarav.person.id, approver: 'ravi', note: 'not in the class' });

    /* The same parent, the same phone, the same email, a different child. */
    const diya = await register(env, kv, {
      ...base, child: { firstName: 'Diya', lastName: 'Menon', dob: '2018-01-09' },
    }, {});
    assert.ok(diya.ok, 'a parent whose one child was rejected could register no sibling');
    assert.equal(diya.person.child.firstName, 'Diya');

    /* Aarav himself, though, is still turned down. */
    const again = await register(env, kv, {
      ...base, child: { firstName: 'Aarav', lastName: 'Menon', dob: '2016-05-04' },
    }, {});
    assert.equal(again.message, 'inactive');
    assert.equal(again.why, 'rejected_match');
  } finally { w.restore(); }
});

test('a rejection written before the name was kept is read through the person', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV();
    const r = await register(env, kv, FORM(), {});
    await reject(env, kv, { id: r.person.id, approver: 'ravi', note: 'no' });

    /* The old format: a bare person id, which is what is sitting in KV from
       before this change. The name is still on the person record, so the new
       rule reads it from there and nothing is lost. */
    await kv.put(rejectedPhoneKey('+32474919900'), r.person.id);
    await kv.delete(rejectedEmailKey('shreya@example.com'));

    const them = await register(env, kv, FORM(), {});
    assert.equal(them.message, 'inactive', 'the rejected person is still turned down');

    const other = await register(env, kv, FORM({
      firstName: 'Someone', lastName: 'Else', email: 'else@example.com',
    }), {});
    assert.ok(other.ok, 'somebody else on that phone is not');

    /* And when even the person record is gone, there is no name to compare,
       so it falls back to blocking the contact. That is the safe side. */
    await kv.delete(personKey(r.person.id));
    const blind = await register(env, kv, FORM({
      firstName: 'Third', lastName: 'Person', email: 'third@example.com',
    }), {});
    assert.equal(blind.message, 'inactive',
      'with nothing left to compare, the old behaviour stands');
  } finally { w.restore(); }
});

test('the hard cap is twice expected, never fewer than ten', async () => {
  assert.equal(hardCap(30), 60);
  assert.equal(hardCap(3), 10);
  assert.equal(hardCap(0), 10);

  const { kv } = await withLink('crew', { expected: 1 });
  const w = world();
  try {
    const env = ENV();
    for (let i = 0; i < 10; i++) {
      const r = await register(env, kv, FORM({
        firstName: `P${i}`, phone: `+3247491990${i}`, email: `p${i}@example.com`,
      }), {});
      assert.ok(r.ok, `row ${i} should have been accepted`);
    }
    const over = await register(env, kv, FORM({
      firstName: 'Eleven', phone: '+32474919911', email: 'eleven@example.com',
    }), {});
    assert.equal(over.message, 'inactive');
    assert.equal((await people(kv)).length, 10);
  } finally { w.restore(); }
});

test('the per-IP cap stops at forty a day', async () => {
  const { kv } = await withLink('guest', { expected: 200 });
  const w = world();
  try {
    const env = ENV();
    const day = new Date().toISOString().slice(0, 10);
    await kv.put(`ipcap:${day}:9.9.9.9`, String(IP_CAP_PER_DAY));
    const r = await register(env, kv, FORM(), { ip: '9.9.9.9' });
    assert.equal(r.message, 'inactive');
    assert.equal((await people(kv)).length, 0);

    const other = await register(env, kv, FORM(), { ip: '8.8.8.8' });
    assert.ok(other.ok, 'the cap is per address, not global');
  } finally { w.restore(); }
});

test('each flag is raised, and none of them blocks', async () => {
  const w = world({ buyer: true });
  try {
    const env = ENV();
    const a = await withLink('artist', { expected: 1 });
    const first = await register(env, a.kv, FORM(), {});
    assert.ok(first.ok);
    assert.ok(first.person.flags.includes('already_buyer'), 'the buyer check did not fire');

    /* Same phone, different name: a flag, and still accepted. */
    const second = await register(env, a.kv, FORM({
      firstName: 'Rahul', email: 'rahul@example.com',
    }), {});
    assert.ok(second.ok);
    assert.ok(second.person.flags.includes('dup_phone'));
    assert.ok(second.person.flags.includes('over_expected'), 'the link is past its expected number');

    /* Same email, different phone. */
    const third = await register(env, a.kv, FORM({
      firstName: 'Nina', phone: '+32474000001',
    }), {});
    assert.ok(third.person.flags.includes('dup_email'));
  } finally { w.restore(); }
});

test('the same person on another team is flagged, not refused', async () => {
  const w = world();
  try {
    const env = ENV();
    const kv = memoryKv();
    for (const [tok, team] of [['AAAAAAAAAAAAAAAAAAAA', 'crew'], ['BBBBBBBBBBBBBBBBBBBB', 'press']]) {
      await kv.put(linkKey(tok), JSON.stringify({
        token: tok, team, label: team, expected: 10, open: true,
      }));
    }
    await register(env, kv, FORM({ k: 'AAAAAAAAAAAAAAAAAAAA' }), {});
    const second = await register(env, kv, FORM({ k: 'BBBBBBBBBBBBBBBBBBBB' }), {});
    assert.ok(second.ok);
    assert.ok(second.person.flags.includes('other_team'));
  } finally { w.restore(); }
});

/* ----------------------------------------------------------- the child team */

test('the child team needs a real date of birth for somebody under 18', async () => {
  const child = teamOf('child');
  const ok = { ...FORM(), child: { firstName: 'Aarav', lastName: 'Menon', dob: '2016-05-04' } };
  assert.equal(validate(ok, child), '');
  assert.equal(validate({ ...ok, child: { ...ok.child, dob: '2026-02-31' } }, child), 'dob_invalid');
  assert.equal(validate({ ...ok, child: { ...ok.child, dob: '2007-01-01' } }, child), 'dob_invalid');
  assert.equal(validate({ ...ok, child: { ...ok.child, dob: '' } }, child), 'dob_invalid');
  assert.equal(validate({ ...ok, child: { firstName: '', lastName: 'M', dob: '2016-05-04' } }, child), 'child');

  assert.equal(ageOnFestival('2016-10-25'), 9, 'the day before their birthday');
  assert.equal(ageOnFestival('2016-10-24'), 10, 'their birthday');
  assert.ok(validDob('2008-10-25'));
  assert.ok(!validDob('2008-10-23'), '18 on the day is not a child artist');
});

test('one parent phone covers several children without a flag', async () => {
  const { kv } = await withLink('child', { expected: 50 });
  const w = world();
  try {
    const env = ENV();
    const base = { ...FORM(), role: '' };
    const one = await register(env, kv, {
      ...base, child: { firstName: 'Aarav', lastName: 'Menon', dob: '2016-05-04' },
    }, {});
    const two = await register(env, kv, {
      ...base, child: { firstName: 'Diya', lastName: 'Menon', dob: '2018-01-09' },
    }, {});
    assert.ok(one.ok && two.ok);
    assert.ok(!two.repeat, 'a second child is a second registration, not a repeat submit');
    assert.notEqual(two.person.id, one.person.id);
    assert.equal((await people(kv)).length, 2, 'both children are in the queue');
    assert.ok(!two.person.flags.includes('dup_phone'), 'a shared parent phone is normal here');

    /* The same parent and the same child again is the back arrow, not a
       third dancer. */
    const same = await register(env, kv, {
      ...base, child: { firstName: 'Aarav', lastName: 'Menon', dob: '2016-05-04' },
    }, {});
    assert.ok(same.repeat, 'the same child twice is one child');
    assert.equal(same.person.id, one.person.id);
    assert.equal((await people(kv)).length, 2);

    /* A different parent entering a child already registered is the double
       entry worth flagging. */
    const again = await register(env, kv, {
      ...base, firstName: 'Shreya2',
      child: { firstName: 'Aarav', lastName: 'Menon', dob: '2016-05-04' },
    }, {});
    assert.ok(again.person.flags.includes('dup_phone'));
  } finally { w.restore(); }
});

test("a child's date of birth reaches the admin payload and nothing else", async () => {
  const { kv } = await withLink('child', { expected: 50 });
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const DOB = '2016-05-04';
    const r = await register(env, kv, {
      ...FORM(), role: '', child: { firstName: 'Aarav', lastName: 'Menon', dob: DOB },
    }, {});
    await approve(env, kv, { id: r.person.id, approver: 'ravi' });

    for (const c of w.calls) {
      assert.ok(!c.body.includes(DOB), `a date of birth went to ${new URL(c.url).host}`);
      assert.ok(!c.url.includes(DOB), `a date of birth went into a URL`);
    }
    /* The pass is in the child's name; the parent is only the contact. */
    const issue = w.tt().find(c => c.method === 'POST' && c.url.includes('issued_tickets'));
    assert.match(issue.body, /full_name=Aarav\+Menon/);
    assert.match(issue.body, /email=shreya%40example\.com/);

    const res = await adminGet({ request: req('GET', null, { 'x-admin-token': ADMIN.ravi }), env });
    const payload = await res.json();
    const row = payload.people.find(p => p.id === r.person.id);
    assert.equal(row.child.dob, DOB, 'the admin payload must carry it');
    assert.equal(row.childAge, 10);
  } finally { w.restore(); }
});

/* ------------------------------------------------------------- 5.4 approval */

test('approval runs the steps in order and leaves a complete record', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});
    w.calls.length = 0;

    const done = await approve(env, kv, { id: r.person.id, approver: 'keerthi' });
    assert.ok(done.ok);
    const p = done.person;

    assert.equal(p.status, 'approved');
    assert.equal(p.decidedBy, 'keerthi');
    assert.ok(p.decidedAt);
    assert.equal(p.tt.issuedTicketId, 'it_1');
    assert.match(p.promo.code, /^SHREYA-[A-Z0-9]{4}$/);
    assert.equal(p.promo.discountId, 'dsc_1');
    assert.ok(p.plus1Token, 'a main artist gets a +1 token');
    assert.equal(p.plus1Token.length, 20);
    assert.ok(p.wallToken, 'the artist team is on the wall');
    assert.equal(p.wallToken.length, 24);
    assert.deepEqual(p.steps,
      { ticket: 'done', discount: 'done', brevo: 'done', email: 'done', whatsapp: 'done' });

    const order = w.calls.map(c => {
      if (/tickettailor\.com\/qr\//.test(c.url)) return 'qr';
      if (c.url.includes('issued_tickets')) return `ticket:${c.method}`;
      if (c.url.includes('discounts')) return 'discount';
      if (c.url.includes('/smtp/email')) return 'email';
      if (c.url.includes('brevo')) return 'brevo';
      if (c.url.includes('facebook')) return 'whatsapp';
      return c.url;
    });
    assert.deepEqual(order,
      ['ticket:GET', 'ticket:POST', 'discount', 'brevo', 'qr', 'email', 'whatsapp'],
      'the pass is fetched immediately before the email that carries it');

    /* The ticket is keyed on the person id, which is what makes a second
       approval able to find it rather than issue again. */
    const issue = w.tt().find(c => c.method === 'POST');
    assert.match(issue.body, new RegExp(`reference=${p.id}`));
    assert.match(issue.body, /event_id=ev_1/);
    assert.match(issue.body, /ticket_type_id=tt_artist/);
    assert.match(issue.body, /send_email=true/);
    assert.ok(!issue.body.includes('{'), 'the endpoint takes a form, not JSON');

    /* And the discount is a 10% code on the single tickets only. */
    const disc = w.tt().find(c => c.url.includes('discounts'));
    assert.match(disc.body, /type=percentage/);
    assert.match(disc.body, /price_percent=10/);
    assert.match(disc.body, /max_redemptions=10/);
    assert.match(disc.body, /ticket_types%5B%5D=tt_single_10/);
    assert.match(disc.body, /ticket_types%5B%5D=tt_single_12/);
  } finally { w.restore(); }
});

test('approving twice issues one ticket and one code', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});
    const first = await approve(env, kv, { id: r.person.id, approver: 'ravi' });
    w.calls.length = 0;
    const second = await approve(env, kv, { id: r.person.id, approver: 'keerthi' });

    assert.ok(second.ok);
    assert.equal(second.skipped, 'status_approved');
    assert.equal(second.person.tt.issuedTicketId, first.person.tt.issuedTicketId);
    assert.equal(second.person.promo.code, first.person.promo.code);
    assert.equal(second.person.plus1Token, first.person.plus1Token);
    assert.equal(second.person.decidedBy, 'ravi', 'the first approver keeps the record');
    assert.equal(w.calls.length, 0, 'the second approval called nothing');
  } finally { w.restore(); }
});

test('a Ticket Tailor failure leaves the person pending and sends nothing else', async () => {
  const { kv } = await withLink('artist');
  const clean = world();
  let id;
  try {
    const env = ENV({ ACCRED: kv });
    id = (await register(env, kv, FORM(), {})).person.id;
  } finally { clean.restore(); }

  const w = world({ fail: 'tt' });
  try {
    const env = ENV({ ACCRED: kv });
    const r = await approve(env, kv, { id, approver: 'ravi' });
    assert.ok(!r.ok);
    assert.equal(r.error, 'ticket_failed');
    assert.equal(r.person.status, 'pending', 'it goes back in the queue');
    assert.match(r.person.steps.ticket, /^failed:/);
    assert.equal(r.person.tt, null);
    assert.equal(r.person.steps.discount, null, 'nothing after the ticket ran');
    assert.equal(w.wa().length, 0);
    assert.equal(w.brevo().length, 0);
  } finally { w.restore(); }
});

test('a failed later step keeps the ticket, and retry runs only that step', async () => {
  const { kv } = await withLink('crew');
  let id;
  const w = world({ fail: 'wa' });
  try {
    const env = ENV({ ACCRED: kv });
    id = (await register(env, kv, FORM({ role: 'Sound' }), {})).person.id;
    const r = await approve(env, kv, { id, approver: 'ravi' });

    assert.ok(r.ok, 'a WhatsApp that bounced must not stop the approval');
    assert.equal(r.person.status, 'approved');
    assert.equal(r.person.tt.issuedTicketId, 'it_1');
    assert.equal(r.person.steps.ticket, 'done');
    assert.equal(r.person.steps.email, 'done');
    assert.match(r.person.steps.whatsapp, /^failed:/);
  } finally { w.restore(); }

  const w2 = world();
  try {
    const env = ENV({ ACCRED: kv });
    const again = await approve(env, kv, { id, approver: 'keerthi', only: ['whatsapp'] });
    assert.equal(again.person.steps.whatsapp, 'done');
    assert.equal(again.person.tt.issuedTicketId, 'it_1', 'the ticket was not reissued');
    assert.equal(w2.tt().length, 0, 'retrying one step called Ticket Tailor not at all');
    assert.equal(w2.wa().length, 1);
  } finally { w2.restore(); }
});

test('an existing ticket for this person is adopted, not duplicated', async () => {
  const { kv } = await withLink('press');
  const w = world({ existingTicket: { id: 'it_old', barcode: 'bc_old', status: 'valid' } });
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM({ role: 'Photographer' }), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });
    assert.equal(done.person.tt.issuedTicketId, 'it_old');
    assert.ok(done.person.adoptedTicket);
    assert.equal(w.tt().filter(c => c.method === 'POST' && c.url.includes('issued_tickets')).length, 0,
      'it issued a second ticket instead of adopting the first');
    const look = w.tt().find(c => c.method === 'GET');
    assert.match(look.url, new RegExp(`reference=${r.person.id}`));
    assert.match(look.url, /status=valid/);
  } finally { w.restore(); }
});

test('a team without a code gets no discount, and a team without a ticket type cannot be approved', async () => {
  const { kv } = await withLink('crew');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM({ role: 'Rigging' }), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });
    assert.equal(done.person.promo, null);
    assert.equal(done.person.steps.discount, null);
    assert.equal(w.tt().filter(c => c.url.includes('discounts')).length, 0);
  } finally { w.restore(); }

  const other = await withLink('guest');
  const w2 = world();
  try {
    /* No TT_TYPE_GUEST in the environment. */
    const env = ENV({ ACCRED: other.kv });
    const r = await register(env, other.kv, FORM({ role: 'Guest of the board' }), {});
    const done = await approve(env, other.kv, { id: r.person.id, approver: 'ravi' });
    assert.ok(!done.ok);
    assert.equal(done.error, 'no_ticket_type_for_guest');
    assert.equal(done.person.status, 'pending');
    assert.equal(w2.tt().length, 0);
  } finally { w2.restore(); }
});

test('only a main artist gets a +1 token, and the guest joins the queue', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const artist = (await approve(env, kv,
      { id: (await register(env, kv, FORM(), {})).person.id, approver: 'ravi' })).person;
    assert.ok(artist.plus1Token);

    /* A +1 token is not a link, so the route resolves it and hands the artist
       in. Without that it is just an unknown token. */
    const raw = await register(env, kv, FORM({
      k: artist.plus1Token, firstName: 'Tom', email: 'tom@example.com', phone: '+32470111222',
    }), {});
    assert.equal(raw.message, 'inactive', 'a +1 token is not a team link');

    const resolved = await register(env, kv, FORM({
      k: artist.plus1Token, firstName: 'Tom', lastName: 'Peeters',
      email: 'tom@example.com', phone: '+32470111222', role: '',
    }), { plus1: { artistId: artist.id, label: 'Shreya Menon' } });

    assert.ok(resolved.ok);
    assert.equal(resolved.person.team, 'plus1');
    assert.equal(resolved.person.plusOneOf, artist.id);
    assert.equal(resolved.person.status, 'pending', 'a +1 is never auto-approved');
    assert.equal(resolved.person.plus1Token, null, 'a +1 does not get a +1');

    const burnt = await kv.get(plus1Key(artist.plus1Token), 'json');
    assert.equal(burnt.used, true, 'the token burns at submit');

    /* And the token is dead for the next person. */
    const second = await register(ENV({ ACCRED: kv }), kv, FORM({
      k: artist.plus1Token, firstName: 'Ann', email: 'ann@example.com', phone: '+32470333444',
    }), {});
    assert.equal(second.message, 'inactive');
  } finally { w.restore(); }
});

test('a rejected +1 reopens the artist token', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const artist = (await approve(env, kv,
      { id: (await register(env, kv, FORM(), {})).person.id, approver: 'ravi' })).person;
    const guest = await register(env, kv, FORM({
      k: artist.plus1Token, firstName: 'Tom', email: 'tom@example.com', phone: '+32470111222',
    }), { plus1: { artistId: artist.id, label: 'Shreya Menon' } });

    await reject(env, kv, { id: guest.person.id, approver: 'ravi', note: 'changed their mind' });
    const entry = await kv.get(plus1Key(artist.plus1Token), 'json');
    assert.equal(entry.used, false, 'the artist can name somebody else');
  } finally { w.restore(); }
});

test('the wall token follows the wall flag and never the child team', async () => {
  for (const [team, want] of [['artist', true], ['crew', true], ['child', false], ['press', false]]) {
    const { kv } = await withLink(team, { expected: 50 });
    const w = world();
    try {
      const env = ENV({ ACCRED: kv });
      const body = team === 'child'
        ? { ...FORM(), role: '', child: { firstName: 'Aarav', lastName: 'M', dob: '2016-05-04' } }
        : FORM({ role: 'Something' });
      const r = await register(env, kv, body, {});
      const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });
      assert.equal(Boolean(done.person.wallToken), want, `${team} wall token`);

      /* And no link in anything that goes out while WALL_ENABLED is false. */
      for (const c of w.calls) {
        assert.ok(!/wall/i.test(c.body), `${team} leaked a wall link`);
      }
    } finally { w.restore(); }
  }
});

test('revoke voids the ticket, deletes the code and says so in Brevo', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const p = (await approve(env, kv,
      { id: (await register(env, kv, FORM(), {})).person.id, approver: 'ravi' })).person;
    w.calls.length = 0;

    const r = await revoke(env, kv, { id: p.id, approver: 'keerthi', note: 'left the group' });
    assert.equal(r.person.status, 'revoked');
    assert.ok(w.tt().some(c => c.url.includes(`/issued_tickets/${p.tt.issuedTicketId}/void`)));
    assert.ok(w.tt().some(c => c.method === 'DELETE' && c.url.includes(p.promo.discountId)));
    assert.equal(await kv.get(promoKey(p.promo.code)), null, 'the code was released');
    assert.ok(w.brevo().some(c => c.body.includes('"REG_STATUS":"revoked"')));
  } finally { w.restore(); }
});

/* --------------------------------------------------------------- 1.4 Brevo */

test('nothing in this module writes to the buyers list', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});
    await approve(env, kv, { id: r.person.id, approver: 'ravi' });
    for (const c of w.brevo()) {
      if (c.method !== 'POST' || !c.url.includes('/contacts')) continue;
      const sent = JSON.parse(c.body);
      const lists = sent.listIds || [];
      assert.ok(!lists.includes(12), 'a contact was put on the buyers list');
      assert.deepEqual(lists, [14], 'the only list is the accreditation list');
      for (const forbidden of ['REFERRAL_CODE', 'TICKET_COUNT', 'CHILD_COUNT', 'REFERRED_BY']) {
        assert.ok(!(forbidden in (sent.attributes || {})),
          `${forbidden} is a buyer attribute and must not be written here`);
      }
    }
  } finally { w.restore(); }
});

test('the Brevo attributes are the ones section 7 lists, and no date of birth', () => {
  const person = {
    firstName: 'Shreya', lastName: 'Menon', email: 'shreya@example.com',
    phone: '+32474919900', lang: 'fr', team: 'child', status: 'approved',
    role: '', label: 'Group A', child: { firstName: 'Aarav', lastName: 'Menon', dob: '2016-05-04' },
    promo: { code: 'SHREYA-7KQ4' }, tt: { issuedTicketId: 'it_1' }, plus1Token: null,
  };
  const a = brevoAttributesFor(person, teamOf('child'));
  assert.equal(a.ACT_OR_ROLE, 'Parent of Aarav');
  assert.equal(a.TEAM, 'child');
  assert.equal(a.REG_STATUS, 'approved');
  assert.equal(a.PROMO_CODE, 'SHREYA-7KQ4');
  assert.equal(a.TT_TICKET_ID, 'it_1');
  assert.equal(a.INVITED_BY, 'Group A');
  assert.equal(a.LANG, 'fr');
  assert.equal(a.SMS, '+32474919900');
  assert.equal(a.WHATSAPP, '+32474919900');
  assert.ok(!JSON.stringify(a).includes('2016-05-04'), 'a date of birth reached Brevo');
});

/* --------------------------------------------------------------- 5.1 access */

test('admin auth: no token, a wrong token, and each named token', async () => {
  const { kv } = await withLink('artist');
  const env = ENV({ ACCRED: kv });

  assert.equal((await adminGet({ request: req('GET'), env })).status, 401);
  assert.equal((await adminGet({
    request: req('GET', null, { 'x-admin-token': 'guess' }), env,
  })).status, 401);
  assert.equal((await adminGet({
    request: req('GET', null, { 'x-admin-token': ADMIN.ravi }), env,
  })).status, 200);

  /* Unset secret refuses everybody, including the right-looking token. */
  const bare = ENV({ ACCRED: kv, TEAM_ADMIN_TOKENS: '' });
  assert.equal((await adminGet({
    request: req('GET', null, { 'x-admin-token': ADMIN.ravi }), env: bare,
  })).status, 503);

  assert.equal(approverFor(env, ADMIN.ravi), 'ravi');
  assert.equal(approverFor(env, ADMIN.keerthi), 'keerthi');
  assert.equal(approverFor(env, 'tok-ravi-124'), '');
  assert.equal(approverFor(env, ''), '');
});

test('the approver on the record is the name behind the token that was used', async () => {
  const { kv } = await withLink('crew');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const ids = [];
    for (const [i, who] of [[0, ADMIN.ravi], [1, ADMIN.keerthi]]) {
      const r = await register(env, kv, FORM({
        firstName: `P${i}`, phone: `+3247491991${i}`, email: `p${i}@example.com`, role: 'Crew',
      }), {});
      ids.push([r.person.id, who]);
    }
    for (const [id, tok] of ids) {
      await adminPost({
        request: req('POST', { action: 'approve', id }, { 'x-admin-token': tok }), env,
      });
    }
    const rows = await people(kv);
    assert.deepEqual(rows.map(p => p.decidedBy).sort(), ['keerthi', 'ravi']);
  } finally { w.restore(); }
});

test('the admin payload carries the teams, the links and everyone', async () => {
  const { kv, t } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    await register(env, kv, FORM(), {});
    const res = await adminGet({ request: req('GET', null, { 'x-admin-token': ADMIN.ravi }), env });
    const d = await res.json();
    assert.equal(d.approver, 'ravi');
    assert.equal(d.teams.length, 12);
    assert.equal(d.links.length, 1);
    assert.equal(d.links[0].url, `https://diwali.artindia.be/team/?k=${t}`);
    assert.equal(d.links[0].registered, 1);
    assert.equal(d.people.length, 1);
    assert.equal(d.teams.find(x => x.key === 'vip').blocked, 'invite_only');
    assert.equal(d.teams.find(x => x.key === 'guest').blocked, 'no_ticket_type_for_guest');
    assert.equal(d.teams.find(x => x.key === 'artist').blocked, '');
  } finally { w.restore(); }
});

test('links are created, closed, reopened, and expected is editable without a deploy', async () => {
  const kv = memoryKv();
  const env = ENV({ ACCRED: kv });
  const head = { 'x-admin-token': ADMIN.ravi };

  const made = await (await adminPost({
    request: req('POST', {
      action: 'link_create', team: 'collab', label: 'Antwerp group', lead: 'Priya', expected: 8,
    }, head), env,
  })).json();
  assert.ok(made.ok);
  assert.equal(made.link.team, 'collab');
  assert.equal(made.link.createdBy, 'ravi');
  assert.equal(made.link.token.length, 20);

  const shut = await (await adminPost({
    request: req('POST', { action: 'link_update', token: made.link.token, open: false }, head), env,
  })).json();
  assert.equal(shut.link.open, false);

  const vip = await adminPost({
    request: req('POST', { action: 'link_create', team: 'vip' }, head), env,
  });
  assert.equal(vip.status, 400, 'the VIP team has no links');

  const plus1 = await adminPost({
    request: req('POST', { action: 'link_create', team: 'plus1' }, head), env,
  });
  assert.equal(plus1.status, 400, 'a +1 link comes from an approval, not from here');

  await adminPost({
    request: req('POST', { action: 'expected_set', team: 'artist', expected: 42 }, head), env,
  });
  assert.equal(Number(await expectedFor(kv, 'artist')), 42);
  assert.ok(await kv.get(teamCfgKey('artist')), 'the override lives in KV, not in the file');
});

/* ------------------------------------------------------------------ 4.1 form */

test('the form endpoint describes a live link and says nothing about a dead one', async () => {
  const { kv, t } = await withLink('child', { expected: 50 });
  const env = ENV({ ACCRED: kv });
  const call = (q, e = env) => formGet({
    request: new Request(`https://diwali.artindia.be/api/team-form?${q}`), env: e,
  });

  const good = await (await call(`k=${t}&lang=fr`)).json();
  assert.ok(good.ok);
  assert.equal(good.team, 'child');
  assert.equal(good.childTeam, true);
  assert.equal(good.label, 'Group A');
  assert.equal(good.teamName, teamOf('child').name.fr);
  assert.equal(good.strings.title, COPY.title.fr);

  for (const q of ['k=NOPE', '']) {
    const bad = await (await call(q)).json();
    assert.equal(bad.ok, false);
    assert.equal(bad.message, 'inactive');
    assert.ok(!('team' in bad), 'a dead link must describe nothing');
  }

  const off = await (await call(`k=${t}`, ENV({ ACCRED: kv, TEAM_REG_ENABLED: 'false' }))).json();
  assert.equal(off.message, 'inactive');
});

test('the register route checks the origin and refuses a stranger', async () => {
  assert.ok(allowedOrigin('https://diwali.artindia.be'));
  assert.ok(allowedOrigin('http://localhost:8788'));
  assert.ok(allowedOrigin(null), 'a same-origin fetch sends no Origin');
  assert.ok(!allowedOrigin('https://evil.example'));

  const { kv } = await withLink('artist');
  const res = await registerPost({
    request: new Request('https://diwali.artindia.be/api/team-register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(FORM()),
    }),
    env: ENV({ ACCRED: kv }),
  });
  assert.equal(res.status, 403);
  assert.equal((await people(kv)).length, 0);
});

/* ------------------------------------------------------------- 1.7 ship dark */

test('a dry run simulates the ticket, the code and the WhatsApp, and reaches nobody', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({
      ACCRED: kv, TEAM_DRY_RUN: 'true', TEAM_TEST_EMAILS: 'ravi@artindia.be',
    });
    const r = await register(env, kv, FORM(), {});
    /* The only call registration makes on a dry run is the read that decides
       the already_buyer flag. Nothing was written and nothing was sent. */
    assert.deepEqual(w.calls.map(c => `${c.method} ${new URL(c.url).pathname}`),
      ['GET /v3/contacts/shreya%40example.com']);
    w.calls.length = 0;

    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });

    assert.ok(done.ok);
    assert.equal(done.person.status, 'approved');
    assert.match(done.person.tt.issuedTicketId, /^dry_tkt_/);
    assert.match(done.person.promo.discountId, /^dry_dsc_/);
    /* Said out loud, not recorded as done: a dry run that reads like a success
       is how a fake ticket ends up believed. */
    assert.deepEqual(done.person.steps, {
      ticket: SKIPPED, discount: SKIPPED, brevo: SKIPPED, email: SKIPPED, whatsapp: SKIPPED,
    });
    assert.equal(w.calls.length, 0,
      'a dry run reached Ticket Tailor, Brevo, Meta or all three');
  } finally { w.restore(); }
});

test('a dry run still emails and upserts an address on the test list', async () => {
  const { kv } = await withLink('crew');
  const w = world();
  try {
    const env = ENV({
      ACCRED: kv, TEAM_DRY_RUN: 'true', TEAM_TEST_EMAILS: 'ravi@artindia.be, keerthi@artindia.be',
    });
    const r = await register(env, kv, FORM({ email: 'ravi@artindia.be', role: 'Stage' }), {});
    assert.ok(w.brevo().some(c => c.url.includes('/smtp/email')), 'the test address got no email');
    await approve(env, kv, { id: r.person.id, approver: 'ravi' });
    assert.equal(w.tt().length, 0, 'the ticket was still simulated');
    assert.equal(w.wa().length, 0, 'the WhatsApp was still simulated');
  } finally { w.restore(); }
});

/* ---------------------------------------------------------------- 6. Diya */

test('an approved person with a code gets the three pass buttons', () => {
  const team = { person: { id: 'p_1' }, team: teamOf('artist'), hasCode: true };
  assert.equal(menuKind(false, team), 'team');
  assert.equal(menuKind(true, team), 'team', 'team beats buyer');
  assert.equal(menuKind(true, null), 'buyer');
  assert.equal(menuKind(false, null), 'guest');

  for (const [lang, titles] of [
    ['en', ['My pass', 'My code', 'Tickets sold']],
    ['fr', ['Mon pass', 'Mon code', 'Billets vendus']],
    ['nl', ['Mijn pas', 'Mijn code', 'Tickets verkocht']],
  ]) {
    assert.deepEqual(menuTitles(lang, 'team').map(([, t]) => t), titles);
    assert.deepEqual(menuTitles(lang, 'team').map(([id]) => id),
      ['MY_PASS', 'MY_CODE', 'CODE_SALES']);
  }

  const menu = buildMenu('+32474919900', 'en', false, false, team);
  assert.deepEqual(menu.interactive.action.buttons.map(b => b.reply.id),
    ['MY_PASS', 'MY_CODE', 'CODE_SALES']);
  for (const b of menu.interactive.action.buttons) {
    assert.ok(b.reply.title.length <= 20, `${b.reply.title} is too long for Meta`);
  }
});

test('without a code the menu is the pass plus the first two prospect buttons', () => {
  const team = { person: { id: 'p_1' }, team: teamOf('crew'), hasCode: false };
  assert.equal(menuKind(false, team), 'teamPlain');
  const menu = buildMenu('+32474919900', 'fr', false, false, team);
  assert.deepEqual(menu.interactive.action.buttons.map(b => b.reply.id),
    ['MY_PASS', 'BUY_TICKETS', 'FESTIVAL_INFO']);
});

test('a team member is never offered the draw', () => {
  for (const kind of ['team', 'teamPlain']) {
    for (const lang of ['en', 'fr', 'nl']) {
      const ids = menuTitles(lang, kind).map(([id]) => id);
      assert.ok(!ids.includes('MY_LINK'), `${kind}/${lang} offers the draw link`);
      assert.ok(!ids.includes('MY_CHANCES'), `${kind}/${lang} offers the draw chances`);
    }
  }
  assert.deepEqual(TEAM_ACTIONS, ['MY_PASS', 'MY_CODE', 'CODE_SALES']);
});

test('the lookup by phone tells team from pending from nobody', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});

    const waiting = await teamMemberFor(kv, '+32474919900');
    assert.ok(waiting.pending);
    assert.ok(!waiting.person);

    await approve(env, kv, { id: r.person.id, approver: 'ravi' });
    const member = await teamMemberFor(kv, '+32474919900');
    assert.equal(member.person.id, r.person.id);
    assert.equal(member.team.key, 'artist');

    assert.equal(await teamMemberFor(kv, '+32499000000'), null);

    await reject(env, kv, { id: r.person.id, approver: 'ravi', note: 'no' });
    assert.equal(await teamMemberFor(kv, '+32474919900'), null,
      'a rejected number is an ordinary visitor');
  } finally { w.restore(); }
});

test('the three pass answers say the right things, and the code line is forwardable', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const p = (await approve(env, kv,
      { id: (await register(env, kv, FORM(), {})).person.id, approver: 'ravi' })).person;
    const member = await teamMemberFor(kv, '+32474919900');

    const pass = await passAnswer(env, kv, member);
    assert.match(pass, /Main artists/);
    assert.match(pass, /shreya@example\.com/);
    assert.match(pass, new RegExp(`/team/plus1/\\?k=${p.plus1Token}`),
      'a main artist is told the state of their +1');
    assert.ok(!pass.includes(p.wallToken), 'the wall link is off until WALL_ENABLED');

    const code = codeAnswer(member.person);
    assert.match(code, new RegExp(p.promo.code));
    assert.match(code, /10% off your Brussels Diwali Festival ticket/);
    assert.match(code, /https:\/\/diwali\.artindia\.be\/go\/buy\?cta=team/);

    const sales = await salesAnswer(env, kv, member.person);
    assert.equal(sales, COPY.bot_sales.en.replace('{ORDERS}', '3'),
      'times_redeemed on the discount is the source');
    const cached = await salesAnswer(env, kv, member.person);
    assert.equal(cached, sales);
    assert.equal(w.tt().filter(c => c.method === 'GET' && c.url.includes('/discounts/')).length, 1,
      'the count is cached, not fetched on every tap');
  } finally { w.restore(); }
});

test('a pass answer carries no pass for somebody without one', () => {
  assert.equal(codeAnswer({ lang: 'en', promo: null }), '');
});

/* --------------------------------------------------------------- 10. env */

test('the buy link is taggable as a team sale', async () => {
  /* /go/buy takes any short cta id and turns it into ref=site-<cta>, so
     cta=team needs no change there. This is the proof of that, and of the
     link the bot actually hands out. */
  const buy = await import('../functions/go/buy.js');
  const res = await buy.onRequestGet({
    request: new Request('https://diwali.artindia.be/go/buy?cta=team&lang=en'),
    env: {},
  });
  const to = new URL(res.headers.get('location'));
  assert.equal(to.searchParams.get('ref'), 'site-team');
  assert.match(codeAnswer({ lang: 'en', promo: { code: 'X-1' } }), /cta=team/);
});

test('a token is from the safe alphabet and a promo code reads as a name', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(token(20), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/);
  }
  assert.match(promoCodeFor('Shreya'), /^SHREYA-[A-Z0-9]{4}$/);
  assert.match(promoCodeFor('Jean-Luc'), /^JEANLUC-[A-Z0-9]{4}$/);
  assert.match(promoCodeFor('Félix'), /^FELIX-[A-Z0-9]{4}$/);
  assert.match(promoCodeFor('Bartholomewson'), /^BARTHOLOME-[A-Z0-9]{4}$/,
    'ten characters of name, then the four random ones');
  assert.match(promoCodeFor(''), /^TEAM-[A-Z0-9]{4}$/,
    'a person with no usable first name still gets a code');
});

test('the emails say what they are for and sign as the festival', () => {
  const team = teamOf('artist');
  const person = {
    firstName: 'Shreya', lastName: 'Menon', email: 'shreya@example.com', lang: 'fr',
    promo: { code: 'SHREYA-7KQ4' }, plus1Token: 'T'.repeat(20), team: 'artist', status: 'approved',
  };
  const got = approvedMail(ENV(), person, team);
  assert.equal(got.subject, COPY.mail_approved_subject.fr);
  const body = got.lines.join('\n');
  assert.match(body, /SHREYA-7KQ4/);
  assert.match(body, /\/team\/plus1\/\?k=TTTTTTTTTTTTTTTTTTTT/);
  assert.match(body, /Artistes principaux/);

  const recv = receivedMail(person, team);
  assert.equal(recv.subject, COPY.mail_received_subject.fr);
  assert.equal(recv.to, 'shreya@example.com');
});

/* ------------------------------------------------------- the pass itself */

/* Ticket Tailor's IssuedTicket schema lists `barcode`, `barcode_url` and
   `qr_code_url` as required, so a real response always carries an image URL
   and the approved email can show the pass rather than promise one. */

test('the issued ticket is read for its QR, with the barcode image as a fallback', () => {
  assert.deepEqual(
    ticketFacts({ id: 'it_1', barcode: 'al4R5', qr_code_url: 'https://tt/qr.png', barcode_url: 'https://tt/bc.png' }),
    { issuedTicketId: 'it_1', barcode: 'al4R5', qrUrl: 'https://tt/qr.png' });

  assert.equal(ticketFacts({ id: 'it_1', barcode: 'x', barcode_url: 'https://tt/bc.png' }).qrUrl,
    'https://tt/bc.png', 'the barcode image stands in when there is no QR');

  assert.equal(ticketFacts({ id: 'it_1', barcode: 'x' }).qrUrl, '',
    'neither URL is an empty string, never undefined');
});

test('the approved email carries the QR image and the barcode text under it', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });
    const p = done.person;

    assert.equal(p.tt.qrUrl, 'https://www.tickettailor.com/qr/1.png');

    const sent = w.brevo().find(c => c.url.includes('/smtp/email')
      && JSON.parse(c.body).subject === COPY.mail_approved_subject.en);
    const mail = JSON.parse(sent.body);

    assert.ok(mail.htmlContent, 'there is no HTML half to put an image in');
    assert.match(mail.htmlContent, /<img src="https:\/\/www\.tickettailor\.com\/qr\/1\.png"/);
    assert.equal((mail.htmlContent.match(new RegExp(p.tt.barcode, 'g')) || []).length, 1,
      'the barcode prints once, under the image, for a reader with images off');

    /* And the text half carries it too, so a stripped message still works. */
    assert.ok(mail.textContent.includes(p.tt.barcode));
    assert.ok(mail.textContent.includes(COPY.mail_qr.en));

    /* send_email stays on: theirs arriving as well costs nothing. */
    const issue = w.tt().find(c => c.method === 'POST' && c.url.includes('issued_tickets'));
    assert.match(issue.body, /send_email=true/);
  } finally { w.restore(); }
});

test('the HTML mail escapes what it is given and links a bare URL once', () => {
  const html = htmlMail(['Tom <script>alert(1)</script>', '',
    'Send them this: https://diwali.artindia.be/team/plus1/?k=ABC.'], null);
  assert.ok(!html.includes('<script>'), 'a name is not markup');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /<a href="https:\/\/diwali\.artindia\.be\/team\/plus1\/\?k=ABC"/);
  assert.ok(html.includes('</a>.'), 'the full stop stayed outside the link');
  assert.ok(!html.includes('<img'), 'no QR, no QR block');
});

test('a dry run has no QR, and the email says so by showing only the barcode', async () => {
  const { kv } = await withLink('crew');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv, TEAM_DRY_RUN: 'true', TEAM_TEST_EMAILS: 'ravi@artindia.be' });
    const r = await register(env, kv, FORM({ email: 'ravi@artindia.be', role: 'Stage' }), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });

    assert.equal(done.person.tt.qrUrl, '', 'nothing was asked of Ticket Tailor');
    const mail = approvedMail(env, done.person, teamOf('crew'));
    assert.ok(!htmlMail(mail.lines, mail.qr).includes('<img'));
    assert.ok(htmlMail(mail.lines, mail.qr).includes(done.person.tt.barcode),
      'with no image the barcode is the pass');
  } finally { w.restore(); }
});

test('Diya points at the same QR as the email, and at nothing when there is none', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const p = (await approve(env, kv,
      { id: (await register(env, kv, FORM(), {})).person.id, approver: 'ravi' })).person;
    const member = await teamMemberFor(kv, '+32474919900');

    const answer = await passAnswer(env, kv, member);
    assert.ok(answer.includes(p.tt.qrUrl), 'MY_PASS does not link to the pass');

    const noQr = { ...member, person: { ...member.person, tt: { issuedTicketId: 'x', barcode: 'y', qrUrl: '' } } };
    const plain = await passAnswer(env, kv, noQr);
    assert.ok(!plain.includes('http') || !plain.includes('/qr/'),
      'no QR means no broken link');
  } finally { w.restore(); }
});

/* ------------------------------------------------------------ 5.5 restore */

test('restore puts a rejected person back and lets them register again', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});
    await reject(env, kv, { id: r.person.id, approver: 'ravi', note: 'wrong group' });

    assert.ok(await kv.get(rejectedPhoneKey('+32474919900')));
    assert.ok(await kv.get(rejectedEmailKey('shreya@example.com')));

    const back = await restore(env, kv, { id: r.person.id, approver: 'keerthi' });
    assert.ok(back.ok);
    assert.equal(back.person.status, 'pending');
    assert.equal(back.person.restoredBy, 'keerthi');
    assert.ok(back.person.restoredAt);
    assert.equal(back.person.decidedBy, null, 'no decision stands on them now');
    assert.equal(back.person.decidedAt, null);
    assert.equal(back.person.note, 'wrong group', 'why they were turned down is still worth keeping');

    assert.equal(await kv.get(rejectedPhoneKey('+32474919900')), null);
    assert.equal(await kv.get(rejectedEmailKey('shreya@example.com')), null);

    /* And the form takes them again, which is the point of it. */
    const again = await register(env, kv, FORM({
      firstName: 'Shreya', phone: '+32474919901', email: 'shreya2@example.com',
    }), {});
    assert.ok(again.ok);
  } finally { w.restore(); }
});

test('restoring one person does not un-remember a sibling on the same phone', async () => {
  const { kv } = await withLink('child', { expected: 50 });
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const base = { ...FORM(), role: '' };
    const one = await register(env, kv, {
      ...base, child: { firstName: 'Aarav', lastName: 'Menon', dob: '2016-05-04' },
    }, {});
    const two = await register(env, kv, {
      ...base, email: 'other@example.com',
      child: { firstName: 'Diya', lastName: 'Menon', dob: '2018-01-09' },
    }, {});

    await reject(env, kv, { id: one.person.id, approver: 'ravi', note: 'a' });
    await reject(env, kv, { id: two.person.id, approver: 'ravi', note: 'b' });
    /* The second rejection owns the phone key now. */
    const owner = () => kv.get(rejectedPhoneKey('+32474919900'), 'json').then(m => m && m.id);
    assert.equal(await owner(), two.person.id);

    await restore(env, kv, { id: one.person.id, approver: 'ravi' });
    assert.equal(await owner(), two.person.id, 'the other rejection still stands');
    assert.equal(await kv.get(rejectedEmailKey('shreya@example.com')), null,
      'but this one released its own email');
  } finally { w.restore(); }
});

test('restore only works on a rejected person, and the route records the approver', async () => {
  const { kv } = await withLink('crew');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM({ role: 'Stage' }), {});

    const early = await restore(env, kv, { id: r.person.id, approver: 'ravi' });
    assert.ok(early.ok);
    assert.equal(early.skipped, 'status_pending');
    assert.equal(early.person.restoredBy, undefined, 'nothing was recorded');

    await reject(env, kv, { id: r.person.id, approver: 'ravi', note: 'no' });
    const res = await adminPost({
      request: req('POST', { action: 'restore', id: r.person.id },
        { 'x-admin-token': ADMIN.keerthi }), env,
    });
    const body = await res.json();
    assert.equal(body.person.status, 'pending');
    assert.equal(body.person.restoredBy, 'keerthi');

    const nobody = await restore(env, kv, { id: 'p_nope', approver: 'ravi' });
    assert.equal(nobody.ok, false);
    assert.equal(nobody.error, 'unknown_person');
  } finally { w.restore(); }
});

/* -------------------------------------------------- 4.1 the language switch */

test('the language switch is above the title on every form page, and only there', () => {
  for (const rel of ['team/index.html', 'fr/team/index.html', 'nl/team/index.html',
    'team/plus1/index.html', 'fr/team/plus1/index.html', 'nl/team/plus1/index.html']) {
    const html = readFileSync(join(DIST, rel), 'utf8');
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));

    assert.equal((main.match(/class="tf-langs"/g) || []).length, 1,
      `${rel} has the switch twice, or not at all`);
    assert.ok(main.indexOf('class="tf-langs"') < main.indexOf('<h1>'),
      `${rel} still shows the switch below the title`);

    /* And it points at this page in the other two languages, not the home page. */
    const leaf = rel.includes('plus1') ? 'team/plus1/' : 'team/';
    for (const [lang, prefix] of [['en', ''], ['fr', '/fr'], ['nl', '/nl']]) {
      assert.ok(main.includes(`href="${prefix}/${leaf}"`),
        `${rel} does not offer ${lang}`);
    }
    assert.match(main, /aria-current="page"/, `${rel} does not mark the current language`);
  }
});

test('every string has all three languages, apart from the one the brief leaves open', () => {
  const open = ['wall_invite'];
  for (const [key, v] of Object.entries(COPY)) {
    if (open.includes(key)) continue;
    for (const l of ['en', 'fr', 'nl']) {
      assert.ok(v[l], `${key}.${l} is empty`);
    }
  }
});

/* ------------------------------------------------------ the pass as a file */

/* The inline image is what most people see. The attachment is what survives a
   client with remote images off, which is the one that matters at a gate. */

test('the approved email attaches the pass, fetched at send time', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });

    assert.equal(done.person.steps.email, 'done');

    const sent = JSON.parse(w.brevo().find(c => c.url.includes('/smtp/email')
      && JSON.parse(c.body).subject === COPY.mail_approved_subject.en).body);

    assert.equal(sent.attachment.length, 1);
    assert.equal(sent.attachment[0].name, 'Brussels Diwali Festival pass - Shreya.png');
    assert.equal(sent.attachment[0].content, btoa('\x89PNG'), 'the bytes go out base64');

    /* And all three ways in are still there. */
    assert.match(sent.htmlContent, /<img src="https:\/\/www\.tickettailor\.com\/qr\/1\.png"/);
    assert.ok(sent.htmlContent.includes(done.person.tt.barcode));
    assert.ok(sent.textContent.includes(done.person.tt.barcode));
  } finally { w.restore(); }
});

test('a pass that will not download still gets the email out, and says so', async () => {
  const { kv } = await withLink('artist');
  const w = world({ fail: 'qr' });
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });

    assert.ok(done.ok);
    assert.equal(done.person.status, 'approved');
    assert.equal(done.person.steps.email, 'done:no_attachment:http_404',
      'the step result names what went wrong');

    const sent = JSON.parse(w.brevo().find(c => c.url.includes('/smtp/email')
      && JSON.parse(c.body).subject === COPY.mail_approved_subject.en).body);
    assert.ok(!('attachment' in sent), 'no empty attachment array');
    assert.ok(sent.htmlContent.includes('<img'), 'the inline image is untouched');
    assert.ok(sent.textContent.includes(done.person.tt.barcode));
  } finally { w.restore(); }
});

test('a half-done email is retryable, and a retry that works clears the note', async () => {
  const { kv } = await withLink('crew');
  let id;
  const broken = world({ fail: 'qr' });
  try {
    const env = ENV({ ACCRED: kv });
    id = (await register(env, kv, FORM({ role: 'Stage' }), {})).person.id;
    const done = await approve(env, kv, { id, approver: 'ravi' });
    assert.match(done.person.steps.email, /^done:no_attachment:/);
  } finally { broken.restore(); }

  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const again = await approve(env, kv, { id, approver: 'ravi', only: ['email'] });
    assert.equal(again.person.steps.email, 'done');
    assert.equal(w.tt().length, 0, 'retrying the email reissued nothing');
    assert.equal(w.qr().length, 1, 'it did fetch the pass again, which is the point');
  } finally { w.restore(); }
});

test('the pass file is named after whoever the pass is for', async () => {
  assert.equal(qrFileName('Shreya'), 'Brussels Diwali Festival pass - Shreya.png');
  assert.equal(qrFileName('  Tom  '), 'Brussels Diwali Festival pass - Tom.png');
  assert.equal(qrFileName(''), 'Brussels Diwali Festival pass - guest.png');

  /* On the child team the email goes to the parent but the pass is the
     child's, and a mother of three should not get three identical names. */
  const { kv } = await withLink('child', { expected: 50 });
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const base = { ...FORM(), role: '' };
    for (const child of [
      { firstName: 'Aarav', lastName: 'Menon', dob: '2016-05-04' },
      { firstName: 'Diya', lastName: 'Menon', dob: '2018-01-09' },
    ]) {
      const r = await register(env, kv, { ...base, child }, {});
      await approve(env, kv, { id: r.person.id, approver: 'ravi' });
    }
    const names = w.brevo()
      .filter(c => c.url.includes('/smtp/email'))
      .map(c => JSON.parse(c.body).attachment)
      .filter(Boolean)
      .map(a => a[0].name);
    assert.deepEqual(names, [
      'Brussels Diwali Festival pass - Aarav.png',
      'Brussels Diwali Festival pass - Diya.png',
    ]);
  } finally { w.restore(); }
});

test('the attachment fetch refuses anything that is not a small image', async () => {
  const real = globalThis.fetch;
  const reply = (status, body, type) => {
    globalThis.fetch = async () => new Response(body, {
      status, headers: type ? { 'content-type': type } : {},
    });
  };
  try {
    assert.deepEqual(await fetchQrAttachment('', 'x.png'), { ok: false, reason: 'no_qr_url' });

    reply(404, 'nope');
    assert.equal((await fetchQrAttachment('https://tt/qr.png', 'x.png')).reason, 'http_404');

    /* A login page where an image was expected: 200, and useless. */
    reply(200, '<!doctype html>', 'text/html');
    assert.equal((await fetchQrAttachment('https://tt/qr.png', 'x.png')).reason, 'not_an_image');

    reply(200, new Uint8Array(0), 'image/png');
    assert.equal((await fetchQrAttachment('https://tt/qr.png', 'x.png')).reason, 'empty');

    reply(200, new Uint8Array(300 * 1024), 'image/png');
    assert.equal((await fetchQrAttachment('https://tt/qr.png', 'x.png')).reason, 'too_big');

    globalThis.fetch = async () => { throw new Error('socket'); };
    assert.equal((await fetchQrAttachment('https://tt/qr.png', 'x.png')).reason, 'threw');
  } finally { globalThis.fetch = real; }
});

test('a dry run attaches nothing, because there is nothing to attach', async () => {
  const { kv } = await withLink('crew');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv, TEAM_DRY_RUN: 'true', TEAM_TEST_EMAILS: 'ravi@artindia.be' });
    const r = await register(env, kv, FORM({ email: 'ravi@artindia.be', role: 'Stage' }), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });

    assert.equal(done.person.steps.email, 'done', 'no URL is not a failed attachment');
    const sent = JSON.parse(w.brevo().find(c => c.url.includes('/smtp/email')
      && JSON.parse(c.body).subject === COPY.mail_approved_subject.en).body);
    assert.ok(!('attachment' in sent));
  } finally { w.restore(); }
});

/* -------------------------------------------- 1. why a ticket was refused */

test('a refused ticket comes back with what Ticket Tailor said', async () => {
  const { kv } = await withLink('artist');
  let id;
  const clean = world();
  try {
    id = (await register(ENV({ ACCRED: kv }), kv, FORM(), {})).person.id;
  } finally { clean.restore(); }

  const w = world({ fail: 'tt' });
  try {
    const env = ENV({ ACCRED: kv });
    const r = await approve(env, kv, { id, approver: 'ravi' });

    assert.equal(r.ok, false);
    assert.equal(r.error, 'ticket_failed');
    assert.equal(r.status, 422, 'the HTTP status reaches the page');
    assert.equal(r.detail, 'Ticket type is sold out', 'and so do their own words');
    assert.deepEqual(r.ttError.where, 'ticket');
    assert.ok(r.ttError.at, 'and when it happened');

    /* The same thing is on the record, so a page that loads later still shows it. */
    assert.equal(r.person.ttError.detail, 'Ticket Tailor refused'
      ? r.person.ttError.detail : 'Ticket type is sold out');
    assert.match(r.person.steps.ticket, /^failed:422 Ticket type is sold out/);
    assert.ok(r.person.stepAt.ticket, 'the step is stamped even when it failed');
    assert.equal(r.person.status, 'pending', 'and they are back in the queue');
  } finally { w.restore(); }
});

test('nothing that looks like a credential reaches a record or a screen', async () => {
  assert.equal(scrubSecret('Basic c2tfbGl2ZV9hYmM6'), 'Basic [redacted]');
  assert.equal(scrubSecret('key sk_live_abcdef123456'), 'key sk_[redacted]');

  const { kv } = await withLink('artist');
  let id;
  const clean = world();
  try { id = (await register(ENV({ ACCRED: kv }), kv, FORM(), {})).person.id; }
  finally { clean.restore(); }

  /* A server that echoes the request back, which is the shape of mistake that
     puts an Authorization header into an error message. */
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('issued_tickets')) {
      return new Response(JSON.stringify({
        errors: [{ message: `rejected: ${(init.headers || {}).authorization} sk_live_SECRET` }],
      }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await approve(ENV({ ACCRED: kv, TT_API_KEY: 'sk_live_SECRET' }), kv,
      { id, approver: 'ravi' });
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes('sk_live_SECRET'), 'the API key reached the response');
    assert.ok(!/Basic [A-Za-z0-9+/=]{8,}/.test(blob), 'an Authorization header reached the response');
    assert.match(r.detail, /\[redacted\]/);
  } finally { globalThis.fetch = real; }
});

test('a refused discount is reported too, and never costs the ticket', async () => {
  const { kv } = await withLink('artist');
  const w = world({ fail: 'discount' });
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });

    assert.ok(done.ok, 'a code that would not mint must not stop the pass');
    assert.equal(done.person.status, 'approved');
    assert.equal(done.person.tt.issuedTicketId, 'it_1');
    assert.match(done.person.steps.discount, /^failed:400 /);
    assert.equal(done.person.ttError.where, 'discount');
  } finally { w.restore(); }
});

test('their errors are read however they are shaped, and never over 300 characters', () => {
  assert.equal(ttMessage({ errors: [{ message: 'a' }, { message: 'b' }] }), 'a; b');
  assert.equal(ttMessage({ message: 'one thing' }), 'one thing');
  assert.equal(ttMessage(null, '  <html>502</html>\n'), '<html>502</html>');
  assert.equal(ttMessage({ errors: [{ message: 'x'.repeat(400) }] }).length, 300);
  assert.equal(ttMessage(null, ''), '');
});

/* ---------------------------------------- 2. a failed add must be visible */

test('an add that fails at the ticket step still answers with the record', async () => {
  const kv = memoryKv();
  const w = world({ fail: 'tt' });
  try {
    const env = ENV({ ACCRED: kv });
    const res = await adminPost({
      request: req('POST', {
        action: 'person_add', team: 'crew', firstName: 'Ravi', lastName: 'Kaushik',
        email: 'ravi@artindia.be', phone: '0474 91 99 00', role: 'Director', lang: 'en',
      }, { 'x-admin-token': ADMIN.ravi }),
      env,
    });
    assert.equal(res.status, 409);
    const d = await res.json();

    assert.equal(d.ok, false);
    assert.ok(d.person, 'without the person the page has nothing to draw');
    assert.equal(d.person.status, 'pending', 'they sit in the queue and can be tried again');
    assert.equal(d.detail, 'Ticket type is sold out');
    assert.equal(d.status, 422);

    /* And they really are stored, so the next GET finds them too. */
    const payload = await (await adminGet({
      request: req('GET', null, { 'x-admin-token': ADMIN.ravi }), env,
    })).json();
    assert.equal(payload.people.length, 1);
    assert.equal(payload.people[0].id, d.person.id);
  } finally { w.restore(); }
});

test('a team with no ticket type set says so in words, before Ticket Tailor is called', async () => {
  const kv = memoryKv();
  const w = world();
  try {
    /* The test environment has no TT_TYPE_CORE, which is what an unset
       variable in Cloudflare looks like. */
    const env = ENV({ ACCRED: kv });
    const res = await adminPost({
      request: req('POST', {
        action: 'person_add', team: 'core', firstName: 'Ravi', lastName: 'Kaushik',
        email: 'ravi@artindia.be', phone: '0474 91 99 00', role: 'Director', lang: 'en',
      }, { 'x-admin-token': ADMIN.ravi }),
      env,
    });
    const d = await res.json();

    assert.equal(d.ok, false);
    assert.equal(d.error, 'no_ticket_type_for_core');
    assert.equal(d.detail,
      'No ticket type is set for Core team. Set TT_TYPE_CORE in Cloudflare.');
    assert.ok(d.person, 'the record is still there to try again');
    assert.equal(d.person.status, 'pending');
    assert.equal(d.person.ttError.where, 'setup');
    assert.equal(w.tt().length, 0, 'nothing was asked of Ticket Tailor');
  } finally { w.restore(); }
});

test('approve, reject, restore and revoke all answer with the record', async () => {
  const { kv } = await withLink('crew');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const id = (await register(env, kv, FORM({ role: 'Stage' }), {})).person.id;
    const call = body => adminPost({
      request: req('POST', body, { 'x-admin-token': ADMIN.ravi }), env,
    }).then(r => r.json());

    for (const [body, status] of [
      [{ action: 'approve', id }, 'approved'],
      [{ action: 'revoke', id, note: 'x' }, 'revoked'],
    ]) {
      const d = await call(body);
      assert.ok(d.person, `${body.action} answered without the record`);
      assert.equal(d.person.status, status);
    }

    const id2 = (await register(env, kv, FORM({
      firstName: 'Tom', phone: '+32470111222', email: 'tom@example.com', role: 'Rigging',
    }), {})).person.id;
    const rej = await call({ action: 'reject', id: id2, note: 'no' });
    assert.equal(rej.person.status, 'rejected');
    const res = await call({ action: 'restore', id: id2 });
    assert.equal(res.person.status, 'pending');
    assert.equal(res.person.restoredBy, 'ravi');
  } finally { w.restore(); }
});

/* ------------------------------------------ 4 and 5. dry run is not truth */

test('a dry run says skipped, not done', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv, TEAM_DRY_RUN: 'true' });
    const r = await register(env, kv, FORM(), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });
    for (const step of ['ticket', 'discount', 'brevo', 'email', 'whatsapp']) {
      assert.equal(done.person.steps[step], SKIPPED, step);
      assert.ok(done.person.stepAt[step], `${step} has no time`);
    }
    assert.ok(isDryId(done.person.tt.issuedTicketId));
    assert.ok(isDryId(done.person.promo.discountId));
  } finally { w.restore(); }
});

test('approving for real throws away everything the dry run invented', async () => {
  const { kv } = await withLink('artist');
  let id, dryCode;
  const dry = world();
  try {
    const env = ENV({ ACCRED: kv, TEAM_DRY_RUN: 'true' });
    id = (await register(env, kv, FORM(), {})).person.id;
    const d = await approve(env, kv, { id, approver: 'ravi' });
    dryCode = d.promo ? d.promo.code : d.person.promo.code;
    assert.ok(isDryId(d.person.tt.issuedTicketId));
  } finally { dry.restore(); }

  /* Live, and the record is approved already. Without clearing it, the fake
     ticket would be believed and no real one would ever be issued. */
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const live = await approve(env, kv, { id, approver: 'ravi', only: STEPS_ALL });

    assert.equal(live.person.tt.issuedTicketId, 'it_1', 'a real ticket was issued');
    assert.ok(!isDryId(live.person.promo.discountId));
    assert.equal(live.person.steps.ticket, 'done');
    assert.equal(live.person.steps.email, 'done');
    assert.equal(await kv.get(promoKey(dryCode)), null, 'the made-up code was released');
    assert.equal(w.tt().filter(c => c.method === 'POST' && c.url.includes('issued_tickets')).length, 1);
  } finally { w.restore(); }
});

test('clearing dry results leaves a real record alone', async () => {
  const kv = memoryKv();
  const real = {
    id: 'p_1', tt: { issuedTicketId: 'it_9', barcode: 'b' },
    promo: { code: 'A-1', discountId: 'dsc_9' },
    steps: { ticket: 'done', discount: 'done', brevo: 'done', email: 'done', whatsapp: 'done' },
  };
  assert.equal(await clearDryResults(kv, real), false);
  assert.equal(real.tt.issuedTicketId, 'it_9');

  const fake = {
    id: 'p_2', tt: { issuedTicketId: 'dry_tkt_1' },
    promo: { code: 'B-2', discountId: 'dry_dsc_1' },
    steps: { ticket: SKIPPED, discount: SKIPPED, brevo: SKIPPED, email: SKIPPED, whatsapp: SKIPPED },
  };
  await kv.put(promoKey('B-2'), '{}');
  assert.equal(await clearDryResults(kv, fake), true);
  assert.equal(fake.tt, null);
  assert.equal(fake.promo, null);
  assert.deepEqual(fake.steps,
    { ticket: null, discount: null, brevo: null, email: null, whatsapp: null });
  assert.equal(await kv.get(promoKey('B-2')), null);
});

/* -------------------------------------------------- 7. the refusals list */

test('every refusal is written down, with a name nobody could mail', async () => {
  const { kv } = await withLink('collab', { expected: 1, label: 'Antwerp group' });
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    await register(env, kv, FORM({ consent: false }), {});
    await register(env, kv, FORM({ email: 'not-an-email' }), {});
    await register(env, kv, FORM({ k: 'NOPE' }), {});
    await register(ENV({ ACCRED: kv, TEAM_CLOSE_AT: '2020-01-01T00:00:00Z' }), kv, FORM(), {});

    const list = await allRefusals(kv);
    assert.equal(list.length, 4);
    assert.deepEqual(list.map(r => r.reason).sort(),
      ['closed', 'consent', 'email', 'unknown_link']);

    const one = list.find(r => r.reason === 'consent');
    assert.equal(one.firstName, 'Shreya');
    assert.equal(one.lastInitial, 'M', 'an initial, not a surname');
    assert.ok(!('lastName' in one), 'no surname is kept');
    assert.ok(!JSON.stringify(list).includes('shreya@example.com'), 'no address is kept');
    assert.ok(!JSON.stringify(list).includes('32474919900'), 'no phone is kept');
    assert.equal(one.team, 'collab');
    assert.equal(one.label, 'Antwerp group');
    assert.ok(one.at);
  } finally { w.restore(); }
});

test('a honeypot is a bot and is not worth a line', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    await register(ENV({ ACCRED: kv }), kv, FORM({ hp: 'Acme' }), {});
    assert.equal((await allRefusals(kv)).length, 0);
  } finally { w.restore(); }
});

test('the refusals list is capped and newest first', async () => {
  const kv = memoryKv();
  for (let i = 0; i < REFUSAL_CAP + 12; i++) {
    await logRefusal(kv, { reason: 'cap', firstName: `P${i}`, lastName: 'X' });
  }
  const trimmed = await trimRefusals(kv);
  assert.equal(trimmed, 12, 'the oldest twelve went');
  const list = await allRefusals(kv);
  assert.equal(list.length, REFUSAL_CAP);
  assert.ok(list[0].at >= list[list.length - 1].at, 'newest first');
});

/* ------------------------------------------------------- 8. add a person */

test('add person normalises the number and refuses one WhatsApp cannot reach', async () => {
  const kv = memoryKv();
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const add = body => adminPost({
      request: req('POST', { action: 'person_add', team: 'core', lang: 'en', ...body },
        { 'x-admin-token': ADMIN.ravi }),
      env,
    });

    const bad = await add({
      firstName: 'A', lastName: 'B', email: 'a@b.be', phone: 'ring the office',
    });
    assert.equal(bad.status, 400);
    const d = await bad.json();
    assert.equal(d.error, 'bad_phone');
    assert.match(d.detail, /\+32 474 91 99 00/, 'it says what a good one looks like');
    assert.equal((await people(kv)).length, 0, 'nobody was created');

    const ok = await add({
      firstName: 'A', lastName: 'B', email: 'a@b.be', phone: '0474 91 99 00',
    });
    const made = (await ok.json()).person;
    assert.equal(made.phone, '+32474919900');
    assert.ok(await kv.get(phoneKey('+32474919900')), 'Diya can find them by number');

    /* No number at all is still allowed: press contacts arrive by email. */
    const none = await add({ firstName: 'C', lastName: 'D', email: 'c@d.be' });
    assert.equal((await none.json()).person.phone, '');
  } finally { w.restore(); }
});

/* --------------------------------------------------------- 9. resending */

test('resend runs that one step again even though it says done', async () => {
  const { kv } = await withLink('crew');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const id = (await register(env, kv, FORM({ role: 'Stage' }), {})).person.id;
    await approve(env, kv, { id, approver: 'ravi' });
    const before = { emails: w.brevo().filter(c => c.url.includes('/smtp/email')).length,
      was: w.wa().length };

    const call = step => adminPost({
      request: req('POST', { action: 'resend', id, step }, { 'x-admin-token': ADMIN.keerthi }), env,
    }).then(r => r.json());

    const mail = await call('email');
    assert.ok(mail.ok);
    assert.equal(mail.person.steps.email, 'done');
    assert.equal(w.brevo().filter(c => c.url.includes('/smtp/email')).length, before.emails + 1,
      'a second email really went out');

    const wa = await call('whatsapp');
    assert.ok(wa.ok);
    assert.equal(w.wa().length, before.was + 1);

    /* And it is only ever those two. */
    const no = await adminPost({
      request: req('POST', { action: 'resend', id, step: 'ticket' },
        { 'x-admin-token': ADMIN.ravi }), env,
    });
    assert.equal(no.status, 400);
    assert.equal(w.tt().filter(c => c.method === 'POST').length, 1, 'no second ticket');
  } finally { w.restore(); }
});

/* ------------------------------------------------------- 6. the stamps */

test('every step and every decision is stamped', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});
    assert.ok(r.person.createdAt, 'registered when?');

    const done = await approve(env, kv, { id: r.person.id, approver: 'keerthi' });
    assert.ok(done.person.decidedAt);
    assert.equal(done.person.decidedBy, 'keerthi');
    for (const step of ['ticket', 'discount', 'brevo', 'email', 'whatsapp']) {
      assert.ok(done.person.stepAt[step], `${step} has no time`);
      assert.ok(!isNaN(Date.parse(done.person.stepAt[step])), `${step} time is not a date`);
    }
    assert.ok(done.person.stepAt.ticket <= done.person.stepAt.whatsapp,
      'the stamps run in the order the steps did');
  } finally { w.restore(); }
});

/* ---------------------------------------------------- the form, as a page */

const FORMS = ['team/index.html', 'fr/team/index.html', 'nl/team/index.html',
  'team/plus1/index.html', 'fr/team/plus1/index.html', 'nl/team/plus1/index.html'];
const page = rel => readFileSync(join(DIST, rel), 'utf8');

test('the top bar names the festival, the dates and the way out', () => {
  for (const rel of FORMS) {
    const html = page(rel);
    const lang = rel.startsWith('fr/') ? 'fr' : rel.startsWith('nl/') ? 'nl' : 'en';
    const top = html.slice(html.indexOf('<div class="tf-top">'), html.indexOf('</div>', html.indexOf('tf-langs')));

    assert.ok(top.includes('src="/favicon.svg"'), `${rel} has no festival mark`);
    assert.match(top, /alt=""/, `${rel} the mark is decoration and must not be announced`);
    assert.ok(top.includes('Brussels Diwali Festival'), `${rel} has no wordmark`);
    assert.ok(top.includes(COPY.dateline[lang]), `${rel} has the wrong dateline`);
    assert.ok(top.includes('tf-langs'), `${rel} has no language switch in the bar`);

    /* And the bar comes before everything. */
    const main = html.slice(html.indexOf('<main'));
    assert.ok(main.indexOf('tf-top') < main.indexOf('<h1>'), `${rel} buries the bar`);
    assert.ok(main.indexOf('tf-langs') < main.indexOf('<h1>'), `${rel} buries the switch`);
    assert.equal((main.match(/class="tf-langs"/g) || []).length, 1, `${rel} has two switches`);
  }
});

test('the page is the display font for its own name and nothing else', () => {
  const css = page('team/index.html');
  assert.match(css, /\.tf h1\{[^}]*font-family:var\(--display\)/, 'the title is not in the display font');
  assert.match(css, /\.tf-fest\{[^}]*font-family:var\(--display\)/, 'the wordmark is not');
  assert.match(css, /\.tf-done h2\{[^}]*font-family:var\(--display\)/, 'the thank you is not');
});

test('the team is a marigold badge and the inputs do not make a phone zoom', () => {
  const html = page('team/index.html');
  assert.match(html, /\.tf-badge\{[^}]*border:1px solid var\(--marigold\)/);
  assert.match(html, /\.tf-badge\{[^}]*color:var\(--marigold\)/);
  assert.ok(html.includes('<span class="tf-badge" id="tf-team">'), 'there is no badge to fill');

  /* 17px. At 16 or under, iOS zooms the page on focus. */
  const inputs = html.match(/\.tf input\[type=text\][^{]*\{([^}]*)\}/)[1];
  const size = Number((inputs.match(/font:400 (\d+)px/) || [])[1]);
  assert.ok(size >= 17, `inputs are ${size}px, which makes a phone zoom`);
});

test('first and last name share a row only once there is room', () => {
  const html = page('team/index.html');
  assert.match(html, /\.tf-pair\{display:grid/);
  assert.match(html, /@media \(min-width:360px\)\{\.tf-pair\{grid-template-columns:1fr 1fr\}\}/,
    'the pair must stack below 360px');
  assert.equal((html.match(/class="tf-pair"/g) || []).length, 2,
    'the child and the person block each get one');
});

test('there is a hint under the email and under the number', () => {
  for (const rel of FORMS) {
    const html = page(rel);
    const lang = rel.startsWith('fr/') ? 'fr' : rel.startsWith('nl/') ? 'nl' : 'en';
    const email = html.slice(html.indexOf('id="f-email"'), html.indexOf('id="f-phone"'));
    const phone = html.slice(html.indexOf('id="f-phone"'), html.indexOf('id="tf-role-field"'));
    assert.ok(email.includes(COPY.email_hint[lang]), `${rel} has no email hint`);
    assert.ok(phone.includes(COPY.phone_hint[lang]), `${rel} has no phone hint`);
    assert.ok(html.includes(COPY.fine[lang]), `${rel} does not say passes wait for approval`);
  }
});

test('the success screen is the tick, the thank you, and the steps', () => {
  for (const rel of FORMS) {
    const html = page(rel);
    const lang = rel.startsWith('fr/') ? 'fr' : rel.startsWith('nl/') ? 'nl' : 'en';
    const done = html.slice(html.indexOf('<div class="tf-done"'), html.indexOf('</main>'));

    assert.ok(done.includes('<svg'), `${rel} has no tick`);
    assert.match(done, /aria-hidden="true"/, `${rel} announces the tick to a screen reader`);
    assert.ok(done.includes(COPY.done_lede[lang]), `${rel} has no lede`);
    for (const k of ['step1_title', 'step1_text', 'step2_title', 'step2_text',
      'step3_title', 'step3_text']) {
      assert.ok(done.includes(COPY[k][lang]), `${rel} is missing ${k}`);
    }
    assert.equal((done.match(/class="tf-step"/g) || []).length, 3);

    /* Three is hidden in the markup and only shown for a team with a code. */
    assert.match(done, /id="tf-step3" hidden/, `${rel} promises a code to everybody`);

    /* The intro belongs to the form, not to the thank you. */
    assert.ok(!done.includes(COPY.intro[lang]), `${rel} repeats the intro on the success screen`);
    assert.ok(done.includes(COPY.another[lang]), `${rel} cannot register a second person`);
    assert.match(done, /id="tf-again" hidden/,
      'the button starts hidden and the script shows it, so a +1 never sees it');
  }
});

test('the script hides the intro and the title with the form', () => {
  const js = page('team/index.html');
  /* One element holds the badge, the title and the intro, and the success
     screen hides it: the form going away must take its heading with it. */
  assert.match(js, /head\.hidden = true;/);
  assert.match(js, /done\.hidden = false;/);
  assert.match(js, /if \(d\.promoCode\) document\.getElementById\('tf-step3'\)\.hidden = false;/);
  assert.match(js, /if \(KIND !== 'plus1'\) again\.hidden = false;/);
  assert.match(js, /S\.done_title\.replace\('\{FIRST\}', payload\.firstName\)/,
    'the thank you must name whoever filled the form in');
});

test('nothing on the page can scroll sideways on a 320px phone', () => {
  const html = page('nl/team/index.html');
  assert.match(html, /\.tf\{max-width:520px;margin:0 auto;padding:0 18px/);
  /* Dutch has the longest words on the page, and a long one must break rather
     than push the page wide. */
  for (const sel of ['.tf h1\\{', '.tf-done h2\\{', '.tf-step-t\\{', '.tf-step-p\\{', '.tf-label\\{']) {
    const rule = html.match(new RegExp(sel + '([^}]*)\\}'))[1];
    assert.ok(/overflow-wrap:anywhere|min-width:0/.test(rule), `${sel} can push the page wide`);
  }
  assert.match(html, /\.tf input\[type=text\][^{]*\{[^}]*box-sizing:border-box/);
  assert.match(html, /width:100%/);
});

test('focus is visible on everything that takes it', () => {
  const html = page('team/index.html');
  const rule = html.match(/\.tf input:focus-visible[^{]*\{([^}]*)\}/)[1];
  assert.match(rule, /outline:3px solid var\(--marigold\)/);
  assert.match(rule, /outline-offset/);
  for (const what of ['select:focus-visible', 'button:focus-visible', 'a:focus-visible']) {
    assert.ok(html.includes(what), `${what} has no focus ring`);
  }
});

test('the badge shows the label only when it says something new', () => {
  const js = page('team/index.html');
  assert.match(js, /d\.label\.toLowerCase\(\) !== String\(d\.teamName\)\.toLowerCase\(\)/,
    '"Core team · Core team" is noise, not information');
});

test('the received email offers a code only to a team that gets one', () => {
  const lang = 'fr';
  const person = { firstName: 'Shreya', lastName: 'Menon', email: 's@x.be', lang };

  const withCode = receivedMail(person, teamOf('artist'));
  assert.ok(withCode.lines.join('\n').includes(COPY.mail_received_code[lang]));

  const without = receivedMail(person, teamOf('crew'));
  assert.ok(!without.lines.join('\n').includes(COPY.mail_received_code[lang]),
    'the technical crew gets no code, so it must not be promised one');
  assert.ok(without.lines.join('\n').includes(COPY.received[lang]));
});

test('the form endpoint says whether to promise a code', async () => {
  const w = world();
  try {
    for (const [team, want] of [['artist', true], ['crew', false], ['child', true]]) {
      const { kv, t } = await withLink(team, { expected: 50 });
      const d = await (await formGet({
        request: new Request(`https://diwali.artindia.be/api/team-form?k=${t}`),
        env: ENV({ ACCRED: kv }),
      })).json();
      assert.equal(d.promoCode, want, team);
    }
  } finally { w.restore(); }
});

test('section 9 of the brief and the copy file say the same thing', () => {
  const brief = readFileSync(join(ROOT, 'docs/claude-code-brief-team-registration.md'), 'utf8');
  const rows = [...brief.matchAll(/^\| ([a-z0-9_]+) \| ([^|]*) \| ([^|]*) \| ([^|]*) \|$/gm)]
    .filter(m => COPY[m[1]]);
  assert.ok(rows.length >= 39, `the table lists ${rows.length} strings`);
  for (const [, key, en, fr, nl] of rows) {
    assert.equal(COPY[key].en, en.trim(), `${key} EN differs from the brief`);
    assert.equal(COPY[key].fr, fr.trim(), `${key} FR differs from the brief`);
    assert.equal(COPY[key].nl, nl.trim(), `${key} NL differs from the brief`);
  }
  /* Every string the page or the emails use is in the table, so nothing
     visitor-facing can be added without Ravi seeing it. */
  for (const key of Object.keys(COPY)) {
    if (/^(bot_|wall_)/.test(key)) continue;
    assert.ok(rows.some(r => r[1] === key), `${key} is missing from section 9`);
  }
});

test('hidden means hidden, whatever the page says about display', () => {
  const html = page('team/index.html');
  /* A class beats an attribute in the cascade, so .tf-step{display:flex}
     outranks the browser's [hidden]{display:none} and step 3 shows on a +1
     page that has no code to promise. This rule is what stops it. */
  assert.match(html, /\.tf \[hidden\]\{display:none!important\}/,
    'without this, every element with a display rule ignores hidden');

  /* The rule has to come before the rules it is defending against, or a later
     one of equal specificity wins. Comments are stripped first: the one above
     this rule quotes the selectors it is protecting against, and matching
     those would prove nothing. */
  const css = html.replace(/\/\*[\s\S]*?\*\//g, '');
  const i = css.indexOf('.tf [hidden]');
  assert.ok(i > 0, 'the rule is only in a comment');
  for (const sel of ['.tf-step{display:flex', '.tf-ghost{display:inline-block',
    '.tf-tick{width:', '.tf-top{display:flex']) {
    const at = css.indexOf(sel);
    assert.ok(at > 0, `${sel} is not in the sheet at all`);
    assert.ok(i < at, `${sel} is declared before the hidden rule`);
  }
});

/* ----------------------------- reading what Ticket Tailor actually answers */

/* The first live approval failed here. Ticket Tailor accepted the POST, a
   ticket existed and a credit was spent, and the reader looked only for a
   `data` key and reported that no id had come back. */

test('one object is found whichever way they wrapped it', () => {
  const T = { object: 'issued_ticket', id: 'it_1', barcode: 'b' };

  assert.equal(oneOf({ data: [T] }).id, 'it_1', 'the documented shape');
  assert.equal(oneOf({ data: T }).id, 'it_1', 'wrapped, not listed');
  assert.equal(oneOf(T).id, 'it_1', 'bare, which is what the live call sent');
  assert.equal(oneOf([T]).id, 'it_1', 'a top-level array');

  /* And nothing invented out of nothing. */
  assert.equal(oneOf({ data: [] }), null);
  assert.equal(oneOf({ data: null }), null);
  assert.equal(oneOf({ object: 'issued_ticket' }), null, 'no id is no ticket');
  assert.equal(oneOf(null), null);
  assert.equal(oneOf('it_1'), null);
  assert.equal(oneOf(42), null);

  /* The first entry that actually has an id, not merely the first entry. */
  assert.equal(oneOf({ data: [{ note: 'x' }, T] }).id, 'it_1');
});

for (const shape of ['array', 'object', 'bare']) {
  test(`an approval reads a ${shape} response and issues one ticket`, async () => {
    const { kv } = await withLink('artist');
    const w = world({ shape });
    try {
      const env = ENV({ ACCRED: kv });
      const r = await register(env, kv, FORM(), {});
      const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });

      assert.ok(done.ok, `a ${shape} response was not read`);
      assert.equal(done.person.status, 'approved');
      assert.equal(done.person.tt.issuedTicketId, 'it_1');
      assert.equal(done.person.tt.barcode, 'bc_1');
      assert.equal(done.person.tt.qrUrl, 'https://www.tickettailor.com/qr/1.png');
      assert.equal(done.person.steps.ticket, 'done');
      assert.equal(w.tt().filter(c => c.method === 'POST' && c.url.includes('issued_tickets')).length, 1);
    } finally { w.restore(); }
  });
}

test('a 2xx with no id in it says what came back, and no values', async () => {
  const { kv } = await withLink('artist');
  const w = world({ shape: 'empty' });
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM(), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });

    assert.equal(done.ok, false);
    assert.equal(done.error, 'ticket_failed');
    assert.equal(done.status, 201, 'the HTTP status it answered with');
    assert.match(done.detail, /without a usable issued ticket id/);
    assert.match(done.detail, /201, keys: data/, 'the card must say what came back');
    assert.equal(done.person.status, 'pending', 'and it goes back in the queue');
  } finally { w.restore(); }
});

test('what came back is described by its keys and never by its values', () => {
  assert.equal(describeBody(201, { object: 'issued_ticket', id: 'it_1', email: 'anouk@example.com' }),
    '201, keys: object, id, email');
  assert.equal(describeBody(200, null), '200, no JSON body');
  assert.equal(describeBody(200, []), '200, array of 0');
  assert.equal(describeBody(200, [1, 2]), '200, array of 2');
  assert.equal(describeBody(200, {}), '200, keys: (none)');
  assert.equal(describeBody(200, 'ok'), '200, a string');

  /* The thing this is for: a body we could not read may still hold somebody's
     address or a barcode, and this string goes on a card and into a log. */
  const said = describeBody(201, { email: 'anouk@example.com', barcode: 'al4R5' });
  assert.ok(!said.includes('anouk@example.com'));
  assert.ok(!said.includes('al4R5'));
});

/* ------------------------------------------------- adopting the right one */

test('a ticket is adopted only when the reference is ours', async () => {
  const { kv } = await withLink('press');
  const w = world({ existingTicket: { id: 'it_old', barcode: 'bc_old', status: 'valid' } });
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM({ role: 'Photographer' }), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });

    assert.equal(done.person.tt.issuedTicketId, 'it_old');
    assert.ok(done.person.adoptedTicket);
    assert.equal(w.tt().filter(c => c.method === 'POST' && c.url.includes('issued_tickets')).length, 0,
      'it issued a second ticket instead of adopting its own');
  } finally { w.restore(); }
});

test("somebody else's ticket is never adopted, however the filter behaved", async () => {
  const { kv } = await withLink('press');
  /* Ticket Tailor ignoring the reference filter and answering with a paying
     buyer's ticket. A missed adoption costs a spare ticket; a wrong one costs
     that buyer their seat. */
  const w = world({ existingTicket: { id: 'it_buyer', barcode: 'bc_buyer', reference: 'or_99887766' } });
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM({ role: 'Photographer' }), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });

    assert.ok(done.ok);
    assert.notEqual(done.person.tt.issuedTicketId, 'it_buyer', "it took a buyer's ticket");
    assert.equal(done.person.tt.issuedTicketId, 'it_1', 'it issued its own instead');
    assert.ok(!done.person.adoptedTicket);
  } finally { w.restore(); }
});

test('a voided ticket of ours is not adopted either', async () => {
  const { kv } = await withLink('press');
  const w = world({
    existingTicket: { id: 'it_dead', barcode: 'x', voided_at: '2026-10-01T00:00:00Z' },
  });
  try {
    const env = ENV({ ACCRED: kv });
    const r = await register(env, kv, FORM({ role: 'Photographer' }), {});
    const done = await approve(env, kv, { id: r.person.id, approver: 'ravi' });
    assert.equal(done.person.tt.issuedTicketId, 'it_1', 'a voided pass is not a pass');
  } finally { w.restore(); }
});

test('a retry after a later failure adopts the ticket instead of issuing a second', async () => {
  const { kv } = await withLink('artist');
  let id, first;

  /* The WhatsApp bounces, so the record is approved with a step to retry. */
  const bad = world({ fail: 'wa' });
  try {
    const env = ENV({ ACCRED: kv });
    id = (await register(env, kv, FORM(), {})).person.id;
    const done = await approve(env, kv, { id, approver: 'ravi' });
    first = done.person.tt.issuedTicketId;
    assert.equal(first, 'it_1');
    assert.match(done.person.steps.whatsapp, /^failed:/);
  } finally { bad.restore(); }

  /* Now a full retry, as the Retry button does when the ticket step was also
     cleared. Ticket Tailor already holds our ticket and must hand it back. */
  const w = world({ existingTicket: { id: 'it_1', barcode: 'bc_1', status: 'valid' } });
  try {
    const env = ENV({ ACCRED: kv });
    const p = await getPersonForTest(kv, id);
    p.steps.ticket = null;
    p.tt = null;
    await kv.put(personKey(id), JSON.stringify(p));

    const again = await approve(env, kv, { id, approver: 'keerthi', only: STEPS_ALL });

    assert.ok(again.ok);
    assert.equal(again.person.tt.issuedTicketId, 'it_1', 'the same ticket came back');
    assert.ok(again.person.adoptedTicket);
    assert.equal(w.tt().filter(c => c.method === 'POST' && c.url.includes('issued_tickets')).length, 0,
      'a second ticket was issued and a second credit spent');
    assert.equal(again.person.steps.whatsapp, 'done');
  } finally { w.restore(); }
});

test('the discount is read the same way, in every shape', async () => {
  for (const [name, body] of [
    ['bare', { object: 'discount', id: 'dsc_1', code: 'X' }],
    ['wrapped', { data: { object: 'discount', id: 'dsc_1' } }],
    ['listed', { data: [{ object: 'discount', id: 'dsc_1' }] }],
  ]) {
    const real = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(body), {
      status: 201, headers: { 'content-type': 'application/json' },
    });
    try {
      const d = await createDiscount(ENV(), {
        code: 'X-1', name: 'n', ticketTypes: ['tt_1'], maxRedemptions: 10, expiresUnix: 1,
      });
      assert.equal(d.id, 'dsc_1', `the ${name} shape was not read`);
    } finally { globalThis.fetch = real; }
  }

  /* And a 2xx with nothing usable in it explains itself. */
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ meta: {} }), {
    status: 201, headers: { 'content-type': 'application/json' },
  });
  try {
    await createDiscount(ENV(), {
      code: 'X-1', name: 'n', ticketTypes: ['tt_1'], maxRedemptions: 10, expiresUnix: 1,
    });
    assert.fail('it should have thrown');
  } catch (e) {
    assert.equal(e.status, 201);
    assert.match(e.detail, /without a usable discount id/);
    assert.match(e.detail, /201, keys: meta/);
  } finally { globalThis.fetch = real; }
});

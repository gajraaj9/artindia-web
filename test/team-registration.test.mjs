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
import { join } from 'node:path';

import {
  TEAMS, COPY, register, approve, reject, revoke, validate, hardCap, flagsFor,
  teamOf, token, promoCodeFor, ageOnFestival, validDob, approverFor, say,
  teamMemberFor, passAnswer, codeAnswer, salesAnswer, linkKey, personKey,
  plus1Key, promoKey, phoneKey, rejectedPhoneKey, teamCfgKey, expectedFor,
  allowedOrigin, brevoAttributesFor, approvedMail, receivedMail, IP_CAP_PER_DAY,
  restore, htmlMail, ticketFacts, rejectedEmailKey,
} from '../functions/api/_accred.js';
import { onRequestGet as adminGet, onRequestPost as adminPost } from '../functions/api/team-admin.js';
import { onRequestGet as formGet } from '../functions/api/team-form.js';
import { onRequestPost as registerPost } from '../functions/api/team-register.js';
import { buildMenu, menuTitles, menuKind, TEAM_ACTIONS } from '../functions/api/_bot.js';

const ROOT = new URL('..', import.meta.url).pathname;

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
function world({ fail = '', discountCollision = false, existingTicket = null, buyer = false } = {}) {
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

    if (url.includes('api.tickettailor.com')) {
      if (fail === 'tt') return reply(502, { errors: [{ message: 'no inventory' }] });
      if (url.includes('/issued_tickets') && method === 'GET') {
        return reply(200, { data: existingTicket ? [existingTicket] : [] });
      }
      if (url.includes('/issued_tickets') && method === 'POST') {
        issued += 1;
        return reply(201, { data: [{
          id: `it_${issued}`,
          barcode: `bc_${issued}`,
          barcode_url: `https://www.tickettailor.com/barcode/${issued}.png`,
          qr_code_url: `https://www.tickettailor.com/qr/${issued}.png`,
        }] });
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
    tt: () => calls.filter(c => c.url.includes('tickettailor')),
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
    const html = readFileSync(join(ROOT, 'dist-diwali', rel), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/, `${rel} is indexable`);
    assert.ok(!html.includes('diya'), `${rel} loads the chat widget`);
    assert.ok(!html.includes('{{'), `${rel} has an unfilled token`);
  }
  const sitemap = readFileSync(join(ROOT, 'dist-diwali/sitemap.xml'), 'utf8');
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
    assert.deepEqual(await register(ENV(), shut.kv, FORM(), {}), { ok: false, message: 'inactive' });

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

test('a rejected phone can never register again, on any link', async () => {
  const { kv } = await withLink('artist');
  const w = world();
  try {
    const env = ENV();
    const r = await register(env, kv, FORM(), { ip: '1.2.3.4' });
    await reject(env, kv, { id: r.person.id, approver: 'ravi', note: 'not on the list' });
    assert.ok(await kv.get(rejectedPhoneKey('+32474919900')));

    const back = await register(env, kv, FORM({ firstName: 'Shreyaa' }), { ip: '1.2.3.4' });
    assert.equal(back.message, 'inactive');
    assert.equal((await people(kv)).length, 1, 'no second row');
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
      if (c.url.includes('issued_tickets')) return `ticket:${c.method}`;
      if (c.url.includes('discounts')) return 'discount';
      if (c.url.includes('/smtp/email')) return 'email';
      if (c.url.includes('brevo')) return 'brevo';
      if (c.url.includes('facebook')) return 'whatsapp';
      return c.url;
    });
    assert.deepEqual(order,
      ['ticket:GET', 'ticket:POST', 'discount', 'brevo', 'email', 'whatsapp']);

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
    assert.deepEqual(done.person.steps, {
      ticket: 'done', discount: 'done', brevo: 'done', email: 'done', whatsapp: 'done',
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
    assert.equal(await kv.get(rejectedPhoneKey('+32474919900')), two.person.id);

    await restore(env, kv, { id: one.person.id, approver: 'ravi' });
    assert.equal(await kv.get(rejectedPhoneKey('+32474919900')), two.person.id,
      'the other rejection still stands');
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
    const html = readFileSync(join(ROOT, 'dist-diwali', rel), 'utf8');
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

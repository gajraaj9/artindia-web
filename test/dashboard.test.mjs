/**
 * The dashboard.
 *
 * Ticket Tailor, Brevo and Meta are mocked at `fetch`; nothing here reaches a
 * live service. The two things worth most of the attention are that money is
 * never in a response it should not be in, and that a service we cannot reach
 * produces the last figures rather than a screen of zeros.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  aggregate, brusselsDay, brusselsHour, lastDays, sumDays, daysToGo,
  orderCounts, orderNet, ticketCounts, classify, sourceOf, SOURCE_ORDER,
  checkInsByHour, festivalStarted, viewerFor, revenueNames, FESTIVAL_DAYS,
} from '../functions/api/_dash.js';
import { onRequestGet as dash, onRequestPost as dashPost } from '../functions/api/dash.js';
import { safeEqual } from '../functions/api/_shared.js';

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

const ADMIN = { ravi: 'tok-ravi', keerthi: 'tok-keerthi' };
const VIEWERS = { stijn: 'tok-stijn' };

const ENV = (over = {}) => ({
  TEAM_ADMIN_TOKENS: JSON.stringify(ADMIN),
  DASH_VIEW_TOKENS: JSON.stringify(VIEWERS),
  TT_API_KEY: 'tt-key',
  TT_EVENT_ID: 'ev_1',
  TT_TYPE_CORE: 'tt_core',
  TT_TYPE_ARTIST: 'tt_artist',
  ...over,
});

/* The five types on the real box office, read off it on 6 October 2026. */
const TYPES = [
  { id: 'tt_presale', name: 'Festival Ticket · Presale', price: 1000 },
  { id: 'tt_online', name: 'Festival Ticket - ONLINE OFFER', price: 1200 },
  { id: 'tt_gate', name: 'Festival Ticket (At Gate)', price: 1500 },
  { id: 'tt_teen', name: 'Child 13-18 ( ID needed )', price: 1000 },
  { id: 'tt_child', name: 'Child Below 12 ( ID needed )', price: 0 },
  { id: 'tt_core', name: 'Core team pass', price: 0 },
  { id: 'tt_artist', name: 'Artist pass', price: 0 },
];

const DAY = 86400;
/* Noon in Brussels on 6 October 2026. */
const NOON = Math.floor(new Date('2026-10-06T12:00:00+02:00').getTime() / 1000);
const NOW = new Date('2026-10-06T12:00:00+02:00');

let orderN = 0;
const order = (over = {}) => ({
  id: `or_${++orderN}`,
  status: 'completed',
  total: 2000,
  refund_amount: 0,
  created_at: NOON,
  referral_tag: '',
  issued_tickets: [{ id: `it_${orderN}`, ticket_type_id: 'tt_presale' }],
  ...over,
});

const OPTS = {
  teamTypes: new Set(['tt_core', 'tt_artist']),
  freeTypes: new Set(['tt_child']),
  typeNames: Object.fromEntries(TYPES.map(t => [t.id, t.name])),
  typePrices: Object.fromEntries(TYPES.map(t => [t.id, t.price])),
};

/** Everything Ticket Tailor and the bot would answer, with knobs. */
function world({ orders = [], checkIns = [], fail = '' } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    const reply = (status, obj) => new Response(JSON.stringify(obj), {
      status, headers: { 'content-type': 'application/json' },
    });
    if (fail === 'tt' && url.includes('tickettailor')) return reply(503, { errors: [{ message: 'down' }] });
    if (url.includes('/v1/events/')) {
      return reply(200, { object: 'event', id: 'ev_1', ticket_types: TYPES });
    }
    if (url.includes('/v1/orders')) {
      const since = Number(new URL(url).searchParams.get('created_at.gte') || 0);
      return reply(200, { data: orders.filter(o => !since || o.created_at >= since) });
    }
    if (url.includes('/v1/check_ins')) {
      if (fail === 'checkins') return reply(500, { errors: [{ message: 'nope' }] });
      return reply(200, { data: checkIns });
    }
    return reply(200, { data: [] });
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

const get = (env, { token = ADMIN.ravi, query = '' } = {}) => dash({
  request: new Request(`https://diwali.artindia.be/api/dash${query}`,
    { headers: token ? { 'X-Admin-Token': token } : {} }),
  env,
});

/* ------------------------------------------------------------- time zone */

test('a day is a Brussels day, on both sides of the clock change', () => {
  /* 25 October 2026 at 01:30 UTC is 03:30 in Brussels: still Sunday. The
     clocks go back that morning, which is the case that catches a naive
     implementation out. */
  assert.equal(brusselsDay(Date.parse('2026-10-25T01:30:00Z') / 1000), '2026-10-25');
  /* 23:30 UTC on 24 October is 01:30 on the 25th in Brussels. */
  assert.equal(brusselsDay(Date.parse('2026-10-24T23:30:00Z') / 1000), '2026-10-25');
  /* And in winter, one hour ahead rather than two. */
  assert.equal(brusselsDay(Date.parse('2026-01-01T23:30:00Z') / 1000), '2026-01-02');
  assert.equal(brusselsHour(Date.parse('2026-10-24T10:00:00Z') / 1000), 12);
});

test('the last days end today, in order, and sum correctly', () => {
  const days = lastDays(7, NOW);
  assert.equal(days.length, 7);
  assert.equal(days[6], '2026-10-06');
  assert.equal(days[0], '2026-09-30');
  assert.ok(days[0] < days[6], 'oldest first');
  assert.equal(sumDays({ '2026-10-06': 3, '2026-10-05': 4, '2020-01-01': 99 }, days), 7);
});

test('the countdown stops at zero and never runs backwards', () => {
  assert.equal(daysToGo(new Date('2026-10-06T12:00:00+02:00')), 18);
  assert.equal(daysToGo(new Date('2026-10-23T12:00:00+02:00')), 1);
  assert.equal(daysToGo(new Date('2026-10-24T12:00:00+02:00')), 0);
  assert.equal(daysToGo(new Date('2026-11-01T12:00:00+02:00')), 0, 'never negative');
  assert.equal(festivalStarted(new Date('2026-10-24T11:59:00+02:00')), false);
  assert.equal(festivalStarted(new Date('2026-10-24T12:00:00+02:00')), true);
});

/* -------------------------------------------------------- what is excluded */

test('cancelled, pending and fully refunded orders are not orders', () => {
  assert.equal(orderCounts(order()), true);
  assert.equal(orderCounts(order({ status: 'cancelled' })), false);
  assert.equal(orderCounts(order({ status: 'pending' })), false);
  assert.equal(orderCounts(order({ total: 2000, refund_amount: 2000 })), false);
  assert.equal(orderCounts(order({ total: 2000, refund_amount: 2500 })), false);
  /* Part of it back is still an order, for what is left. */
  assert.equal(orderCounts(order({ total: 2000, refund_amount: 500 })), true);
  assert.equal(orderNet(order({ total: 2000, refund_amount: 500 })), 1500);
  assert.equal(orderNet(order({ total: 2000, refund_amount: 9000 })), 0, 'never below zero');
  /* A free order is not a refunded one. */
  assert.equal(orderCounts(order({ total: 0, refund_amount: 0 })), true);
});

test('a voided ticket is not a ticket', () => {
  assert.equal(ticketCounts({ id: 'it_1' }), true);
  assert.equal(ticketCounts({ id: 'it_1', voided_at: '2026-10-01T00:00:00Z' }), false);
  assert.equal(ticketCounts({ id: 'it_1', status: 'voided' }), false);
  assert.equal(ticketCounts(null), false);
});

test('an excluded order takes its tickets and its money with it', () => {
  const a = aggregate([
    order({ issued_tickets: [{ id: 'a', ticket_type_id: 'tt_presale' }] }),
    order({ status: 'cancelled', issued_tickets: [{ id: 'b', ticket_type_id: 'tt_presale' }] }),
    order({ total: 2000, refund_amount: 2000, issued_tickets: [{ id: 'c', ticket_type_id: 'tt_presale' }] }),
    order({
      total: 4000,
      issued_tickets: [
        { id: 'd', ticket_type_id: 'tt_presale' },
        { id: 'e', ticket_type_id: 'tt_presale', voided_at: '2026-10-01T00:00:00Z' },
      ],
    }),
  ], OPTS);

  assert.equal(a.paid, 2, 'one from each surviving order');
  assert.equal(a.orders, 2);
  assert.equal(a.revenue, 6000, 'the cancelled and the refunded brought nothing');
  assert.equal(a.all, 2, 'the voided ticket is not in the total either');
});

/* ---------------------------------------------------------- classification */

test('team, free and paid are told apart by type and by reference', () => {
  const o = { teamTypes: new Set(['tt_core']), freeTypes: new Set(['tt_child']) };
  assert.equal(classify({ ticket_type_id: 'tt_core' }, o), 'team');
  assert.equal(classify({ ticket_type_id: 'tt_child' }, o), 'free');
  assert.equal(classify({ ticket_type_id: 'tt_presale' }, o), 'paid');
  /* A pass issued by the accreditation module, on a type nobody configured. */
  assert.equal(classify({ ticket_type_id: 'tt_unknown', reference: 'p_abc' }, o), 'team',
    'better to call a free pass a pass than to sell it');
  assert.equal(classify({ ticket_type_id: 'tt_presale', reference: 'or_99' }, o), 'paid');
});

test('the paying teenager counts and the free child does not', () => {
  const a = aggregate([order({
    total: 2000,
    issued_tickets: [
      { id: 'a', ticket_type_id: 'tt_teen' },
      { id: 'b', ticket_type_id: 'tt_child' },
      { id: 'c', ticket_type_id: 'tt_core' },
    ],
  })], OPTS);

  assert.equal(a.paid, 1, 'Child 13-18 is 10 EUR, so it is a paid ticket');
  assert.equal(a.free, 1);
  assert.equal(a.team, 1);
  assert.equal(a.all, 3, 'and all three are in the number Ticket Tailor shows');
});

/* --------------------------------------------------------------- group deals */

test('a group deal is counted from its shared barcode, never from its name', () => {
  const a = aggregate([order({
    total: 3500,
    issued_tickets: [
      { id: 'a', ticket_type_id: 'tt_presale', group_ticket_barcode: 'gb_1' },
      { id: 'b', ticket_type_id: 'tt_presale', group_ticket_barcode: 'gb_1' },
      { id: 'c', ticket_type_id: 'tt_presale', group_ticket_barcode: 'gb_1' },
      { id: 'd', ticket_type_id: 'tt_presale', group_ticket_barcode: 'gb_1' },
      { id: 'e', ticket_type_id: 'tt_presale' },
    ],
  })], OPTS);

  assert.equal(a.groups.deals, 1, 'four tickets, one shared barcode, one deal');
  assert.equal(a.groups.people, 4);
  assert.equal(a.paid, 5, 'each person inside the deal counts once in the paid total');
});

test('with no group deals on sale the counters stay at zero', () => {
  const a = aggregate([order()], OPTS);
  assert.deepEqual(a.groups, { deals: 0, people: 0 });
});

/* ------------------------------------------------------------- the sources */

test('every order lands in exactly one source bucket', () => {
  assert.equal(sourceOf(''), 'none');
  assert.equal(sourceOf(null), 'none');
  assert.equal(sourceOf('site-hero'), 'site');
  assert.equal(sourceOf('event_page_widget'), 'site');
  assert.equal(sourceOf('ig-launch'), 'instagram');
  assert.equal(sourceOf('team-ravi123'), 'team');
  assert.equal(sourceOf('ABCDEF'), 'referral', 'six characters of the code alphabet');
  assert.equal(sourceOf('xmas-promo'), 'other');

  const a = aggregate([
    order({ referral_tag: '' }),
    order({ referral_tag: 'site-hero' }),
    order({ referral_tag: 'ig-5' }),
    order({ referral_tag: 'ABCDEF' }),
    order({ referral_tag: 'team-ravi123' }),
    order({ referral_tag: 'somebody-else' }),
  ], OPTS);
  assert.deepEqual(a.bySource,
    { none: 1, site: 1, instagram: 1, referral: 1, team: 1, other: 1 });
  assert.equal(SOURCE_ORDER.length, 6);
});

/* ---------------------------------------------------------------- check-ins */

test('check-ins are counted per hour, per day, public and team apart', () => {
  const at = iso => Math.floor(Date.parse(iso) / 1000);
  const rows = [
    { issued_ticket_id: 'a', check_in_at: at('2026-10-24T12:10:00+02:00'), quantity: 1 },
    { issued_ticket_id: 'b', check_in_at: at('2026-10-24T12:40:00+02:00'), quantity: 1 },
    { issued_ticket_id: 'c', check_in_at: at('2026-10-24T14:05:00+02:00'), quantity: 1 },
    /* 25 October 2026 is the day the clocks go back, so an hour that is 13:00
       Brussels is +01:00 and not +02:00. Writing it the other way is how an
       hour of Sunday's arrivals ends up in the wrong column. */
    { issued_ticket_id: 'd', check_in_at: at('2026-10-25T13:00:00+01:00'), quantity: 1 },
    /* Somebody scanned out again. */
    { issued_ticket_id: 'a', check_in_at: at('2026-10-24T12:50:00+02:00'), quantity: -1 },
    /* A scan from a day that is not the festival is ignored. */
    { issued_ticket_id: 'z', check_in_at: at('2026-10-20T12:00:00+02:00'), quantity: 1 },
  ];
  const by = checkInsByHour(rows, { a: 'public', b: 'team', c: 'public', d: 'team' });

  assert.deepEqual(Object.keys(by), FESTIVAL_DAYS);
  assert.equal(by['2026-10-24'].public[12], 0, 'one in and the same one out again');
  assert.equal(by['2026-10-24'].team[12], 1);
  assert.equal(by['2026-10-24'].public[14], 1);
  assert.equal(by['2026-10-24'].total, 2);
  assert.equal(by['2026-10-25'].team[13], 1);
  assert.equal(by['2026-10-25'].total, 1);
});

/* ------------------------------------------------------------------ access */

test('only a known token gets in, and only a named one sees money', () => {
  const env = ENV();
  const v = t => viewerFor(env, t, { safeEqual });

  assert.deepEqual(v(ADMIN.ravi), { name: 'ravi', revenue: true });
  assert.deepEqual(v(ADMIN.keerthi), { name: 'keerthi', revenue: false },
    'an admin who is not on the revenue list does not see revenue');
  assert.deepEqual(v(VIEWERS.stijn), { name: 'stijn', revenue: false });
  assert.equal(v('guess'), null);
  assert.equal(v(''), null);

  /* The list is a name list, and it defaults to Ravi alone. */
  assert.deepEqual(revenueNames({}), ['ravi']);
  assert.deepEqual(revenueNames({ DASH_REVENUE_USERS: 'Ravi, Keerthi' }), ['ravi', 'keerthi']);
  assert.deepEqual(viewerFor(ENV({ DASH_REVENUE_USERS: 'keerthi' }), ADMIN.keerthi, { safeEqual }),
    { name: 'keerthi', revenue: true });

  /* A broken secret locks everybody out rather than letting anybody in. */
  assert.equal(viewerFor({ TEAM_ADMIN_TOKENS: 'not json' }, 'anything', { safeEqual }), null);
});

test('no token, a wrong token and no configuration are all refused', async () => {
  const kv = memoryKv();
  const w = world({ orders: [order()] });
  try {
    assert.equal((await get(ENV({ ACCRED: kv }), { token: '' })).status, 401);
    assert.equal((await get(ENV({ ACCRED: kv }), { token: 'guess' })).status, 401);
    assert.equal((await dash({
      request: new Request('https://x/api/dash', { headers: { 'X-Admin-Token': ADMIN.ravi } }),
      env: { ACCRED: kv },
    })).status, 503);
    assert.equal((await dashPost()).status, 405, 'the dashboard writes nothing');
  } finally { w.restore(); }
});

test('a view-only token gets a response that never had revenue in it', async () => {
  const kv = memoryKv();
  const w = world({ orders: [order({ total: 5000 })] });
  try {
    const env = ENV({ ACCRED: kv });

    const full = await (await get(env, { token: ADMIN.ravi })).json();
    assert.equal(full.viewer.revenue, true);
    assert.equal(full.revenue.total, 5000);
    assert.ok('revenue' in full.byType[0], 'the full view sees revenue per type');

    for (const token of [ADMIN.keerthi, VIEWERS.stijn]) {
      const res = await get(env, { token });
      const body = await res.text();
      const d = JSON.parse(body);

      assert.equal(d.ok, true);
      assert.equal(d.viewer.revenue, false);
      assert.ok(!('revenue' in d), 'the field is absent, not empty');
      for (const t of d.byType) assert.ok(!('revenue' in t), 'nor on a ticket type');
      /* And the number itself is nowhere in the bytes that went out. */
      assert.ok(!body.includes('5000'), 'the amount reached a view-only token');
      assert.equal(d.headline.paid, 1, 'they still see everything else');
    }
  } finally { w.restore(); }
});

/* ------------------------------------------------------------- the caching */

test('figures are cached for five minutes and a refresh gets past it', async () => {
  const kv = memoryKv();
  const orders = [order()];
  const w = world({ orders });
  try {
    const env = ENV({ ACCRED: kv });

    await get(env);
    const first = w.calls.length;
    assert.ok(first > 0);

    await get(env);
    assert.equal(w.calls.length, first, 'the second read came out of KV');

    const fresh = await (await get(env, { query: '?refresh=1' })).json();
    assert.ok(w.calls.length > first, 'a refresh really asks again');
    assert.ok(fresh.asOf);
  } finally { w.restore(); }
});

test('a refresh twice in a minute answers the same figures rather than asking again', async () => {
  const kv = memoryKv();
  const w = world({ orders: [order()] });
  try {
    const env = ENV({ ACCRED: kv });
    await get(env);
    await get(env, { query: '?refresh=1' });
    const after = w.calls.length;

    const again = await (await get(env, { query: '?refresh=1' })).json();
    assert.equal(w.calls.length, after, 'a finger on a button is not a question');
    assert.match(again.note, /same figures/);
  } finally { w.restore(); }
});

test('Ticket Tailor being unreachable shows the last figures, never zeros', async () => {
  const kv = memoryKv();
  const good = world({ orders: [order(), order()] });
  let before;
  try {
    before = await (await get(ENV({ ACCRED: kv }))).json();
    assert.equal(before.headline.paid, 2);
  } finally { good.restore(); }

  const bad = world({ fail: 'tt' });
  try {
    const d = await (await get(ENV({ ACCRED: kv }), { query: '?refresh=1' })).json();
    assert.equal(d.ok, true);
    assert.equal(d.headline.paid, 2, 'the figures we had, not a screen of zeros');
    assert.equal(d.stale, true);
    assert.equal(d.asOf, before.asOf, 'and it says when they were true');
    assert.match(d.note, /could not be reached/);
  } finally { bad.restore(); }
});

test('unreachable with nothing cached says so, and still does not show zeros', async () => {
  const kv = memoryKv();
  const w = world({ fail: 'tt' });
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    assert.equal(d.ok, false);
    assert.match(d.error, /no earlier figures/);
    assert.equal(d.asOf, null);
    assert.ok(!('headline' in d), 'there is no headline to misread as nought');
  } finally { w.restore(); }
});

test('check-ins failing does not take the rest of the dashboard with them', async () => {
  const kv = memoryKv();
  const w = world({ orders: [order()], fail: 'checkins' });
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    assert.equal(d.ok, true);
    assert.equal(d.headline.paid, 1);
    assert.equal(d.checkIns.available, false);
    assert.ok(d.checkIns.why, 'and it says why');
  } finally { w.restore(); }
});

/* ------------------------------------------------------- incremental reads */

test('a later read asks only for what it has not seen', async () => {
  const kv = memoryKv();
  const first = world({ orders: [order({ created_at: NOON - 3 * DAY })] });
  try { await get(ENV({ ACCRED: kv })); } finally { first.restore(); }

  const later = world({ orders: [order({ created_at: NOON })] });
  try {
    await get(ENV({ ACCRED: kv }), { query: '?refresh=1' });
    const asked = later.calls.find(u => u.includes('/v1/orders'));
    assert.match(asked, /created_at\.gte=/, 'it asked for everything since the last one');
  } finally { later.restore(); }
});

test('an order read twice is counted once', async () => {
  const kv = memoryKv();
  const repeated = order({ created_at: NOON, total: 2000 });
  const w = world({ orders: [repeated] });
  try {
    const env = ENV({ ACCRED: kv });
    const a = await (await get(env)).json();
    assert.equal(a.headline.paid, 1);
    /* The same order comes back on the next read, because it sits on the
       high-water mark. It must replace itself, not add to itself. */
    const b = await (await get(env, { query: '?refresh=1' })).json();
    assert.equal(b.headline.paid, 1);
    assert.equal(b.revenue.total, 2000);
  } finally { w.restore(); }
});

/* ------------------------------------------------------------ the payload */

test('the payload carries no personal data beyond a first name', async () => {
  const accred = memoryKv();
  await accred.put('person:p_1', JSON.stringify({
    id: 'p_1', team: 'artist', status: 'approved',
    firstName: 'Shreya', lastName: 'Menon', email: 'shreya@example.com',
    phone: '+32474919900', child: { firstName: 'Aarav', lastName: 'N', dob: '2016-05-04' },
    promo: { code: 'SHREYA412', discountId: 'dsc_1' },
  }));

  const w = world({ orders: [order({ discount_code: 'SHREYA412' })] });
  try {
    const res = await get(ENV({ ACCRED: accred }));
    const body = await res.text();

    assert.ok(body.includes('Shreya'), 'a first name beside a code is the point');
    assert.ok(!body.includes('Menon'), 'a surname is in the payload');
    assert.ok(!body.includes('shreya@example.com'), 'an address is in the payload');
    assert.ok(!body.includes('32474919900'), 'a phone number is in the payload');
    assert.ok(!body.includes('2016-05-04'), 'a date of birth is in the payload');
    assert.ok(!body.includes('Aarav'), "a child's name is in the payload");

    const d = JSON.parse(body);
    assert.deepEqual(d.topCodes, [{ code: 'SHREYA412', first: 'Shreya', orders: 1 }]);
  } finally { w.restore(); }
});

test('the payload has every section the page draws, in a shape it can read', async () => {
  const kv = memoryKv();
  const w = world({ orders: [order({ referral_tag: 'ig-1' })] });
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    for (const k of ['viewer', 'asOf', 'daysToGo', 'headline', 'small', 'groups',
      'perDay', 'byType', 'bySource', 'team', 'waiting', 'topCodes', 'checkIns']) {
      assert.ok(k in d, `the page draws ${k} and the payload has no such key`);
    }
    assert.equal(Object.keys(d.perDay).length, 14, 'fourteen days for a wide screen');
    assert.deepEqual(d.bySource.map(s => s.key), SOURCE_ORDER);
    assert.equal(d.small.all, 1);
    assert.equal(typeof d.daysToGo, 'number');
  } finally { w.restore(); }
});

/* --------------------------------------------------------------- the page */

/* The words a reader sees, with the stylesheet and the comments taken out. */
const text = html => html
  .replace(/<style>[\s\S]*?<\/style>/g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('the page is hidden, read only, and says what it cannot do', () => {
  const html = readFileSync(join(ROOT, 'diwali-admin/dashboard.html'), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /localStorage\.getItem\(KEY\)/, 'the token is kept like /admin/team');

  /* One fetch, one method, nothing that writes. */
  const posts = html.match(/method:\s*'POST'/g) || [];
  assert.equal(posts.length, 0, 'the dashboard must not POST anything anywhere');
  assert.ok(!/api\/team-admin/.test(html), 'it must not reach the admin write route');
  assert.equal((html.match(/fetch\(/g) || []).length, 1, 'one call, to its own endpoint');
  assert.match(html, /fetch\('\/api\/dash'/);

  /* Revenue is only ever drawn when the server said so. */
  assert.match(html, /if \(D\.revenue\)/);
  assert.match(html, /order totals, after discount codes/);

  /* No targets and no pace, anywhere. */
  for (const word of ['target', 'on track', 'behind', 'ahead of', 'forecast', 'pace']) {
    /* Whole words only: "white-space" is not a pace indicator. */
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(text(html)),
      `the page says "${word}"`);
  }
});

test('the other two admin pages link to it, and it links back', () => {
  for (const rel of ['diwali-admin/team.html', 'diwali-admin/wa.html']) {
    const html = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(html, /href="\/admin\/dashboard"/, `${rel} has no link to the dashboard`);
  }
  const dashHtml = readFileSync(join(ROOT, 'diwali-admin/dashboard.html'), 'utf8');
  assert.match(dashHtml, /href="\/admin\/team"/);
  assert.match(dashHtml, /href="\/admin\/wa"/);
});

test('there is no Sales tab left behind on the team page', () => {
  const html = readFileSync(join(ROOT, 'diwali-admin/team.html'), 'utf8');
  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(tabs)].sort(), ['links', 'people', 'queue', 'refused']);
});

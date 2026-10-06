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
  orderMoney, isDealLine, isTicketLine, SHAPE_VERSION, isCurrentShape, ticketsOf,
  ageOf, AGE_KEYS, blankAges, AGE_GROUPS,
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
  { id: 'tt_6865730', name: 'Child 13-18 ( ID needed )', price: 1000 },
  { id: 'tt_6753537', name: 'Child Below 12 ( ID needed )', price: 0 },
  { id: 'tt_core', name: 'Core team pass', price: 0 },
  { id: 'tt_artist', name: 'Artist pass', price: 0 },
];

const DAY = 86400;
/* Noon in Brussels on 6 October 2026. */
const NOON = Math.floor(new Date('2026-10-06T12:00:00+02:00').getTime() / 1000);
const NOW = new Date('2026-10-06T12:00:00+02:00');

let orderN = 0;

/**
 * One order with one presale ticket on it, unless told otherwise.
 *
 * `lines` is the shorthand: [typeId, quantity, total] per ticket line, and a
 * discount as ['gift_card', 1, -amount]. The issued tickets that go with it
 * are built to match, because in the real API they are two separate reads
 * that have to agree.
 */
function order(over = {}) {
  const id = `or_${++orderN}`;
  const lines = over.lines || [['tt_presale', 1, 1000]];
  delete over.lines;
  /* A deal admits people the line itself says nothing about, so a fixture
     states them: ['deal:Family of 4', 1, 3500, ['tt_presale','tt_presale']]. */
  const extra = over.extraTickets || [];
  delete over.extraTickets;

  const line_items = [];
  const tickets = [];

  lines.forEach(([item, qty, total, inside], i) => {
    const deal = String(item).startsWith('deal:');
    const name = deal ? String(item).slice(5) : item;
    line_items.push({
      object: 'line_item', id: `li_${id}_${i}`,
      /* A real deal line is not type 'ticket', which is the whole of the
         bug: it used to fall through to fees and take its people with it. */
      type: deal ? 'bundle' : (item === 'gift_card' ? 'gift_card'
        : (item === 'void' ? 'void' : (FEE.has(item) ? item : 'ticket'))),
      item_id: deal ? 'bu_1' : (item === 'gift_card' || item === 'void' || FEE.has(item) ? null : item),
      description: name, quantity: qty, total, value: total,
    });
    if (deal) {
      for (const t of (inside || [])) {
        tickets.push({ id: `it_${id}_d${tickets.length}`, ticket_type_id: t });
      }
      return;
    }
    if (item === 'gift_card' || item === 'void' || FEE.has(item)) return;
    for (let k = 0; k < qty; k++) {
      tickets.push({ id: `it_${id}_${item}_${k}`, ticket_type_id: item });
    }
  });

  for (const t of extra) tickets.push({ id: `it_${id}_x${tickets.length}`, ticket_type_id: t });

  const total = line_items.reduce((n, l) => n + l.total, 0);
  return {
    order: {
      id, status: 'completed', total, refund_amount: 0,
      created_at: NOON, referral_tag: '', line_items,
      issued_tickets: tickets.map(t => ({ ...t })),
      ...over,
    },
    tickets,
  };
}

const FEE = new Set(['transaction_charge', 'tax', 'donation']);

/**
 * The orders, and how many of each type exist.
 *
 * Counts of what exists come off the ticket types on the event; who paid
 * comes from the orders. A fixture states both.
 */
function world2(made, extraIssued = {}) {
  const issued = { ...extraIssued };
  for (const m of made) {
    if (!orderCounts(m.order)) continue;
    for (const t of m.tickets) {
      issued[t.ticket_type_id] = (issued[t.ticket_type_id] || 0) + 1;
    }
  }
  return { orders: made.map(m => m.order), tickets: made.flatMap(m => m.tickets), issued };
}

/** quantity_issued per type, as the event reports it. */
const issuedOf = (...pairs) => Object.fromEntries(pairs);

/** The same thing from a list of tickets, for a fixture that has one. */
const countOf = tickets => tickets.reduce((o, t) => {
  if (t.voided_at) return o;
  o[t.ticket_type_id] = (o[t.ticket_type_id] || 0) + 1;
  return o;
}, {});

const OPTS = {
  teamTypes: new Set(['tt_core', 'tt_artist']),
  typeNames: Object.fromEntries(TYPES.map(t => [t.id, t.name])),
  typePrices: Object.fromEntries(TYPES.map(t => [t.id, t.price])),
};

/** Everything Ticket Tailor and the bot would answer, with knobs. */
function world({ orders = [], tickets = null, seriesBundles = [], checkIns = [], fail = '' } = {}) {
  /* When a test does not say, the tickets are the ones the orders imply. */
  const issued = tickets || orders.flatMap(o => (o.issued_tickets || []).map(
    t => ({ ...t, order_id: String(o.id) })));
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
      const counts = countOf(issued);
      return reply(200, {
        object: 'event', id: 'ev_1', event_series_id: 'es_1',
        ticket_types: TYPES.map(t => ({ ...t, quantity_issued: counts[t.id] || 0 })),
      });
    }
    if (url.includes('/v1/event_series/')) {
      return reply(200, { object: 'event_series', id: 'es_1', bundles: seriesBundles });
    }
    if (url.includes('/v1/issued_tickets')) return reply(200, { data: issued });
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
  const o = over => order({ ...over }).order;
  assert.equal(orderCounts(o()), true);
  assert.equal(orderCounts(o({ status: 'cancelled' })), false);
  assert.equal(orderCounts(o({ status: 'pending' })), false);
  assert.equal(orderCounts(o({ total: 2000, refund_amount: 2000 })), false);
  assert.equal(orderCounts(o({ total: 2000, refund_amount: 2500 })), false);
  /* Part of it back is still an order, for what is left. */
  assert.equal(orderCounts(o({ total: 2000, refund_amount: 500 })), true);
  assert.equal(orderNet(o({ total: 2000, refund_amount: 500 })), 1500);
  assert.equal(orderNet(o({ total: 2000, refund_amount: 9000 })), 0, 'never below zero');
  assert.equal(orderCounts(o({ total: 0, refund_amount: 0 })), true);
});

test('a voided ticket is not a ticket', () => {
  assert.equal(ticketCounts({ id: 'it_1' }), true);
  assert.equal(ticketCounts({ id: 'it_1', voided_at: '2026-10-01T00:00:00Z' }), false);
  assert.equal(ticketCounts({ id: 'it_1', status: 'voided' }), false);
  assert.equal(ticketCounts(null), false);
});

test('an excluded order takes its tickets and its money with it', () => {
  const good = order();
  const cancelled = order({ status: 'cancelled' });
  const refunded = order();
  refunded.order.refund_amount = refunded.order.total;
  const w = world2([good, cancelled, refunded]);

  const a = aggregate(w.orders, w.issued, OPTS);
  assert.equal(a.orders, 1);
  assert.equal(a.revenue, 1000, 'the cancelled and the refunded brought nothing');
  assert.equal(a.paid, 1, 'and their tickets are not paid tickets');
  assert.equal(a.comp, 0,
    'nor complimentary ones: a cancelled order is not a gift, it is nothing');
  assert.equal(a.all, 1, 'and they are not in the total either');
});

/* -------------------------------------------------------------- the money */

test('an order is split into ticket money and everything else, and they add up', () => {
  const m = orderMoney({
    total: 2200, refund_amount: 0,
    line_items: [
      { type: 'ticket', item_id: 'tt_presale', quantity: 2, total: 2000 },
      { type: 'gift_card', total: -200 },
      { type: 'transaction_charge', total: 400 },
    ],
  });
  assert.equal(m.gross, 2000);
  assert.equal(m.discount, 200, 'gift_card is what Ticket Tailor calls a discount');
  assert.equal(m.ticketMoney, 1800);
  assert.equal(m.other, 400, 'the fee is not ticket money');
  assert.equal(m.ticketMoney + m.other, m.net, 'the parts are the whole');
});

test('a discount is spread over the lines in proportion, to the last cent', () => {
  const m = orderMoney({
    total: 2700, refund_amount: 0,
    line_items: [
      { type: 'ticket', item_id: 'tt_gate', quantity: 1, total: 1500 },
      { type: 'ticket', item_id: 'tt_presale', quantity: 1, total: 1000 },
      { type: 'ticket', item_id: 'tt_6865730', quantity: 1, total: 1000 },
      { type: 'gift_card', total: -333 },
    ],
  });
  const parts = [...m.byLine.values()];
  assert.equal(parts.reduce((a, b) => a + b, 0), m.ticketMoney,
    'rounding has to land somewhere, and the parts still make the whole');
  assert.ok(parts[0] > parts[1], 'the dearest line carries the most of it');
});

test('a partial refund comes off everything in proportion', () => {
  const m = orderMoney({
    total: 2000, refund_amount: 1000,
    line_items: [{ type: 'ticket', item_id: 'tt_presale', quantity: 2, total: 2000 }],
  });
  assert.equal(m.net, 1000);
  assert.equal(m.ticketMoney, 1000, 'half the money back is half the ticket money');
});

test('the table adds up to the headline, with fees on their own line', () => {
  const a = order({
    lines: [['tt_presale', 2, 2000], ['gift_card', 1, -200], ['transaction_charge', 1, 600]],
  });
  const b = order({ lines: [['tt_gate', 1, 1500]] });
  const w = world2([a, b]);

  const agg = aggregate(w.orders, w.issued, OPTS);
  const singles = agg.byType.reduce((n, t) => n + t.revenue, 0);
  const deals = agg.byDeal.reduce((n, d) => n + d.revenue, 0);
  assert.equal(singles + deals + agg.fees, agg.revenue,
    'the types plus the deals plus the fees is the headline, exactly');
  assert.equal(agg.revenue, 2400 + 1500);
  assert.equal(agg.fees, 600, 'the charge is a fee, and only the charge');
});

/* --------------------------------------------- paid, free and complimentary */

test('the paying teenager counts, the free child does not, the freebie is its own', () => {
  const sale = order({ lines: [['tt_6865730', 1, 1000], ['tt_6753537', 1, 0]] });
  /* A paid type that went out at nothing: a complimentary ticket. */
  const comp = order({ lines: [['tt_gate', 1, 0]] });
  const w = world2([sale, comp]);

  const a = aggregate(w.orders, w.issued, OPTS);
  assert.equal(a.paid, 1, 'Child 13-18 is 10 EUR, so it is a paid ticket');
  assert.equal(a.free, 1, 'Child Below 12 is a free type');
  assert.equal(a.comp, 1, 'a gate ticket at nothing is complimentary, not paid');
  assert.equal(a.all, 3);
  assert.ok(a.gap.complimentary > 0, 'and it cost us something at list price');
});

test('team passes are counted from the event, order or no order', () => {
  const sale = order();
  /* Issued through the API: no order at all, which is why counting from
     orders showed nought however many had been approved. */
  const passes = [
    { id: 'it_p1', ticket_type_id: 'tt_core', reference: 'p_aaa' },
    { id: 'it_p2', ticket_type_id: 'tt_artist', reference: 'p_bbb' },
    /* And one that was voided, which is not a pass. */
    { id: 'it_p3', ticket_type_id: 'tt_core', reference: 'p_ddd', voided_at: '2026-10-01T00:00:00Z' },
  ];

  const a = aggregate([sale.order], countOf([...sale.tickets, ...passes]), OPTS);
  assert.equal(a.team, 2, 'this used to be nought, because they are in no order');
  assert.equal(a.paid, 1);
  assert.equal(a.all, 3, 'all tickets is what Ticket Tailor shows, voided excluded');
});

test('a pass on an unconfigured type is never counted as paid', () => {
  /* Counting from the event means a ticket type and not a ticket, so the old
     per-ticket p_ reference is no longer read. A pass that somehow exists on
     a type with no TT_TYPE_* set lands in complimentary, which is the safe
     side: it can never inflate the paid total or the revenue.
     The approval pipeline refuses to issue one at all in that state, so this
     is a guard rather than a case. */
  const sale = order();
  const stray = [{ id: 'it_x', ticket_type_id: 'tt_gate', reference: 'p_zzz' }];
  const a = aggregate([sale.order], countOf([...sale.tickets, ...stray]), OPTS);

  assert.equal(a.paid, 1, 'the one somebody actually paid for');
  assert.equal(a.comp, 1, 'and the stray one, counted as a giveaway');
  assert.equal(a.team, 0);
});

/* --------------------------------------------------------------- bundles */

test('a group deal is paid tickets, counted from the order\'s own tickets', () => {
  /* The shape that broke it: a deal line that is not type "ticket", and four
     tickets issued on the order at nothing. Every one of them was being
     counted as complimentary and the deal\'s whole price as a fee. */
  const deal = order({
    lines: [['deal:Family of 4', 1, 3500,
      ['tt_presale', 'tt_presale', 'tt_6753537', 'tt_6753537']]],
  });
  const w = world2([deal]);
  const a = aggregate(w.orders, w.issued, OPTS);

  assert.equal(a.comp, 0, 'nobody in a deal is a giveaway');
  assert.equal(a.fees, 0, 'and the deal price is not a fee');
  assert.equal(a.insideDeals, 2, 'two of the four are of a paid type');
  assert.equal(a.paid, 2, 'and they are paid tickets');
  assert.equal(a.free, 2, 'the two children are free tickets, as always');
  assert.equal(a.revenue, 3500);

  assert.deepEqual(a.byDeal, [{ name: 'Family of 4', deals: 1, people: 2, revenue: 3500 }]);
  assert.equal(a.groups.deals, 1);
  assert.equal(a.groups.people, 2);
});

test('an order with a deal and single tickets splits them correctly', () => {
  const mixed = order({
    lines: [
      ['tt_gate', 2, 3000],
      ['deal:Group of Six', 1, 5000, Array(6).fill('tt_presale')],
    ],
  });
  const w = world2([mixed]);
  const a = aggregate(w.orders, w.issued, OPTS);

  assert.equal(a.paidIndividually, 2, 'the two gate tickets were bought on their own');
  assert.equal(a.insideDeals, 6, 'and six came in on the deal');
  assert.equal(a.paid, 8);
  assert.equal(a.comp, 0);
  assert.equal(a.fees, 0);

  const gate = a.byType.find(t => t.id === 'tt_gate');
  assert.equal(gate.sold, 2, 'the type row counts only what was bought on its own');
  assert.equal(gate.revenue, 3000);
  assert.deepEqual(a.byDeal, [{ name: 'Group of Six', deals: 1, people: 6, revenue: 5000 }]);

  /* Singles plus deals plus fees is the headline, exactly. */
  const singles = a.byType.reduce((n, t) => n + t.revenue, 0);
  const deals = a.byDeal.reduce((n, d) => n + d.revenue, 0);
  assert.equal(singles + deals + a.fees, a.revenue);
});

test('a genuine complimentary ticket is one with no deal to account for it', () => {
  /* A paid type issued at nothing on an order that bought no deal. */
  const comp = order({ lines: [['tt_gate', 1, 0]] });
  const w = world2([comp]);
  const a = aggregate(w.orders, w.issued, OPTS);

  assert.equal(a.comp, 1);
  assert.equal(a.paid, 0);
  assert.equal(a.insideDeals, 0);

  /* And one issued on an order that did buy a deal is not complimentary. */
  const onDeal = order({
    lines: [['deal:Family of 3', 1, 2500, ['tt_gate']]],
  });
  const b = aggregate(...Object.values(pick(world2([onDeal]))), OPTS);
  assert.equal(b.comp, 0);
  assert.equal(b.paid, 1);
});

const pick = w => ({ orders: w.orders, issued: w.issued });

test('a deal line is told from a ticket line and from a fee', () => {
  assert.ok(isTicketLine({ type: 'ticket', item_id: 'tt_1', total: 100 }));
  assert.ok(!isDealLine({ type: 'ticket', item_id: 'tt_1', total: 100 }));

  /* However the deal identifies itself: bu_, a type of its own, or neither. */
  assert.ok(isDealLine({ type: 'bundle', item_id: 'bu_1', total: 3500 }));
  assert.ok(isDealLine({ type: 'ticket', item_id: 'bu_1', total: 3500 }));
  assert.ok(isDealLine({ type: 'group', item_id: null, description: 'Family of 4', total: 3500 }));

  /* A fee is never a deal, which is the mistake that started this. */
  for (const t of ['transaction_charge', 'tax', 'donation']) {
    assert.ok(!isDealLine({ type: t, total: 400 }), `${t} is not a deal`);
    assert.ok(!isTicketLine({ type: t, total: 400 }));
  }
  assert.ok(!isDealLine({ type: 'gift_card', total: -300 }));
  assert.ok(!isDealLine({ type: 'void', total: -1000 }));
  assert.ok(!isDealLine({ type: 'bundle', item_id: 'bu_1', total: 0 }), 'nothing is not a deal');
});

test('fees are only real fee lines, and the deal money is not among them', () => {
  const o = order({
    lines: [
      ['deal:Family of 4', 1, 3500, ['tt_presale', 'tt_presale']],
      ['transaction_charge', 1, 400],
      ['tax', 1, 100],
    ],
  });
  const m = orderMoney(o.order);
  assert.equal(m.gross, 3500, 'the deal is admission money');
  assert.equal(m.other, 500, 'and only the charge and the tax are not');
  assert.equal(m.ticketMoney + m.other, m.net);

  const w = world2([o]);
  const a = aggregate(w.orders, w.issued, OPTS);
  assert.equal(a.fees, 500);
  assert.equal(a.insideDeals, 2);
});

/* ------------------------------------------------------------- the gap */

test('the gap between list price and money received is explained, cause by cause', () => {
  const sale = order({ lines: [['tt_gate', 2, 3000], ['gift_card', 1, -300]] });
  sale.order.total = 2700;
  const comp = order({ lines: [['tt_gate', 1, 0]] });
  const lost = order({ lines: [['tt_gate', 1, 1500]], status: 'cancelled' });
  const back = order({ lines: [['tt_presale', 1, 1000]] });
  back.order.refund_amount = 400;

  const w = world2([sale, comp, lost, back]);
  const a = aggregate(w.orders, w.issued, OPTS);

  assert.equal(a.gap.discounts, 300);
  assert.equal(a.gap.cancelled, 1500, 'one order cancelled');
  assert.equal(a.gap.refunds, 400);
  assert.equal(a.comp, 1, 'one gate ticket given away');
  assert.ok(a.gap.complimentary > 0, 'and it cost us something at list price');
  /* List price of everything that exists and is not a team pass. */
  assert.equal(a.gap.list, 1500 * 3 + 1000);
});

/* ---------------------------------------------------------- classification */

test('team, free and paid are told apart by type and by reference', () => {
  const o = { teamTypes: new Set(['tt_core']), freeTypes: new Set(['tt_6753537']) };
  assert.equal(classify({ ticket_type_id: 'tt_core' }, o), 'team');
  assert.equal(classify({ ticket_type_id: 'tt_6753537' }, o), 'free');
  assert.equal(classify({ ticket_type_id: 'tt_presale' }, o), 'paid');
  /* A pass issued by the accreditation module, on a type nobody configured. */
  assert.equal(classify({ ticket_type_id: 'tt_unknown', reference: 'p_abc' }, o), 'team',
    'better to call a free pass a pass than to sell it');
  assert.equal(classify({ ticket_type_id: 'tt_presale', reference: 'or_99' }, o), 'paid');
});

test('every order lands in exactly one source bucket', () => {
  assert.equal(sourceOf(''), 'none');
  assert.equal(sourceOf(null), 'none');
  assert.equal(sourceOf('site-hero'), 'site');
  assert.equal(sourceOf('event_page_widget'), 'site');
  assert.equal(sourceOf('ig-launch'), 'instagram');
  assert.equal(sourceOf('team-ravi123'), 'team');
  assert.equal(sourceOf('ABCDEF'), 'referral', 'six characters of the code alphabet');
  assert.equal(sourceOf('xmas-promo'), 'other');

  const w = world2(['', 'site-hero', 'ig-5', 'ABCDEF', 'team-ravi123', 'somebody-else']
    .map(referral_tag => order({ referral_tag })));
  const a = aggregate(w.orders, w.issued, OPTS);
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

  assert.deepEqual(v(ADMIN.ravi), { name: 'ravi', admin: true, revenue: true });
  assert.deepEqual(v(ADMIN.keerthi), { name: 'keerthi', admin: true, revenue: false },
    'an admin who is not on the revenue list does not see revenue');
  assert.deepEqual(v(VIEWERS.stijn), { name: 'stijn', admin: false, revenue: false },
    'and a view-only person is not an admin at all');
  assert.equal(v('guess'), null);
  assert.equal(v(''), null);

  /* The list is a name list, and it defaults to Ravi alone. */
  assert.deepEqual(revenueNames({}), ['ravi']);
  assert.deepEqual(revenueNames({ DASH_REVENUE_USERS: 'Ravi, Keerthi' }), ['ravi', 'keerthi']);
  assert.deepEqual(viewerFor(ENV({ DASH_REVENUE_USERS: 'keerthi' }), ADMIN.keerthi, { safeEqual }),
    { name: 'keerthi', admin: true, revenue: true });

  /* A broken secret locks everybody out rather than letting anybody in. */
  assert.equal(viewerFor({ TEAM_ADMIN_TOKENS: 'not json' }, 'anything', { safeEqual }), null);
});

test('no token, a wrong token and no configuration are all refused', async () => {
  const kv = memoryKv();
  const w = world(world2([order()]));
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
  const w = world(world2([order({ lines: [['tt_gate', 1, 5000]] })]));
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
  const w = world(world2([order()]));
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
  const good = world(world2([order(), order()]));
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
  const w = world({ ...world2([order()]), fail: 'checkins' });
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
  const first = world(world2([order({ created_at: NOON - 3 * DAY })]));
  try { await get(ENV({ ACCRED: kv })); } finally { first.restore(); }

  const later = world(world2([order({ created_at: NOON })]));
  try {
    await get(ENV({ ACCRED: kv }), { query: '?refresh=1' });
    const asked = later.calls.find(u => u.includes('/v1/orders'));
    assert.match(asked, /created_at\.gte=/, 'it asked for everything since the last one');
  } finally { later.restore(); }
});

test('an order read twice is counted once', async () => {
  const kv = memoryKv();
  const repeated = order({ created_at: NOON });
  const w = world(world2([repeated]));
  try {
    const env = ENV({ ACCRED: kv });
    const a = await (await get(env)).json();
    assert.equal(a.headline.paid, 1);
    /* The same order comes back on the next read, because it sits on the
       high-water mark. It must replace itself, not add to itself. */
    const b = await (await get(env, { query: '?refresh=1' })).json();
    assert.equal(b.headline.paid, 1);
    assert.equal(b.revenue.total, 1000);
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

  const w = world(world2([order({ discount_code: 'SHREYA412' })]));
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
  const w = world(world2([order({ referral_tag: 'ig-1' })]));
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    for (const k of ['viewer', 'asOf', 'daysToGo', 'headline', 'small', 'deals',
      'perDay', 'byType', 'bySource', 'team', 'waiting', 'topCodes', 'checkIns']) {
      assert.ok(k in d, `the page draws ${k} and the payload has no such key`);
    }
    assert.equal(Object.keys(d.perDay).length, 14, 'fourteen days for a wide screen');
    assert.deepEqual(d.bySource.map(s => s.key), SOURCE_ORDER);
    assert.equal(d.small.all, 1);
    assert.equal(typeof d.daysToGo, 'number');
    for (const p of d.periods) {
      assert.equal(typeof p.all, 'number', 'each card says how many tickets in all');
      assert.equal(typeof p.orders, 'number');
    }
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
  /* Every money figure on the page is behind this flag, which the server set. */
  assert.ok((html.match(/D\.revenue/g) || []).length >= 5,
    'money must be drawn only when the server said this viewer may see it');
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

/* ------------------------------------------------ the figures the page shows */

test('the table total is the headline revenue, to the cent', async () => {
  const kv = memoryKv();
  const a = order({
    lines: [['tt_gate', 2, 3000], ['gift_card', 1, -300], ['transaction_charge', 1, 500]],
  });
  const b = order({ lines: [['tt_presale', 1, 1000], ['tt_6865730', 1, 1000]] });
  const w = world(world2([a, b]));
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();

    const table = d.byType.reduce((n, t) => n + t.revenue, 0)
      + d.deals.rows.reduce((n, x) => n + x.revenue, 0) + d.reconcile.fees;
    assert.equal(table, d.headline.revenue, 'the table is a different number otherwise');
    assert.equal(d.reconcile.total, d.headline.revenue);
    assert.equal(d.reconcile.unexplained, 0, 'and nothing is left over');
    assert.equal(d.reconcile.fees, 500, 'the fee has its own line and a reason');
    assert.equal(d.headline.revenue, 3200 + 2000);
  } finally { w.restore(); }
});

test('the paid table lists paid types only, and its count is PAID TICKETS', async () => {
  const kv = memoryKv();
  const sale = order({ lines: [['tt_gate', 1, 1500], ['tt_6753537', 1, 0]] });
  const comp = order({ lines: [['tt_presale', 1, 0]] });
  const w = world(world2([sale, comp]));
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();

    assert.ok(d.byType.every(t => t.price > 0), 'a free type is not in the paid table');
    assert.ok(d.otherTypes.some(t => t.name.includes('Child Below 12')),
      'it is in the short list under it');
    assert.equal(d.complimentary, 1);
    assert.equal(d.headline.paid, 1, 'the gate ticket, and nothing given away');
    assert.equal(d.small.free, 1);
    assert.equal(d.small.comp, 1);
    assert.equal(d.small.all, 3, 'all three are in the Ticket Tailor number');
  } finally { w.restore(); }
});

test('team passes are counted even though no order ever held them', async () => {
  const accred = memoryKv();
  for (const i of [1, 2]) {
    await accred.put(`person:p_${i}`, JSON.stringify({
      id: `p_${i}`, team: 'core', status: 'approved',
      firstName: 'A', lastName: 'B', email: 'a@b.be',
    }));
  }
  const sale = order();
  const w = world({
    orders: [sale.order],
    tickets: [
      ...sale.tickets,
      { id: 'it_p1', ticket_type_id: 'tt_core', reference: 'p_1' },
      { id: 'it_p2', ticket_type_id: 'tt_artist', reference: 'p_2' },
    ],
  });
  try {
    const d = await (await get(ENV({ ACCRED: accred }))).json();
    assert.equal(d.small.team, 2, 'this used to be nought however many were approved');
    assert.equal(d.small.teamApproved, 2, 'and it agrees with the queue');
    assert.equal(d.small.all, 3);
  } finally { w.restore(); }
});

test('the gap from list price to money received is itemised', async () => {
  const kv = memoryKv();
  const sale = order({ lines: [['tt_gate', 2, 3000], ['gift_card', 1, -300]] });
  const comp = order({ lines: [['tt_gate', 1, 0]] });
  const w = world(world2([sale, comp]));
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    assert.equal(d.gap.discounts, 300);
    assert.ok(d.gap.complimentary > 0);
    assert.equal(d.gap.received, d.headline.revenue);
  } finally { w.restore(); }
});

test('the deals the box office defines are read off the event series', async () => {
  const kv = memoryKv();
  const w = world({
    ...world2([order()]),
    seriesBundles: [
      { id: 'bu_1', name: 'Family of 4', price: 3500, status: 'ON_SALE' },
      { id: 'bu_2', name: 'Group of Six', price: 5000, status: 'HIDDEN' },
    ],
  });
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    /* Names only. Nothing is counted from them, so an empty list means
       nothing is wrong. */
    assert.deepEqual(d.deals.defined.map(x => x.name), ['Family of 4', 'Group of Six']);
    assert.equal(d.deals.sold, 0, 'and no order read so far includes one');
    assert.ok(!w.calls.some(u => /\/bundles/.test(u)),
      'the bundles endpoint has no GET and must not be asked for');
  } finally { w.restore(); }
});

/* ----------------------------------------------------- the view-only role */

test('a view-only token gets no money in any card, period or table', async () => {
  const kv = memoryKv();
  const w = world(world2([order({ lines: [['tt_gate', 3, 4500]] })]));
  try {
    const env = ENV({ ACCRED: kv });
    const body = await (await get(env, { token: VIEWERS.stijn })).text();
    const d = JSON.parse(body);

    assert.equal(d.viewer.revenue, false);
    assert.equal(d.viewer.admin, false, 'and they are not an admin');
    assert.ok(!('revenue' in d));
    assert.ok(!('revenue' in d.headline), 'the headline card carries no money');
    assert.ok(!('reconcile' in d));
    assert.ok(!('gap' in d));
    for (const p of d.periods) {
      assert.ok(!('revenue' in p), `the ${p.key} card carries money`);
    }
    for (const t of [...d.byType, ...d.otherTypes]) assert.ok(!('revenue' in t));
    assert.ok(!body.includes('4500'), 'the amount reached a view-only token');

    /* They still see everything that is not money. */
    assert.equal(d.headline.paid, 3);
    assert.equal(d.periods.length, 3);
  } finally { w.restore(); }
});

test('an admin who is not on the revenue list is still an admin', async () => {
  const kv = memoryKv();
  const w = world(world2([order()]));
  try {
    const d = await (await get(ENV({ ACCRED: kv }), { token: ADMIN.keerthi })).json();
    assert.equal(d.viewer.admin, true, 'they may open the other admin pages');
    assert.equal(d.viewer.revenue, false, 'they may not see money');
    assert.ok(!('revenue' in d.headline));
  } finally { w.restore(); }
});

/* ------------------------------------------------------------ navigation */

test('the admin area opens on the dashboard', () => {
  const redirects = readFileSync(join(ROOT, 'diwali-holding/_redirects'), 'utf8');
  assert.match(redirects, /^\/admin\s+\/admin\/dashboard\s+302$/m);
  assert.match(redirects, /^\/admin\/\s+\/admin\/dashboard\s+302$/m);
});

test('every admin page carries the same navigation, dashboard first', () => {
  for (const rel of ['diwali-admin/team.html', 'diwali-admin/wa.html']) {
    const html = readFileSync(join(ROOT, rel), 'utf8');
    const at = s => html.indexOf(s);
    assert.ok(at('href="/admin/dashboard"') > 0, `${rel} has no dashboard link`);
    assert.ok(at('href="/admin/dashboard"') < at('href="/admin/team"'),
      `${rel} does not put the dashboard first`);
    assert.ok(at('href="/admin/team"') < at('href="/admin/wa"'),
      `${rel} has team passes after WhatsApp`);
  }
  /* The dashboard builds its own, because it is the one that knows the role. */
  const dash = readFileSync(join(ROOT, 'diwali-admin/dashboard.html'), 'utf8');
  assert.match(dash, /D\.viewer\.revenue \|\| D\.viewer\.admin/,
    'a view-only person must be offered only the dashboard');
});

test('a view-only person who opens an admin page is sent to the dashboard', () => {
  for (const rel of ['diwali-admin/team.html', 'diwali-admin/wa.html']) {
    const html = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(html, /function sendToDashboard\(/, `${rel} cannot redirect them`);
    assert.match(html, /location\.replace\('\/admin\/dashboard'\)/, rel);
    /* And it is tried before telling somebody their token is wrong. */
    assert.ok(html.indexOf('sendToDashboard(') < html.lastIndexOf('refused'),
      `${rel} calls the token wrong before checking whether it is`);
  }
});

test('a token typed on any admin page lands on the dashboard', () => {
  for (const rel of ['diwali-admin/team.html', 'diwali-admin/wa.html']) {
    const html = readFileSync(join(ROOT, rel), 'utf8');
    /* The call site, not the declaration. */
    const at = html.lastIndexOf('writeToken(v);');
    assert.ok(at > 0, `${rel} never stores the token`);
    assert.match(html.slice(at, at + 400), /location\.replace\('\/admin\/dashboard'\)/,
      `${rel} stays put after unlocking`);
  }
});

test('a cursor that never advances stops the read instead of multiplying it', async () => {
  const kv = memoryKv();
  const made = Array.from({ length: 120 }, () => order());
  const w = world2(made);

  /* An API that ignores starting_after and answers with the same first page
     for ever. Counting the same ticket two hundred times is a worse failure
     than stopping early. */
  const real = globalThis.fetch;
  let pages = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const reply = o => new Response(JSON.stringify(o),
      { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/bundles')) return reply({ data: [] });
    if (url.includes('/v1/events/')) {
      return reply({ object: 'event', id: 'ev_1', event_series_id: 'es_1', ticket_types: TYPES });
    }
    if (url.includes('/v1/orders')) { pages += 1; return reply({ data: w.orders.slice(0, 100) }); }
    if (url.includes('/v1/issued_tickets')) return reply({ data: w.tickets.slice(0, 100) });
    return reply({ data: [] });
  };

  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    assert.ok(pages <= 3, `it asked ${pages} times for the same page`);
    assert.equal(d.revenue.orders, 100, 'and counted each order once');
  } finally { globalThis.fetch = real; }
});

/* --------------------------------------------- failing without disappearing */

test('a cache from an older deploy is ignored, not read and crashed on', async () => {
  const kv = memoryKv();
  /* Exactly what cb4d8ae left behind: the right key, the old shape, with no
     perDayMoney and no gap. Reading it threw inside shape(), the Worker
     answered an HTML error page, and the browser called that "could not
     reach the server" about a server it had reached. */
  await kv.put('dash:figures', JSON.stringify({
    at: new Date().toISOString(),
    agg: { paid: 5, free: 0, team: 0, all: 5, revenue: 777200, orders: 5,
      perDay: {}, byType: [], bySource: {}, byCode: {}, groups: { deals: 0, people: 0 } },
    team: { teams: [], waiting: 0, codes: [] },
  }));
  await kv.put(`dash:figures:v${SHAPE_VERSION}`, JSON.stringify({ at: 'x', agg: {} }));

  const w = world(world2([order()]));
  try {
    const res = await get(ENV({ ACCRED: kv }));
    const d = await res.json();
    assert.equal(res.status, 200);
    assert.equal(d.ok, true, 'an old cache must not take the page down');
    assert.equal(d.headline.paid, 1, 'and the figures are rebuilt, not the old ones');
  } finally { w.restore(); }

  /* And the check itself knows what it is looking for. */
  assert.equal(isCurrentShape(null), false);
  assert.equal(isCurrentShape({ version: 1, agg: {} }), false);
  assert.equal(isCurrentShape({ version: SHAPE_VERSION, agg: { paid: 1 } }), false,
    'half a shape is not the shape');
});

test('deals failing does not fail the build, and the page is told', async () => {
  const kv = memoryKv();
  const w = world2([order()]);
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const reply = (st, o) => new Response(JSON.stringify(o),
      { status: st, headers: { 'content-type': 'application/json' } });
    if (url.includes('/v1/event_series/')) {
      return reply(502, { errors: [{ message: 'the series is down' }] });
    }
    if (url.includes('/v1/events/')) {
      const counts = countOf(w.tickets);
      return reply(200, { object: 'event', id: 'ev_1', event_series_id: 'es_1',
        ticket_types: TYPES.map(t => ({ ...t, quantity_issued: counts[t.id] || 0 })) });
    }
    if (url.includes('/v1/orders')) return reply(200, { data: w.orders });
    return reply(200, { data: [] });
  };
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    assert.equal(d.ok, true, 'a bad minute on bundles must not cost the whole page');
    assert.equal(d.headline.paid, 1);
    const said = d.degraded.find(x => x.stage === 'deals');
    assert.ok(said, 'and the page is told which section is missing');
    assert.equal(said.status, 502);
    assert.match(said.reason, /the series is down/);
  } finally { globalThis.fetch = real; }
});

test('check-ins failing does not fail the build either', async () => {
  const kv = memoryKv();
  const w = world({ ...world2([order()]), fail: 'checkins' });
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    assert.equal(d.ok, true);
    assert.equal(d.checkIns.available, false);
    assert.ok(d.degraded.some(x => x.stage === 'check-ins'));
  } finally { w.restore(); }
});

test('a required stage failing names itself, with the status', async () => {
  const kv = memoryKv();
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/v1/events/')) {
      return new Response(JSON.stringify({ errors: [{ message: 'event is gone' }] }),
        { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = await get(ENV({ ACCRED: kv }));
    const d = await res.json();
    assert.equal(res.status, 200, 'it is still JSON, and still readable');
    assert.equal(d.ok, false);
    assert.equal(d.stage, 'types', 'it says which part failed');
    assert.equal(d.status, 404, 'and what Ticket Tailor answered');
    assert.match(d.reason, /event is gone/);
  } finally { globalThis.fetch = real; }
});

test('whatever goes wrong, the answer is JSON with a stage on it', async () => {
  /* A binding that throws on read: not a Ticket Tailor problem at all, and
     the sort of thing that used to reach the browser as an HTML error page. */
  const broken = {
    async get() { throw new Error('KV exploded'); },
    async put() {}, async delete() {},
    async list() { return { keys: [], list_complete: true }; },
  };
  const w = world(world2([order()]));
  try {
    const res = await get(ENV({ ACCRED: broken }));
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.ok, true, 'a cache that will not read is not a failure');
  } finally { w.restore(); }

  /* And one that cannot be recovered from still answers JSON. */
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('socket closed'); };
  try {
    const res = await get(ENV({ ACCRED: memoryKv() }));
    assert.match(res.headers.get('content-type') || '', /json/);
    const d = await res.json();
    assert.equal(d.ok, false);
    assert.ok(d.stage, 'every failure names a stage');
    assert.match(d.reason, /socket closed/);
  } finally { globalThis.fetch = real; }
});

test('a secret could never ride out on a failure message', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/v1/events/')) {
      return new Response(JSON.stringify({
        errors: [{ message: `refused ${(init.headers || {}).authorization} sk_live_SECRET` }],
      }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const body = await (await get(ENV({ ACCRED: memoryKv(), TT_API_KEY: 'sk_live_SECRET' }))).text();
    assert.ok(!body.includes('sk_live_SECRET'));
    assert.ok(!/Basic [A-Za-z0-9+/=]{8,}/.test(body));
    assert.match(body, /redacted/);
  } finally { globalThis.fetch = real; }
});

test('a build walks a bounded number of pages and leaves a cursor', async () => {
  const kv = memoryKv();
  /* More orders than one build is allowed, so it does its share and says it
     is catching up rather than quietly showing a short total. */
  const made = Array.from({ length: 2500 }, () => order());
  const w = world2(made);
  const real = globalThis.fetch;
  let orderCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const reply = o => new Response(JSON.stringify(o),
      { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/v1/event_series/')) return reply({ object: 'event_series', bundles: [] });
    if (url.includes('/v1/events/')) {
      const counts = countOf(w.tickets);
      return reply({ object: 'event', id: 'ev_1', event_series_id: 'es_1',
        ticket_types: TYPES.map(t => ({ ...t, quantity_issued: counts[t.id] || 0 })) });
    }
    if (url.includes('/v1/orders')) {
      orderCalls += 1;
      const u = new URL(url);
      const after = u.searchParams.get('starting_after');
      const from = after ? w.orders.findIndex(o => o.id === after) + 1 : 0;
      return reply({ data: w.orders.slice(from, from + 100) });
    }
    return reply({ data: [] });
  };
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    assert.ok(orderCalls <= 20, `it walked ${orderCalls} pages in one request`);
    assert.equal(d.catchingUp, true, 'and it says there is more to come');

    const state = await kv.get(`dash:state:v${SHAPE_VERSION}`, 'json');
    assert.ok(state.cursor, 'the next build carries on from here');
    /* And the state holds only what the arithmetic reads. */
    const one = state.orders[0];
    assert.deepEqual(Object.keys(one).sort(), ['created_at', 'discount_code', 'id',
      'issued_tickets', 'line_items', 'referral_tag', 'refund_amount', 'status', 'total']);
    assert.deepEqual(Object.keys(one.issued_tickets[0]).sort(), ['id', 'ticket_type_id'],
      'and only the two fields the counting reads');
  } finally { globalThis.fetch = real; }
});

/* ---------------------------------------------------- the page's four cases */

test('the page tells the four failure cases apart', () => {
  const html = readFileSync(join(ROOT, 'diwali-admin/dashboard.html'), 'utf8');

  /* It reads the body as text first, so a body that is not JSON is reported
     as what it is rather than as a network failure. */
  assert.match(html, /return r\.text\(\);/);
  assert.match(html, /JSON\.parse\(body\)/);
  assert.match(html, /is not JSON/);
  assert.match(html, /HTTP ' \+ status/);

  /* The server reporting a failure says which stage. */
  assert.match(html, /It failed at: '/);
  assert.match(html, /d\.stage/);

  /* Drawing failing is its own case and not a network one. */
  assert.match(html, /could not draw them/);

  /* And "could not reach the server" is now only in the catch. */
  const at = html.indexOf('Could not reach the server');
  assert.ok(at > 0);
  assert.ok(html.lastIndexOf('.catch(function (e) {', at) > html.indexOf('function load(fresh)'),
    'that line must only be reachable when the request never completed');
  assert.equal((html.match(/Could not reach the server/g) || []).length, 1);
});

test('the Refresh button and the navigation survive a failure', () => {
  const html = readFileSync(join(ROOT, 'diwali-admin/dashboard.html'), 'utf8');
  assert.match(html, /function chrome\(\)/);
  assert.match(html, /\$\('refresh'\)\.hidden = false;/);
  /* Every failure path puts the chrome back before saying anything. */
  const failFn = html.slice(html.indexOf('function fail(text, detail)'));
  assert.match(failFn.slice(0, 200), /chrome\(\);/);
});

/* -------------------------------------------------------------- the ages */

test('the mapping names the two child types and everything else is an adult', () => {
  assert.equal(ageOf('tt_6865730'), 'teen', 'Child 13-18');
  assert.equal(ageOf('tt_6753537'), 'child', 'Child Below 12');
  for (const id of ['tt_presale', 'tt_online', 'tt_gate', 'tt_anything_new', '']) {
    assert.equal(ageOf(id), 'adult', `${id} should fall back to adult`);
  }
  /* Adult is the fallback because it cannot undercount the site. */
  assert.deepEqual(AGE_KEYS, ['adult', 'teen', 'child']);
  assert.deepEqual(AGE_GROUPS.map(g => g.key), ['adult', 'teen', 'child']);
  assert.deepEqual(blankAges(), { adult: 0, teen: 0, child: 0 });

  /* The mapping is a data file, not an environment variable. */
  const cfg = JSON.parse(readFileSync(join(ROOT, 'data/ticket-ages.json'), 'utf8'));
  assert.equal(cfg.ages.tt_6865730, 'teen');
  assert.equal(cfg.ages.tt_6753537, 'child');
  assert.equal(cfg.default, 'adult');
});

test('the three age figures always add up to people coming', () => {
  const w = world2([
    order({ lines: [['tt_gate', 2, 3000], ['tt_6865730', 1, 1000], ['tt_6753537', 2, 0]] }),
    order({ lines: [['tt_presale', 1, 1000]] }),
  ]);
  const a = aggregate(w.orders, w.issued, OPTS);

  assert.deepEqual(a.ages, { adult: 3, teen: 1, child: 2 });
  assert.equal(a.people, 6);
  assert.equal(a.ages.adult + a.ages.teen + a.ages.child, a.people,
    'the split is the total split three ways, by construction');
  /* And the public total is everything that exists less the team's passes. */
  assert.equal(a.people, a.all - a.team);
});

test('somebody inside a group deal is counted in their own age group', () => {
  const deal = order({
    lines: [['deal:Family of 4', 1, 3500,
      ['tt_gate', 'tt_gate', 'tt_6865730', 'tt_6753537']]],
  });
  const w = world2([deal]);
  const a = aggregate(w.orders, w.issued, OPTS);

  assert.deepEqual(a.ages, { adult: 2, teen: 1, child: 1 },
    'a deal admits people, and each takes the age group of their own type');
  assert.equal(a.people, 4);
  assert.equal(a.insideDeals, 3, 'three of them are of a paid type');
  assert.equal(a.comp, 0);

  /* And they are in the day's figures too. */
  const day = Object.keys(a.perDayAge)[0];
  assert.deepEqual(a.perDayAge[day], { adult: 2, teen: 1, child: 1 });
  assert.equal(a.perDayPeople[day], 4);
});

test('team passes are never in the age figures', () => {
  const sale = order({ lines: [['tt_gate', 1, 1500]] });
  const a = aggregate([sale.order], { tt_gate: 1, tt_core: 9, tt_artist: 4 }, OPTS);

  assert.equal(a.team, 13);
  assert.equal(a.people, 1, 'the public, and only the public');
  assert.deepEqual(a.ages, { adult: 1, teen: 0, child: 0 });
  assert.equal(a.ages.adult + a.ages.teen + a.ages.child, a.people);
});

test('a public type with no age group counts as an adult and is named', () => {
  const sale = order({ lines: [['tt_gate', 2, 3000]] });
  const w = world2([sale]);
  const a = aggregate(w.orders, w.issued,
    { ...OPTS, typeNames: { ...OPTS.typeNames, tt_gate: 'Festival Ticket (At Gate)' } });

  assert.equal(a.ages.adult, 2, 'adult cannot undercount the site');
  assert.deepEqual(a.unmapped, [{ id: 'tt_gate', name: 'Festival Ticket (At Gate)', issued: 2 }]);

  /* A type that is in the mapping is not named, and nor is one nobody bought. */
  const b = aggregate(...[[], { tt_6865730: 3, tt_gate: 0 }], OPTS);
  assert.deepEqual(b.unmapped, []);
  assert.equal(b.ages.teen, 3);
});

/* ----------------------------------------------- the people on the page */

test('the headline and the period cards lead with people, split three ways', async () => {
  const kv = memoryKv();
  const w = world(world2([
    order({ lines: [['tt_gate', 2, 3000], ['tt_6753537', 1, 0]] }),
    order({ lines: [['deal:Family of 4', 1, 3500, ['tt_presale', 'tt_6865730']]] }),
  ]));
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();

    assert.equal(d.headline.people, 5);
    assert.deepEqual(d.headline.ages, { adult: 3, teen: 1, child: 1 });
    assert.equal(Object.values(d.headline.ages).reduce((a, b) => a + b, 0), d.headline.people);
    assert.deepEqual(d.ageGroups.map(g => g.label), ['Adults', '13 to 18', 'Under 12']);

    for (const p of d.periods) {
      assert.equal(typeof p.people, 'number');
      assert.equal(Object.values(p.ages).reduce((a, b) => a + b, 0), p.people,
        `${p.key} does not add up`);
      assert.equal(typeof p.all, 'number');
      assert.equal(typeof p.orders, 'number');
    }
    /* Everything was bought today, so today is the whole of it. */
    const today = d.periods.find(p => p.key === 'today');
    assert.equal(today.people, 5);
    assert.deepEqual(today.ages, d.headline.ages);

    /* Everyone on site is the public plus the people working. */
    assert.equal(d.small.onSite, d.headline.people + d.small.team);

    /* The chart is people per day now, not paid tickets. */
    assert.equal(Object.values(d.perDay).reduce((a, b) => a + b, 0), 5);

    /* And the table still totals to the paid part and to the headline money. */
    const sold = d.byType.reduce((n, t) => n + t.sold, 0)
      + d.deals.rows.reduce((n, x) => n + x.people, 0);
    assert.equal(sold, d.headline.people - d.small.free - d.small.comp,
      'the paid part of the table is people less the free and the given away');
    const table = d.byType.reduce((n, t) => n + t.revenue, 0)
      + d.deals.rows.reduce((n, x) => n + x.revenue, 0) + d.reconcile.fees;
    assert.equal(table, d.headline.revenue);
  } finally { w.restore(); }
});

test('the type table says which age group each ticket admits', async () => {
  const kv = memoryKv();
  const w = world(world2([
    order({ lines: [['tt_gate', 1, 1500], ['tt_6865730', 1, 1000], ['tt_6753537', 1, 0]] }),
  ]));
  try {
    const d = await (await get(ENV({ ACCRED: kv }))).json();
    const byId = Object.fromEntries([...d.byType, ...d.otherTypes].map(t => [t.id, t.age]));
    assert.equal(byId.tt_gate, 'adult');
    assert.equal(byId.tt_6865730, 'teen');
    assert.equal(byId.tt_6753537, 'child');
  } finally { w.restore(); }
});

test('a view-only token gets the people figures and no money at all', async () => {
  const kv = memoryKv();
  const w = world(world2([order({ lines: [['tt_gate', 3, 4500], ['tt_6753537', 1, 0]] })]));
  try {
    const env = ENV({ ACCRED: kv });
    const body = await (await get(env, { token: VIEWERS.stijn })).text();
    const d = JSON.parse(body);

    assert.equal(d.headline.people, 4, 'they see who is coming');
    assert.deepEqual(d.headline.ages, { adult: 3, teen: 0, child: 1 });
    assert.ok(!('revenue' in d.headline), 'and no money in the headline card');
    assert.ok(!('revenue' in d));
    for (const p of d.periods) {
      assert.ok(!('revenue' in p), `the ${p.key} card carries money`);
      assert.equal(Object.values(p.ages).reduce((a, b) => a + b, 0), p.people);
    }
    for (const t of [...d.byType, ...d.otherTypes]) assert.ok(!('revenue' in t));
    for (const r of d.deals.rows) assert.ok(!('revenue' in r));
    assert.ok(!body.includes('4500'), 'the amount reached a view-only token');
  } finally { w.restore(); }
});

test('the page leads with people and no longer with paid tickets', () => {
  const html = readFileSync(join(ROOT, 'diwali-admin/dashboard.html'), 'utf8');
  assert.match(html, /People coming/);
  assert.match(html, /People per day/);
  assert.match(html, /Everyone on site/);
  assert.match(html, /function ages\(/);
  assert.match(html, /D\.unmapped/, 'an unmapped type has to be named on the page');
  /* Paid tickets survives as the total of the table, not as a headline. */
  assert.ok(!/<div class="k">Paid tickets<\/div>/.test(html));
  assert.match(html, /<td>Paid tickets<\/td>/);
});

/**
 * The dashboard's arithmetic.
 *
 * Every function here is pure and takes the data it needs, so the whole thing
 * can be tested with a handful of fake orders and no network at all. The
 * route does the fetching and the caching; this file does the counting.
 *
 * Two rules run through all of it. A cancelled or refunded order never counts,
 * and a voided ticket never counts: a dashboard that quietly includes money
 * that was given back is worse than no dashboard. And nothing personal leaves
 * here but a first name beside a code.
 */

import { AGE_OF, AGE_DEFAULT, AGE_GROUPS } from './_ages.js';

export { AGE_GROUPS };

/* ------------------------------------------------------------------- time */

/* The festival is in Brussels and so is everyone reading this. A day boundary
   anywhere else would put an evening's sales on the wrong day twice a year. */
const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit',
});
const HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels', hour: '2-digit', hour12: false,
});

/** 'YYYY-MM-DD' in Brussels, from a unix timestamp in seconds. */
export const brusselsDay = unix => DAY_FMT.format(new Date(Number(unix) * 1000));

/** The hour of the day in Brussels, 0 to 23. */
export const brusselsHour = unix => Number(HOUR_FMT.format(new Date(Number(unix) * 1000)));

/** The last n days, oldest first, ending today in Brussels. */
export function lastDays(n, now = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(brusselsDay(Math.floor(now.getTime() / 1000) - i * 86400));
  }
  return out;
}

export const FESTIVAL_DAYS = ['2026-10-24', '2026-10-25'];

/** Whole days from now until the gates open. Never negative. */
export function daysToGo(now = new Date(), when = '2026-10-24T12:00:00+02:00') {
  const ms = new Date(when).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86400000));
}

/* --------------------------------------------------------- what counts */

/**
 * Is this order real money that stayed with us?
 *
 * `status` is completed, pending or cancelled, and a refund is an amount
 * rather than a flag, so a partly refunded order is still an order and a
 * fully refunded one is not.
 */
export function orderCounts(order) {
  if (!order) return false;
  if (String(order.status || '').toLowerCase() !== 'completed') return false;
  const total = Number(order.total) || 0;
  const back = Number(order.refund_amount) || 0;
  if (total > 0 && back >= total) return false;
  return true;
}

/** What is left of an order after a partial refund, in cents. */
export const orderNet = order =>
  Math.max(0, (Number(order.total) || 0) - (Number(order.refund_amount) || 0));

/** A voided ticket is not a ticket. */
export const ticketCounts = t =>
  Boolean(t) && !t.voided_at && String(t.status || 'valid').toLowerCase() !== 'voided';

/**
 * Team pass, free public ticket, or paid.
 *
 * A team pass is a ticket type named in a TT_TYPE_* variable. Those tickets
 * also carry a p_ reference, which is how one is recognised when the type
 * list is incomplete: better to call a free pass a pass than to sell it.
 */
export function classify(ticket, { teamTypes, freeTypes }) {
  const type = String(ticket.ticket_type_id || '');
  if (teamTypes.has(type)) return 'team';
  if (/^p_/.test(String(ticket.reference || ''))) return 'team';
  if (freeTypes.has(type)) return 'free';
  return 'paid';
}

/**
 * Where an order came from, from referral_tag alone.
 *
 * The buckets are the ones somebody can act on: the site's own buttons, one
 * Instagram post, a buyer's draw link, a team member's link. Anything else is
 * somebody else's campaign and is counted without being guessed at.
 */
export function sourceOf(tag) {
  const raw = String(tag || '').trim();
  if (!raw) return 'none';
  if (/^ig-/i.test(raw)) return 'instagram';
  if (/^team-/i.test(raw)) return 'team';
  if (/^site-/i.test(raw) || /^event_page_widget$/i.test(raw)) return 'site';
  /* The buyer referral code: six characters of the code alphabet. */
  if (/^[A-HJ-NP-Z2-9]{6}$/i.test(raw)) return 'referral';
  return 'other';
}

export const SOURCE_ORDER = ['none', 'site', 'instagram', 'referral', 'team', 'other'];

/* -------------------------------------------------------------- the ages */

/**
 * Which age group a public ticket type admits.
 *
 * Anything the mapping does not name counts as an adult, which is the answer
 * that cannot undercount the site, and the dashboard says which type it was
 * so the mapping can be corrected rather than quietly drifting.
 */
export function ageOf(typeId) {
  return AGE_OF[String(typeId)] || AGE_DEFAULT;
}

export const AGE_KEYS = ['adult', 'teen', 'child'];
export const blankAges = () => ({ adult: 0, teen: 0, child: 0 });

/* ------------------------------------------------------------ the money */

/* `gift_card` is Ticket Tailor's name for a discount or voucher applied to
   the order; `void` is a ticket voided after purchase. */
export const DISCOUNT_LINE = 'gift_card';
export const VOID_LINE = 'void';

/* The only lines that are not somebody buying something to come in with.
   Everything else that carries money is ticket revenue, whether it is a
   single ticket or a group deal, and whatever Ticket Tailor calls its type. */
export const FEE_LINES = new Set(['transaction_charge', 'tax', 'donation']);

export const linesOf = order =>
  (Array.isArray(order && order.line_items) ? order.line_items : []);

const abs = v => Math.abs(Number(v) || 0);

/** A plain ticket line: one ticket type, bought on its own. */
export const isTicketLine = l =>
  !FEE_LINES.has(String(l && l.type))
  && String(l && l.type) !== DISCOUNT_LINE
  && String(l && l.type) !== VOID_LINE
  && /^tt_/.test(String((l && l.item_id) || ''));

/**
 * A group deal line.
 *
 * Anything that is money for admission and is not a plain ticket type. The
 * documented item id is `bu_`, but a line that identifies its deal some other
 * way must still be ticket revenue: treating it as a fee is what put a deal's
 * whole price into "fees, tax and other" and made every ticket it covered
 * look like a giveaway.
 */
export const isDealLine = l =>
  !FEE_LINES.has(String(l && l.type))
  && String(l && l.type) !== DISCOUNT_LINE
  && String(l && l.type) !== VOID_LINE
  && !/^tt_/.test(String((l && l.item_id) || ''))
  && (Number(l && l.total) || 0) !== 0;

/** Kept for the tests that name it; a deal is a bundle by another word. */
export const isBundleLine = isDealLine;

/**
 * What an order brought in, and where it went.
 *
 * Admission money is every ticket line and every deal line, less the
 * discount. Fees and tax are the rest. The two together are the order's net,
 * so the table can add up to the headline without a fudge.
 */
export function orderMoney(order) {
  const lines = linesOf(order);
  const buying = lines.filter(l => isTicketLine(l) || isDealLine(l));
  const gross = buying.reduce((n, l) => n + (Number(l.total) || 0), 0);
  const discount = lines.filter(l => String(l.type) === DISCOUNT_LINE)
    .reduce((n, l) => n + abs(l.total), 0);
  const fees = lines.filter(l => FEE_LINES.has(String(l.type)))
    .reduce((n, l) => n + (Number(l.total) || 0), 0);

  const net = orderNet(order);
  const total = Number(order.total) || 0;
  const kept = total > 0 ? net / total : 1;

  const ticketMoney = Math.max(0, gross - discount) * kept;

  const byLine = new Map();
  for (const l of buying) {
    const share = gross > 0 ? (Number(l.total) || 0) / gross : 0;
    byLine.set(l, Math.round(ticketMoney * share));
  }
  /* Rounding lands on the biggest line, so the parts still make the whole. */
  const allocated = [...byLine.values()].reduce((a, b) => a + b, 0);
  if (byLine.size && allocated !== Math.round(ticketMoney)) {
    let biggest = null;
    for (const [l, v] of byLine) if (!biggest || v > byLine.get(biggest)) biggest = l;
    byLine.set(biggest, byLine.get(biggest) + (Math.round(ticketMoney) - allocated));
  }

  return {
    gross, discount, fees, net,
    ticketMoney: Math.round(ticketMoney),
    other: net - Math.round(ticketMoney),
    byLine,
  };
}

/* ------------------------------------------------------------- the counting */

/* Bumped whenever the shape of a cached figures object changes. A cache
   written by an older deploy is ignored rather than read and crashed on. */
export const SHAPE_VERSION = 4;

/** Does this cached object have everything shape() is about to read? */
export function isCurrentShape(f) {
  if (!f || typeof f !== 'object') return false;
  if (Number(f.version) !== SHAPE_VERSION) return false;
  const a = f.agg;
  if (!a || typeof a !== 'object') return false;
  for (const k of ['perDay', 'perDayMoney', 'perDayAll', 'perDayOrders',
    'perDayPeople', 'perDayAge', 'ages', 'unmapped',
    'byType', 'byDeal', 'bySource', 'byCode', 'groups', 'gap']) {
    if (!a[k] || typeof a[k] !== 'object') return false;
  }
  for (const k of ['paid', 'free', 'team', 'comp', 'all', 'people',
    'revenue', 'fees', 'insideDeals']) {
    if (typeof a[k] !== 'number') return false;
  }
  return Boolean(f.team && Array.isArray(f.team.teams));
}

const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

export const ticketsOf = order =>
  (Array.isArray(order && order.issued_tickets) ? order.issued_tickets : [])
    .filter(ticketCounts);

/**
 * Everything the page shows.
 *
 * How many of each type exist comes from the ticket types on the event, which
 * carry `quantity_issued`: one call for the lot. Who paid, and for what, comes
 * from the orders, counted against the order's own issued tickets rather than
 * against any bundle definition, because the definitions cannot be read back
 * at all and a count that depends on them is a count that breaks.
 *
 * A ticket issued at nothing on an order that bought a deal is a person
 * inside that deal, and they are paid tickets. Complimentary means only a
 * ticket of a paid type issued at nothing with no deal on the order to
 * account for it.
 */
export function aggregate(orders, typeIssued = {}, {
  teamTypes, typeNames = {}, typePrices = {},
} = {}) {
  const perDay = {};
  const perDayMoney = {};
  const perDayAll = {};
  const perDayOrders = {};
  const perDayPeople = {};
  const perDayAge = {};
  const byType = {};
  const byDeal = {};
  const bySource = {};
  const byCode = {};

  let revenue = 0, orderCount = 0, feeMoney = 0;
  let discountGiven = 0, refundedMoney = 0, lostToCancelled = 0;
  let paidIndividually = 0, insideDeals = 0, compInOrders = 0, dealCount = 0;

  const isTeam = id => teamTypes.has(String(id));
  const isFree = id => Number(typePrices[id]) === 0 && !isTeam(id);

  for (const order of orders) {
    if (!orderCounts(order)) {
      lostToCancelled += linesOf(order)
        .filter(l => isTicketLine(l) || isDealLine(l))
        .reduce((n, l) => n + (Number(l.total) || 0), 0);
      continue;
    }

    orderCount += 1;
    const m = orderMoney(order);
    revenue += m.net;
    feeMoney += m.other;
    discountGiven += m.discount;
    refundedMoney += Number(order.refund_amount) || 0;

    const day = brusselsDay(order.created_at);
    bump(perDayMoney, day, m.net);
    bump(perDayOrders, day);
    bump(bySource, sourceOf(order.referral_tag));

    const code = String(order.discount_code
      || (order.discount && order.discount.code) || '').toUpperCase();
    if (code) bump(byCode, code);

    /* ---- what this order bought, line by line ---- */
    const boughtPerType = {};     // type -> how many were bought on their own
    const deals = [];             // the deal lines, with their money

    for (const [line, amount] of m.byLine) {
      const qty = Number(line.quantity) || 1;
      if (isDealLine(line)) {
        const name = String(line.description || line.item_id || 'Group deal').trim();
        deals.push({ name, qty, amount });
        dealCount += qty;
        continue;
      }
      const typeId = String(line.item_id);
      touchType(byType, typeId, typeNames, typePrices, amount);
      if (isFree(typeId) || isTeam(typeId)) continue;
      if (amount > 0) bump(boughtPerType, typeId, qty);
    }

    /* ---- and who came in on it ---- */
    const issuedHere = {};
    let allHere = 0;
    for (const t of ticketsOf(order)) {
      allHere += 1;
      const typeId = String(t.ticket_type_id || 'unknown');
      bump(issuedHere, typeId);
      /* Everybody who is coming, whatever they paid and however they got in.
         A ticket inside a deal takes the age group of its own type. */
      if (isTeam(typeId)) continue;
      bump(perDayPeople, day);
      perDayAge[day] = perDayAge[day] || blankAges();
      perDayAge[day][ageOf(typeId)] += 1;
    }
    bump(perDayAll, day, allHere);

    let dealPeopleHere = 0;
    for (const [typeId, n] of Object.entries(issuedHere)) {
      if (isTeam(typeId) || isFree(typeId)) continue;
      const bought = Math.min(n, boughtPerType[typeId] || 0);
      paidIndividually += bought;
      byType[typeId] = byType[typeId] || blankType(typeId, typeNames, typePrices);
      byType[typeId].sold += bought;

      const left = n - bought;
      if (!left) continue;
      if (deals.length) dealPeopleHere += left;
      else compInOrders += left;
    }

    /* The people inside this order's deals, shared out by what each cost. */
    if (dealPeopleHere) {
      insideDeals += dealPeopleHere;
      bump(perDay, day, dealPeopleHere);
      const money = deals.reduce((n, d) => n + d.amount, 0);
      let given = 0;
      deals.forEach((d, i) => {
        const share = i === deals.length - 1
          ? dealPeopleHere - given
          : Math.round(dealPeopleHere * (money ? d.amount / money : 1 / deals.length));
        given += share;
        const row = byDeal[d.name] = byDeal[d.name]
          || { name: d.name, deals: 0, people: 0, revenue: 0 };
        row.deals += d.qty;
        row.people += share;
        row.revenue += d.amount;
      });
    } else {
      for (const d of deals) {
        const row = byDeal[d.name] = byDeal[d.name]
          || { name: d.name, deals: 0, people: 0, revenue: 0 };
        row.deals += d.qty;
        row.revenue += d.amount;
      }
    }

    /* Individually bought tickets land on the day their order did. */
    const boughtHere = Object.entries(issuedHere)
      .filter(([id]) => !isTeam(id) && !isFree(id))
      .reduce((n, [id, c]) => n + Math.min(c, boughtPerType[id] || 0), 0);
    if (boughtHere) bump(perDay, day, boughtHere);
  }

  /* ---- how many of each type exist, from the event ---- */
  const issuedOf = id => Number(typeIssued[id]) || 0;
  let free = 0, team = 0, all = 0, issuedPaidTypes = 0, listGross = 0;
  const ages = blankAges();
  const unmapped = [];

  for (const id of new Set([...Object.keys(typeIssued), ...Object.keys(typePrices)])) {
    const n = issuedOf(id);
    all += n;
    if (isTeam(id)) { team += n; continue; }

    /* Everyone coming in on a public ticket, by what their own type admits. */
    ages[ageOf(id)] += n;
    if (n > 0 && !AGE_OF[String(id)]) {
      unmapped.push({ id, name: typeNames[id] || id, issued: n });
    }

    if (isFree(id)) { free += n; continue; }
    issuedPaidTypes += n;
    listGross += n * (Number(typePrices[id]) || 0);
  }

  /* People coming is every public ticket, which is everything that exists
     less the team's own passes. The three age figures are that number split
     three ways, so they add up to it by construction. */
  const people = ages.adult + ages.teen + ages.child;

  const paid = paidIndividually + insideDeals;
  /* A paid type that exists and no order accounts for: issued by hand. */
  const compOutside = Math.max(0, issuedPaidTypes - paid - compInOrders);
  const comp = compInOrders + compOutside;
  const compList = issuedPaidTypes > 0 ? Math.round((listGross * comp) / issuedPaidTypes) : 0;

  const withAge = t => ({
    ...t,
    kind: isTeam(t.id) ? 'team' : (isFree(t.id) ? 'free' : 'paid'),
    age: isTeam(t.id) ? '' : ageOf(t.id),
    issued: issuedOf(t.id),
  });
  const types = Object.values(byType).map(withAge);
  for (const id of Object.keys(typeIssued)) {
    if (types.some(t => t.id === id)) continue;
    types.push(withAge(blankType(id, typeNames, typePrices)));
  }

  return {
    paid, free, team, comp, all,
    people,
    ages,
    unmapped,
    perDayPeople,
    perDayAge,
    paidIndividually,
    insideDeals,
    orders: orderCount,
    revenue,
    fees: feeMoney,
    perDay,
    perDayMoney,
    perDayAll,
    perDayOrders,
    byType: types.sort((a, b) => b.revenue - a.revenue || b.sold - a.sold),
    byDeal: Object.values(byDeal).sort((a, b) => b.revenue - a.revenue),
    bySource,
    byCode,
    groups: { deals: dealCount, people: insideDeals },
    gap: {
      list: listGross,
      discounts: discountGiven,
      complimentary: compList,
      refunds: refundedMoney,
      cancelled: lostToCancelled,
    },
  };
}

const blankType = (id, names, prices) => ({
  id, name: names[id] || id, price: prices[id] ?? null, sold: 0, revenue: 0,
});

function touchType(byType, id, names, prices, amount) {
  byType[id] = byType[id] || blankType(id, names, prices);
  byType[id].revenue += amount;
}

/** Sum of the paid tickets on the given days. */
export const sumDays = (perDay, days) =>
  days.reduce((n, d) => n + (perDay[d] || 0), 0);

/* --------------------------------------------------------------- check-ins */

/**
 * People scanned in, per hour, on each festival day.
 *
 * `quantity` is 1 for a check in and -1 for a check out, so a ticket scanned
 * out again stops counting. Public and team are split on the issued ticket's
 * reference, which is the only split that needs no ticket type list.
 */
export function checkInsByHour(checkIns, ticketKind = {}) {
  const out = {};
  for (const day of FESTIVAL_DAYS) out[day] = { public: {}, team: {}, total: 0 };

  for (const c of checkIns) {
    const at = Number(c.check_in_at || c.created_at);
    if (!Number.isFinite(at)) continue;
    const day = brusselsDay(at);
    if (!out[day]) continue;
    const hour = brusselsHour(at);
    const side = ticketKind[String(c.issued_ticket_id)] === 'team' ? 'team' : 'public';
    const by = Number(c.quantity);
    const n = Number.isFinite(by) ? by : 1;
    out[day][side][hour] = (out[day][side][hour] || 0) + n;
    out[day].total += n;
  }

  /* A scan out can take an hour below zero on its own; the floor keeps a
     negative out of a bar chart without hiding it from the total. */
  for (const day of FESTIVAL_DAYS) {
    for (const side of ['public', 'team']) {
      for (const h of Object.keys(out[day][side])) {
        out[day][side][h] = Math.max(0, out[day][side][h]);
      }
    }
    out[day].total = Math.max(0, out[day].total);
  }
  return out;
}

/** True once the gates have opened on the first day. */
export const festivalStarted = (now = new Date()) =>
  now.getTime() >= new Date('2026-10-24T12:00:00+02:00').getTime();

/* ------------------------------------------------------------------ access */

/**
 * Who is asking, and whether they may see money.
 *
 * Revenue is decided here and enforced in the route by building a different
 * object, never by hiding a field the response still carries.
 */
export function viewerFor(env, presented, { safeEqual }) {
  const read = raw => { try { return JSON.parse(raw || '{}') || {}; } catch { return {}; } };
  const admins = read(env.TEAM_ADMIN_TOKENS);
  const viewers = read(env.DASH_VIEW_TOKENS);
  if (!presented) return null;

  for (const [name, tok] of Object.entries(admins)) {
    if (safeEqual(String(tok), String(presented))) {
      return { name, admin: true, revenue: revenueNames(env).includes(name.toLowerCase()) };
    }
  }
  /* A view-only person may read the dashboard and nothing else, so the page
     offers them no navigation to a page that would refuse them. */
  for (const [name, tok] of Object.entries(viewers)) {
    if (safeEqual(String(tok), String(presented))) return { name, admin: false, revenue: false };
  }
  return null;
}

export const revenueNames = env => String(env.DASH_REVENUE_USERS || 'ravi')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

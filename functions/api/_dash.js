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

/* ------------------------------------------------------------ the money */

/* What a line item is. `gift_card` is Ticket Tailor's name for a discount or
   voucher applied to the order; `void` is a ticket voided after purchase. */
export const TICKET_LINE = 'ticket';
export const DISCOUNT_LINE = 'gift_card';
export const VOID_LINE = 'void';

export const linesOf = order =>
  (Array.isArray(order && order.line_items) ? order.line_items : []);

const abs = v => Math.abs(Number(v) || 0);

/**
 * What an order actually brought in, and where it went.
 *
 * `total` is the whole order including fees and tax, so the money attributed
 * to ticket types is the ticket lines less the discount, and whatever is left
 * over is fees, tax and donations. Both halves are returned, because the two
 * together have to add up to the headline or the table is a different number
 * wearing the same name.
 *
 * A partial refund scales the whole thing: Ticket Tailor does not say which
 * line the money came off, so taking it off everything in proportion is the
 * only answer that does not invent a detail.
 */
export function orderMoney(order) {
  const lines = linesOf(order);
  const tickets = lines.filter(l => String(l.type) === TICKET_LINE);
  const gross = tickets.reduce((n, l) => n + (Number(l.total) || 0), 0);
  const discount = lines.filter(l => String(l.type) === DISCOUNT_LINE)
    .reduce((n, l) => n + abs(l.total), 0);
  const voided = lines.filter(l => String(l.type) === VOID_LINE)
    .reduce((n, l) => n + abs(l.total), 0);

  const net = orderNet(order);
  const total = Number(order.total) || 0;
  const kept = total > 0 ? net / total : 1;

  const ticketMoney = Math.max(0, (gross - discount)) * kept;

  /* Per line, in proportion to what it cost before the code. */
  const byLine = new Map();
  for (const l of tickets) {
    const share = gross > 0 ? (Number(l.total) || 0) / gross : 0;
    byLine.set(l, Math.round(ticketMoney * share));
  }
  /* Rounding has to land somewhere, and it lands on the biggest line, so the
     parts still add up to the whole. */
  const allocated = [...byLine.values()].reduce((a, b) => a + b, 0);
  if (byLine.size && allocated !== Math.round(ticketMoney)) {
    let biggest = null;
    for (const [l, v] of byLine) if (!biggest || v > byLine.get(biggest)) biggest = l;
    byLine.set(biggest, byLine.get(biggest) + (Math.round(ticketMoney) - allocated));
  }

  return {
    gross, discount, voided, net,
    ticketMoney: Math.round(ticketMoney),
    other: net - Math.round(ticketMoney),
    byLine,
  };
}

/** A line that is a bundle rather than a plain ticket type. */
export const isBundleLine = line => /^bu_/.test(String(line && line.item_id || ''));

/* ------------------------------------------------------------- the counting */

const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

/**
 * Everything the page shows.
 *
 * Counts come from the issued tickets, which is the only complete list: a
 * pass issued through the API belongs to no order at all, so counting from
 * orders alone showed nought team passes however many had been approved.
 * Money comes from the orders, because that is where money is.
 *
 * A ticket is paid when somebody paid for it. A ticket of a paid type that
 * went out at nothing is complimentary and is counted on its own, because a
 * paid total that includes free tickets is not a paid total.
 */
export function aggregate(orders, tickets, {
  teamTypes, typeNames = {}, typePrices = {}, bundles = {},
} = {}) {
  const perDay = {};
  const perDayMoney = {};
  const byType = {};
  const bySource = {};
  const byCode = {};
  const groups = new Set();

  /* ---- the money, from the orders ---- */
  let revenue = 0, orderCount = 0, otherMoney = 0;
  let discountGiven = 0, bundleSaving = 0, refundedMoney = 0, lostToCancelled = 0;
  let bundleDeals = 0, bundlePeople = 0;

  const paidPerOrderType = new Map();   // `${orderId}|${typeId}` -> cents
  const orderDay = new Map();
  /* Orders that count for nothing. Ticket Tailor usually voids their tickets
     too, but a ticket whose order was cancelled must not quietly become a
     complimentary one just because nobody paid for it. */
  const deadOrders = new Set();

  for (const order of orders) {
    const id = String(order.id);
    if (!orderCounts(order)) {
      deadOrders.add(id);
      lostToCancelled += linesOf(order)
        .filter(l => String(l.type) === TICKET_LINE)
        .reduce((n, l) => n + (Number(l.total) || 0), 0);
      continue;
    }

    orderCount += 1;
    const m = orderMoney(order);
    revenue += m.net;
    otherMoney += m.other;
    discountGiven += m.discount;
    refundedMoney += Number(order.refund_amount) || 0;

    const day = brusselsDay(order.created_at);
    orderDay.set(id, day);
    bump(bySource, sourceOf(order.referral_tag));

    const code = String(order.discount_code
      || (order.discount && order.discount.code) || '').toUpperCase();
    if (code) bump(byCode, code);

    for (const [line, amount] of m.byLine) {
      const qty = Number(line.quantity) || 1;

      if (isBundleLine(line)) {
        const bundle = bundles[String(line.item_id)];
        bundleDeals += qty;
        /* What the deal contains, and what it would have cost one by one. */
        const inside = (bundle && bundle.ticket_types) || [];
        const heads = inside.reduce((n, t) => n + (Number(t.quantity) || 0), 0);
        bundlePeople += heads * qty;
        const list = inside.reduce((n, t) =>
          n + (Number(typePrices[t.id]) || 0) * (Number(t.quantity) || 0), 0) * qty;
        if (list) bundleSaving += Math.max(0, list - (Number(line.total) || 0));

        if (inside.length) {
          /* Split across what is in it, in proportion to list price. */
          for (const t of inside) {
            const w = list ? ((Number(typePrices[t.id]) || 0) * (Number(t.quantity) || 0) * qty) / list : 0;
            const part = Math.round(amount * w);
            addMoney(paidPerOrderType, id, t.id, part);
            touchType(byType, t.id, typeNames, typePrices, part);
          }
          continue;
        }
        /* An unknown bundle keeps its own row rather than being guessed at. */
        touchType(byType, String(line.item_id), typeNames, typePrices, amount,
          line.description || String(line.item_id));
        addMoney(paidPerOrderType, id, String(line.item_id), amount);
        continue;
      }

      const typeId = String(line.item_id || line.description || 'unknown');
      addMoney(paidPerOrderType, id, typeId, amount);
      touchType(byType, typeId, typeNames, typePrices, amount, line.description);
    }
  }

  /* ---- the counts, from the issued tickets ---- */
  let paid = 0, free = 0, team = 0, comp = 0, all = 0;
  let listGross = 0, compList = 0;

  for (const t of tickets) {
    if (!ticketCounts(t)) continue;
    if (deadOrders.has(String(t.order_id || ''))) continue;
    all += 1;

    const typeId = String(t.ticket_type_id || '');
    if (t.group_ticket_barcode) groups.add(String(t.group_ticket_barcode));

    if (teamTypes.has(typeId) || /^p_/.test(String(t.reference || ''))) { team += 1; continue; }

    const price = Number(typePrices[typeId]);
    if (Number.isFinite(price) && price === 0) { free += 1; continue; }

    /* Somebody paid for this one, or they did not. */
    const paidHere = moneyFor(paidPerOrderType, String(t.order_id || ''), typeId);
    listGross += Number.isFinite(price) ? price : 0;

    if (paidHere > 0) {
      paid += 1;
      const day = orderDay.get(String(t.order_id || ''));
      if (day) bump(perDay, day);
    } else {
      comp += 1;
      compList += Number.isFinite(price) ? price : 0;
    }
  }

  /* Money per day, from the orders that produced the paid tickets. */
  for (const order of orders) {
    if (!orderCounts(order)) continue;
    const day = brusselsDay(order.created_at);
    bump(perDayMoney, day, orderNet(order));
  }

  const types = Object.values(byType).map(t => ({
    ...t,
    kind: teamTypes.has(t.id) ? 'team'
      : (Number(typePrices[t.id]) === 0 ? 'free' : 'paid'),
  }));

  return {
    paid, free, team, comp, all,
    orders: orderCount,
    revenue,
    perDay,
    perDayMoney,
    byType: types.sort((a, b) => b.revenue - a.revenue),
    bySource,
    byCode,
    groups: { deals: bundleDeals, people: bundlePeople, groupBarcodes: groups.size },
    other: otherMoney,
    gap: {
      list: listGross,
      discounts: discountGiven,
      bundles: bundleSaving,
      complimentary: compList,
      refunds: refundedMoney,
      cancelled: lostToCancelled,
    },
  };
}

function touchType(byType, id, names, prices, amount, fallbackName) {
  byType[id] = byType[id] || {
    id,
    name: names[id] || fallbackName || id,
    price: prices[id] ?? null,
    sold: 0,
    revenue: 0,
  };
  byType[id].revenue += amount;
}

const addMoney = (map, orderId, typeId, amount) => {
  if (!orderId) return;
  const k = `${orderId}|${typeId}`;
  map.set(k, (map.get(k) || 0) + amount);
};
const moneyFor = (map, orderId, typeId) => map.get(`${orderId}|${typeId}`) || 0;

/** Tickets sold per type, counted from the issued tickets. */
export function soldByType(tickets) {
  const out = {};
  for (const t of tickets) {
    if (!ticketCounts(t)) continue;
    bump(out, String(t.ticket_type_id || 'unknown'));
  }
  return out;
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

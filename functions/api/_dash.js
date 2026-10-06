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

/* ------------------------------------------------------------- the counting */

const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

/**
 * Everything the page shows, from orders and ticket types.
 *
 * Group deals are read from `group_ticket_barcode`, which Ticket Tailor puts
 * on every issued ticket that is part of one. A deal is therefore a set of
 * individual tickets sharing a barcode: the people inside it are already
 * counted one by one in the paid total, and the number of deals is the number
 * of distinct barcodes. Nothing is inferred from a ticket type's name.
 */
export function aggregate(orders, { teamTypes, freeTypes, typeNames = {}, typePrices = {} } = {}) {
  const perDay = {};
  const byType = {};
  const bySource = {};
  const byCode = {};
  const groups = new Set();

  let paid = 0, free = 0, team = 0, all = 0;
  let revenue = 0, orderCount = 0;
  let groupPeople = 0;

  for (const order of orders) {
    if (!orderCounts(order)) continue;
    orderCount += 1;
    revenue += orderNet(order);
    bump(bySource, sourceOf(order.referral_tag));

    const day = brusselsDay(order.created_at);
    const tickets = (Array.isArray(order.issued_tickets) ? order.issued_tickets : [])
      .filter(ticketCounts);

    for (const t of tickets) {
      all += 1;
      const kind = classify(t, { teamTypes, freeTypes });
      const type = String(t.ticket_type_id || 'unknown');

      byType[type] = byType[type] || {
        id: type, name: typeNames[type] || type, price: typePrices[type] ?? null,
        sold: 0, revenue: 0, kind,
      };
      byType[type].sold += 1;

      if (t.group_ticket_barcode) { groups.add(String(t.group_ticket_barcode)); groupPeople += 1; }

      if (kind === 'team') { team += 1; continue; }
      if (kind === 'free') { free += 1; continue; }

      paid += 1;
      perDay[day] = (perDay[day] || 0) + 1;
      byType[type].revenue += Number(typePrices[type] ?? 0);
    }

    /* A code used on an order, for the top-codes list. The tag carries it
       only for a team link; a discount code is on the order itself. */
    const code = String(order.discount_code || (order.discount && order.discount.code) || '').toUpperCase();
    if (code) bump(byCode, code);
  }

  return {
    paid, free, team, all,
    orders: orderCount,
    revenue,
    perDay,
    byType: Object.values(byType).sort((a, b) => b.sold - a.sold),
    bySource,
    byCode,
    groups: { deals: groups.size, people: groupPeople },
  };
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
      return { name, revenue: revenueNames(env).includes(name.toLowerCase()) };
    }
  }
  for (const [name, tok] of Object.entries(viewers)) {
    if (safeEqual(String(tok), String(presented))) return { name, revenue: false };
  }
  return null;
}

export const revenueNames = env => String(env.DASH_REVENUE_USERS || 'ravi')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

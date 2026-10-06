/**
 * GET /api/dash   everything the dashboard shows, in one call
 *
 * Read only. It never writes to Ticket Tailor, Brevo, Meta or a person's
 * record, and the only thing it writes to KV is its own cached figures.
 *
 * Revenue is decided on the server and built into a different object: a
 * view-only token does not get the fields and hidden, it gets a response that
 * never had them. Hiding money in a payload is the same as sending it.
 */

import { json, safeEqual, listAll } from './_shared.js';
import { botKey } from './_bot.js';
import {
  TEAMS, tt, oneOf, allPeople, expectedFor, teamOf, ticketTypeFor, isDryId,
} from './_accred.js';
import {
  aggregate, lastDays, sumDays, brusselsDay, daysToGo, SOURCE_ORDER,
  checkInsByHour, festivalStarted, viewerFor, SHAPE_VERSION, isCurrentShape,
} from './_dash.js';
import { scrubSecret } from './_accred.js';

/* The keys carry the shape version. A cache written by an older deploy is a
   different object with the same name, and reading one is what turned a
   missing field into a 500 and a page that said "could not reach the
   server" about a server it had reached. */
const CACHE_KEY = `dash:figures:v${SHAPE_VERSION}`;
const STATE_KEY = `dash:state:v${SHAPE_VERSION}`;
const LOCAL_KEY = `dash:local:v${SHAPE_VERSION}`;
const REFRESH_KEY = 'dash:refreshed';
const CACHE_SECONDS = 5 * 60;
const LOCAL_CACHE_SECONDS = 15 * 60;
const REFRESH_EVERY_MS = 60 * 1000;
/* A rebuild from nothing, now and then, so an order refunded after it was
   first read is eventually noticed. Incremental fetching never revisits. */
const FULL_REBUILD_HOURS = 24;
const PAGE = 100;

/* The budget.
 *
 * A Worker is allowed a limited number of outbound fetches per request: 50 on
 * the free plan, 1000 on paid. The expensive loop is orders, so a build walks
 * at most this many pages and leaves a cursor behind; the next build carries
 * on from there. Ticket counts cost nothing extra at all now, because they
 * come off the ticket types in the same call that fetches their names.
 *
 * At 5,000 orders a cold start therefore takes three builds rather than one
 * long one, and every build stays inside about 25 fetches.
 */
const MAX_PAGES = 20;
const MAX_CHECKIN_PAGES = 5;

/* ------------------------------------------------------------- the fetching */

/**
 * Orders, newest page first, stopping at a timestamp we already have.
 *
 * Ticket Tailor pages with starting_after, so an incremental read asks for
 * everything created at or after the high-water mark and walks until the page
 * comes back short. With thousands of orders behind it, a refresh costs one
 * page rather than forty.
 */
/**
 * Every page of something, by id.
 *
 * The loop stops when a page comes back short, and also when a page brings
 * nothing new. The second condition is the one that matters: if the cursor is
 * ever ignored, the same page comes back for ever and the counts come out
 * multiplied by however many times round it went. Counting the same ticket
 * two hundred times is a worse failure than stopping early.
 */
async function fetchAll(env, path, query = {}, { after: start = '', max = MAX_PAGES } = {}) {
  const seen = new Set();
  const out = [];
  let after = start;
  let done = true;
  for (let page = 0; page < max; page++) {
    const r = await tt(env, path, {
      query: {
        limit: String(PAGE),
        event_id: env.TT_EVENT_ID || '',
        ...query,
        ...(after ? { starting_after: after } : {}),
      },
    });
    const rows = Array.isArray(r?.data) ? r.data : [];
    let added = 0;
    for (const row of rows) {
      const id = String(row && row.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(row);
      added += 1;
    }
    if (!added) {
      if (rows.length) console.warn('dash: pagination made no progress on', path);
      break;
    }
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].id;
    /* There is more, and this build has done its share of it. */
    if (page === max - 1) done = false;
  }
  out.cursor = after;
  out.done = done;
  return out;
}

const fetchOrders = (env, sinceUnix, after) => fetchAll(env, '/v1/orders', {
  ...(sinceUnix ? { 'created_at.gte': String(sinceUnix) } : {}),
}, { after, max: MAX_PAGES });

const fetchCheckIns = env => fetchAll(env, '/v1/check_ins', {}, { max: MAX_CHECKIN_PAGES });

/**
 * The deals the box office defines, for naming only.
 *
 * `/v1/event_series/{id}/bundles` has no GET at all: the documented methods
 * are create, update and delete, which is why asking for it answered 404.
 * The event series object itself carries a `bundles` list, so that is where
 * they are read from, in one call.
 *
 * Nothing is counted from these. Every figure comes from the order lines and
 * the order's own issued tickets, so a dashboard still counts correctly when
 * this call returns nothing at all.
 */
async function fetchDeals(env, seriesId) {
  if (!seriesId) return [];
  const r = await tt(env, `/v1/event_series/${encodeURIComponent(seriesId)}`);
  const series = oneOf(r) || {};
  const rows = Array.isArray(series.bundles) ? series.bundles : [];
  return rows.map(b => ({
    id: String(b.id), name: b.name || String(b.id),
    price: Number(b.price) || 0, status: b.status || '',
    heads: (b.ticket_types || []).reduce((n, t) => n + (Number(t.quantity) || 0), 0),
  }));
}

/** The event's ticket types: what each one is called and what it costs. */
async function fetchTypes(env) {
  const r = await tt(env, `/v1/events/${encodeURIComponent(env.TT_EVENT_ID || '')}`);
  const ev = oneOf(r) || {};
  const types = Array.isArray(ev.ticket_types) ? ev.ticket_types : [];
  const names = {}, prices = {};
  for (const t of types) {
    names[t.id] = t.name || t.id;
    prices[t.id] = Number(t.price) || 0;
  }
  /* `quantity_issued` is required on a ticket type, so how many of each
     exist arrives in the same call as what they are called. */
  const issued = {};
  for (const t of types) issued[t.id] = Number(t.quantity_issued) || 0;
  return {
    names, prices, types, issued,
    seriesId: ev.event_series_id || '',
    groups: ev.ticket_groups || [],
  };
}

/* ------------------------------------------------------------ the local half */

/** Team passes from ACCRED: approved against expected, and who is waiting. */
async function teamFigures(env) {
  const kv = env.ACCRED;
  if (!kv) return { teams: [], waiting: 0, codes: [] };

  const people = await allPeople(kv);
  const rows = [];
  for (const t of TEAMS) {
    const expected = Number(await expectedFor(kv, t.key));
    const mine = people.filter(p => p.team === t.key);
    rows.push({
      key: t.key,
      name: t.name.en,
      expected,
      approved: mine.filter(p => p.status === 'approved').length,
      waiting: mine.filter(p => p.status === 'pending' || p.status === 'approving').length,
    });
  }

  /* A first name beside a code, and nothing else about them. */
  const codes = people
    .filter(p => p.status === 'approved' && p.promo && p.promo.code && !isDryId(p.promo.discountId))
    .map(p => ({ first: p.firstName, code: p.promo.code }));

  return {
    teams: rows,
    waiting: rows.reduce((n, r) => n + r.waiting, 0),
    codes,
  };
}

/** The draw and the bot, read from the same keys their own dashboards read. */
async function localFigures(env, cacheKv) {
  const kv = env.REFERRALS;
  if (!kv) return null;

  /* These come from a few thousand KV reads and change slowly, so they keep
     their own entry with a longer life than the figures around them. */
  try {
    const held = cacheKv ? await cacheKv.get(LOCAL_KEY, 'json') : null;
    if (held && Date.now() - Date.parse(held.at || 0) < LOCAL_CACHE_SECONDS * 1000) {
      return held.value;
    }
  } catch { /* read it again, then */ }

  const [welcomeKeys, logKeys, unansweredKeys, escalationKeys] = await Promise.all([
    listAll(kv, botKey.welcome(''), 4000),
    listAll(kv, botKey.log(''), 4000),
    listAll(kv, botKey.unanswered(''), 1000),
    listAll(kv, 'bot:escalation:', 1000),
  ]);

  const wa = { sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const k of welcomeKeys) {
    const v = await kv.get(k, 'json');
    if (!v) continue;
    wa.sent += 1;
    const st = String(v.status || 'sent');
    if (st === 'delivered') wa.delivered += 1;
    if (st === 'read') { wa.delivered += 1; wa.read += 1; }
    if (st === 'failed') wa.failed += 1;
  }

  /* Buyers who brought a friend, and the entries behind them. */
  const refKeys = await listAll(kv, 'refcount:', 4000);
  let referrers = 0, referred = 0;
  for (const k of refKeys) {
    const n = Number(await kv.get(k)) || 0;
    if (n > 0) { referrers += 1; referred += n; }
  }

  const value = {
    wa: {
      ...wa,
      deliveredPercent: wa.sent ? Math.round((wa.delivered / wa.sent) * 100) : 0,
      conversations: logKeys.length,
      waiting: unansweredKeys.length + escalationKeys.length,
    },
    draw: { referrers, referred },
  };

  try {
    if (cacheKv) {
      await cacheKv.put(LOCAL_KEY, JSON.stringify({ at: new Date().toISOString(), value }),
        { expirationTtl: 3600 });
    }
  } catch { /* a cache that will not write is not a failure */ }

  return value;
}

/* ---------------------------------------------------------------- stages */

/**
 * Run one part of the build and say which one it was if it fails.
 *
 * Required stages stop the build; optional ones hand back a reason and the
 * page says that section is unavailable. A dashboard with no check-in figures
 * is still a dashboard; a dashboard that will not load because the check-in
 * endpoint had a bad minute is not.
 */
class StageError extends Error {
  constructor(stage, cause) {
    const status = Number(cause && cause.status) || 0;
    super(`${stage}: ${scrubSecret(String((cause && (cause.detail || cause.message)) || cause))}`);
    this.stage = stage;
    this.status = status;
    this.reason = scrubSecret(String((cause && (cause.detail || cause.message)) || cause)).slice(0, 300);
  }
}

async function required(stage, run) {
  try { return await run(); } catch (e) { throw new StageError(stage, e); }
}

async function optional(stage, run, fallback) {
  try { return { ok: true, value: await run() }; } catch (e) {
    const err = new StageError(stage, e);
    console.error('dash: optional stage failed', err.message);
    return { ok: false, value: fallback, stage, status: err.status, reason: err.reason };
  }
}

/* ----------------------------------------------------------------- handler */

export async function onRequestGet({ request, env }) {
  try {
    return await handle(request, env);
  } catch (e) {
    /* The last line of defence. Whatever happened, the answer is JSON with a
       stage and a reason on it, because an HTML error page from the platform
       reads to the browser as "could not reach the server" about a server it
       reached perfectly well. */
    const stage = e && e.stage ? e.stage : 'handler';
    const reason = scrubSecret(String((e && (e.reason || e.message)) || e)).slice(0, 300);
    console.error('dash: failed at', stage, reason);
    return json(200, {
      ok: false, stage, status: Number(e && e.status) || 0, reason, asOf: null,
    });
  }
}

async function handle(request, env) {
  if (!env.TEAM_ADMIN_TOKENS && !env.DASH_VIEW_TOKENS) {
    return json(503, { ok: false, stage: 'access', reason: 'not_configured' });
  }
  const who = viewerFor(env, request.headers.get('x-admin-token') || '', { safeEqual });
  if (!who) return json(401, { ok: false, stage: 'access', reason: 'unauthorised' });

  const kv = env.ACCRED || env.REFERRALS || null;
  const url = new URL(request.url);
  const wantsFresh = url.searchParams.get('refresh') === '1';
  const now = new Date();

  /* A cached object written by an older deploy is a different shape with the
     same name. It is dropped rather than read, which is the whole of the bug
     this guard exists for. */
  let cached = null;
  try { cached = kv ? await kv.get(CACHE_KEY, 'json') : null; } catch { /* no cache, no harm */ }
  if (cached && !isCurrentShape(cached)) {
    console.warn('dash: cached figures are an older shape, ignored');
    cached = null;
  }

  let lastRefresh = 0;
  try { lastRefresh = Number(kv ? await kv.get(REFRESH_KEY) : 0) || 0; } catch { /* none */ }
  const tooSoon = cached && wantsFresh && Date.now() - lastRefresh < REFRESH_EVERY_MS;
  const fresh = cached && !wantsFresh
    && Date.now() - Date.parse(cached.at || 0) < CACHE_SECONDS * 1000;

  if (cached && (fresh || tooSoon)) {
    return json(200, shape(cached, who, { now, cached: true, tooSoon }));
  }

  if (wantsFresh && kv) {
    try { await kv.put(REFRESH_KEY, String(Date.now()), { expirationTtl: 3600 }); }
    catch { /* the limiter is a courtesy, not a lock */ }
  }

  let figures;
  try {
    figures = await build(env, kv, now);
  } catch (e) {
    const stage = e && e.stage ? e.stage : 'build';
    const reason = scrubSecret(String((e && (e.reason || e.message)) || e)).slice(0, 300);
    const status = Number(e && e.status) || 0;
    console.error('dash: build failed at', stage, reason);

    if (cached) {
      /* The last figures we had, with the time they were true, and a line
         saying so. Never zeros: a dashboard showing nothing sold is a worse
         lie than one admitting it is out of date. */
      return json(200, shape(cached, who, {
        now, cached: true, stale: true, stage, status,
        error: `Ticket Tailor could not be reached (${stage}). These are the last figures we have.`,
      }));
    }
    return json(200, {
      ok: false, stage, status, reason, asOf: null,
      error: 'Ticket Tailor could not be reached, and there are no earlier figures to show.',
    });
  }

  try { if (kv) await kv.put(CACHE_KEY, JSON.stringify(figures), { expirationTtl: 3600 }); }
  catch (e) { console.error('dash: cache write failed', String(e).slice(0, 120)); }

  return json(200, shape(figures, who, { now }));
}

/* --------------------------------------------------------------- the build */

async function build(env, kv, now) {
  const teamTypes = new Set(TEAMS.map(t => ticketTypeFor(env, t.key)).filter(Boolean));

  /* Required: without the types there is nothing to name and nothing to
     price, and without the orders there is no money. */
  const { names, prices, types, issued, seriesId, groups } =
    await required('types', () => fetchTypes(env));

  let state = null;
  try { state = kv ? await kv.get(STATE_KEY, 'json') : null; } catch { /* rebuild */ }
  const staleState = !state || !state.at
    || Date.now() - Date.parse(state.at) > FULL_REBUILD_HOURS * 3600 * 1000;

  const since = staleState ? 0 : Number(state.highWater) || 0;
  const startAfter = staleState ? '' : String(state.cursor || '');
  const fetched = await required('orders', () => fetchOrders(env, since, startAfter));

  const kept = staleState && !startAfter ? [...fetched] : [...(state && state.orders) || [], ...fetched];
  const byId = new Map();
  for (const o of kept) byId.set(String(o.id), slimOrder(o));
  const all = [...byId.values()];
  const highWater = all.reduce((n, o) => Math.max(n, Number(o.created_at) || 0), 0);

  /* Optional: a bad minute on either of these must not cost the whole page. */
  /* Names only, and the page works without them. */
  const dealsStage = await optional('deals', () => fetchDeals(env, seriesId), []);

  const agg = aggregate(all, issued, { teamTypes, typeNames: names, typePrices: prices });

  let checkIns = { available: false, byDay: null, error: 'not read yet' };
  const ciStage = await optional('check-ins', async () => {
    const rows = await fetchCheckIns(env);
    /* Which side of the gate each scanned ticket is. Only the tickets that
       were actually scanned need looking up, which on any day before the
       festival is none at all. */
    const kind = {};
    for (const c of rows) kind[String(c.issued_ticket_id)] = 'public';
    return checkInsByHour(rows, kind);
  }, null);
  checkIns = ciStage.ok
    ? { available: true, byDay: ciStage.value, error: '' }
    : { available: false, byDay: null, error: ciStage.reason };

  const teamStage = await optional('team', () => teamFigures(env), { teams: [], waiting: 0, codes: [] });
  const localStage = await optional('local', () => localFigures(env, kv), null);

  try {
    if (kv) {
      await kv.put(STATE_KEY, JSON.stringify({
        at: now.toISOString(),
        highWater,
        cursor: fetched.done ? '' : fetched.cursor,
        orders: all,
      }), { expirationTtl: 3 * 24 * 3600 });
    }
  } catch (e) { console.error('dash: state write failed', String(e).slice(0, 120)); }

  return {
    version: SHAPE_VERSION,
    at: now.toISOString(),
    agg,
    types: types.map(t => ({ id: t.id, name: t.name, price: Number(t.price) || 0 })),
    deals: dealsStage.value,
    ticketGroups: (groups || []).map(g => ({ id: g.id, name: g.name })),
    checkIns,
    team: teamStage.value,
    local: localStage.value,
    /* More orders to walk than one build is allowed, so the next one carries
       on. Said out loud rather than quietly showing a short total. */
    catchingUp: !fetched.done,
    degraded: [dealsStage, ciStage, teamStage, localStage]
      .filter(x => !x.ok)
      .map(x => ({ stage: x.stage, status: x.status, reason: x.reason })),
  };
}

/* Only the fields the arithmetic reads. A cached state holding whole orders
   is a KV value that grows without limit and a payload nobody needs. */
function slimOrder(o) {
  return {
    id: String(o.id),
    status: o.status,
    total: Number(o.total) || 0,
    refund_amount: Number(o.refund_amount) || 0,
    created_at: Number(o.created_at) || 0,
    referral_tag: o.referral_tag || '',
    discount_code: o.discount_code || (o.discount && o.discount.code) || '',
    line_items: (Array.isArray(o.line_items) ? o.line_items : []).map(l => ({
      type: l.type, item_id: l.item_id || null, description: l.description || '',
      quantity: Number(l.quantity) || 1, total: Number(l.total) || 0,
    })),
    /* The order carries its own issued tickets, so who came in on a deal
       costs no extra call. Two fields of each, which is all that is read. */
    issued_tickets: (Array.isArray(o.issued_tickets) ? o.issued_tickets : []).map(t => ({
      id: String(t.id), ticket_type_id: String(t.ticket_type_id || ''),
      ...(t.voided_at ? { voided_at: t.voided_at } : {}),
      ...(t.status ? { status: t.status } : {}),
    })),
  };
}

/* -------------------------------------------------------------- the shaping */

/**
 * The payload, built for this viewer.
 *
 * The revenue fields are added rather than removed: a view-only token gets an
 * object that never carried them, so there is nothing to leak in a log, a
 * cache or a console.
 */
function shape(f, who, { now, cached = false, stale = false, tooSoon = false, error = '', stage = '', status = 0 } = {}) {
  const agg = f.agg;
  const sec = Math.floor(now.getTime() / 1000);
  const today = brusselsDay(sec);
  const yesterday = brusselsDay(sec - 86400);
  const last7 = lastDays(7, now);

  const period = (key, label, days) => ({
    key, label,
    paid: sumDays(agg.perDay, days),
    all: sumDays(agg.perDayAll, days),
    orders: sumDays(agg.perDayOrders, days),
  });

  const paidTypes = agg.byType.filter(t => t.kind === 'paid');
  const otherTypes = agg.byType.filter(t => t.kind !== 'paid');

  const out = {
    ok: true,
    viewer: { name: who.name, revenue: who.revenue, admin: Boolean(who.admin) },
    asOf: f.at,
    cached,
    stale,
    note: error || (tooSoon ? 'Refreshed a moment ago. These are the same figures.' : ''),
    stage,
    status,
    catchingUp: Boolean(f.catchingUp),
    degraded: f.degraded || [],
    daysToGo: daysToGo(now),

    headline: { paid: agg.paid },
    periods: [
      period('today', 'Today', [today]),
      period('yesterday', 'Yesterday', [yesterday]),
      period('last7', 'Last 7 days', last7),
    ],

    small: {
      free: agg.free,
      comp: agg.comp,
      team: agg.team,
      teamApproved: (f.team.teams || []).reduce((n, t) => n + t.approved, 0),
      teamExpected: (f.team.teams || []).reduce((n, t) => n + t.expected, 0),
      all: agg.all,
    },

    deals: {
      sold: agg.groups.deals,
      people: agg.groups.people,
      rows: agg.byDeal.map(d => ({ name: d.name, deals: d.deals, people: d.people })),
      /* What the box office defines, for naming only. Nothing is counted
         from it, so an empty list means nothing is wrong. */
      defined: (f.deals || []).map(d => ({ name: d.name, status: d.status })),
    },

    perDay: Object.fromEntries(lastDays(14, now).map(d => [d, agg.perDay[d] || 0])),
    byType: paidTypes.map(t => ({ id: t.id, name: t.name, price: t.price, sold: t.sold })),
    otherTypes: otherTypes.map(t => ({
      id: t.id, name: t.name, price: t.price, sold: t.issued, kind: t.kind,
    })),
    complimentary: agg.comp,

    bySource: SOURCE_ORDER.map(k => ({ key: k, orders: agg.bySource[k] || 0 })),
    team: f.team.teams,
    waiting: f.team.waiting,
    topCodes: topCodes(agg.byCode, f.team.codes),
    draw: (f.local && f.local.draw) || null,
    wa: (f.local && f.local.wa) || null,
    checkIns: f.checkIns && f.checkIns.byDay
      ? { available: true, started: festivalStarted(now), byDay: f.checkIns.byDay }
      : { available: false, started: festivalStarted(now), why: (f.checkIns && f.checkIns.error) || '' },
  };

  if (who.revenue) {
    out.headline.revenue = agg.revenue;
    out.revenue = { total: agg.revenue, orders: agg.orders };

    const money = days => days.reduce((n, d) => n + (agg.perDayMoney[d] || 0), 0);
    out.periods[0].revenue = money([today]);
    out.periods[1].revenue = money([yesterday]);
    out.periods[2].revenue = money(last7);

    const byId = Object.fromEntries(agg.byType.map(t => [t.id, t.revenue]));
    out.byType = out.byType.map(t => ({ ...t, revenue: byId[t.id] || 0 }));
    out.otherTypes = out.otherTypes.map(t => ({ ...t, revenue: byId[t.id] || 0 }));
    out.deals.rows = agg.byDeal.map(d => ({
      name: d.name, deals: d.deals, people: d.people, revenue: d.revenue,
    }));

    /* Single tickets, plus the deals, plus the fees, is the headline. */
    const singles = out.byType.reduce((n, t) => n + t.revenue, 0);
    const dealMoney = agg.byDeal.reduce((n, d) => n + d.revenue, 0);
    out.reconcile = {
      singles,
      deals: dealMoney,
      /* Only real fee, tax and donation lines. */
      fees: agg.fees,
      total: agg.revenue,
      /* Nothing should be left, and if something is it gets said. */
      unexplained: agg.revenue - singles - dealMoney - agg.fees,
    };

    const g = agg.gap;
    out.gap = {
      list: g.list,
      discounts: g.discounts,
      complimentary: g.complimentary,
      refunds: g.refunds,
      cancelled: g.cancelled,
      received: agg.revenue,
    };
  }
  return out;
}

/** The five codes that sold the most, with the first name beside each. */
function topCodes(byCode, people) {
  const name = Object.fromEntries((people || []).map(p => [p.code, p.first]));
  return Object.entries(byCode)
    .filter(([code]) => name[code])
    .map(([code, orders]) => ({ code, first: name[code], orders }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 5);
}

export const onRequestPost = () => json(405, { ok: false, error: 'method_not_allowed' });

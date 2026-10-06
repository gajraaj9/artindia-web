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
  checkInsByHour, festivalStarted, viewerFor,
} from './_dash.js';

const CACHE_KEY = 'dash:figures';
const STATE_KEY = 'dash:state';
const REFRESH_KEY = 'dash:refreshed';
const CACHE_SECONDS = 5 * 60;
const REFRESH_EVERY_MS = 60 * 1000;
/* A rebuild from nothing, now and then, so an order refunded after it was
   first read is eventually noticed. Incremental fetching never revisits. */
const FULL_REBUILD_HOURS = 24;
const PAGE = 100;
const MAX_PAGES = 200;

/* ------------------------------------------------------------- the fetching */

/**
 * Orders, newest page first, stopping at a timestamp we already have.
 *
 * Ticket Tailor pages with starting_after, so an incremental read asks for
 * everything created at or after the high-water mark and walks until the page
 * comes back short. With thousands of orders behind it, a refresh costs one
 * page rather than forty.
 */
async function fetchOrders(env, sinceUnix) {
  const out = [];
  let after = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await tt(env, '/v1/orders', {
      query: {
        limit: String(PAGE),
        event_id: env.TT_EVENT_ID || '',
        ...(sinceUnix ? { 'created_at.gte': String(sinceUnix) } : {}),
        ...(after ? { starting_after: after } : {}),
      },
    });
    const rows = Array.isArray(r?.data) ? r.data : [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].id;
  }
  return out;
}

async function fetchCheckIns(env) {
  const out = [];
  let after = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await tt(env, '/v1/check_ins', {
      query: {
        limit: String(PAGE),
        event_id: env.TT_EVENT_ID || '',
        ...(after ? { starting_after: after } : {}),
      },
    });
    const rows = Array.isArray(r?.data) ? r.data : [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].id;
  }
  return out;
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
  return { names, prices, types };
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
async function localFigures(env) {
  const kv = env.REFERRALS;
  if (!kv) return null;

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

  return {
    wa: {
      ...wa,
      deliveredPercent: wa.sent ? Math.round((wa.delivered / wa.sent) * 100) : 0,
      conversations: logKeys.length,
      waiting: unansweredKeys.length + escalationKeys.length,
    },
    draw: { referrers, referred },
  };
}

/* ----------------------------------------------------------------- handler */

export async function onRequestGet({ request, env }) {
  if (!env.TEAM_ADMIN_TOKENS && !env.DASH_VIEW_TOKENS) {
    return json(503, { ok: false, error: 'not_configured' });
  }
  const who = viewerFor(env, request.headers.get('x-admin-token') || '', { safeEqual });
  if (!who) return json(401, { ok: false, error: 'unauthorised' });

  const kv = env.ACCRED || env.REFERRALS || null;
  const url = new URL(request.url);
  const wantsFresh = url.searchParams.get('refresh') === '1';
  const now = new Date();

  let cached = null;
  try { cached = kv ? await kv.get(CACHE_KEY, 'json') : null; } catch { /* no cache, no harm */ }

  /* Refresh is allowed once a minute, counted from the last refresh and not
     from the last build: a page that has been sitting on five-minute-old
     figures can still be refreshed at once. More often than a minute and it is
     a finger on a button, not a question anybody has. */
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
    console.error('dash: build failed', String(e).slice(0, 200));
    if (cached) {
      /* The last figures we had, with the time they were true, and a line
         saying so. Never zeros: a dashboard showing nothing sold is a worse
         lie than a dashboard admitting it is out of date. */
      return json(200, shape(cached, who, {
        now, cached: true, stale: true,
        error: 'Ticket Tailor could not be reached. These are the last figures we have.',
      }));
    }
    return json(200, {
      ok: false,
      error: 'Ticket Tailor could not be reached, and there are no earlier figures to show.',
      asOf: null,
    });
  }

  try { if (kv) await kv.put(CACHE_KEY, JSON.stringify(figures), { expirationTtl: 3600 }); }
  catch (e) { console.error('dash: cache write failed', String(e).slice(0, 120)); }

  return json(200, shape(figures, who, { now }));
}

/* --------------------------------------------------------------- the build */

async function build(env, kv, now) {
  const teamTypes = new Set(TEAMS.map(t => ticketTypeFor(env, t.key)).filter(Boolean));

  const { names, prices, types } = await fetchTypes(env);
  const freeTypes = new Set(Object.entries(prices)
    .filter(([id, p]) => Number(p) === 0 && !teamTypes.has(id)).map(([id]) => id));

  /* Incremental, with a rebuild from nothing now and then so a refund that
     landed on an old order is eventually seen. */
  let state = null;
  try { state = kv ? await kv.get(STATE_KEY, 'json') : null; } catch { /* rebuild */ }
  const stale = !state || !state.at
    || Date.now() - Date.parse(state.at) > FULL_REBUILD_HOURS * 3600 * 1000;

  const since = stale ? 0 : Number(state.highWater) || 0;
  const orders = await fetchOrders(env, since);

  const kept = stale ? orders : [...(state.orders || []), ...orders];
  /* One row per order id, newest wins, so a re-read of the boundary order
     replaces it rather than counting it twice. */
  const byId = new Map();
  for (const o of kept) byId.set(String(o.id), o);
  const all = [...byId.values()];
  const highWater = all.reduce((n, o) => Math.max(n, Number(o.created_at) || 0), 0);

  const agg = aggregate(all, { teamTypes, freeTypes, typeNames: names, typePrices: prices });

  /* Check-ins, and which side of the gate each ticket is. */
  let checkIns = { available: true, byDay: null, error: '' };
  try {
    const rows = await fetchCheckIns(env);
    const kind = {};
    for (const o of all) {
      for (const t of (o.issued_tickets || [])) {
        kind[String(t.id)] = (teamTypes.has(String(t.ticket_type_id))
          || /^p_/.test(String(t.reference || ''))) ? 'team' : 'public';
      }
    }
    checkIns.byDay = checkInsByHour(rows, kind);
  } catch (e) {
    checkIns = { available: false, byDay: null, error: String(e.message || e).slice(0, 200) };
  }

  const team = await teamFigures(env);
  const local = await localFigures(env);

  try {
    if (kv) {
      await kv.put(STATE_KEY, JSON.stringify({
        at: now.toISOString(), highWater, orders: all,
      }), { expirationTtl: 3 * 24 * 3600 });
    }
  } catch (e) { console.error('dash: state write failed', String(e).slice(0, 120)); }

  return {
    at: now.toISOString(),
    agg,
    types: types.map(t => ({ id: t.id, name: t.name, price: Number(t.price) || 0 })),
    checkIns,
    team,
    local,
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
function shape(f, who, { now, cached = false, stale = false, tooSoon = false, error = '' } = {}) {
  const agg = f.agg;
  const today = brusselsDay(Math.floor(now.getTime() / 1000));
  const yesterday = brusselsDay(Math.floor(now.getTime() / 1000) - 86400);
  const last7 = lastDays(7, now);
  const prev7 = lastDays(14, now).slice(0, 7);

  const out = {
    ok: true,
    viewer: { name: who.name, revenue: who.revenue },
    asOf: f.at,
    cached,
    stale,
    note: error || (tooSoon ? 'Refreshed a moment ago. These are the same figures.' : ''),
    daysToGo: daysToGo(now),
    headline: {
      paid: agg.paid,
      today: agg.perDay[today] || 0,
      yesterday: agg.perDay[yesterday] || 0,
      last7: sumDays(agg.perDay, last7),
      prev7: sumDays(agg.perDay, prev7),
    },
    small: {
      free: agg.free,
      team: agg.team,
      teamExpected: (f.team.teams || []).reduce((n, t) => n + t.expected, 0),
      all: agg.all,
    },
    groups: agg.groups,
    perDay: Object.fromEntries(lastDays(14, now).map(d => [d, agg.perDay[d] || 0])),
    byType: agg.byType.map(t => ({ id: t.id, name: t.name, price: t.price, sold: t.sold, kind: t.kind })),
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
    out.revenue = { total: agg.revenue, orders: agg.orders };
    out.byType = out.byType.map(t => ({
      ...t,
      revenue: (agg.byType.find(x => x.id === t.id) || {}).revenue || 0,
    }));
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

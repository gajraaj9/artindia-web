/**
 * GET /api/funnel?days=<n>      the measurement layer, in one call
 *
 * Visits from Cloudflare Web Analytics, clicks from the /go/buy counters,
 * orders from the Ticket Tailor webhook's own counters, and the ratios
 * between them. Everything is aggregate: no visitor is identified anywhere in
 * here, which is the whole point of measuring without cookies.
 *
 *   curl -H "X-Admin-Token: $WA_ADMIN_TOKEN" \
 *     'https://diwali.artindia.be/api/funnel?days=7'
 *
 * Env:
 *   WA_ADMIN_TOKEN      guards this, as it guards the rest of /admin
 *   CF_ACCOUNT_ID       Cloudflare account id
 *   CF_ANALYTICS_TOKEN  API token with Account -> Account Analytics -> Read
 *   CF_WA_SITE_TAG      optional. The Web Analytics site tag, which is the
 *                       token already printed in the page's beacon tag
 *
 * Without the two CF_ vars the visit numbers come back null and everything
 * else still works, because the clicks and the orders are ours.
 */

import { json, safeEqual, listAll } from './_shared.js';

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
/* The site tag is not a secret: it is printed in every page's beacon tag. */
const DEFAULT_SITE_TAG = 'c77e9f296e564f32b4b427bea8c78e87';

const dayString = d => d.toISOString().slice(0, 10);

function daysBack(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(dayString(new Date(Date.now() - i * 86400000)));
  }
  return out;
}

/**
 * Web Analytics, over the GraphQL analytics API.
 *
 * Two groupings in one request: one by day for the totals, one by referrer
 * host for where they came from. Failure is not fatal; the funnel still has
 * its own two thirds.
 */
async function visits(env, since, until) {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
    return { ok: false, reason: 'not_configured' };
  }
  const siteTag = env.CF_WA_SITE_TAG || DEFAULT_SITE_TAG;
  const query = `
    query Funnel($account: String!, $siteTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          byDay: rumPageloadEventsAdaptiveGroups(
            limit: 100
            orderBy: [date_ASC]
            filter: { siteTag: $siteTag, datetime_geq: $since, datetime_leq: $until }
          ) {
            count
            uniq { uniques }
            dimensions { date }
          }
          byReferrer: rumPageloadEventsAdaptiveGroups(
            limit: 25
            orderBy: [count_DESC]
            filter: { siteTag: $siteTag, datetime_geq: $since, datetime_leq: $until }
          ) {
            count
            dimensions { refererHost }
          }
        }
      }
    }`;

  try {
    const res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { account: env.CF_ACCOUNT_ID, siteTag, since, until },
      }),
    });
    const body = await res.json();
    if (!res.ok || (body.errors && body.errors.length)) {
      console.error('funnel: web analytics query failed', res.status, JSON.stringify(body.errors || body).slice(0, 400));
      return { ok: false, reason: 'query_failed', detail: (body.errors || [])[0] };
    }
    const account = (((body.data || {}).viewer || {}).accounts || [])[0] || {};
    const byDay = (account.byDay || []).map(r => ({
      date: r.dimensions.date,
      views: r.count,
      visitors: (r.uniq && r.uniq.uniques) || 0,
    }));
    return {
      ok: true,
      by_day: byDay,
      views: byDay.reduce((n, r) => n + r.views, 0),
      visitors: byDay.reduce((n, r) => n + r.visitors, 0),
      referrers: (account.byReferrer || []).map(r => ({
        host: r.dimensions.refererHost || '(direct)',
        views: r.count,
      })),
    };
  } catch (e) {
    console.error('funnel: web analytics threw', String(e));
    return { ok: false, reason: 'unreachable' };
  }
}

/* clicks:<date>:<cta>:<lang>:<source> -> a count. */
async function clicks(kv, days) {
  const keys = await listAll(kv, 'clicks:', 5000);
  const wanted = new Set(days);
  const rows = [];
  for (let i = 0; i < keys.length; i += 20) {
    const batch = keys.slice(i, i + 20);
    const values = await Promise.all(batch.map(k => kv.get(k).catch(() => null)));
    batch.forEach((k, n) => {
      const [, date, cta, lang, source] = k.split(':');
      if (!wanted.has(date)) return;
      rows.push({ date, cta, lang, source, count: Number(values[n]) || 0 });
    });
  }
  return rows;
}

/* orders:<date>:<class> -> a count. */
async function orders(kv, days) {
  const keys = await listAll(kv, 'orders:', 2000);
  const wanted = new Set(days);
  const rows = [];
  for (let i = 0; i < keys.length; i += 20) {
    const batch = keys.slice(i, i + 20);
    const values = await Promise.all(batch.map(k => kv.get(k).catch(() => null)));
    batch.forEach((k, n) => {
      const [, date, cls] = k.split(':');
      if (!wanted.has(date)) return;
      rows.push({ date, tag: cls, count: Number(values[n]) || 0 });
    });
  }
  return rows;
}

const sum = (rows, pick) => rows.reduce((n, r) => n + (pick ? (pick(r) ? r.count : 0) : r.count), 0);

function group(rows, key) {
  const out = {};
  for (const r of rows) {
    const k = r[key] || '(none)';
    out[k] = (out[k] || 0) + r.count;
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

export async function onRequestGet({ request, env }) {
  if (!env.WA_ADMIN_TOKEN) {
    console.error('funnel: WA_ADMIN_TOKEN unset, refusing every request');
    return json(503, { ok: false, error: 'not_configured' });
  }
  if (!safeEqual(request.headers.get('x-admin-token') || '', env.WA_ADMIN_TOKEN)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  if (!env.REFERRALS) return json(503, { ok: false, error: 'kv_not_bound' });

  const q = new URL(request.url).searchParams;
  const days = Math.min(90, Math.max(1, Number(q.get('days')) || 7));
  const window = daysBack(days);
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
  const until = new Date().toISOString();

  let clickRows, orderRows, visitData;
  try {
    [clickRows, orderRows, visitData] = await Promise.all([
      clicks(env.REFERRALS, window),
      orders(env.REFERRALS, window),
      visits(env, since, until),
    ]);
  } catch (e) {
    console.error('funnel: read failed', String(e));
    return json(500, { ok: false, error: 'read_failed' });
  }

  const totalClicks = sum(clickRows);
  const totalOrders = sum(orderRows);
  const totalVisits = visitData.ok ? visitData.views : null;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

  return json(200, {
    ok: true,
    days,
    generated_at: new Date().toISOString(),
    visits: visitData,
    clicks: {
      total: totalClicks,
      by_cta: group(clickRows, 'cta'),
      by_lang: group(clickRows, 'lang'),
      by_source: group(clickRows, 'source'),
      rows: clickRows.sort((a, b) => (a.date < b.date ? 1 : -1)),
    },
    orders: {
      total: totalOrders,
      tagged: sum(orderRows, r => r.tag !== 'untagged'),
      untagged: sum(orderRows, r => r.tag === 'untagged'),
      by_tag: group(orderRows, 'tag'),
    },
    ratios: {
      clicks_per_visit: pct(totalClicks, totalVisits),
      orders_per_click: pct(totalOrders, totalClicks),
      orders_per_visit: pct(totalOrders, totalVisits),
    },
  });
}

export const onRequestPost = () => json(405, { ok: false, error: 'method_not_allowed' });

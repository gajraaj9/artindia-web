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

import { json, safeEqual, listAll, CLICK_BLOBS } from './_shared.js';

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const SITE_HOST = 'diwali.artindia.be';

/* The beacon token in the page and the site tag the analytics API wants are
   two different identifiers. Using the beacon token here returned an empty
   result with no error for as long as it took to notice. So the tag is
   discovered from the data instead: ask which site tags have pageloads for
   this hostname and take that one. Cached per isolate; CF_WA_SITE_TAG still
   overrides if it ever needs pinning. */
let siteTagCache = null;

async function ask(env, query, variables) {
  const r = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

async function resolveSiteTag(env) {
  if (env.CF_WA_SITE_TAG) return env.CF_WA_SITE_TAG;
  if (siteTagCache) return siteTagCache;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const body = await ask(env, `
    query($account:String!,$since:Time!){viewer{accounts(filter:{accountTag:$account}){
      rumPageloadEventsAdaptiveGroups(limit:50, orderBy:[count_DESC],
        filter:{datetime_geq:$since}){ count dimensions{ siteTag requestHost } }}}}`,
    { account: env.CF_ACCOUNT_ID, since });
  if (body.errors && body.errors.length) {
    console.error('funnel: site tag lookup failed', JSON.stringify(body.errors).slice(0, 300));
    return '';
  }
  const rows = (((body.data || {}).viewer || {}).accounts || [])[0];
  const groups = (rows && rows.rumPageloadEventsAdaptiveGroups) || [];
  const mine = groups.find(g => (g.dimensions.requestHost || '') === SITE_HOST);
  siteTagCache = (mine && mine.dimensions.siteTag) || '';
  if (!siteTagCache) console.warn('funnel: no site tag found for', SITE_HOST);
  else console.log('funnel: site tag for', SITE_HOST, 'is', siteTagCache);
  return siteTagCache;
}

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
  const siteTag = await resolveSiteTag(env);
  if (!siteTag) return { ok: false, reason: 'no_site_tag' };
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
            sum { visits }
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
    const body = await ask(env, query, { account: env.CF_ACCOUNT_ID, siteTag, since, until });
    if (body.errors && body.errors.length) {
      console.error('funnel: web analytics query failed', JSON.stringify(body.errors).slice(0, 400));
      return { ok: false, reason: 'query_failed', detail: body.errors[0] };
    }
    const account = (((body.data || {}).viewer || {}).accounts || [])[0] || {};
    /* count is page views; sum.visits is Cloudflare's visit count, which is
       the closest this dataset gets to unique visitors and is what the Web
       Analytics dashboard itself shows. */
    const byDay = (account.byDay || []).map(r => ({
      date: r.dimensions.date,
      views: r.count,
      visitors: (r.sum && r.sum.visits) || 0,
    }));
    return {
      ok: true,
      site_tag: siteTag,
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

/* ---------------------------------------------------------- analytics engine */

const SQL_API = account =>
  `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`;

/** One SQL query against the click dataset. Null when it cannot be run. */
async function sql(env, query) {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null;
  try {
    const r = await fetch(SQL_API(env.CF_ACCOUNT_ID), {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
      body: query,
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('funnel: sql failed', r.status, text.slice(0, 300));
      return null;
    }
    return JSON.parse(text);
  } catch (e) {
    console.error('funnel: sql threw', String(e));
    return null;
  }
}

const DATASET = 'diwali_clicks';
/* blob1..blobN in the order logClick writes them. */
const col = name => `blob${CLICK_BLOBS.indexOf(name) + 1}`;

/**
 * Clicks out of the dataset rather than the KV counters.
 *
 * Analytics Engine samples under load, so a row stands for _sample_interval
 * clicks and summing that is the unbiased count. Returns null when the
 * dataset cannot be read, and the caller falls back to KV.
 */
async function clicksFromAE(env, days) {
  const body = await sql(env, `
    SELECT toDate(timestamp) AS date,
           ${col('cta')} AS cta,
           ${col('lang')} AS lang,
           ${col('utm_source')} AS source,
           SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY date, cta, lang, source
    ORDER BY date DESC
    LIMIT 1000`);
  if (!body || !Array.isArray(body.data)) return null;
  return body.data.map(r => ({
    date: String(r.date).slice(0, 10),
    cta: r.cta || 'unknown',
    lang: r.lang || 'xx',
    source: r.source || 'direct',
    count: Number(r.count) || 0,
  }));
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

  /* ?rows=1 shows the last few rows exactly as the dataset holds them. */
  if (q.get('rows')) {
    const body = await sql(env, `
      SELECT timestamp, ${CLICK_BLOBS.map((n, i) => `blob${i + 1} AS ${n}`).join(', ')},
             _sample_interval
      FROM ${DATASET}
      WHERE timestamp >= NOW() - INTERVAL '1' DAY
      ORDER BY timestamp DESC
      LIMIT ${Math.min(50, Math.max(1, Number(q.get('rows')) || 10))}`);
    if (!body) return json(503, { ok: false, error: 'dataset_unreadable' });
    return json(200, { ok: true, dataset: DATASET, rows: body.data, meta: body.meta });
  }

  const days = Math.min(90, Math.max(1, Number(q.get('days')) || 7));
  const window = daysBack(days);
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
  const until = new Date().toISOString();

  let clickRows, orderRows, visitData, clickSource;
  try {
    let fromAE;
    [fromAE, orderRows, visitData] = await Promise.all([
      clicksFromAE(env, days),
      orders(env.REFERRALS, window),
      visits(env, since, until),
    ]);
    /* The dataset is the source of truth once it is bound: KV stops being
       written the moment it is, so reading KV would quietly show zero. */
    clickRows = fromAE || await clicks(env.REFERRALS, window);
    clickSource = fromAE ? 'analytics_engine' : 'kv';
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
      source: clickSource,
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

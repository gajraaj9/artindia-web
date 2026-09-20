/**
 * GET /api/wa-unanswered?since=<ISO>
 *
 * Everything the bot could not answer, and everyone who asked for a person —
 * newest first. This is the list the FAQ grows from: a question that shows up
 * here three times is a question docs/faq.md is missing.
 *
 *   curl -H "X-Admin-Token: $WA_ADMIN_TOKEN" \
 *     'https://diwali.artindia.be/api/wa-unanswered?since=2026-09-20'
 *
 * Add &format=text for a list you can read in a terminal; the JSON carries the
 * same thing under "text".
 *
 * Env: WA_ADMIN_TOKEN. Needs the REFERRALS KV binding.
 */

import { json, safeEqual } from './_shared.js';
import { botKey } from './_bot.js';

const plain = (status, body) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });

/* The keys are `<prefix><ISO timestamp>-<counter>`, so they sort by time on
   their own and a prefix scan comes back in order without reading any values. */
async function collect(kv, prefix, kind, since) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) {
      const at = k.name.slice(prefix.length);
      if (since && at < since) continue;
      out.push({ key: k.name, at, kind });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

export async function onRequestGet({ request, env }) {
  if (!env.WA_ADMIN_TOKEN) {
    console.error('wa-unanswered: WA_ADMIN_TOKEN unset, refusing every request');
    return json(503, { ok: false, error: 'not_configured' });
  }
  if (!safeEqual(request.headers.get('x-admin-token') || '', env.WA_ADMIN_TOKEN)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  if (!env.REFERRALS) return json(503, { ok: false, error: 'kv_not_bound' });

  const q = new URL(request.url).searchParams;
  const since = (q.get('since') || '').trim();
  const wantsText = q.get('format') === 'text';

  let rows;
  try {
    rows = [
      ...await collect(env.REFERRALS, botKey.unanswered(''), 'unanswered', since),
      ...await collect(env.REFERRALS, botKey.escalation(''), 'escalation', since),
    ];
  } catch (e) {
    console.error('wa-unanswered: list failed', String(e));
    return json(500, { ok: false, error: 'kv_list' });
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  /* Values are read only for the rows that survived the filter, so a narrow
     ?since is a cheap request even once there are thousands of keys. */
  const items = [];
  for (const row of rows.slice(0, 500)) {
    let value = null;
    try { value = await env.REFERRALS.get(row.key, 'json'); } catch { /* skipped below */ }
    if (value) items.push({ kind: row.kind, at: row.at, ...value });
  }

  const lines = items.map(i => i.kind === 'escalation'
    ? `${i.at}  HUMAN     ${i.phone}  [${i.lang}]  ${i.name || ''}  ${JSON.stringify(i.last_message || '')}`
    : `${i.at}  UNANSWERED ${i.phone}  [${i.lang}]  ${JSON.stringify(i.text || '')}  (${i.reason || ''})`);
  const body = lines.join('\n') || 'nothing since ' + (since || 'the beginning');

  if (wantsText) return plain(200, body + '\n');

  return json(200, {
    ok: true,
    since: since || null,
    counts: {
      unanswered: items.filter(i => i.kind === 'unanswered').length,
      escalation: items.filter(i => i.kind === 'escalation').length,
    },
    items,
    text: body,
  });
}

export const onRequestPost = () => json(405, { ok: false, error: 'method_not_allowed' });

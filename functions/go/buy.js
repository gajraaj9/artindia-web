/**
 * GET /go/buy?cta=<id>&lang=<en|fr|nl>[&utm_*=...][&ref=...]
 *
 * Every link on the site that leaves for the box office goes through here, so
 * a click can be counted before it leaves. Nothing is stored in the visitor's
 * browser: the campaign parameters ride on the href, put there by a few lines
 * of inline script at page load, and the count lands server side.
 *
 * 302, never 301: a cached 301 would take the measurement out of the loop for
 * good, and a browser that has cached one cannot be told to stop.
 */

import { BOX_OFFICE, logClick, clickFrom, tagClass } from '../api/_shared.js';

/* What may appear as a cta id. Anything else is counted as unknown rather
   than written through to a dataset. */
const CTA_RE = /^[a-z0-9-]{1,24}$/;
const LANGS = ['en', 'fr', 'nl'];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = url.searchParams;

  const rawCta = String(q.get('cta') || '').toLowerCase();
  const cta = CTA_RE.test(rawCta) ? rawCta : 'unknown';
  const lang = LANGS.includes(String(q.get('lang') || '').toLowerCase())
    ? q.get('lang').toLowerCase() : '';

  const click = clickFrom(request, { cta, lang });
  const sink = await logClick(env, click);

  const to = new URL(env.TICKET_URL || BOX_OFFICE);

  /* The utm trio is passed through untouched so the box office and the
     analytics see the same campaign the site did. */
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const v = q.get(k);
    if (v) to.searchParams.set(k, v.slice(0, 120));
  }

  /* Attribution. An existing ref is somebody's referral code or a channel tag
     that was minted earlier in the journey, and overwriting it would take the
     credit away from whoever earned it. Only an order that arrives with
     nothing gets site-<cta>, which is what stops the site's own buttons
     showing up in Ticket Tailor as untagged. */
  const existing = String(q.get('ref') || '').trim();
  to.searchParams.set('ref', existing || `site-${cta}`);

  return new Response(null, {
    status: 302,
    headers: {
      location: to.toString(),
      'cache-control': 'no-store',
      /* Which sink took the click. The difference between a bound dataset and
         a silent fallback is otherwise invisible from outside. */
      'x-click-sink': sink,
    },
  });
}

/* HEAD answers as GET does, or a link checker sees the homepage instead. */
export const onRequestHead = onRequestGet;

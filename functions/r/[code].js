/**
 * GET /r/<CODE>   personal referral link  ->  the box office
 *
 * The link that goes out in the WhatsApp welcome. It exists so that the code
 * is short enough to read off a phone screen and so that the campaign tagging
 * happens here, once, rather than in a template we would have to re-approve
 * with Meta every time the box office URL changed.
 *
 * 302, never 301: this is a campaign link, and a browser that has cached a 301
 * cannot be told to stop.
 */

import { CODE_RE } from '../api/_shared.js';

/* The Ticket Tailor box office, same URL the site's own CTA points at. In env
   so a change of event id does not need a deploy of this function. */
const BOX_OFFICE = 'https://tickets.artindia.be/events/artindia/2392534';
const HOME = 'https://diwali.artindia.be';

const redirect = to => new Response(null, {
  status: 302,
  headers: { location: to, 'cache-control': 'no-store' },
});

export async function onRequestGet({ params, env }) {
  const code = String(params.code || '').trim().toUpperCase();

  /* An unreadable or unknown code still gets the visitor to the festival.
     Someone who mistyped a link off a phone screen should land on the site,
     not on an error — they just do not credit anybody. */
  if (!CODE_RE.test(code) || !env.REFERRALS) return redirect(HOME);

  let entry = null;
  try {
    entry = await env.REFERRALS.get(`code:${code}`, 'json');
  } catch (e) {
    console.error('r/: KV read failed', code, String(e));
  }
  if (!entry) return redirect(HOME);

  /* Both spellings. ref= is what Ticket Tailor actually carries onto the order
     today; the utm_* trio is what the analytics read, and utm_campaign is the
     one /api/tt-order looks for first if Ticket Tailor starts passing it. */
  const url = new URL(env.TICKET_URL || BOX_OFFICE);
  url.searchParams.set('ref', code);
  url.searchParams.set('utm_source', 'referral');
  url.searchParams.set('utm_medium', 'whatsapp');
  url.searchParams.set('utm_campaign', code);
  return redirect(url.toString());
}

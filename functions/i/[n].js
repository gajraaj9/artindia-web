/**
 * GET /i/<n>   one Instagram post  ->  the box office
 *
 * Short enough to set in a story or a bio, and tagged per post, so a campaign
 * can be read post by post rather than as one lump of "instagram".
 *
 * This is a function rather than a line in _redirects because Pages does not
 * substitute a :placeholder inside the destination's query string: the rule
 *   /i/:n  https://tickets…?ref=ig-:n…
 * arrives at the box office as ref=ig-%3An, literally. The tag is the whole
 * point of the link, so it is built here instead.
 *
 * 302, never 301: these are campaign links, and a browser that has cached a
 * 301 cannot be told to stop.
 */

/* The same box office the /r/ route uses. In env so a change of event id is
   not a deploy of two functions. */
const BOX_OFFICE = 'https://tickets.artindia.be/events/artindia/2392534';

/* What may appear after /i/. Lowercase, digits and hyphens, twenty
   characters at most: enough for ig-launch-week, short enough that nothing
   long or strange ends up on somebody's contact record in Brevo. */
const TAG_RE = /^[a-z0-9-]{1,20}$/;

const redirect = to => new Response(null, {
  status: 302,
  headers: { location: to, 'cache-control': 'no-store' },
});

export function onRequestGet({ params, env }) {
  const n = String(params.n || '').trim();
  const url = new URL(env.TICKET_URL || BOX_OFFICE);

  /* Instagram is recorded either way — the visit happened and came from
     there. Only the post tag is withheld, because an unreadable one would
     put a junk campaign on the buyer's contact for the life of the festival. */
  url.searchParams.set('utm_source', 'instagram');
  url.searchParams.set('utm_medium', 'social');

  if (TAG_RE.test(n)) {
    const tag = `ig-${n}`;
    /* ref is what Ticket Tailor actually carries onto the order, as
       referral_tag; utm_campaign is what the analytics read. /api/tt-order
       recognises the ig- prefix as a channel rather than a referral code. */
    url.searchParams.set('ref', tag);
    url.searchParams.set('utm_campaign', tag);
  } else {
    console.warn('i/: unusable tag', JSON.stringify(n.slice(0, 40)));
  }

  return redirect(url.toString());
}

/* HEAD must answer exactly as GET does. Pages routes the two separately, and
   without this a HEAD falls through to the static site and comes back 200
   with the homepage — which is what a link checker, a scanner, or anyone
   verifying the redirect with `curl -sI` would see. */
export const onRequestHead = onRequestGet;

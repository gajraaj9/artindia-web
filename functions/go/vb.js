/**
 * GET /go/vb   the visit.brussels listing link
 *
 * Was a line in _redirects. It is a function now only so the click is counted
 * like every other one; the destination is exactly what it was.
 */

import { logClick, clickFrom } from '../api/_shared.js';

const TO = 'https://diwali.artindia.be/?utm_source=visitbrussels&utm_medium=listing&utm_campaign=diwali2026';

export async function onRequestGet({ request, env }) {
  await logClick(env, clickFrom(request, {
    cta: 'vb', utm_source: 'visitbrussels', utm_medium: 'listing', utm_campaign: 'diwali2026',
  }));
  return new Response(null, {
    status: 302,
    headers: { location: TO, 'cache-control': 'no-store' },
  });
}

export const onRequestHead = onRequestGet;

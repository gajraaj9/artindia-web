/**
 * POST /api/team-register
 *
 * The only way a person gets into the queue, and it is a queue: this route
 * never issues a ticket, a code or a WhatsApp. All of that waits for a named
 * approver. See section 1 of the brief.
 *
 * Every refusal answers with the same polite copy key and no detail.
 */

import { json } from './_shared.js';
import {
  allowedOrigin, langOf, plus1Key, getPerson, register, regEnabled, say,
  linkKey, teamOf, isGuestForm,
} from './_accred.js';

export async function onRequestPost({ request, env }) {
  if (!allowedOrigin(request.headers.get('origin'))) {
    return json(403, { ok: false, error: 'bad_origin' });
  }
  if (!env.ACCRED) return json(200, { ok: false, message: 'inactive' });

  let body;
  try { body = await request.json(); } catch { return json(400, { ok: false, error: 'bad_json' }); }

  /* /guest/ posts no token. The link is the one VIP_LINK_TOKEN names, and
     register() applies that team's own switch and closing date. */
  if (body && body.viaGuest === true) {
    if (!env.VIP_LINK_TOKEN) {
      return json(200, { ok: false, message: 'vip_inactive', text: say('vip_inactive', langOf(body.lang)) });
    }
    body.k = String(env.VIP_LINK_TOKEN);
  } else if (!regEnabled(env)) {
    /* Not a +1 and not the guest form: the team form's switch, as before.
       A vip link pasted by hand is resolved by register() itself. */
    const link = await env.ACCRED.get(linkKey(String((body && body.k) || '')), 'json');
    if (!(link && isGuestForm(teamOf(link.team)))) {
      return json(200, { ok: false, message: 'inactive' });
    }
  }

  const kv = env.ACCRED;
  const lang = langOf(body.lang);
  const ip = request.headers.get('cf-connecting-ip') || '';

  /* A +1 token is not a link, so it is resolved here and handed to register
     as the artist it belongs to. */
  let plus1 = null;
  const guest = await kv.get(plus1Key(String(body.k || '')), 'json');
  if (guest) {
    if (guest.used) return json(200, { ok: false, message: 'inactive', text: say('inactive', lang) });
    const artist = await getPerson(kv, guest.artistId);
    plus1 = {
      artistId: guest.artistId,
      label: artist ? `${artist.firstName} ${artist.lastName}` : '',
    };
  }

  const r = await register(env, kv, body, { ip, plus1 });

  if (!r.ok) {
    return json(200, { ok: false, message: r.message, text: say(r.message, lang) });
  }
  /* A flagged form, a repeat and a real new row all answer the same way. A
     person who tripped the trap is not told so, and neither is a robot. */
  return json(200, { ok: true, text: say('received', lang) });
}

export const onRequestGet = () => json(405, { ok: false, error: 'method_not_allowed' });

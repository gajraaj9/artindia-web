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
} from './_accred.js';

export async function onRequestPost({ request, env }) {
  if (!allowedOrigin(request.headers.get('origin'))) {
    return json(403, { ok: false, error: 'bad_origin' });
  }
  if (!env.ACCRED) return json(200, { ok: false, message: 'inactive' });
  if (!regEnabled(env)) return json(200, { ok: false, message: 'inactive' });

  let body;
  try { body = await request.json(); } catch { return json(400, { ok: false, error: 'bad_json' }); }

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
  /* A bot, a repeat and a real new row all look the same from the outside. */
  return json(200, { ok: true, text: say('received', lang) });
}

export const onRequestGet = () => json(405, { ok: false, error: 'method_not_allowed' });

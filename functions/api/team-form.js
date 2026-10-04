/**
 * GET /api/team-form?k=<token>
 *
 * What the form needs to draw itself: which team this link is for, the label
 * so the person can see they are in the right place, and the copy.
 *
 * It answers 200 with `ok: false` for an unknown token, a closed link and a
 * switched-off module alike. A 404 would tell a stranger with a guessed token
 * that some other token exists, and the page has exactly one thing to say in
 * all three cases anyway.
 */

import { json } from './_shared.js';
import {
  COPY, LANGS, langOf, linkKey, plus1Key, teamOf, getPerson, regEnabled,
  registrationClosed, passName, closeAt,
} from './_accred.js';

const dead = (lang, message) => json(200, {
  ok: false, message, strings: strings(lang),
});

const strings = lang => Object.fromEntries(
  Object.entries(COPY).map(([k, v]) => [k, v[lang] || v.en || '']));

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const lang = langOf(url.searchParams.get('lang'));
  const k = String(url.searchParams.get('k') || '');

  if (!env.ACCRED) return dead(lang, 'inactive');
  if (!regEnabled(env)) return dead(lang, 'inactive');
  if (!k) return dead(lang, 'inactive');
  if (registrationClosed(env)) return dead(lang, 'closed');

  const kv = env.ACCRED;

  /* A team link first, then a +1 token. One endpoint for both forms, because
     the only difference between them is the role field. */
  const link = await kv.get(linkKey(k), 'json');
  if (link) {
    if (!link.open) return dead(lang, 'inactive');
    const team = teamOf(link.team);
    if (!team || team.inviteOnly) return dead(lang, 'inactive');
    return json(200, {
      ok: true,
      kind: 'team',
      team: team.key,
      teamName: passName(team, lang),
      label: link.label || '',
      childTeam: Boolean(team.childTeam),
      /* On the child team the form is a parent filling it in for a child, and
         the child's act is the class they are in. There is no role to ask the
         parent for. */
      needsRole: !team.childTeam,
      closesAt: closeAt(env).toISOString(),
      strings: strings(lang),
    });
  }

  const guest = await kv.get(plus1Key(k), 'json');
  if (guest && !guest.used) {
    const artist = await getPerson(kv, guest.artistId);
    const team = teamOf('plus1');
    return json(200, {
      ok: true,
      kind: 'plus1',
      team: 'plus1',
      teamName: passName(team, lang),
      label: artist ? `${artist.firstName} ${artist.lastName}` : '',
      childTeam: false,
      needsRole: false,
      closesAt: closeAt(env).toISOString(),
      strings: strings(lang),
    });
  }

  return dead(lang, 'inactive');
}

export const onRequestPost = () => json(405, { ok: false, error: 'method_not_allowed' });
export { LANGS };

/**
 * GET /api/team-form?k=<token>
 * GET /api/team-form?guest=1      the special guest form at /guest/
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
  registrationClosed, passName, closeAt, isGuestForm, hasForm,
  closedFor, closeAtFor, vipEnabled,
} from './_accred.js';

const dead = (lang, message) => json(200, {
  ok: false, message, strings: strings(lang),
});

const strings = lang => Object.fromEntries(
  Object.entries(COPY).map(([k, v]) => [k, v[lang] || v.en || '']));

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const lang = langOf(url.searchParams.get('lang'));
  /* /guest/ carries no token: the invitation prints a short address, and
     which link it opens is VIP_LINK_TOKEN's to say. */
  const viaGuest = url.searchParams.get('guest') === '1';
  const k = viaGuest ? String(env.VIP_LINK_TOKEN || '') : String(url.searchParams.get('k') || '');

  if (viaGuest) {
    if (!env.ACCRED || !vipEnabled(env) || !k) return dead(lang, 'vip_inactive');
  } else {
    if (!env.ACCRED) return dead(lang, 'inactive');
    if (!k) return dead(lang, 'inactive');
  }

  const kv = env.ACCRED;

  /* A team link first, then a +1 token. One endpoint for both forms, because
     the only difference between them is the role field. */
  const link = await kv.get(linkKey(k), 'json');
  const linkTeam = link ? teamOf(link.team) : null;

  /* The special guest form, whether it was reached at /guest/ or by its link.
     Its own switch and its own closing date; never the team label, which is
     an internal note about whose list this is. */
  if (isGuestForm(linkTeam)) {
    if (!vipEnabled(env) || !link.open) return dead(lang, 'vip_inactive');
    if (closedFor(env, linkTeam)) return dead(lang, 'vip_closed');
    return json(200, {
      ok: true,
      kind: 'vip',
      vip: true,
      team: linkTeam.key,
      teamName: (COPY.vip_badge && (COPY.vip_badge[lang] || COPY.vip_badge.en)) || '',
      label: '',
      childTeam: false,
      needsRole: false,
      promoCode: false,
      closesAt: closeAtFor(env, linkTeam).toISOString(),
      strings: strings(lang),
    });
  }
  if (viaGuest) return dead(lang, 'vip_inactive');

  if (!regEnabled(env)) return dead(lang, 'inactive');
  if (registrationClosed(env)) return dead(lang, 'closed');

  if (link) {
    if (!link.open) return dead(lang, 'inactive');
    const team = linkTeam;
    if (!hasForm(team)) return dead(lang, 'inactive');
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
      /* Whether the success screen promises a discount code. Only some teams
         get one, and promising one that never arrives is worse than silence. */
      promoCode: Boolean(team.promoCode),
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
      promoCode: Boolean(team && team.promoCode),
      closesAt: closeAt(env).toISOString(),
      strings: strings(lang),
    });
  }

  return dead(lang, 'inactive');
}

export const onRequestPost = () => json(405, { ok: false, error: 'method_not_allowed' });
export { LANGS };

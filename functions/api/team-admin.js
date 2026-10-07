/**
 * GET /api/team-admin   everything the page needs, in one call
 * POST /api/team-admin  one decision at a time
 *
 * Authenticated by `X-Admin-Token` against the named tokens in
 * `TEAM_ADMIN_TOKENS`. The name that matched is the approver written onto
 * every decision, which is the whole reason the tokens are named and not one
 * shared secret: "who let this person in" has to have an answer.
 *
 * `WA_ADMIN_TOKEN` is deliberately not accepted here. It has been pasted into
 * chat transcripts, and this route reads a list of children's dates of birth.
 */

import { json, normalisePhone } from './_shared.js';
import { botKey, logMessage, LOG_SECONDS } from './_bot.js';
import {
  TEAMS, approverFor, allLinks, allPeople, approve, reject, revoke, restore, expectedFor,
  teamCfgKey, linkKey, teamOf, token, dryRun, regEnabled, closeAt, ticketTypeFor,
  approvalBlocker, getPerson, putPerson, addIdTo, phoneKey, emailKey, newPersonId,
  ageOnFestival, validDob, langOf, STEPS, hardCap, allRefusals, trimRefusals,
  SKIPPED, isDryId, changeCode, recentlySent, markSent, RESEND_LOCK_SECONDS,
} from './_accred.js';

/* The caller, or null. 503 when the secret is unset: an admin route with no
   configured tokens must refuse everyone rather than let anyone in. */
function who(request, env) {
  if (!env.TEAM_ADMIN_TOKENS) return { error: 503 };
  const presented = request.headers.get('x-admin-token') || '';
  const name = approverFor(env, presented);
  return name ? { name } : { error: 401 };
}

const guard = (request, env) => {
  const r = who(request, env);
  if (r.error === 503) return { res: json(503, { ok: false, error: 'not_configured' }) };
  if (r.error) return { res: json(401, { ok: false, error: 'unauthorised' }) };
  if (!env.ACCRED) return { res: json(503, { ok: false, error: 'no_kv_binding' }) };
  return { approver: r.name };
};

/* --------------------------------------------------------------------- get */

export async function onRequestGet({ request, env }) {
  const g = guard(request, env);
  if (g.res) return g.res;

  const kv = env.ACCRED;
  const people = await allPeople(kv);
  const links = await allLinks(kv);
  await trimRefusals(kv);
  const refused = await allRefusals(kv);

  const counts = {};
  for (const p of people) {
    if (p.status === 'rejected' || p.status === 'revoked') continue;
    counts[p.team] = (counts[p.team] || 0) + 1;
  }

  const teams = [];
  for (const t of TEAMS) {
    const expected = await expectedFor(kv, t.key);
    teams.push({
      key: t.key,
      name: t.name,
      expected: Number(expected),
      seedExpected: t.expected,
      registered: counts[t.key] || 0,
      promoCode: Boolean(t.promoCode),
      plusOne: Boolean(t.plusOne),
      wall: Boolean(t.wall),
      childTeam: Boolean(t.childTeam),
      inviteOnly: Boolean(t.inviteOnly),
      derived: Boolean(t.derived),
      /* Why the Approve button on this team is dead, if it is. */
      blocked: t.inviteOnly ? 'invite_only'
        : (env.TT_EVENT_ID ? '' : 'no_tt_event_id')
          || (ticketTypeFor(env, t.key) ? '' : `no_ticket_type_for_${t.key}`),
    });
  }

  return json(200, {
    ok: true,
    approver: g.approver,
    settings: {
      regEnabled: regEnabled(env),
      dryRun: dryRun(env),
      closesAt: closeAt(env).toISOString(),
      wallEnabled: String(env.WALL_ENABLED) === 'true',
      accredList: env.BREVO_ACCRED_LIST_ID || '',
    },
    teams,
    links: links.map(l => ({
      ...l,
      registered: people.filter(p => p.linkToken === l.token && p.status !== 'rejected').length,
      cap: hardCap(l.expected),
      url: `https://diwali.artindia.be/team/?k=${l.token}`,
    })),
    refused,
    people: people
      .map(p => ({
        ...p,
        /* The date of birth is in the payload and in the export and nowhere
           else. The age is here so nobody has to do the arithmetic. */
        childAge: p.child ? ageOnFestival(p.child.dob) : null,
      }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
  });
}

/* -------------------------------------------------------------------- post */

/* The welcome log entry, so a Meta delivery report for this number lands on
   this message and the status shows in /api/wa-status and on the dashboard,
   exactly as it does for a buyer. */
const logger = (kv, person) => async (messageId, template) => {
  const ts = new Date().toISOString();
  try {
    await kv.put(botKey.welcome(person.phone), JSON.stringify({
      phone: person.phone, ts, name: person.firstName, template,
      waMessageId: messageId, team: person.team,
      status: 'sent', last_status_ts: ts,
    }), { expirationTtl: LOG_SECONDS });
    await logMessage(kv, person.phone,
      { dir: 'out', kind: 'template', text: `${template} (team pass)` },
      { name: person.firstName, team: true });
  } catch (e) {
    console.error('team-admin: pass log failed', String(e));
  }
};

export async function onRequestPost({ request, env }) {
  const g = guard(request, env);
  if (g.res) return g.res;
  const approver = g.approver;
  const kv = env.ACCRED;

  let body;
  try { body = await request.json(); } catch { return json(400, { ok: false, error: 'bad_json' }); }
  const action = String(body.action || '');

  switch (action) {
    case 'approve': {
      /* The WhatsApp log needs the number before the pipeline runs, and the
         pipeline needs the logger, so the person is read twice. Cheap. */
      const p = await getPerson(kv, String(body.id));
      if (!p) return json(404, { ok: false, error: 'unknown_person' });
      const r = await approve(env, kv, { id: p.id, approver, log: logger(kv, p) });
      /* Even a refusal answers with the record. A failed approval leaves a
         person sitting in the queue, and the page draws them from this rather
         than from a read that may not see the write yet. */
      return json(r.ok ? 200 : 409, r);
    }

    /* One step, again, whether or not it says done. The Resend buttons. */
    case 'resend': {
      const step = String(body.step || '');
      if (!['email', 'whatsapp'].includes(step)) {
        return json(400, { ok: false, error: 'bad_step' });
      }
      const p = await getPerson(kv, String(body.id));
      if (!p) return json(404, { ok: false, error: 'unknown_person' });
      if (p.status !== 'approved') return json(409, { ok: false, error: 'not_approved', person: p });

      /* A double click, or two approvers on the same card at the same moment.
         The page asks before a quick repeat; this is what makes the answer
         true even when the page could not have known. */
      const recent = await recentlySent(kv, p.id, step);
      if (recent) {
        const plural = n => (n === 1 ? '' : 's');
        return json(409, {
          ok: false,
          error: 'sent_just_now',
          detail: `That ${step === 'email' ? 'email' : 'WhatsApp'} was sent `
            + `${recent.since} second${plural(recent.since)} ago. `
            + `Wait ${recent.wait} second${plural(recent.wait)} and try again.`,
          person: p,
          retryAfter: recent.wait,
        });
      }
      await markSent(kv, p.id, step);

      const r = await approve(env, kv,
        { id: p.id, approver, only: [step], force: true, log: logger(kv, p) });
      return json(r.ok ? 200 : 409, r);
    }

    case 'retry': {
      const p = await getPerson(kv, String(body.id));
      if (!p) return json(404, { ok: false, error: 'unknown_person' });
      /* Only what failed, unless the caller named the steps. */
      const only = Array.isArray(body.steps) && body.steps.length
        ? body.steps.filter(s => STEPS.includes(s))
        : STEPS.filter(s => p.steps[s] !== 'done');
      if (!only.length) return json(200, { ok: true, person: p, skipped: 'nothing_to_retry' });
      const r = await approve(env, kv, { id: p.id, approver, only, log: logger(kv, p) });
      return json(r.ok ? 200 : 409, r);
    }

    case 'reject':
      return json(200, await reject(env, kv,
        { id: String(body.id), approver, note: body.note || '' }));

    case 'revoke':
      return json(200, await revoke(env, kv,
        { id: String(body.id), approver, note: body.note || '' }));

    case 'restore':
      return json(200, await restore(env, kv, { id: String(body.id), approver }));

    /* A different code, by hand. Sends nothing: the approver decides whether
       to tell them, and the Resend buttons carry the new one. */
    case 'code_change': {
      const r = await changeCode(env, kv,
        { id: String(body.id), code: body.code, approver });
      return json(r.ok ? 200 : 409, r);
    }

    case 'link_create': {
      const team = teamOf(String(body.team || ''));
      if (!team) return json(400, { ok: false, error: 'unknown_team' });
      /* No link for a team nobody fills a form for. */
      if (team.inviteOnly || team.derived) return json(400, { ok: false, error: 'team_has_no_links' });
      const t = token(20);
      const link = {
        token: t,
        team: team.key,
        label: String(body.label || '').slice(0, 80),
        lead: String(body.lead || '').slice(0, 80),
        expected: Number(body.expected) || Number(team.expected) || 10,
        open: true,
        createdBy: approver,
        createdAt: new Date().toISOString(),
      };
      await kv.put(linkKey(t), JSON.stringify(link));
      return json(200, { ok: true, link, url: `https://diwali.artindia.be/team/?k=${t}` });
    }

    case 'link_update': {
      const t = String(body.token || '');
      const link = await kv.get(linkKey(t), 'json');
      if (!link) return json(404, { ok: false, error: 'unknown_link' });
      if ('open' in body) link.open = Boolean(body.open);
      if ('expected' in body) link.expected = Number(body.expected) || link.expected;
      if ('label' in body) link.label = String(body.label).slice(0, 80);
      if ('lead' in body) link.lead = String(body.lead).slice(0, 80);
      await kv.put(linkKey(t), JSON.stringify(link));
      return json(200, { ok: true, link });
    }

    case 'expected_set': {
      const team = teamOf(String(body.team || ''));
      if (!team) return json(400, { ok: false, error: 'unknown_team' });
      const n = Number(body.expected);
      if (!Number.isFinite(n) || n < 0) return json(400, { ok: false, error: 'bad_number' });
      await kv.put(teamCfgKey(team.key), JSON.stringify({ expected: n }));
      return json(200, { ok: true, team: team.key, expected: n });
    }

    /* Somebody who is never going to fill a form: a board member's guest
       taken down over the phone, a journalist added from an email. Created
       approved by whoever is logged in, and put through the same steps. */
    case 'person_add': {
      const team = teamOf(String(body.team || ''));
      if (!team) return json(400, { ok: false, error: 'unknown_team' });
      if (team.inviteOnly) return json(400, { ok: false, error: 'invite_only_team' });
      if (team.childTeam && !validDob(body.child && body.child.dob)) {
        return json(400, { ok: false, error: 'dob_invalid' });
      }
      /* A number typed over the phone, with spaces, a 0 in front and maybe a
         country code. It has to be the same shape as one the form produced,
         or Diya will never find them and Brevo will hold two of them. */
      const phone = String(body.phone || '').trim() ? normalisePhone(body.phone) : '';
      if (String(body.phone || '').trim() && !phone) {
        return json(400, {
          ok: false,
          error: 'bad_phone',
          detail: 'That is not a number WhatsApp can reach. Use the international '
            + 'form, for example +32 474 91 99 00.',
        });
      }

      const person = {
        id: newPersonId(),
        team: team.key,
        linkToken: '',
        label: String(body.label || `added by ${approver}`).slice(0, 80),
        firstName: String(body.firstName || '').trim().slice(0, 60),
        lastName: String(body.lastName || '').trim().slice(0, 60),
        email: String(body.email || '').trim().toLowerCase(),
        phone,
        role: String(body.role || '').trim().slice(0, 60),
        lang: langOf(body.lang),
        child: team.childTeam ? {
          firstName: String(body.child.firstName || '').trim().slice(0, 60),
          lastName: String(body.child.lastName || '').trim().slice(0, 60),
          dob: String(body.child.dob),
        } : null,
        plusOneOf: null,
        plus1TokenUsed: null,
        vip: null,
        wallToken: null,
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        note: '',
        flags: ['added_by_admin'],
        tt: null,
        promo: null,
        plus1Token: null,
        steps: { ticket: null, discount: null, brevo: null, email: null, whatsapp: null },
        createdAt: new Date().toISOString(),
        ip: '',
      };
      if (!person.firstName || !person.lastName || !person.email) {
        return json(400, { ok: false, error: 'missing_fields' });
      }
      await putPerson(kv, person);
      if (person.phone) await addIdTo(kv, phoneKey(person.phone), person.id);
      await addIdTo(kv, emailKey(person.email), person.id);
      const r = await approve(env, kv, { id: person.id, approver, log: logger(kv, person) });
      return json(r.ok ? 200 : 409, r);
    }

    default:
      return json(400, { ok: false, error: 'unknown_action' });
  }
}

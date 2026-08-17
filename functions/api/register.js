/**
 * POST /api/register   { email, source }
 *
 * Adds the address to a Brevo list. Runs on Cloudflare's edge, so the API key
 * stays server-side and never reaches the browser.
 *
 * Set these in Cloudflare → Workers & Pages → the project → Settings →
 * Variables and Secrets:
 *
 *   BREVO_API_KEY   secret, from Brevo → SMTP & API → API keys
 *   BREVO_LIST_ID   the numeric id of the list, e.g. 3
 */

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function onRequestPost({ request, env }) {
  let email, source;
  try {
    ({ email, source } = await request.json());
  } catch {
    return json(400, { ok: false, error: 'bad_request' });
  }

  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || email.length > 254) {
    return json(400, { ok: false, error: 'invalid_email' });
  }

  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID) {
    // Not configured yet — accept the address rather than showing an error,
    // and leave a trace in the logs so it isn't silently lost.
    console.log('register (unconfigured):', email, source);
    return json(200, { ok: true, stored: false });
  }

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      email,
      listIds: [Number(env.BREVO_LIST_ID)],
      updateEnabled: true,                       // re-registering is not an error
      attributes: {
        SOURCE: source || 'diwali-2026',
        SIGNUP_DATE: new Date().toISOString().slice(0, 10),
      },
    }),
  });

  // 201 created, 204 updated. A duplicate comes back as 400 duplicate_parameter,
  // which from the visitor's point of view is a success.
  if (res.ok || res.status === 204) return json(200, { ok: true, stored: true });

  const detail = await res.text();
  if (detail.includes('duplicate_parameter')) return json(200, { ok: true, stored: true });

  console.error('brevo error', res.status, detail);
  return json(502, { ok: false, error: 'upstream' });
}

export const onRequestGet = () => json(405, { ok: false, error: 'method_not_allowed' });

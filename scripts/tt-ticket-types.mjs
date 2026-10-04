#!/usr/bin/env node
/**
 * Every ticket type on the Diwali event, with its id, so the TT_TYPE_* and
 * TT_DISCOUNT_TICKET_TYPES variables can be filled in by copying rather than
 * by reading them off a dashboard URL.
 *
 *   TT_API_KEY=sk_... node scripts/tt-ticket-types.mjs
 *   TT_API_KEY=sk_... node scripts/tt-ticket-types.mjs --event ev_1234
 *
 * On demand only. Nothing in the build or the deploy calls this: the build is
 * hermetic and makes no network calls.
 *
 * GET /v1/events returns each event with its ticket types inline, so one call
 * answers the whole question. The key goes out as HTTP Basic with an empty
 * password, which is what Ticket Tailor's API expects.
 */

const KEY = process.env.TT_API_KEY;
if (!KEY) {
  console.error('TT_API_KEY is not set.\n'
    + 'Run: TT_API_KEY=sk_... node scripts/tt-ticket-types.mjs');
  process.exit(2);
}

const want = (() => {
  const i = process.argv.indexOf('--event');
  return i > 0 ? process.argv[i + 1] : process.env.TT_EVENT_ID || '';
})();

async function get(path, query = {}) {
  const url = new URL(`https://api.tickettailor.com${path}`);
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      authorization: 'Basic ' + Buffer.from(`${KEY}:`).toString('base64'),
      accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`${res.status} on ${url.pathname}\n${text.slice(0, 600)}`);
    process.exit(1);
  }
  return JSON.parse(text);
}

const money = (cents, currency) =>
  `${((Number(cents) || 0) / 100).toFixed(2)} ${String(currency || '').toUpperCase()}`;

const r = await get('/v1/events', { limit: '100' });
const events = (r.data || []).filter(ev => !want || ev.id === want);

if (!events.length) {
  console.log(want
    ? `No event with id ${want}. Run without --event to list them all.`
    : 'The box office has no events.');
  process.exit(0);
}

for (const ev of events) {
  console.log('');
  console.log(`${ev.name}`);
  console.log(`  TT_EVENT_ID        ${ev.id}`);
  console.log(`  event_series_id    ${ev.event_series_id || '(none)'}`);
  console.log(`  status             ${ev.status}  ${ev.start?.iso || ''}`);
  console.log(`  issued / orders    ${ev.total_issued_tickets} / ${ev.total_orders}`);

  const types = ev.ticket_types || [];
  if (!types.length) {
    console.log('  no ticket types on this event');
    continue;
  }
  console.log('');
  console.log('  ticket type id                      price        left   status      name');
  for (const t of types.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))) {
    console.log('  '
      + String(t.id).padEnd(35)
      + money(t.price, ev.currency).padEnd(13)
      + String(t.quantity ?? '-').padEnd(7)
      + String(t.status || '').padEnd(12)
      + t.name);
  }

  /* The paid single adult tickets are the only ones a 10% team code may touch:
     a percentage off a Family or Friends ticket is a discount on four seats. */
  const single = types.filter(t => Number(t.price) > 0
    && !/family|friends|group|duo/i.test(t.name || ''));
  if (single.length) {
    console.log('');
    console.log('  Paid single tickets, as a starting point for');
    console.log(`  TT_DISCOUNT_TICKET_TYPES   ${single.map(t => t.id).join(',')}`);
    console.log(`  (${single.map(t => t.name).join(' | ')})`);
    console.log('  Check that list by hand before using it. Never include a Family');
    console.log('  or Friends ticket.');
  }
}
console.log('');

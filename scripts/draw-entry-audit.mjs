#!/usr/bin/env node
/**
 * How many past orders lost a draw entry to the old counting rule, and how
 * many entries in total.
 *
 *   TT_API_KEY=sk_... node scripts/draw-entry-audit.mjs
 *   TT_API_KEY=sk_... node scripts/draw-entry-audit.mjs --csv > affected.csv
 *
 * Until 5 October 2026 an order's child count came from the ticket type NAME:
 * anything matching /child|enfant|kind|kid|under 12|.../ was a child and
 * earned no entry. The box office sells "Child 13-18 ( ID needed )" at 10 EUR,
 * so every paying teenager was counted as free. The rule is now the money.
 *
 * This replays both rules over every order and prints the difference. It
 * changes nothing: no Brevo write, no KV write. Ravi decides whether to
 * correct the counts, and this is the list to correct from.
 *
 * On demand only. Nothing in the build or the deploy calls it.
 */

const KEY = process.env.TT_API_KEY;
if (!KEY) {
  console.error('TT_API_KEY is not set.\n'
    + 'Run: TT_API_KEY=sk_... node scripts/draw-entry-audit.mjs');
  process.exit(2);
}
const CSV = process.argv.includes('--csv');
const EVENT = process.env.TT_EVENT_ID || '';

/* The rule as it stood, kept here verbatim so the comparison is honest. */
const OLD_CHILD_RE =
  /child|children|enfant|enfants|kind|kinderen|kid|under\s*12|moins\s*de\s*12|onder\s*12/i;

const cents = v => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const countOld = lines => lines.reduce((a, li) => {
  const qty = Number(li.quantity ?? 1) || 1;
  const free = OLD_CHILD_RE.test(String(li.description || '')) || cents(li.total) === 0;
  return { total: a.total + qty, child: a.child + (free ? qty : 0) };
}, { total: 0, child: 0 });

const countNew = lines => lines.reduce((a, li) => {
  const qty = Number(li.quantity ?? 1) || 1;
  return { total: a.total + qty, child: a.child + (cents(li.total) === 0 ? qty : 0) };
}, { total: 0, child: 0 });

const entries = c => Math.max(0, c.total - c.child);

async function* orders() {
  let after = '';
  for (;;) {
    const url = new URL('https://api.tickettailor.com/v1/orders');
    url.searchParams.set('limit', '100');
    if (EVENT) url.searchParams.set('event_id', EVENT);
    if (after) url.searchParams.set('starting_after', after);
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
    const page = JSON.parse(text);
    const rows = page.data || [];
    if (!rows.length) return;
    for (const o of rows) yield o;
    if (!page.links || !page.links.next) return;
    after = rows[rows.length - 1].id;
  }
}

const affected = [];
let seen = 0;

for await (const o of orders()) {
  seen++;
  const lines = Array.isArray(o.line_items) ? o.line_items : [];
  if (!lines.length) continue;
  const before = entries(countOld(lines));
  const after = entries(countNew(lines));
  if (after === before) continue;
  affected.push({
    id: o.id,
    email: String((o.buyer_details || {}).email || '').toLowerCase(),
    name: `${(o.buyer_details || {}).first_name || ''} ${(o.buyer_details || {}).last_name || ''}`.trim(),
    created: o.created_at,
    before,
    after,
    gained: after - before,
    lines: lines.map(li => `${li.quantity ?? 1}x ${li.description} @${li.total}`).join(' | '),
  });
}

if (CSV) {
  const cell = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  console.log('order_id,email,name,created,entries_before,entries_after,gained,line_items');
  for (const a of affected) {
    console.log([a.id, a.email, a.name, a.created, a.before, a.after, a.gained, a.lines]
      .map(cell).join(','));
  }
} else {
  const total = affected.reduce((n, a) => n + a.gained, 0);
  console.log('');
  console.log(`Orders read:        ${seen}`);
  console.log(`Orders affected:    ${affected.length}`);
  console.log(`Entries to add:     ${total}`);
  console.log('');
  for (const a of affected) {
    console.log(`  ${a.id}  ${a.email.padEnd(32)} ${a.before} -> ${a.after}  (+${a.gained})`);
    console.log(`      ${a.lines}`);
  }
  console.log('');
  console.log('Nothing was written. Re-run with --csv for a file to correct from.');
}

#!/usr/bin/env node
/**
 * Are the cuttings on /press still there?
 *
 *   node scripts/check-links.mjs
 *
 * Run on demand, never by the build. The pages are a function of the
 * repository alone, so a deploy cannot fail because an outlet is slow, has
 * moved a story, or turns automated requests away. This is the other half of
 * that bargain: nothing checks the links unless somebody asks.
 *
 * Exits 0 whatever it finds. A 403 is usually a newsroom refusing robots
 * rather than a dead link, so the report is for a person to read, not for a
 * machine to gate on. Pass --strict to exit 1 when anything fails, if you ever
 * want it in a scheduled job.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LANGS = ['en', 'fr', 'nl'];
const TIMEOUT = 12000;
const STRICT = process.argv.includes('--strict');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140 Safari/537.36';

const read = rel => (existsSync(join(ROOT, rel))
  ? JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) : null);

/* Every address the site links out to, each one labelled with the outlet that
   actually owns it. A dispatch carried by three papers is three links under
   three names, not three links under the name of the first. */
function links() {
  const out = [];
  const add = (label, url) => { if (url) out.push({ label, url }); };

  for (const x of read('data/news.json') || []) {
    add(x.outlet, x.url);
    for (const l of LANGS) add(`${x.outlet} (${l})`, x[`url_${l}`]);
    for (const a of x.also || []) add(`${a.outlet} (also in: ${x.outlet})`, a.url);
  }
  for (const p of (read('data/partners.json') || {}).partners || []) {
    if (!p.live) continue;
    add(p.name, p.url);
    for (const l of LANGS) add(`${p.name} (${l})`, p[`url_${l}`]);
  }
  return out;
}

/* One address can be reached under several labels: visit.brussels publishes
   the same listing per language, and a dispatch can run unchanged on two
   mastheads. Fetch each address once and report every name it answers to. */
function byUrl(all) {
  const m = new Map();
  for (const { label, url } of all) {
    if (!m.has(url)) m.set(url, []);
    if (!m.get(url).includes(label)) m.get(url).push(label);
  }
  return [...m].map(([url, labels]) => ({ url, labels }));
}

async function check(url) {
  const signal = AbortSignal.timeout(TIMEOUT);
  const go = method => fetch(url, { method, redirect: 'follow', signal, headers: { 'user-agent': UA } });
  try {
    /* HEAD first because it is cheaper. A few outlets answer it with 404, 405
       or 501 and then serve the same address perfectly well to a GET. */
    let r = await go('HEAD');
    if ([404, 405, 501].includes(r.status)) r = await go('GET');
    return { status: r.status, final: r.url };
  } catch (err) {
    return { status: 0, why: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
}

const all = byUrl(links());
if (!all.length) {
  console.log('No links to check.');
  process.exit(0);
}

const results = await Promise.all(all.map(async x => ({ ...x, ...await check(x.url) })));
results.sort((a, b) => (b.status >= 400 || b.status === 0) - (a.status >= 400 || a.status === 0));

const width = Math.max(...results.map(r => r.labels.join(', ').length));
for (const r of results) {
  const ok = r.status >= 200 && r.status < 400;
  const mark = ok ? 'ok  ' : 'FAIL';
  const code = String(r.status || '-').padStart(3);
  console.log(`  ${mark} ${code}  ${r.labels.join(', ').padEnd(width)}  ${r.url}${r.why ? `  (${r.why})` : ''}`);
  /* Where a link ends up matters as much as whether it answers: a story moved
     behind a redirect to a section front is alive and useless. */
  if (ok && r.final && r.final !== r.url) console.log(`${' '.repeat(width + 13)}  -> ${r.final}`);
}

const bad = results.filter(r => !(r.status >= 200 && r.status < 400));
console.log(`\n${results.length} links, ${results.length - bad.length} answered, ${bad.length} did not.`);
if (bad.length) console.log('A 403 is usually a newsroom refusing robots rather than a dead link.');
process.exit(STRICT && bad.length ? 1 : 0);

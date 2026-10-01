/**
 * The programme page.
 *
 * Six pages, two days in three languages, built from data/programme.json and
 * deployed while still hidden. Most of what is checked here is what the page
 * must NOT do: be findable before Ravi says so, show one day's acts on the
 * other day's page, or break the house copy rules.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-diwali');
const PR = JSON.parse(readFileSync(join(ROOT, 'data/programme.json'), 'utf8'));
const FLAGS = JSON.parse(readFileSync(join(ROOT, 'data/diwali.json'), 'utf8')).flags || {};
const PUBLIC = FLAGS.programme_public === true;

const build = () => execFileSync('node', ['build-diwali.mjs'], { cwd: ROOT, stdio: 'pipe' });
build();

/* The six, by the paths the brief fixes. */
const PAGES = {
  'en saturday': 'programme/index.html',
  'en sunday': 'programme/sunday/index.html',
  'fr saturday': 'fr/programme/index.html',
  'fr sunday': 'fr/programme/sunday/index.html',
  'nl saturday': 'nl/programme/index.html',
  'nl sunday': 'nl/programme/sunday/index.html',
};
const LANG_OF = k => k.split(' ')[0];
const read = rel => readFileSync(join(DIST, rel), 'utf8');
const html = Object.fromEntries(Object.entries(PAGES).map(([k, v]) => [k, read(v)]));
/* Everything the brief's copy rules talk about is inside main: the header and
   the footer belong to the rest of the site. */
const mainOf = h => h.slice(h.indexOf('<main'), h.indexOf('</main>'));

test('the six pages are built', () => {
  for (const [name, rel] of Object.entries(PAGES)) {
    assert.ok(existsSync(join(DIST, rel)), `${name} missing at ${rel}`);
    assert.ok(html[name].includes('id="programme-main"'), `${name} has no programme main`);
  }
});

test('hidden while the flag is off: noindex, out of the sitemap, nothing links in', () => {
  assert.equal(PUBLIC, false, 'this suite describes the hidden state; flip it back');

  for (const [name, h] of Object.entries(html)) {
    assert.match(h, /<meta name="robots" content="noindex, nofollow">/,
      `${name} is missing its noindex`);
  }

  const sitemap = read('sitemap.xml');
  assert.ok(!sitemap.includes('/programme'), 'sitemap names the programme while it is hidden');

  /* A link to the page itself, not the #programme anchor the footer has always
     carried. Only the six may point at each other. */
  const linkIn = /href="\/(?:fr\/|nl\/)?programme\//;
  const elsewhere = ['index.html', 'fr/index.html', 'nl/index.html',
    'partners/index.html', 'fr/partners/index.html', 'nl/partners/index.html'];
  for (const rel of elsewhere) {
    assert.ok(!linkIn.test(read(rel)), `${rel} links to the programme while it is hidden`);
  }
});

test('each day shows its own acts and not the other day\'s', () => {
  const sat = html['en saturday'];
  const sun = html['en sunday'];

  for (const yes of ['Dr. Suryaprakash', 'Shobha Yatra']) {
    assert.ok(sat.includes(yes), `Saturday is missing ${yes}`);
    assert.ok(!sun.includes(yes), `Sunday should not carry ${yes}`);
  }
  for (const yes of ['Kirtan with ISKCON', 'Brides of India']) {
    assert.ok(sun.includes(yes), `Sunday is missing ${yes}`);
    assert.ok(!sat.includes(yes), `Saturday should not carry ${yes}`);
  }
});

test('an act only one day runs wears that day\'s badge', () => {
  const only = id => PR.days.filter(day =>
    Object.values(day.chapters).flat().includes(id)).map(day => day.id);

  for (const [name, h] of Object.entries(html)) {
    const dayId = name.split(' ')[1];
    const day = PR.days.find(x => x.id === dayId);
    const main = mainOf(h);
    const solo = PR.acts.filter(a => only(a.id).length === 1 && only(a.id)[0] === dayId);
    const shared = PR.acts.filter(a => only(a.id).length === 2);
    assert.ok(solo.length, `${name} has no single-day acts to badge`);
    const badges = main.split(`class="pg-act-only">${day.only[LANG_OF(name)]}`).length - 1;
    assert.equal(badges, solo.length,
      `${name} badges ${badges} acts, ${solo.length} run on that day alone`);
    assert.ok(shared.length, 'both days should share some acts');
  }
});

test('chapter four is the same on both days, and whole', () => {
  for (const [name, h] of Object.entries(html)) {
    const main = mainOf(h);
    assert.ok(main.includes('Ticket2Bollywood'), `${name} is missing Ticket2Bollywood`);
    /* The grid container is .pg-t2b-cards, so the card class is matched with
       its closing quote or a modifier after it, never as a prefix. */
    assert.equal((main.match(/class="pg-t2b-card[ "]/g) || []).length, PR.t2b.items.length,
      `${name} does not carry all four Ticket2Bollywood cards`);
    for (const item of PR.t2b.items) {
      assert.ok(main.includes(item.name[LANG_OF(name)]),
        `${name} is missing the ${item.id} card`);
    }
  }
});

test('every page says which day it is and how to reach the other one', () => {
  for (const [name, h] of Object.entries(html)) {
    const lang = LANG_OF(name);
    const dayId = name.split(' ')[1];
    const other = PR.days.find(x => x.id !== dayId);
    const main = mainOf(h);

    assert.equal(main.split('class="pg-day is-here"').length - 1, 1,
      `${name} should fill exactly one day card`);
    assert.equal(main.split(/<a class="pg-day[^"]*" href="[^"]*"\s+aria-current="page"/).length - 1, 1,
      `${name} should mark exactly one day card as the current page`);

    const root = lang === 'en' ? '' : `/${lang}`;
    const to = other.slug ? `${root}/programme/${other.slug}/#day` : `${root}/programme/#day`;
    assert.ok(main.includes(`href="${to}"`), `${name} does not link to ${to}`);
  }
});

test('the copy rules hold inside main', () => {
  for (const [name, h] of Object.entries(html)) {
    const main = mainOf(h);
    /* Written as an escape so the character itself is nowhere in the repo. */
    assert.ok(!main.includes('\u2014'), `${name} has an em dash`);
    for (const banned of ['Jashn', 'Avenue of Lights', 'weekend']) {
      assert.ok(!new RegExp(banned, 'i').test(main), `${name} says "${banned}"`);
    }
    const clock = main.match(/\b\d{1,2}[:.h]\d{2}\b/);
    assert.equal(clock, null, `${name} prints a clock time: ${clock && clock[0]}`);
  }
});

test('the day is translated, not left in English', () => {
  assert.ok(html['fr saturday'].includes('Racines'), '/fr/programme/ is missing Racines');
  assert.ok(html['nl saturday'].includes('Wortels'), '/nl/programme/ is missing Wortels');
  assert.ok(html['fr sunday'].includes('Rencontres'), '/fr/programme/sunday/ is missing Rencontres');
  assert.ok(html['nl sunday'].includes('Ontmoetingen'), '/nl/programme/sunday/ is missing Ontmoetingen');
});

test('the price is read from the ticket data, never typed into this page', () => {
  const d = JSON.parse(readFileSync(join(ROOT, 'data/diwali.json'), 'utf8'));
  for (const [name, h] of Object.entries(html)) {
    const lang = LANG_OF(name);
    const main = mainOf(h);
    assert.ok(main.includes('cta=programme'), `${name} does not count its ticket click`);
    assert.ok(main.includes(d.tickets.cta_live[lang].replace(/&/g, '&amp;')),
      `${name} does not reuse the landing page's ticket button`);
  }
});

test('the build survives an empty media/programme/', () => {
  const dir = join(ROOT, 'media/programme');
  const weMadeIt = !existsSync(dir);
  if (weMadeIt) mkdirSync(dir, { recursive: true });
  try {
    assert.ok(existsSync(dir) && readdirSync(dir).length === 0,
      'this check wants the folder empty; it has photos in it now');
    build();
    assert.ok(existsSync(join(DIST, 'programme/index.html')));
    const main = mainOf(read('programme/index.html'));
    assert.ok(!main.includes('<picture'), 'no photos means no picture elements');
    assert.ok(main.includes('The Heritage'), 'the page is still whole without photos');
  } finally {
    if (weMadeIt) rmdirSync(dir);
  }
});

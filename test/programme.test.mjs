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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

/* One switch, two states, and this check follows whichever one the flag is in,
   so turning the programme on is a one-line change to data/diwali.json and
   the suite then proves the public state instead of refusing it. */
const HOME = ['index.html', 'fr/index.html', 'nl/index.html'];
const PARTNERS = ['partners/index.html', 'fr/partners/index.html', 'nl/partners/index.html'];
/* A link to the page itself, not the #programme anchor the footer has always
   carried. */
const linkIn = /href="\/(?:fr\/|nl\/)?programme\//;

test('hidden while the flag is off: noindex, out of the sitemap, nothing links in', { skip: PUBLIC }, () => {
  for (const [name, h] of Object.entries(html)) {
    assert.match(h, /<meta name="robots" content="noindex, nofollow">/,
      `${name} is missing its noindex`);
  }
  assert.ok(!read('sitemap.xml').includes('/programme'), 'sitemap names the programme while it is hidden');
  /* Only the six may point at each other. */
  for (const rel of [...HOME, ...PARTNERS]) {
    assert.ok(!linkIn.test(read(rel)), `${rel} links to the programme while it is hidden`);
  }
  /* The home page keeps the block it has always had until the switch. */
  for (const rel of HOME) {
    assert.ok(read(rel).includes('class="band timeline" id="programme"'), `${rel} lost its programme block`);
    assert.ok(!read(rel).includes('pg-home'), `${rel} shows the teaser while the programme is hidden`);
  }
});

test('public once the flag is on: indexed, in the sitemap, and the home page leads in', { skip: !PUBLIC }, () => {
  for (const [name, h] of Object.entries(html)) {
    assert.ok(!/<meta name="robots" content="noindex/.test(h), `${name} is still noindex`);
  }
  const sitemap = read('sitemap.xml');
  for (const path of ['/programme/', '/programme/sunday/', '/fr/programme/', '/fr/programme/sunday/',
    '/nl/programme/', '/nl/programme/sunday/']) {
    assert.ok(sitemap.includes(path), `sitemap is missing ${path}`);
  }
  /* The header nav on every page now goes to the programme. */
  for (const rel of [...HOME, ...PARTNERS]) {
    assert.ok(linkIn.test(read(rel)), `${rel} does not link to the programme`);
  }
  /* The home page: the teaser in place of the hour-by-hour block, built from
     the programme's own highlights and days, every link leading into it. */
  for (const rel of HOME) {
    const h = read(rel);
    const root = rel === 'index.html' ? '' : `/${rel.split('/')[0]}`;
    assert.ok(h.includes('class="band pg-home" id="programme"'), `${rel} has no programme teaser`);
    assert.ok(!h.includes('class="band timeline"'), `${rel} still shows the hour-by-hour block`);
    const sec = h.slice(h.indexOf('class="band pg-home"'));
    const teaser = sec.slice(0, sec.indexOf('</section>'));
    assert.equal((teaser.match(/<a class="pg-tile/g) || []).length, PR.highlights.length,
      `${rel} does not carry every highlight`);
    assert.equal((teaser.match(/class="pg-day is-open"/g) || []).length, 2,
      `${rel} should offer both days, neither marked as current`);
    assert.ok(!teaser.includes('is-here'), `${rel} marks a day as the current page`);
    for (const to of [`${root}/programme/`, `${root}/programme/sunday/`]) {
      assert.ok(teaser.includes(`href="${to}"`), `${rel} teaser does not link to ${to}`);
    }
    const hrefs = [...teaser.matchAll(/<a [^>]*href="([^"]+)"/g)].map(m => m[1]);
    for (const href of hrefs) {
      assert.ok(href.startsWith(`${root}/programme/`), `${rel} teaser links somewhere else: ${href}`);
    }
    for (const banned of ['Avenue of Lights', 'Jashn', '—']) {
      assert.ok(!teaser.includes(banned), `${rel} teaser says "${banned}"`);
    }
  }
});

/* The first build gave this page a palette and a type scale of its own, with
   the chapter colours written into the markup from the data. It read as a
   different website. The page now takes its ground and its sizes from the
   stylesheet the rest of the site uses, and these two checks keep it there. */
test('the page carries no colours of its own in the markup or the data', () => {
  for (const [name, h] of Object.entries(html)) {
    assert.ok(!/style="background/.test(mainOf(h)), `${name} sets a background inline`);
  }
  for (const ch of PR.chapters) {
    assert.equal(ch.ground, undefined, `chapter ${ch.id} still carries a ground colour`);
    assert.equal(ch.band, undefined, `chapter ${ch.id} still carries a band colour`);
  }
});

test('no heading on the page is set larger than the site allows', () => {
  const css = readFileSync(join(ROOT, 'static/diwali.css'), 'utf8');
  const block = css.slice(css.indexOf('The programme page'),
    css.indexOf('the strip above the footer'));
  /* The largest size any pg- rule may reach: 4.75rem, the party title. The
     landing page's own h1 is 6.4rem, and nothing here may pass it. */
  const sizes = [...block.matchAll(/font-size:\s*(?:clamp\([^,]+,[^,]+,\s*)?([\d.]+)(px|rem)/g)]
    .map(m => (m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1])));
  assert.ok(sizes.length > 20, 'the programme block was not found in the stylesheet');
  assert.ok(Math.max(...sizes) <= 76, `a programme rule reaches ${Math.max(...sizes)}px`);
});

test('each day shows its own acts and not the other day\'s', () => {
  const sat = html['en saturday'];
  const sun = html['en sunday'];

  /* Checked on the act cards: the highlights row above the day cards is the
     same on both days by design, and names acts from either. */
  const cardsOf = h => [...mainOf(h).matchAll(/<h3 class="pg-(?:act|feat)-name">([^<]*)<\/h3>/g)].map(m => m[1]).join('\n');
  const [satC, sunC] = [cardsOf(sat), cardsOf(sun)];
  for (const yes of ['Dr. Suryaprakash', 'The Procession']) {
    assert.ok(satC.includes(yes), `Saturday is missing ${yes}`);
    assert.ok(!sunC.includes(yes), `Sunday should not carry ${yes}`);
  }
  for (const yes of ['Kirtan Sing-Along', 'Brides of India']) {
    assert.ok(sunC.includes(yes), `Sunday is missing ${yes}`);
    assert.ok(!satC.includes(yes), `Saturday should not carry ${yes}`);
  }
  for (const both of ['Lighting the Lamps', 'Pooja for World Peace and Harmony', 'An Offering in Dance']) {
    assert.ok(sat.includes(both), `Saturday is missing ${both}`);
    assert.ok(sun.includes(both), `Sunday is missing ${both}`);
  }
});

test('the first chapter is the welcome, with its four items', () => {
  for (const [name, h] of Object.entries(html)) {
    const main = mainOf(h);
    const first = main.indexOf('<section class="pg-ch"');
    const second = main.indexOf('<section class="pg-ch"', first + 1);
    const chapterOne = main.slice(first, second);
    assert.ok(chapterOne.includes('id="chapter-welcome"'),
      `${name} does not open on chapter-welcome`);
    assert.equal((chapterOne.match(/class="pg-act"/g) || []).length, 4,
      `${name} should open with the four items of the welcome`);
  }
});

/* The highlights sit above the day cards, so they are one list for the whole
   festival: the same tiles, in the same order, on all six pages. A highlight
   that belongs to one day links to that day's page; everything else stays on
   the page it is on. */
test('the highlights are the list in the data, each pointing somewhere real', () => {
  assert.ok(PR.highlights.length >= 3, 'a carousel wants at least three highlights');
  for (const day of PR.days) {
    assert.equal(day.highlights, undefined, `${day.id} still carries highlights of its own`);
  }
  for (const [name, h] of Object.entries(html)) {
    const lang = LANG_OF(name);
    const dayId = name.split(' ')[1];
    const main = mainOf(h);
    const root = lang === 'en' ? '' : `/${lang}`;
    const pathOf = id => {
      const slug = PR.days.find(x => x.id === id).slug;
      return slug ? `${root}/programme/${slug}/` : `${root}/programme/`;
    };
    const tiles = [...main.matchAll(/<a class="pg-tile[^"]*" href="([^"]+)"/g)].map(m => m[1]);
    const want = PR.highlights.map(x =>
      (x.day && x.day !== dayId ? pathOf(x.day) : '') + x.href);
    assert.deepEqual(tiles, want, `${name} lists its highlights wrongly`);
    for (const x of PR.highlights) {
      assert.ok(x.href.startsWith('#'), `a highlight leaves the programme: ${x.href}`);
      const target = html[`${lang} ${x.day || dayId}`];
      assert.ok(mainOf(target).includes(`id="${x.href.slice(1)}"`),
        `${name}: a highlight points at ${x.href}, which is not on its page`);
    }
  }
});

test('the highlights come before the choice of day, and scroll without a script', () => {
  const css = readFileSync(join(ROOT, 'static/diwali.css'), 'utf8');
  assert.match(css, /\.pg-tiles\{[^}]*overflow-x:auto[^}]*scroll-snap-type:x/,
    'the row must scroll by hand when JavaScript is off');
  for (const [name, h] of Object.entries(html)) {
    const main = mainOf(h);
    assert.ok(main.indexOf('class="pg-tiles"') < main.indexOf('class="pg-days"'),
      `${name} puts the day cards above the highlights`);
    assert.match(main, /class="pg-miss-nav" hidden/, `${name} shows arrows that need a script`);
  }
});

test('the day bar carries four chapter shortcuts', () => {
  for (const [name, h] of Object.entries(html)) {
    const main = mainOf(h);
    const nav = main.slice(main.indexOf('<nav class="pg-bar-jump"'));
    const links = [...nav.slice(0, nav.indexOf('</nav>')).matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    assert.equal(links.length, PR.jump.length, `${name} has ${links.length} shortcuts, not four`);
    assert.deepEqual(links, PR.jump.map(j => j.href), `${name} shortcuts are in the wrong order`);
    for (const href of links) {
      assert.ok(main.includes(`id="${href.slice(1)}"`),
        `${name} shortcut points at ${href}, which is not on the page`);
    }
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
    /* The festival has religious roots and is not a religious event. These are
       the words that made the first version read like one. */
    /* The pooja and the procession are named plainly: Ravi's call, 2 Oct. The
       pooja is the centre of the festival and is called what it is. */
    const TONE = ['Blessing', 'spiritual', 'devotion', 'd\u00e9votion',
      'devotionele', 'prayer', 'pri\u00e8re', 'gebed', 'Shobha Yatra'];
    for (const banned of ['Jashn', 'Avenue of Lights', 'weekend', ...TONE]) {
      assert.ok(!new RegExp(banned, 'i').test(main), `${name} says "${banned}"`);
    }
    const clock = main.match(/\b\d{1,2}[:.h]\d{2}\b/);
    assert.equal(clock, null, `${name} prints a clock time: ${clock && clock[0]}`);
  }
});

test('no chapter is numbered, and the small print is there', () => {
  for (const [name, h] of Object.entries(html)) {
    const lang = LANG_OF(name);
    const main = mainOf(h);
    const labels = [...main.matchAll(/<p class="pg-band-label">([\s\S]*?)<\/p>/g)].map(m => m[1]);
    assert.equal(labels.length, 4, `${name} should have four chapter bands`);
    for (const l of labels) {
      assert.ok(!l.includes(PR.ui.chapter[lang]), `${name} still numbers a chapter: ${l}`);
    }
    assert.ok(main.includes(`<p class="pg-fine">${PR.ui.disclaimer[lang]}</p>`),
      `${name} is missing the subject-to-change line`);
  }
});

test('the social links are the right ones and open in a tab of their own', () => {
  const foot = html['en saturday'].slice(html['en saturday'].indexOf('<footer'));
  const links = [...foot.matchAll(/<div class="foot-social">([\s\S]*?)<\/div>/g)][0][1];
  assert.ok(links.includes('https://www.instagram.com/artindia_brussels/'), 'the Instagram link is not the live account');
  for (const a of links.match(/<a [^>]*>/g)) {
    assert.match(a, /target="_blank" rel="noopener"/, `a social link opens in the same tab: ${a}`);
  }
});

test('the day is translated, not left in English', () => {
  /* "Traditions" is the same word in English and French, so the French page is
     checked on its date instead. */
  assert.ok(html['fr saturday'].includes('24 octobre'), '/fr/programme/ is missing its French date');
  assert.ok(html['nl saturday'].includes('Tradities'), '/nl/programme/ is missing Tradities');
  for (const name of Object.keys(html)) {
    assert.ok(!/Roots|Racines|Wortels/.test(mainOf(html[name])), `${name} still calls Saturday by its old name`);
  }
  assert.ok(html['fr sunday'].includes('Rencontres'), '/fr/programme/sunday/ is missing Rencontres');
  assert.ok(html['nl sunday'].includes('Ontmoetingen'), '/nl/programme/sunday/ is missing Ontmoetingen');
});

test('each day names itself in the tab and in a share card', () => {
  for (const [name, h] of Object.entries(html)) {
    const day = PR.days.find(x => x.id === name.split(' ')[1]);
    const want = day.title[LANG_OF(name)];
    assert.ok(h.includes(`<title>${want}</title>`), `${name} has the wrong title`);
    assert.ok(h.includes(`<meta property="og:title" content="${want}">`),
      `${name} has the wrong og:title`);
  }
  /* Two days open in two tabs have to be telling apart, which is the whole
     point of a per-day title. */
  const titles = Object.keys(PAGES).map(k =>
    html[k].match(/<title>([^<]*)<\/title>/)[1]);
  assert.equal(new Set(titles).size, titles.length, 'two pages share a title');
});

/* Not strictly the programme's business, but this is the suite that has a
   built dist-diwali to look at, and the programme pages are half of what the
   rule protects. */
test('only the home page redirects on language', () => {
  const HOME = ['index.html', 'fr/index.html', 'nl/index.html'];
  const ELSEWHERE = [
    'partners/index.html', 'fr/partners/index.html', 'nl/partners/index.html',
    ...Object.values(PAGES),
  ];

  for (const rel of HOME) {
    assert.ok(read(rel).includes('location.replace'),
      `${rel} should still send a first-time visitor to their language`);
  }
  for (const rel of ELSEWHERE) {
    assert.ok(!read(rel).includes('location.replace'),
      `${rel} would carry a visitor off the page they asked for`);
  }
  /* Every page still remembers a deliberate click on the language switch,
     which is the half that was never the problem. */
  for (const rel of [...HOME, ...ELSEWHERE]) {
    assert.ok(read(rel).includes('ai_lang'), `${rel} forgets the language choice`);
  }
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

/* Photographs arrive one at a time, so this has to hold at every stage: with
   none, with some, with all. The first version of this check demanded an empty
   folder, which meant the first photo anyone delivered broke the suite. */
test('a missing photo is normal, whether the folder is empty, part full or full', () => {
  const dir = join(ROOT, 'media/programme');
  const have = new Set(existsSync(dir)
    ? readdirSync(dir).filter(f => /\.(jpe?g|png|webp|avif)$/i.test(f))
      .map(f => f.replace(/\.[^.]+$/, '').split('--')[0])
    : []);

  const main = mainOf(html['en saturday']);
  assert.ok(main.includes('The Heritage'), 'the page is whole whatever photos exist');
  if (have.size === 0) {
    assert.ok(!main.includes('<picture'), 'no photos means no picture elements');
  }

  /* Every act without a photo is a card without a picture: no placeholder
     box, no broken image. */
  const cards = main.split('<article class="pg-act">').slice(1).map(c => c.split('</article>')[0]);
  const saturday = PR.days.find(x => x.id === 'saturday');
  const ids = Object.values(saturday.chapters).flat();
  assert.equal(cards.length, ids.length, 'one card per Saturday act');
  ids.forEach((id, i) => {
    assert.equal(cards[i].includes('<picture'), have.has(id),
      `${id}: the card and the folder disagree about whether a photo exists`);
  });
});

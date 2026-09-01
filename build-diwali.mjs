#!/usr/bin/env node
/**
 * diwali.artindia.be
 *
 *   node build-diwali.mjs   →  dist-diwali/
 *
 * Dark ground, image-led, almost no chrome. The festival is lamps in the
 * dark, so the site is too: deep indigo, marigold, and photographs doing
 * the talking.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Images } from './images.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = 'https://diwali.artindia.be';
const d = JSON.parse(readFileSync(join(HERE, 'data/diwali.json'), 'utf8'));

const IMG = new Images(join(HERE, 'media'), join(HERE, '.cache/img'));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const out = join(HERE, 'dist-diwali');

/* ---------------------------------------------------------------- lamp */
const lamp = (scale = 1) => `<svg class="lamp" viewBox="0 0 32 40" width="${28 * scale}" aria-hidden="true">
  <path class="flame" d="M16 3 C20 9 22 12 22 16 a6 6 0 0 1-12 0 c0-4 2-7 6-13z" fill="#E8A33B"/>
  <path class="flame" d="M16 9 C18 13 19 15 19 17 a3 3 0 0 1-6 0 c0-2 1-4 3-8z" fill="#F6DFA6"/>
  <path d="M4 24 h24 c-1 6-6 9-12 9 s-11-3-12-9z" fill="#8A4B2A"/></svg>`;

/* ---------------------------------------------------------------- blocks */
function hero() {
  /* The still is always rendered — it is the poster, the fallback for anyone
     with reduced motion, and what shows while the video loads. The video sits
     on top of it if there is one. */
  const still = IMG.has('diwali-hero')
    ? IMG.tag('diwali-hero', { alt: '', sizes: '100vw', eager: true })
    : '<div class="hero-fallback"></div>';

  const vids = ['diwali-hero.webm', 'diwali-hero.mp4']
    .filter(f => existsSync(join(HERE, 'media', f)));
  const media = vids.length
    ? `${still}<video class="hero-video" autoplay muted loop playsinline preload="none">${
        vids.map(f => `<source src="/static/media/${f}" type="video/${f.endsWith('webm') ? 'webm' : 'mp4'}">`).join('')
      }</video>`
    : still;
  const days = d.event.days.map(x => `<div class="day">
      <span class="day-label">${esc(x.label)}</span>
      <span class="day-date">${esc(x.date)}</span>
      <span class="day-hours">${esc(x.hours)}</span></div>`).join('<span class="day-rule"></span>');

  return `<header class="hero">
  <div class="hero-media">${media}</div>
  <div class="hero-veil"></div>
  <div class="hero-body wrap">
    <p class="kicker">${esc(d.event.edition)} · ${esc(d.event.place)}</p>
    <h1>Brussels <em>Diwali</em> Festival</h1>
    <p class="tagline">${esc(d.event.tagline)}</p>
    <div class="lamps">${Array.from({ length: 10 }, (_, i) => lamp(i === 9 ? 1.5 : 1)).join('')}</div>
    <div class="days">${days}</div>
    <div class="hero-actions">
      <a class="btn" href="#register">Weekend tickets from ${esc(d.event.price_from)}</a>
      <span class="btn-note" id="countdown">On sale 4 September</span>
    </div>
  </div>
  <a class="hero-scroll" href="#intro" aria-label="Read on"></a>
</header>`;
}

function stats() {
  return `<section class="statrow"><div class="wrap stats">${
    d.stats.map(s => `<div class="stat"><span class="n">${esc(s.n)}</span>
      <span class="l">${esc(s.label)}</span></div>`).join('')}</div></section>`;
}

function theme() {
  const t = d.theme;
  const media = IMG.has(t.image)
    ? IMG.tag(t.image, { alt: '', sizes: '(min-width:900px) 48vw, 100vw', className: 'split-img' })
    : '<div class="split-img awaiting"><span>Photograph to come</span></div>';
  const panels = t.panels.map((p, i) => `<details${i === 0 ? ' open' : ''}>
      <summary><span>${esc(p.q)}</span></summary>
      <div class="answer"><p>${esc(p.a)}</p></div></details>`).join('');
  return `<section class="band split" id="theme">
    <div class="wrap split-grid">
      <div class="split-media">${media}</div>
      <div class="split-text">
        <p class="kicker gold">${esc(t.kicker)}</p>
        <h2>${esc(t.title)}</h2>
        <div class="accordion">${panels}</div>
      </div>
    </div></section>`;
}

function intro() {
  return `<section class="band" id="intro">
  <div class="wrap col">
    <p class="kicker gold">${esc(d.intro.kicker)}</p>
    <h2>${esc(d.intro.heading)}</h2>
    ${d.intro.body.map(p => `<p class="lede">${esc(p)}</p>`).join('')}
  </div></section>`;
}

/* The four pillars. Alternating splits down the page, image and text
   swapping sides. A pillar whose photograph has not arrived yet runs as
   text at full width; an empty grey box would say less than the writing. */
function pillars() {
  return d.pillars.map((p, i) => {
    const media = IMG.has(p.image)
      ? `<div class="pillar-media">${IMG.tag(p.image, {
          alt: '', sizes: '(min-width:900px) 48vw, 100vw', className: 'pillar-img' })}</div>`
      : '';
    const text = p.body.map(x => `<p class="lede">${esc(x)}</p>`).join('');
    return `<section class="band pillar${media && i % 2 ? ' flip' : ''}${media ? '' : ' noimg'}" id="pillar-${esc(p.id)}">
    <div class="wrap pillar-grid">
      ${media}
      <div class="pillar-text">
        <p class="kicker gold">${esc(p.kicker)}</p>
        <h2>${esc(p.title)}</h2>
        ${text}
      </div>
    </div></section>`;
  }).join('');
}

function gallery() {
  /* Hide the rail until there is a real set. Two of the same photograph
     side by side looks worse than no gallery at all. */
  const seen = new Set();
  const shots = d.gallery.filter(s => {
    if (!IMG.has(s) || seen.has(s)) return false;
    seen.add(s); return true;
  });
  if (shots.length < 3) return '';
  const items = shots.map(s => `<li>${IMG.tag(s, {
    alt: '', sizes: '(min-width:900px) 46vw, 84vw', className: 'shot' })}</li>`).join('');
  return `<section class="band gallery" id="gallery">
    <div class="wrap"><h2 class="section-h">The festival</h2></div>
    <ul class="rail">${items}</ul></section>`;
}

/* Both of these stay silent until there is something real to show. An
   empty "what people say" heading is worse than no section at all, and a
   past sponsor's logo needs that sponsor's permission before it goes up. */
function quotes() {
  const q = d.quotes;
  if (!q || !q.items || !q.items.length) return '';
  const items = q.items.map(x => `<figure class="quote">
      <blockquote><p>${esc(x.text)}</p></blockquote>
      <figcaption>${esc(x.who)}${x.role ? `<span>${esc(x.role)}</span>` : ''}</figcaption>
    </figure>`).join('');
  return `<section class="band quotes" id="quotes">
    <div class="wrap">
      <p class="kicker gold">${esc(q.kicker)}</p>
      <h2 class="section-h">${esc(q.title)}</h2>
      <div class="quote-grid">${items}</div>
    </div></section>`;
}

function partners() {
  const p = d.partners;
  if (!p || !p.items || !p.items.length) return '';
  const item = x => {
    const inner = x.logo
      ? `<img src="/static/partners/${esc(x.logo)}" alt="${esc(x.name)}" loading="lazy" decoding="async">`
      : `<span>${esc(x.name)}</span>`;
    return `<li class="partner">${x.url
      ? `<a href="${esc(x.url)}" rel="noopener">${inner}</a>` : inner}</li>`;
  };
  return `<section class="band partners" id="partners">
    <div class="wrap">
      <p class="kicker gold">${esc(p.kicker)}</p>
      <h2 class="section-h">${esc(p.title)}</h2>
      ${p.note ? `<p class="lede">${esc(p.note)}</p>` : ''}
    </div>
    <ul class="partner-rail">${p.items.map(item).join('')}</ul></section>`;
}

function practical() {
  const items = d.practical.map((p, i) => `<details${i === 0 ? ' open' : ''}>
      <summary><span>${esc(p.q)}</span></summary>
      <div class="answer"><p>${esc(p.a)}</p></div></details>`).join('');
  return `<section class="band" id="practical">
    <div class="wrap col"><h2 class="section-h">Before you come</h2>
    <div class="accordion">${items}</div></div></section>`;
}

function prices() {
  const t = d.tickets;
  if (!t || !t.rows) return '';
  const rows = t.rows.map(r => `<li>
      <span class="p">${esc(r.price)}</span>
      <span class="w">${esc(r.when)}</span></li>`).join('');
  return `<ul class="prices">${rows}</ul>
    ${t.note ? `<p class="price-note">${esc(t.note)}</p>` : ''}`;
}

function register() {
  return `<section class="band register" id="register">
  <div class="wrap col">
    <p class="kicker gold">Tickets on sale 4 September 2026</p>
    <h2>Be first through the gate</h2>
    <p class="lede">Register now and we will write to you the morning tickets open. One email, nothing else.</p>
    ${prices()}
    <p class="lede ticket-note">Children under 12 come free, but they still need an event band. Register them with the rest of your booking. Everything on site is card only.</p>
    <p class="done" id="done" role="status"></p>
    <form id="signup" novalidate>
      <div class="field">
        <label class="sr" for="email">Email address</label>
        <input type="email" id="email" name="email" placeholder="your@email.com" autocomplete="email" required>
        <button class="btn" type="submit">Register</button>
      </div>
      <p class="err" id="err" role="alert"></p>
    </form>
  </div></section>`;
}

function footer() {
  const f = d.footer;
  const social = (f.social || []).filter(x => x.url).map(x =>
    `<a href="${x.url}" rel="noopener">${esc(x.name)}</a>`).join('');
  return `<footer>
  <div class="wrap foot-top">
    <p class="foot-mark">Brussels Diwali Festival</p>
    <p class="foot-motto">Sharing India with the world</p>
    ${social ? `<div class="foot-social">${social}</div>` : ''}
  </div>
  <div class="wrap foot-cols">
    <div><p class="col-h">The festival</p>
      <a href="#register">Tickets</a><a href="#theme">The theme</a>
      <a href="#practical">Practical</a>${galleryHTML ? '<a href="#gallery">Gallery</a>' : ''}</div>
    <div><p class="col-h">Art India</p>
      <a href="https://artindia.be">artindia.be</a>
      <a href="https://artindia.be/festivals/">Festivals</a>
      <a href="https://artindia.be/partners/">Partnerships</a>
      <a href="https://artindia.be/press/">Press</a></div>
    <div><p class="col-h">Contact</p>
      <a href="mailto:${f.email}">${esc(f.email)}</a>
      <a href="mailto:${f.partners_email}">${esc(f.partners_email)}</a></div>
    <div><p class="col-h">Art India ASBL</p>
      <p class="fine">${esc(f.address)}<br>VAT ${esc(f.vat)}<br>
      Non-profit association registered in Belgium</p></div>
  </div></footer>`;
}

/* ---------------------------------------------------------------- build */
for (const stem of ['diwali-hero', ...d.pillars.map(p => p.image), ...d.gallery]) {
  if (IMG.has(stem)) await IMG.prepare(stem);
}
IMG.save();

const css = readFileSync(join(HERE, 'static/diwali.css'), 'utf8');
const CSSV = createHash('sha1').update(css).digest('hex').slice(0, 8);

const jsonld = JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Festival',
  name: `${d.event.name} 2026`,
  startDate: '2026-10-24', endDate: '2026-10-25',
  eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
  eventStatus: 'https://schema.org/EventScheduled',
  location: { '@type': 'Place', name: 'Atomium Esplanade',
    address: { '@type': 'PostalAddress', addressLocality: 'Brussels', addressCountry: 'BE' } },
  organizer: { '@type': 'Organization', name: 'Art India ASBL', url: 'https://artindia.be' },
  offers: { '@type': 'Offer', price: '10', priceCurrency: 'EUR',
    availability: 'https://schema.org/PreOrder', validFrom: '2026-09-04', url: SITE },
});

const galleryHTML = gallery();

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brussels Diwali Festival 2026, 10th edition, 24 &amp; 25 October, Atomium</title>
<meta name="description" content="The tenth Brussels Diwali Festival, 24 and 25 October 2026 on the esplanade of the Atomium. Music, dance, food and light. Tickets from €10.">
<link rel="canonical" href="${SITE}/">
<meta property="og:type" content="website">
<meta property="og:title" content="Brussels Diwali Festival 2026, 10th edition">
<meta property="og:description" content="${esc(d.event.tagline)}. 24 &amp; 25 October 2026, Atomium esplanade. Tickets from €10.">
<meta property="og:url" content="${SITE}/">
<meta property="og:image" content="${SITE}/og-diwali.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0B0E24">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Rozha+One&family=Mukta:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/diwali.css?v=${CSSV}">
<script type="application/ld+json">${jsonld}</script>
</head>
<body>
<a class="skip" href="#intro">Skip to content</a>
<nav class="topbar">
  <div class="wrap bar">
    <a class="brand" href="/"><span>Brussels Diwali Festival</span></a>
    <div class="bar-right">
      <a class="bar-org" href="https://artindia.be">
        <img class="bar-logo" src="/static/logo-mark.png" alt="Art India" width="28" height="32">
        <span>Art India</span></a>
      <a class="bar-cta" href="#register">Tickets</a>
    </div>
  </div>
</nav>
<div class="pillbar">
  <div class="pill">
    <span class="pill-name">Brussels Diwali</span>
    <span class="pill-rule"></span>
    ${d.nav.filter(n => n.href !== '#gallery' || galleryHTML)
        .map((n, i) => `<a href="${n.href}"${i === 0 ? ' class="on"' : ''}>${esc(n.label)}</a>`).join('')}
  </div>
</div>
${hero()}
<main>
${stats()}
${intro()}
${pillars()}
${theme()}
${quotes()}
${galleryHTML}
${practical()}
${partners()}
${register()}
</main>
${footer()}
<div class="stickybar">
  <div class="wrap sb-in">
    <span class="sb-txt">Weekend tickets from ${esc(d.event.price_from)}</span>
    <a class="sb-cta" href="#register">Get tickets</a>
  </div>
</div>
<script>
const SALE = new Date("${d.event.sale_opens}");
const TICKET_URL = ${JSON.stringify(d.event.ticket_url || '')};
const el = document.getElementById('countdown');
if (el) {
  const days = Math.ceil((SALE - new Date()) / 86400000);
  el.textContent = days > 0 ? days + ' days until tickets open' : 'On sale now';
}

/* The sale switch. General sale opens eight hours after the registration
   mail goes out, so 18:00 on 4 September. Until that moment, and for as
   long as ticket_url is empty, every ticket button keeps scrolling to the
   registration form. Two conditions and nothing else: no other states, and
   no URL parameter that can flip it early. An empty ticket_url is the hard
   stop, so the clock passing on its own changes nothing. */
const OPEN_AT = new Date(SALE.getTime() + 8 * 3600 * 1000);
if (TICKET_URL && new Date() >= OPEN_AT) {
  for (const a of document.querySelectorAll('.hero-actions .btn, .bar-cta, .sb-cta')) {
    a.href = TICKET_URL;
    a.textContent = 'Buy tickets';
    a.rel = 'noopener';
  }
}
/* The form stays usable after a success: a family registering three people
   should get through three addresses without reloading. Both messages are
   live regions that collapse when empty, so nothing is toggled with
   [hidden]. .field is display:flex, and an author display rule beats the
   [hidden] one, which is how the field used to stay on screen with the
   previous address still in it. */
const FORM_ENDPOINT = "/api/register";
const DONE_MSG = "You're on the list. We'll write on 4 September.";
const EMAIL_RE = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/;

const form = document.getElementById('signup');
const err = document.getElementById('err'), done = document.getElementById('done');
const btn = form.querySelector('button');
const BTN_LABEL = btn.textContent;   /* captured once, before anything can overwrite it */

/* The error goes the moment they start correcting it. */
form.email.addEventListener('input', () => { err.textContent = ''; });

form.addEventListener('submit', async e => {
  e.preventDefault();
  /* Clear the previous confirmation while this one is in flight, so the
     message on screen always belongs to the address just submitted. */
  done.textContent = '';

  const email = form.email.value.trim();
  if (!EMAIL_RE.test(email)) {
    err.textContent = "That email address doesn't look right.";
    form.email.focus();
    return;
  }
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Registering…';

  try {
    const r = await fetch(FORM_ENDPOINT, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: 'diwali-2026' }) });
    if (!r.ok) throw new Error('failed');
    form.reset();                 /* empty the field, ready for the next address */
    done.textContent = DONE_MSG;
    form.email.focus();
  } catch (_) {
    /* Whatever they typed stays put so they can just press Register again. */
    err.textContent = "Something went wrong. Please try again, or write to diwali@artindia.be.";
  } finally {
    /* Every path out of the handler, success and network failure alike. */
    btn.disabled = false;
    btn.textContent = BTN_LABEL;
  }
});
</script>
</body>
</html>
`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), html);
cpSync(join(HERE, 'static/diwali.css'), join(out, 'diwali.css'));
for (const f of ['favicon.svg', 'og-diwali.png', '_redirects']) {
  const p = join(HERE, 'diwali-holding', f);
  if (existsSync(p)) cpSync(p, join(out, f));
}
/* Art India mark in the top bar — the organiser's logo, not the festival's. */
{
  const p = join(HERE, 'static/brand/logo-mark.png');
  if (existsSync(p)) {
    mkdirSync(join(out, 'static'), { recursive: true });
    cpSync(p, join(out, 'static/logo-mark.png'));
  }
}
/* Partner logos, once there are any and once each one is cleared for use. */
if (existsSync(join(HERE, 'static/partners'))) {
  cpSync(join(HERE, 'static/partners'), join(out, 'static/partners'), { recursive: true });
}
if (existsSync(join(HERE, '.cache/img'))) {
  cpSync(join(HERE, '.cache/img'), join(out, 'static/img'), { recursive: true });
}
for (const f of ['diwali-hero.mp4', 'diwali-hero.webm']) {
  const p = join(HERE, 'media', f);
  if (existsSync(p)) {
    mkdirSync(join(out, 'static/media'), { recursive: true });
    cpSync(p, join(out, 'static/media', f));
  }
}
if (existsSync(join(HERE, 'functions'))) {
  cpSync(join(HERE, 'functions'), join(out, 'functions'), { recursive: true });
}
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${SITE}/</loc></url>\n</urlset>\n`);

console.log(`\n${IMG.report()}`);
console.log(`Built diwali.artindia.be → dist-diwali/\n`);

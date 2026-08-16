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
  const media = IMG.has('diwali-hero')
    ? IMG.tag('diwali-hero', { alt: '', sizes: '100vw', eager: true })
    : '<div class="hero-fallback"></div>';
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
    <div class="lamps">${Array.from({ length: 10 }, (_, i) => lamp(i === 9 ? 1.5 : 1)).join('')}</div>
    <div class="days">${days}</div>
    <div class="hero-actions">
      <a class="btn" href="#register">Tickets from ${esc(d.event.price_from)}</a>
      <span class="btn-note" id="countdown">On sale 5 September</span>
    </div>
  </div>
  <a class="hero-scroll" href="#intro" aria-label="Read on"></a>
</header>`;
}

function intro() {
  return `<section class="band" id="intro">
  <div class="wrap col">
    <p class="kicker gold">${esc(d.intro.kicker)}</p>
    <h2>${esc(d.intro.heading)}</h2>
    ${d.intro.body.map(p => `<p class="lede">${esc(p)}</p>`).join('')}
  </div></section>`;
}

function highlights() {
  const cards = d.highlights.map(h => {
    const media = IMG.has(h.image)
      ? IMG.tag(h.image, { alt: '', sizes: '(min-width:900px) 33vw, 100vw', className: 'card-img' })
      : '<div class="card-img awaiting"><span>Photograph to come</span></div>';
    return `<article class="card">
      ${media}
      <div class="card-body">
        <p class="kicker gold">${esc(h.kicker)}</p>
        <h3>${esc(h.title)}</h3>
        <p>${esc(h.text)}</p>
        <a class="more" href="${h.href}">${esc(h.cta)}</a>
      </div></article>`;
  }).join('');
  return `<section class="band" id="highlights">
    <div class="wrap"><h2 class="section-h">Highlights</h2>
    <div class="cards">${cards}</div></div></section>`;
}

function gallery() {
  const shots = d.gallery.filter(s => IMG.has(s));
  if (!shots.length) return '';
  const items = shots.map(s => `<li>${IMG.tag(s, {
    alt: '', sizes: '(min-width:900px) 46vw, 84vw', className: 'shot' })}</li>`).join('');
  return `<section class="band gallery" id="gallery">
    <div class="wrap"><h2 class="section-h">The festival</h2></div>
    <ul class="rail">${items}</ul></section>`;
}

function practical() {
  const items = d.practical.map((p, i) => `<details${i === 0 ? ' open' : ''}>
      <summary><span>${esc(p.q)}</span></summary>
      <div class="answer"><p>${esc(p.a)}</p></div></details>`).join('');
  return `<section class="band" id="practical">
    <div class="wrap col"><h2 class="section-h">Before you come</h2>
    <div class="accordion">${items}</div></div></section>`;
}

function register() {
  return `<section class="band register" id="register">
  <div class="wrap col">
    <p class="kicker gold">Tickets on sale 5 September 2026</p>
    <h2>Be first through the gate</h2>
    <p class="lede">Register now and we will write to you the morning tickets open — one email, nothing else.</p>
    <form id="signup" novalidate>
      <div class="field">
        <label class="sr" for="email">Email address</label>
        <input type="email" id="email" name="email" placeholder="your@email.com" autocomplete="email" required>
        <button class="btn" type="submit">Register</button>
      </div>
      <p class="err" id="err" role="alert" hidden></p>
      <p class="done" id="done" role="status" hidden>You're on the list. We'll write on 5 September.</p>
    </form>
  </div></section>`;
}

function footer() {
  const f = d.footer;
  return `<footer><div class="wrap foot">
    <div><p class="motto">Sharing India with the world</p>
      <p class="fine">${esc(f.org)}<br>${esc(f.address)}<br>VAT ${esc(f.vat)}</p></div>
    <div><p class="kicker gold">Contact</p>
      <p><a href="mailto:${f.email}">${esc(f.email)}</a><br>
         <a href="mailto:${f.partners_email}">${esc(f.partners_email)}</a></p></div>
    <div><p class="kicker gold">Art India</p>
      <p><a href="https://artindia.be">artindia.be</a><br>
         <a href="https://artindia.be/partners/">Partnerships</a><br>
         <a href="https://artindia.be/press/">Press</a></p></div>
  </div></footer>`;
}

/* ---------------------------------------------------------------- build */
for (const stem of ['diwali-hero', ...d.highlights.map(h => h.image), ...d.gallery]) {
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
    availability: 'https://schema.org/PreOrder', validFrom: '2026-09-05', url: SITE },
});

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brussels Diwali Festival 2026 — 10th edition, 24 &amp; 25 October, Atomium</title>
<meta name="description" content="The tenth Brussels Diwali Festival, 24 and 25 October 2026 on the esplanade of the Atomium. Music, dance, food and light. Tickets from €10.">
<link rel="canonical" href="${SITE}/">
<meta property="og:type" content="website">
<meta property="og:title" content="Brussels Diwali Festival 2026 — 10th edition">
<meta property="og:description" content="24 &amp; 25 October 2026, Atomium esplanade. Tickets from €10.">
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
      <a class="bar-link" href="#practical">Practical</a>
      <a class="bar-cta" href="#register">Tickets</a>
    </div>
  </div>
</nav>
${hero()}
<main>
${intro()}
${highlights()}
${gallery()}
${practical()}
${register()}
</main>
${footer()}
<script>
const SALE = new Date("${d.event.sale_opens}");
const el = document.getElementById('countdown');
if (el) {
  const days = Math.ceil((SALE - new Date()) / 86400000);
  el.textContent = days > 0 ? days + ' days until tickets open' : 'On sale now';
}
const FORM_ENDPOINT = "";
const form = document.getElementById('signup');
const err = document.getElementById('err'), done = document.getElementById('done');
form.addEventListener('submit', async e => {
  e.preventDefault();
  const email = form.email.value.trim();
  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) {
    err.textContent = "That email address doesn't look right."; err.hidden = false;
    form.email.focus(); return;
  }
  err.hidden = true;
  if (FORM_ENDPOINT) {
    try { await fetch(FORM_ENDPOINT, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: 'diwali-2026' }) }); } catch (_) {}
  }
  form.querySelector('.field').hidden = true;
  done.hidden = false;
});
</script>
</body>
</html>
`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), html);
cpSync(join(HERE, 'static/diwali.css'), join(out, 'diwali.css'));
for (const f of ['favicon.svg', 'og-diwali.png']) {
  const p = join(HERE, 'diwali-holding', f);
  if (existsSync(p)) cpSync(p, join(out, f));
}
if (existsSync(join(HERE, '.cache/img'))) {
  cpSync(join(HERE, '.cache/img'), join(out, 'static/img'), { recursive: true });
}
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${SITE}/</loc></url>\n</urlset>\n`);

console.log(`\n${IMG.report()}`);
console.log(`Built diwali.artindia.be → dist-diwali/\n`);

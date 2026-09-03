#!/usr/bin/env node
/**
 * diwali.artindia.be
 *
 *   node build-diwali.mjs   →  dist-diwali/      (EN)
 *                              dist-diwali/fr/   (FR)
 *
 * Dark ground, image-led, almost no chrome. The festival is lamps in the
 * dark, so the site is too: deep indigo, marigold, and photographs doing
 * the talking.
 *
 * Both languages are rendered from one data/diwali.json, so the sale switch,
 * the prices and the dates cannot drift apart between them. Every visitor
 * facing string is { en, fr } and t() throws on a missing translation rather
 * than quietly serving English to a French reader.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Images } from './images.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = 'https://diwali.artindia.be';
const d = JSON.parse(readFileSync(join(HERE, 'data/diwali.json'), 'utf8'));

const LANGS = ['en', 'fr', 'nl'];
const PATH_OF = { en: '/', fr: '/fr/', nl: '/nl/' };
/* Dutch is region tagged: the copy is Flemish, and a Dutch reader in the
   Netherlands should not be told this is written for them. */
const HREFLANG = { en: 'en', fr: 'fr', nl: 'nl-BE' };
const OG_LOCALE = { en: 'en_GB', fr: 'fr_BE', nl: 'nl_BE' };

const IMG = new Images(join(HERE, 'media'), join(HERE, '.cache/img'));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Is the sale open at the moment this build runs? When it is, the live state
   is baked straight into the HTML: correct without JavaScript, and no flash of
   "tickets open Friday" before a script rewrites it. The runtime switch below
   is only emitted when the build happens ahead of the sale, so a page built
   early still flips on its own. */
const SALE_AT = new Date(d.event.sale_opens);
const LIVE = Boolean(d.event.ticket_url) && new Date() >= SALE_AT;
/* An embedded checkout only exists once a widget URL has been pasted in from
   the Ticket Tailor dashboard. Until then the CTAs keep going straight to the
   box office: adding a hop to a live sale to reach an empty box would cost
   orders. widget_url is the hard stop, exactly as ticket_url is for LIVE. */
const EMBED = LIVE && Boolean(d.event.widget_url);
const TICKETS_HREF = EMBED ? '#tickets' : (LIVE ? d.event.ticket_url : '#register');
const CTA_EXTERNAL = LIVE && !EMBED;

const out = join(HERE, 'dist-diwali');

const FLAGS = d.flags || {};
const PRACTICAL_ON = FLAGS.practical_enabled !== false;
const HERO_VIDEO_ON = FLAGS.hero_video_enabled === true;

/* Panel photographs live in media/panels/<panel>/01.jpg and are discovered at
   build time, so adding a gallery is dropping files in a folder. Nothing is
   rendered unless the flag is on AND that panel actually has pictures: an
   empty frame or a stock placeholder says less than the writing does. */
function panelShots(id) {
  if (!FLAGS.galleries_enabled) return [];
  const dir = join(HERE, 'media/panels', id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /\.(jpe?g|png|webp|avif)$/i.test(f))
    .sort()
    .slice(0, 5);
}

/* ---------------------------------------------------------------- lamp */
const lamp = (scale = 1) => `<svg class="lamp" viewBox="0 0 32 40" width="${28 * scale}" aria-hidden="true">
  <path class="flame" d="M16 3 C20 9 22 12 22 16 a6 6 0 0 1-12 0 c0-4 2-7 6-13z" fill="#E8A33B"/>
  <path class="flame" d="M16 9 C18 13 19 15 19 17 a3 3 0 0 1-6 0 c0-2 1-4 3-8z" fill="#F6DFA6"/>
  <path d="M4 24 h24 c-1 6-6 9-12 9 s-11-3-12-9z" fill="#8A4B2A"/></svg>`;

/* ================================================================ page */
function render(lang) {
  /* Picks the language, and refuses to fall back. A missing translation is a
     build failure, not a page that is half English. */
  const t = v => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (v[lang] == null) throw new Error(`missing ${lang} for: ${JSON.stringify(v).slice(0, 90)}`);
    return v[lang];
  };
  const e = v => esc(t(v));
  const PRICE = t(d.event.price_from);

  /* ------------------------------------------------------------ hero */
  function hero() {
    /* Plain indigo until the final photograph arrives. The still and the video
       are the same decision: showing last year's crowd shot behind this year's
       title is worse than showing nothing, and a flag keeps the markup and the
       encodes ready rather than deleting them.

       With the flag on, the still is always rendered too. It is the poster,
       the fallback for reduced motion, and what shows while the video loads. */
    const still = IMG.has('diwali-hero')
      ? IMG.tag('diwali-hero', { alt: '', sizes: '100vw', eager: true })
      : '<div class="hero-fallback"></div>';
    const vids = HERO_VIDEO_ON
      ? ['diwali-hero.webm', 'diwali-hero.mp4'].filter(f => existsSync(join(HERE, 'media', f)))
      : [];
    const media = !HERO_VIDEO_ON
      ? '<div class="hero-fallback"></div>'
      : vids.length
        ? `${still}<video class="hero-video" autoplay muted loop playsinline preload="none">${
            vids.map(f => `<source src="/static/media/${f}" type="video/${f.endsWith('webm') ? 'webm' : 'mp4'}">`).join('')
          }</video>`
        : still;
    const days = d.event.days.map(x => `<div class="day">
        <span class="day-label">${e(x.label)}</span>
        <span class="day-date">${e(x.date)}</span>
        <span class="day-hours">${e(x.hours)}</span></div>`).join('<span class="day-rule"></span>');

    return `<header class="hero" id="top">
  <div class="hero-media">${media}</div>
  <div class="hero-veil"></div>
  <div class="hero-body wrap">
    <p class="kicker">${e(d.event.edition)} · ${e(d.event.scale)} · ${e(d.event.place)}</p>
    <h1>Brussels <em>Diwali</em> Festival</h1>
    <p class="tagline">${e(d.event.tagline)}</p>
    <p class="hero-line">${e(d.event.hero_line)}</p>
    <div class="lamps">${Array.from({ length: 10 }, (_, i) => lamp(i === 9 ? 1.5 : 1)).join('')}</div>
    <div class="days">${days}</div>
    <div class="hero-actions">
      <a class="btn" id="hero-cta" href="${esc(TICKETS_HREF)}"${CTA_EXTERNAL ? ' rel="noopener"' : ''}>${
        e(LIVE ? d.tickets.cta_live : d.tickets.cta_presale)}</a>
      <span class="btn-note" id="cta-note">${e(d.event.cta_note)}</span>
    </div>
  </div>
  <a class="hero-scroll" href="#awaits" aria-label="${e(d.ui.read_on)}"></a>
</header>`;
  }

  /* --------------------------------------------- what awaits you (B2) */
  /* Five senses, five panels. Text led until the footage arrives; each panel
     is a slot a photograph or a loop can drop into without moving anything. */
  function awaits() {
    const a = d.awaits;
    const panels = a.panels.map(p => {
      const shots = panelShots(p.id);
      /* Snap scrolling rail. Rendered only when there are real photographs for
         this panel, so a panel without any looks exactly as it does today. */
      const gallery = shots.length ? `
        <div class="pgal" data-panel="${esc(p.id)}">
          <ul class="pgal-rail">${shots.map((f, i) => `<li><img
              src="/static/panels/${esc(p.id)}/${esc(f)}"
              alt="" loading="lazy" decoding="async"
              width="800" height="600"></li>`).join('')}</ul>
          ${shots.length > 1 ? `<div class="pgal-dots" aria-hidden="true">${
            shots.map((_, i) => `<span${i === 0 ? ' class="on"' : ''}></span>`).join('')}</div>` : ''}
        </div>` : '';
      return `<li class="sense${shots.length ? ' has-gal' : ''}" id="sense-${esc(p.id)}">
        <h3>${e(p.title)}</h3>
        <p>${e(p.body)}</p>${gallery}</li>`;
    }).join('');
    return `<section class="band awaits" id="awaits">
  <div class="wrap">
    <p class="kicker gold">${e(a.kicker)}</p>
    <h2 class="section-h">${e(a.heading)}</h2>
    <ul class="senses">${panels}</ul>
  </div></section>`;
  }

  /* --------------------------------------------------- timeline (B3) */
  function timeline() {
    const tl = d.timeline;
    const rows = tl.entries.map(x => `<li>
        <span class="tl-when">${e(x.when)}</span>
        <div class="tl-body"><h3>${e(x.what)}</h3><p>${e(x.note)}</p></div></li>`).join('');
    return `<section class="band timeline" id="programme">
  <div class="wrap col">
    <p class="kicker gold">${e(tl.kicker)}</p>
    <h2 class="section-h">${e(tl.heading)}</h2>
    <ol class="tl">${rows}</ol>
    <p class="tl-note">${e(tl.note)}</p>
  </div></section>`;
  }

  /* ---------------------------------------------------- tickets (A1) */
  /* Three lines and one note. The gate price is always the gate price, never
     the regular price: it is what you pay for turning up without planning. */
  function tickets() {
    const tk = d.tickets;
    const rows = tk.rows.map(r => `<li>
        <span class="t-label">${e(r.label)}</span>
        <span class="t-price">${e(r.price)}</span>
        ${r.note ? `<span class="t-note">${e(r.note)}</span>` : ''}</li>`).join('');
    const notes = (tk.notes || []).map(n => `<p class="price-note">${e(n)}</p>`).join('');

    /* The ladder is server rendered and readable the moment the page paints.
       The checkout is the heavy part, so it only mounts when the section comes
       near the viewport or someone taps a CTA. The mount reserves its height
       up front, otherwise the widget appearing would shove the page under the
       reader's thumb. Without a widget_url the section keeps the direct link,
       which is the state the sale is in today. */
    const embed = EMBED ? `
    <div class="tt-mount" id="tt-mount" data-widget="${esc(d.event.widget_url)}">
      <p class="tt-loading" id="tt-loading">${e(tk.embed_loading)}</p>
    </div>
    <p class="tt-fallback">${e(tk.embed_fallback)}
      <a id="tt-fallback-link" href="${esc(d.event.ticket_url)}" rel="noopener">${e(tk.embed_fallback_link)}</a></p>`
      : `<p class="ticket-cta"><a class="btn" id="ticket-cta" href="${esc(TICKETS_HREF)}"${CTA_EXTERNAL ? ' rel="noopener"' : ''}>${
          e(LIVE ? tk.cta_live : tk.cta_presale)}</a></p>`;

    return `<section class="band tickets" id="tickets">
  <div class="wrap col">
    <p class="kicker gold">${e(tk.kicker)}</p>
    <h2>${e(tk.heading)}</h2>
    <ul class="prices">${rows}</ul>
    ${notes}${embed}
  </div></section>`;
  }

  /* ----------------------------------------------- for the little ones */
  function kids() {
    const k = d.kids;
    return `<section class="band" id="kids">
  <div class="wrap col">
    <p class="kicker gold">${e(k.kicker)}</p>
    <h2>${e(k.heading)}</h2>
    <p class="lede">${e(k.body)}</p>
  </div></section>`;
  }

  /* --------------------------------------------- why the lamps are lit */
  function lamps() {
    const l = d.lamps;
    return `<section class="band" id="lamps">
  <div class="wrap col">
    <p class="kicker gold">${e(l.kicker)}</p>
    <h2>${e(l.heading)}</h2>
    ${l.body.map(p => `<p class="lede">${e(p)}</p>`).join('')}
  </div></section>`;
  }

  /* ------------------------------------------ culture united, compressed */
  function theme() {
    const th = d.theme;
    return `<section class="band" id="theme">
  <div class="wrap col">
    <p class="kicker gold">${e(th.kicker)}</p>
    <h2>${e(th.heading)}</h2>
    <p class="lede">${e(th.body)}</p>
  </div></section>`;
  }

  /* ------------------------------------------------ before you come */
  function practical() {
    const p = d.practical;
    const items = p.items.map((x, i) => `<details${i === 0 ? ' open' : ''}>
        <summary><span>${e(x.q)}</span></summary>
        <div class="answer"><p>${e(x.a)}</p></div></details>`).join('');
    return `<section class="band" id="practical">
  <div class="wrap col">
    <p class="kicker gold">${e(p.kicker)}</p>
    <h2 class="section-h">${e(p.heading)}</h2>
    <div class="accordion">${items}</div>
  </div></section>`;
  }

  /* Silent until the logos are cleared, one permission per logo. */
  function partners() {
    const p = d.partners;
    if (!p || !p.items || !p.items.length) return '';
    const item = x => {
      const inner = x.logo
        ? `<img src="/static/partners/${esc(x.logo)}" alt="${esc(x.name)}" loading="lazy" decoding="async">`
        : `<span>${esc(x.name)}</span>`;
      return `<li class="partner">${x.url ? `<a href="${esc(x.url)}" rel="noopener">${inner}</a>` : inner}</li>`;
    };
    return `<section class="band partners" id="partners">
  <div class="wrap">
    <p class="kicker gold">${e(p.kicker)}</p>
    <h2 class="section-h">${e(p.title)}</h2>
  </div>
  <ul class="partner-rail">${p.items.map(item).join('')}</ul></section>`;
  }

  /* ------------------------------------------------------- register */
  function register() {
    const r = d.register;
    return `<section class="band register" id="register">
  <div class="wrap col">
    <p class="kicker gold" id="reg-kicker">${e(LIVE ? r.kicker_live : r.kicker_presale)}</p>
    <h2 id="reg-heading">${e(LIVE ? r.heading_live : r.heading_presale)}</h2>
    <p class="lede" id="reg-lede">${e(LIVE ? r.lede_live : r.lede_presale)}</p>
    <p class="done" id="done" role="status"></p>
    <form id="signup" novalidate>
      <div class="field">
        <label class="sr" for="email">${e(r.email_label)}</label>
        <input type="email" id="email" name="email" placeholder="${e(r.placeholder)}" autocomplete="email" required>
        <button class="btn" type="submit">${e(r.submit)}</button>
      </div>
      <p class="err" id="err" role="alert"></p>
    </form>
  </div></section>`;
  }

  function footer() {
    const f = d.footer;
    const social = (f.social || []).filter(x => x.url).map(x =>
      `<a href="${esc(x.url)}" rel="noopener">${esc(x.name)}</a>`).join('');
    const org = lang === 'fr' ? 'https://artindia.be/fr/' : 'https://artindia.be';
    return `<footer>
  <div class="wrap foot-top">
    <p class="foot-mark">Brussels Diwali Festival</p>
    <p class="foot-motto">${e(f.motto)}</p>
    ${social ? `<div class="foot-social">${social}</div>` : ''}
  </div>
  <div class="wrap foot-cols">
    <div><p class="col-h">${e(f.col_festival)}</p>
      <a href="#tickets">${e(f.links.tickets)}</a><a href="#programme">${e(f.links.programme)}</a>${
        PRACTICAL_ON ? `<a href="#practical">${e(f.links.practical)}</a>` : ''}</div>
    <div><p class="col-h">${e(f.col_org)}</p>
      <a href="${org}">artindia.be</a>
      <a href="${org}festivals/">${e(f.links.festivals)}</a>
      <a href="${org}partners/">${e(f.links.partners)}</a>
      <a href="${org}press/">${e(f.links.press)}</a></div>
    <div><p class="col-h">${e(f.col_contact)}</p>
      <a href="mailto:${f.email}">${esc(f.email)}</a>
      <a href="mailto:${f.partners_email}">${esc(f.partners_email)}</a></div>
    <div><p class="col-h">${e(f.col_legal)}</p>
      <p class="fine">${esc(f.address)}<br>VAT ${esc(f.vat)}<br>${e(f.legal_line)}</p></div>
  </div>
  <div class="wrap foot-heritage"><p>${e(f.heritage)}</p></div>
</footer>`;
  }

  /* ------------------------------------------------------- head bits */
  const alternates = LANGS.map(l =>
    `<link rel="alternate" hreflang="${HREFLANG[l]}" href="${SITE}${PATH_OF[l]}">`).join('\n') +
    `\n<link rel="alternate" hreflang="x-default" href="${SITE}/">`;

  const ogImage = lang !== 'en' && existsSync(join(HERE, `diwali-holding/og-diwali-${lang}.png`))
    ? `/og-diwali-${lang}.png` : '/og-diwali.png';

  const jsonld = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Festival',
    name: `${t(d.event.name)} 2026`,
    inLanguage: lang,
    startDate: '2026-10-24', endDate: '2026-10-25',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    location: { '@type': 'Place', name: 'Atomium Esplanade',
      address: { '@type': 'PostalAddress', addressLocality: 'Brussels', addressCountry: 'BE' } },
    organizer: { '@type': 'Organization', name: 'Art India ASBL', url: 'https://artindia.be' },
    offers: { '@type': 'Offer', price: '10', priceCurrency: 'EUR',
      availability: LIVE ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder',
      validFrom: d.event.sale_opens.slice(0, 10),
      url: LIVE ? d.event.ticket_url : SITE + PATH_OF[lang] },
  });

  /* Language switch. Runs in the head so a French speaker never sees the
     English page paint first. A stored choice always wins, which is what
     stops the sniff from overriding someone who picked deliberately. */
/* The rule is: the page you asked for is the page you get, and it becomes
   your preference. Only the English root ever redirects, and only to honour a
   choice already made or, on a first ever visit, the browser's language.
   Enforcing the stored language on every page is what made /nl/ unreachable
   for anyone who had once clicked EN: it bounced them home before Dutch could
   paint. The click is recorded from a delegated listener in the head rather
   than a handler at the foot of the body, so a fast click cannot outrun it. */
  const langScript = `(function(){var K='ai_lang',P={en:'/',fr:'/fr/',nl:'/nl/'},
here=${JSON.stringify(lang)};
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest&&e.target.closest('#langsw a[data-lang]');
  if(a){try{localStorage.setItem(K,a.getAttribute('data-lang'));}catch(_){}}
},true);
if(here!=='en'){try{localStorage.setItem(K,here);}catch(_){}return;}
var s=null;try{s=localStorage.getItem(K);}catch(_){}
if(s){if(P[s]&&s!==here)location.replace(P[s]);return;}
var L=(navigator.languages&&navigator.languages.length)?navigator.languages:[navigator.language||''];
var want='en';
for(var i=0;i<L.length;i++){var t=(L[i]||'').toLowerCase();
 if(t.indexOf('nl')===0){want='nl';break;}
 if(t.indexOf('fr')===0){want='fr';break;}
 if(t.indexOf('en')===0){want='en';break;}}
if(want!=='en')location.replace(P[want]);})();`;

  /* One control, two shapes. A wide screen shows all three as pills; a phone
     shows the current language as a button that opens the other two, because
     three pills plus a ticket link will not fit one row at 390px. */
  const langSwitch = LANGS.map(l =>
    `<a href="${PATH_OF[l]}" hreflang="${HREFLANG[l]}" data-lang="${l}"${l === lang ? ' class="on" aria-current="true"' : ''}>${l.toUpperCase()}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="${HREFLANG[lang]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(d.meta.title)}</title>
<meta name="description" content="${e(d.meta.description)}">
<link rel="canonical" href="${SITE}${PATH_OF[lang]}">
${alternates}
<meta property="og:type" content="website">
<meta property="og:locale" content="${OG_LOCALE[lang]}">
<meta property="og:title" content="${e(d.meta.og_title)}">
<meta property="og:description" content="${e(d.meta.og_description)}">
<meta property="og:url" content="${SITE}${PATH_OF[lang]}">
<meta property="og:image" content="${SITE}${ogImage}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0B0E24">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Rozha+One&family=Mukta:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/diwali.css?v=${CSSV}">
<!-- Cloudflare Web Analytics. Cookie free, so it needs no consent banner,
     which is the whole reason it is here rather than GA4.
     [DECISION: CF_ANALYTICS_TOKEN] Paste the token from the Cloudflare
     dashboard and uncomment. Shipping it with a placeholder token would
     send every visitor a request that 400s, so it stays commented.
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "CF_ANALYTICS_TOKEN"}'></script>
-->
<script>${langScript}</script>
<script type="application/ld+json">${jsonld}</script>
</head>
<body>
<a class="skip" href="#awaits">${e(d.ui.skip)}</a>
<nav class="topbar">
  <div class="wrap bar">
    <div class="bar-left">
      <a class="bar-org" href="https://artindia.be" target="_blank" rel="noopener" title="Art India">
        <img class="bar-logo" src="/static/logo-mark.png" alt="Art India" width="39" height="48"></a>
      <a class="brand" href="${PATH_OF[lang]}"><span class="wm-a">Brussels Diwali</span><span class="wm-b"> Festival</span></a>
    </div>
    <div class="bar-right">
      <div class="langsw" id="langsw" role="group" aria-label="${e(d.ui.lang_label)}">
        <button type="button" class="lang-cur" id="lang-cur" aria-expanded="false"
                aria-controls="lang-list" aria-label="${e(d.ui.lang_label)}">${lang.toUpperCase()}<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
        <div class="lang-list" id="lang-list">${langSwitch}</div>
      </div>
      <a class="bar-cta" href="${esc(TICKETS_HREF)}"${CTA_EXTERNAL ? ' rel="noopener"' : ''}>${
        e(LIVE ? d.tickets.cta_short : d.tickets.kicker)}</a>
    </div>
  </div>
</nav>
<div class="pillbar" id="pillbar">
  <div class="pill">
    <span class="pill-name">Brussels Diwali</span>
    <span class="pill-rule"></span>
    ${d.nav.filter(n => PRACTICAL_ON || n.href !== '#practical')
        .map((n, i) => `<a href="${esc(n.href)}"${i === 0 ? ' class="on"' : ''}>${e(n.label)}</a>`).join('')}
  </div>
</div>
${hero()}
<main>
${awaits()}
${timeline()}
${tickets()}
${kids()}
${lamps()}
${theme()}
${PRACTICAL_ON ? practical() : ''}
${partners()}
${register()}
</main>
${footer()}
<div class="stickybar" id="stickybar"${LIVE ? '' : ' style="display:none"'}>
  <div class="wrap sb-in">
    <span class="sb-txt">${e(d.ui.sticky_txt)}</span>
    <a class="sb-cta" href="${esc(CTA_EXTERNAL ? d.event.ticket_url : '#tickets')}"${CTA_EXTERNAL ? ' rel="noopener"' : ''}>${e(d.ui.sticky_cta)}</a>
  </div>
</div>
<script>
const SALE = new Date("${d.event.sale_opens}");
const TICKET_URL = ${JSON.stringify(d.event.ticket_url || '')};
const PRICE_FROM = ${JSON.stringify(PRICE)};
const LANG = ${JSON.stringify(lang)};

/* The pill stays with the reader. It compacts once the hero is behind them,
   and marks whichever section they are actually looking at. On phones the
   bottom ticket bar already owns fixed space, so the pill is left to scroll
   away rather than eat a second slice of a small screen. */
/* The masthead and the pill are measured rather than guessed. Their heights
   change with the language, the viewport and whether the bar has wrapped, and
   every hardcoded offset here has been wrong at least once. */
(() => {
  const root = document.documentElement;
  const top = document.querySelector('.topbar');
  const bar = document.getElementById('pillbar');
  const hero = document.querySelector('.hero');
  const sticky = document.getElementById('stickybar');
  if (!bar) return;
  const links = [...bar.querySelectorAll('a[href^="#"]')];
  const targets = links
    .map(a => ({ a, el: document.getElementById(a.getAttribute('href').slice(1)) }))
    .filter(x => x.el);

  const measure = () => {
    if (top) root.style.setProperty('--hdr', Math.round(top.getBoundingClientRect().height) + 'px');
    const pill = bar.querySelector('.pill');
    if (pill) root.style.setProperty('--pill', Math.round(pill.getBoundingClientRect().height) + 'px');
  };

  /* Below this width the pill is left in the flow entirely: a phone has no
     room for two fixed strips, and a half pill clipped under the masthead is
     worse than no pill at all. */
  const isPhone = () => window.matchMedia('(max-width: 820px)').matches;

  let ticking = false;
  const update = () => {
    ticking = false;
    /* Read where the hero actually is now, rather than deriving it from
       offsetTop and offsetHeight. Those are measured against the offset parent
       and go stale while fonts and images settle the layout, which had the
       bottom bar staying hidden on one language and not another. */
    const past = hero
      ? hero.getBoundingClientRect().bottom <= 140
      : scrollY > 120;
    bar.classList.toggle('stuck', past && !isPhone());
    bar.classList.toggle('compact', past && !isPhone());
    /* The bottom bar waits until the hero is behind you, so its button and the
       hero's are never the same gold on the same screen. */
    if (sticky) sticky.classList.toggle('show', past);
    if (!targets.length) return;
    const line = innerHeight * 0.34;
    let current = targets[0];
    for (const t of targets) {
      if (t.el.getBoundingClientRect().top <= line) current = t;
    }
    for (const t of targets) t.a.classList.toggle('on', t === current);
  };
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };
  measure();
  update();
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', () => { measure(); onScroll(); }, { passive: true });
  addEventListener('hashchange', onScroll);
  /* Landing on a link that already carries an anchor scrolls the page without
     necessarily firing a scroll event first, which left someone arriving at
     /#tickets with no bottom bar until they moved. Re-check once the images
     and fonts have settled the layout, and once more on load. */
  addEventListener('load', () => { measure(); update(); });
  setTimeout(() => { measure(); update(); }, 0);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); update(); });
})();

/* The phone language menu. The list is the same three links the desktop shows
   as pills, so there is one set of hrefs and one place the choice is stored. */
(() => {
  const wrap = document.getElementById('langsw');
  const btn = document.getElementById('lang-cur');
  if (!wrap || !btn) return;
  const close = () => { wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = wrap.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
})();

/* Panel galleries. Nothing here runs until a panel actually has photographs,
   so the whole block is inert while the flag is off. The dots follow the rail
   rather than driving it: the rail is a plain scroller, which is what makes it
   work with a thumb, a trackpad and a keyboard without any of our help. */
(() => {
  const gals = document.querySelectorAll('.pgal');
  if (!gals.length) return;
  for (const g of gals) {
    const rail = g.querySelector('.pgal-rail');
    const dots = [...g.querySelectorAll('.pgal-dots span')];
    if (!rail || dots.length < 2) continue;
    let t = false;
    rail.addEventListener('scroll', () => {
      if (t) return;
      t = true;
      requestAnimationFrame(() => {
        t = false;
        const i = Math.round(rail.scrollLeft / rail.clientWidth);
        dots.forEach((d, n) => d.classList.toggle('on', n === i));
      });
    }, { passive: true });
  }
})();

/* Campaign origin. Captured on landing and kept for the session, so a visitor
   who arrives from a poster QR code and buys twenty minutes later still counts
   as the poster's sale in Ticket Tailor. */
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'];
const utm = {};
try {
  const q = new URLSearchParams(location.search);
  for (const k of UTM_KEYS) if (q.get(k)) sessionStorage.setItem(k, q.get(k));
  for (const k of UTM_KEYS) utm[k] = sessionStorage.getItem(k) || '';
} catch (_) { for (const k of UTM_KEYS) utm[k] = ''; }

/* The embedded checkout. Ticket Tailor's widget script reads its settings off
   its own script tag and swaps itself for an iframe, so mounting means writing
   the tag into the reserved box at the moment we want it. Three triggers, and
   whichever comes first wins: the section nears the viewport, someone taps a
   CTA, or the anchor is already in the URL on arrival.

   ref carries the campaign origin, so an order still counts against the poster
   or the Instagram bio it came from. lang keeps the checkout in the language of
   the page around it. */
const mountWidget = (() => {
  let armed = false, done = false;
  function mount() {
    if (done) return;
    const box = document.getElementById('tt-mount');
    if (!box) return;
    done = true;
    const s = document.createElement('script');
    s.src = 'https://cdn.tickettailor.com/js/widgets/min/widget.js';
    s.setAttribute('data-url', box.dataset.widget);
    s.setAttribute('data-type', 'inline');
    s.setAttribute('data-inline-minimal', 'false');
    s.setAttribute('data-inline-show-logo', 'false');
    s.setAttribute('data-inline-lang', LANG);
    if (utm.utm_source) s.setAttribute('data-inline-ref', utm.utm_source);
    /* If the script cannot load at all, say so rather than leaving a box that
       spins for ever. The direct link underneath is always there. */
    s.onerror = () => {
      const l = document.getElementById('tt-loading');
      if (l) l.classList.add('failed');
    };
    box.appendChild(s);
    /* The loading line sits under the iframe until the widget paints over it. */
    const seen = new MutationObserver(() => {
      if (box.querySelector('iframe')) {
        box.classList.add('loaded');
        seen.disconnect();
      }
    });
    seen.observe(box, { childList: true, subtree: true });
  }
  return {
    arm() {
      if (armed) return;
      armed = true;
      const box = document.getElementById('tt-mount');
      if (!box) return;
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver(es => {
          if (es.some(x => x.isIntersecting)) { io.disconnect(); mount(); }
        }, { rootMargin: '600px 0px' });
        io.observe(box);
      } else {
        mount();
      }
      /* Tapping any ticket CTA should not wait for the scroll to finish. */
      for (const a of document.querySelectorAll('#hero-cta, .bar-cta, .sb-cta')) {
        a.addEventListener('click', mount, { once: true });
      }
      if (location.hash === '#tickets') mount();
    },
    mount,
  };
})();

/* The sale switch. sale_opens is the moment tickets go live, with no offset
   applied to it. When the page was built after that moment the live state is
   already in the HTML and this block simply re-applies it, which is what lets
   it add the campaign ref without a second code path. An empty ticket_url is
   still the hard stop, and no URL parameter can flip it early. */
const SALE_LIVE = Boolean(TICKET_URL) && new Date() >= SALE;
const EMBED = ${JSON.stringify(EMBED)};

/* The box office link, carrying the campaign origin. Used by the fallback
   line under the widget, and by the CTAs when there is no widget. */
function boxOffice() {
  let href = TICKET_URL;
  if (utm.utm_source) {
    href += (href.includes('?') ? '&' : '?') + 'ref=' + encodeURIComponent(utm.utm_source);
  }
  return href;
}

if (SALE_LIVE) {
  const href = boxOffice();
  if (!EMBED) {
    for (const a of document.querySelectorAll('#hero-cta, #ticket-cta, .bar-cta, .sb-cta')) {
      a.href = href;
      a.rel = 'noopener';
    }
  }
  const fb = document.getElementById('tt-fallback-link');
  if (fb) fb.href = href;
  const L = ${JSON.stringify({
    cta_live: t(d.tickets.cta_live), cta_short: t(d.tickets.cta_short),
    kicker: t(d.register.kicker_live), heading: t(d.register.heading_live),
    lede: t(d.register.lede_live),
  })};
  for (const a of document.querySelectorAll('#hero-cta, #ticket-cta')) a.textContent = L.cta_live;
  if (EMBED) mountWidget.arm();
  const barCta = document.querySelector('.bar-cta');
  if (barCta) barCta.textContent = L.cta_short;
  const rk = document.getElementById('reg-kicker');
  const rh = document.getElementById('reg-heading');
  const rl = document.getElementById('reg-lede');
  if (rk) rk.textContent = L.kicker;
  if (rh) rh.textContent = L.heading;
  if (rl) rl.textContent = L.lede;
  /* Clears the inline rule so the stylesheet decides again: visible on
     phones, still hidden on desktop. */
  const sb = document.getElementById('stickybar');
  if (sb) sb.style.display = '';
}

/* The form stays usable after a success: a family registering three people
   should get through three addresses without reloading. Both messages are
   live regions that collapse when empty, so nothing is toggled with
   [hidden]. .field is display:flex, and an author display rule beats the
   [hidden] one, which is how the field used to stay on screen with the
   previous address still in it. */
const FORM_ENDPOINT = "/api/register";
const MSG = ${JSON.stringify({
    done: t(LIVE ? d.register.done_live : d.register.done_presale),
    bad: t(d.register.bad_email),
    failed: t(d.register.failed),
    submitting: t(d.register.submitting),
  })};
const EMAIL_RE = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/;

const form = document.getElementById('signup');
const err = document.getElementById('err'), done = document.getElementById('done');
const btn = form.querySelector('button');
const BTN_LABEL = btn.textContent;   /* captured once, before anything can overwrite it */

/* The error goes the moment they start correcting it. */
form.email.addEventListener('input', () => { err.textContent = ''; });

form.addEventListener('submit', async ev => {
  ev.preventDefault();
  /* Clear the previous confirmation while this one is in flight, so the
     message on screen always belongs to the address just submitted. */
  done.textContent = '';

  const email = form.email.value.trim();
  if (!EMAIL_RE.test(email)) {
    err.textContent = MSG.bad;
    form.email.focus();
    return;
  }
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = MSG.submitting;

  try {
    const r = await fetch(FORM_ENDPOINT, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: 'diwali-2026', lang: LANG,
        referrer: document.referrer || '',
        utm_source: utm.utm_source, utm_medium: utm.utm_medium,
        utm_campaign: utm.utm_campaign }) });
    if (!r.ok) throw new Error('failed');
    form.reset();                 /* empty the field, ready for the next address */
    done.textContent = MSG.done;
    form.email.focus();
  } catch (_) {
    /* Whatever they typed stays put so they can just press Register again. */
    err.textContent = MSG.failed;
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
}

/* ---------------------------------------------------------------- build */
if (IMG.has('diwali-hero')) await IMG.prepare('diwali-hero');
IMG.save();

const css = readFileSync(join(HERE, 'static/diwali.css'), 'utf8');
const CSSV = createHash('sha1').update(css).digest('hex').slice(0, 8);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const lang of LANGS) {
  const dir = lang === 'en' ? out : join(out, lang);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), render(lang));
}
cpSync(join(HERE, 'static/diwali.css'), join(out, 'diwali.css'));
for (const f of ['favicon.svg', 'og-diwali.png', 'og-diwali-fr.png', 'og-diwali-nl.png', '_redirects']) {
  const p = join(HERE, 'diwali-holding', f);
  if (existsSync(p)) cpSync(p, join(out, f));
}
/* Art India mark in the top bar, the organiser's logo rather than the festival's. */
{
  const p = join(HERE, 'static/brand/logo-mark-hd.png');
  if (existsSync(p)) {
    mkdirSync(join(out, 'static'), { recursive: true });
    cpSync(p, join(out, 'static/logo-mark.png'));
  }
}
/* Partner logos, once there are any and once each one is cleared for use. */
if (existsSync(join(HERE, 'static/partners'))) {
  cpSync(join(HERE, 'static/partners'), join(out, 'static/partners'), { recursive: true });
}
if (d.flags && d.flags.galleries_enabled && existsSync(join(HERE, 'media/panels'))) {
  cpSync(join(HERE, 'media/panels'), join(out, 'static/panels'), { recursive: true });
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
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${LANGS.map(l => `<url><loc>${SITE}${PATH_OF[l]}</loc>
${LANGS.map(a => `  <xhtml:link rel="alternate" hreflang="${HREFLANG[a]}" href="${SITE}${PATH_OF[a]}"/>`).join('\n')}
</url>`).join('\n')}
</urlset>
`);

console.log(`\n${IMG.report()}`);
console.log(`Built diwali.artindia.be → dist-diwali/  (${LANGS.join(', ')})\n`);

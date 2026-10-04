#!/usr/bin/env node
/**
 * Art India static site generator.
 * Zero dependencies. Reads data/content.json + templates/, writes dist/.
 *
 *   node build.mjs
 *
 * EN lives at the root, FR under /fr/. Add a language by adding it to LANGS
 * and filling in the strings — the build fails loudly if any are missing.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Images, parseName } from './images.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = 'https://artindia.be';
const LANGS = ['en', 'fr'];
const DEFAULT = 'en';
const ORDER = ['index', 'productions', 'festivals', 'organisation', 'ten-years', 'partners', 'press'];

const data = JSON.parse(readFileSync(join(HERE, 'data/content.json'), 'utf8'));
const base = readFileSync(join(HERE, 'templates/base.html'), 'utf8');

const problems = [];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Pull a translated value, complaining if a language is missing. */
function t(obj, lang, where) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;
  if (obj[lang] === undefined || obj[lang] === null || obj[lang] === '') {
    problems.push(`Missing ${lang.toUpperCase()} for ${where}`);
    return '';
  }
  return obj[lang];
}

const path = (lang, slug) =>
  (lang === DEFAULT ? '/' : `/${lang}/`) + (slug ? slug + '/' : '');

/* ---------------- page bodies ---------------- */

function decadeSpine() {
  const years = [];
  for (let y = 2016; y <= 2026; y++) {
    years.push(`<li${y === 2026 ? ' class="now"' : ''}>${y}</li>`);
  }
  return `<div class="decade"><ol>${years.join('')}</ol></div>`;
}

function figuresBlock(lang) {
  const items = Object.entries(data.figures)
    .filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined)
    .map(([k, v]) => {
      const label = t(data.ui.figures[k], lang, `ui.figures.${k}`);
      return `<div class="fig"><dt>${esc(v)}</dt><dd>${esc(label)}</dd></div>`;
    });
  if (!items.length) return '';
  return `<dl class="figures">${items.join('')}</dl>`;
}

function festivalCards(lang) {
  return `<div class="fests">` + data.festivals.map(f => {
    const name = esc(t(f.name, lang, `festival ${f.id} name`));
    const head = f.url ? `<h3><a href="${f.url}">${name}</a></h3>` : `<h3>${name}</h3>`;
    return `<article class="fest">
      <div>
        ${head}
        <p class="when">${esc(t(f.when, lang, 'when'))} · ${esc(t(f.where, lang, 'where'))}</p>
        <p>${esc(t(f.blurb, lang, `festival ${f.id} blurb`))}</p>
        ${f.status ? `<p class="status">${esc(t(f.status, lang, 'status'))}</p>` : ''}
      </div>
      ${plate(stemFor(f.id, f.image), '', lang)}
    </article>`;
  }).join('') + `</div>`;
}

function boardBlock(lang) {
  if (!data.org.board || !data.org.board.length) return '';
  const rows = data.org.board.map(m =>
    `<li><span class="k">${esc(m.name)}</span><span class="v">${esc(t(m.role, lang, 'board role'))}</span></li>`
  ).join('');
  return `<section><h2>${esc(t(data.ui.board_heading, lang, 'board_heading'))}</h2><ul class="rows">${rows}</ul></section>`;
}

function legalBlock(lang) {
  const o = data.org;
  return `<section><h2>${esc(t(data.ui.legal_heading, lang, 'legal_heading'))}</h2>
    <ul class="rows">
      <li><span class="k">${lang === 'fr' ? 'Dénomination' : 'Legal name'}</span><span class="v">${esc(o.legal_name)}</span></li>
      <li><span class="k">${lang === 'fr' ? 'Forme juridique' : 'Legal form'}</span><span class="v">${lang === 'fr' ? 'Association sans but lucratif (ASBL)' : 'Non-profit association (ASBL/VZW)'}</span></li>
      <li><span class="k">${lang === 'fr' ? 'Numéro TVA' : 'VAT number'}</span><span class="v">${esc(o.vat)}</span></li>
      <li><span class="k">${lang === 'fr' ? 'Siège' : 'Registered office'}</span><span class="v">${esc(o.address)}</span></li>
      <li><span class="k">${lang === 'fr' ? 'Fondée en' : 'Founded'}</span><span class="v">${o.founded}</span></li>
    </ul></section>`;
}

function tiersBlock(lang) {
  const items = data.tiers.map(x =>
    `<li><h3>${esc(t(x.name, lang, `tier ${x.id}`))}</h3><p>${esc(t(x.desc, lang, `tier ${x.id} desc`))}</p></li>`
  ).join('');
  return `<section><h2>${esc(t(data.ui.tiers_heading, lang, 'tiers_heading'))}</h2><ul class="tiers">${items}</ul></section>`;
}


/* ------------------------------------------------------------------
   Festival mode. While it runs, every page carries a ticket bar and the
   homepage opens with the festival. It switches itself off: a build after
   active_until leaves it out, and pages built before then carry a small
   script that removes it in the browser at that moment. No deploy needed.
------------------------------------------------------------------ */
const FM = data.festival_mode;
const fmOn = !!FM && Date.now() < Date.parse(FM.active_until);

if (fmOn) {
  // Visitor-facing copy rules. Walk every string, in every language.
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (v && typeof v === 'object') {
      if ('en' in v || 'fr' in v) {
        for (const l of LANGS) if (!v[l] || !v[l].length) problems.push(`Missing ${l.toUpperCase()} for ${where}`);
      }
      return Object.entries(v).forEach(([k, x]) => !k.startsWith('_') && walk(x, `${where}.${k}`));
    }
    if (typeof v !== 'string') return;
    if (/—/.test(v)) problems.push(`Em dash in ${where}`);
    if (/week-?end|valid both days/i.test(v)) problems.push(`Banned wording in ${where}: "${v}"`);
  };
  walk(FM, 'festival_mode');
}

/** "20 days to go", counted in Brussels calendar days. Mirrors the page script. */
function fmCountdown(lang, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(now);
  const n = Math.round((Date.parse(FM.starts) - Date.parse(today)) / 864e5);
  const c = FM.countdown;
  if (n > 1) return t(c.days, lang, 'countdown.days').replace('{n}', n);
  if (n === 1) return t(c.tomorrow, lang, 'countdown.tomorrow');
  if (n === 0) return t(c.today, lang, 'countdown.today');
  return t(c.last, lang, 'countdown.last');
}

const fmTickets = lang => t(FM.url, lang, 'festival_mode.url') + '#tickets';

function fmBar(lang) {
  if (!fmOn) return '';
  return `<a class="fm-bar" data-fm href="${t(FM.url, lang, 'festival_mode.url')}">
  <span class="wrap fm-bar-in">
    <span class="fm-bar-text">${esc(t(FM.name, lang, 'name'))} · ${esc(t(FM.dates_short, lang, 'dates_short'))} · ${esc(t(FM.place, lang, 'place'))}</span>
    <span class="fm-btn fm-bar-btn">${esc(t(FM.cta, lang, 'cta'))}</span>
  </span>
</a>`;
}

function fmBlock(lang) {
  const copy = t(FM.block_copy, lang, 'block_copy');
  const photo = IMG.has(FM.image)
    ? IMG.tag(FM.image, { alt: t(FM.image_alt, lang, 'image_alt'), sizes: '(min-width:820px) 46vw, 100vw', ratio: '16/9', className: 'plate' })
    : '';
  return `<section class="fm-block band band-night">
    <div class="fm-grid">
      ${photo}
      <div>
        <h2>${esc(t(FM.block_heading, lang, 'block_heading'))}</h2>
        ${(copy || []).map(p => `<p>${esc(p)}</p>`).join('')}
        <p class="fm-link"><a href="${t(FM.url, lang, 'festival_mode.url')}">${esc(t(FM.block_link, lang, 'block_link'))}</a></p>
      </div>
    </div>
  </section>`;
}

/** The homepage while the festival runs. The usual opening waits in a
    <template> and replaces this one when the mode expires. */
function fmIndex(page, lang) {
  const c = FM.countdown;
  const count = `<p class="eyebrow" id="fm-count" data-start="${FM.starts}"
    data-days="${esc(t(c.days, lang, 'c'))}" data-tomorrow="${esc(t(c.tomorrow, lang, 'c'))}"
    data-today="${esc(t(c.today, lang, 'c'))}" data-last="${esc(t(c.last, lang, 'c'))}">${esc(fmCountdown(lang))}</p>`;
  return [
    count,
    `<h1>${esc(t(FM.name, lang, 'name'))}</h1>`,
    `<div class="tri full-rule"><i></i><i></i><i></i></div>`,
    `<p class="lede">${esc(t(FM.line, lang, 'line'))}</p>`,
    `<p class="fm-cta"><a class="fm-btn" href="${fmTickets(lang)}">${esc(t(FM.cta, lang, 'cta'))}</a></p>`,
    heroMedia(lang),
    fmBlock(lang),
    `<section class="fm-intro"><p class="fm-motto">${esc(t(data.org.motto, lang, 'org.motto'))}</p>
      <p class="lede">${esc(t(page.lede, lang, 'index.lede'))}</p></section>`,
    `<section>${prose(page, lang)}</section>`,
    ...indexRest(lang),
  ].filter(Boolean).join('\n');
}

const FM_SCRIPT = until => `<script>
(function(){
  var d=document.documentElement;
  if(Date.now()<${until}){
    addEventListener('DOMContentLoaded',function(){
      var c=document.getElementById('fm-count');if(!c)return;
      var s=c.dataset,today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels'}).format(new Date());
      var n=Math.round((Date.parse(s.start)-Date.parse(today))/864e5);
      c.textContent=n>1?s.days.replace('{n}',n):n===1?s.tomorrow:n===0?s.today:s.last;
    });
    return;
  }
  d.classList.add('fm-off');
  addEventListener('DOMContentLoaded',function(){
    document.querySelectorAll('[data-fm]').forEach(function(e){e.remove()});
    var on=document.getElementById('fm-on'),off=document.getElementById('fm-off');
    if(!on||!off)return;
    on.replaceWith(off.content);
    document.title=off.dataset.title;
    var m=document.querySelector('meta[name=description]');if(m)m.content=off.dataset.desc;
  });
})();
</script>`;


/* ------------------------------------------------------------------
   Images. Drop originals into media/ named after what they belong to:
     hero.jpg            the homepage hero
     diwali.jpg          named after the festival id
     taj.jpg             named after the production id
   Add --bottom, --top or --60 to shift the focal point. Sizes, formats
   and srcset are generated automatically; nothing is cropped by hand.
------------------------------------------------------------------ */
const CSS_HASH = createHash('sha1')
  .update(readFileSync(join(HERE, 'static/style.css')))
  .digest('hex').slice(0, 8);

const IMG = new Images(join(HERE, 'media'), join(HERE, '.cache/img'));

/* Two ways an image can arrive:
   — dropped into media/ named after the thing  (media/diwali.jpg)
   — uploaded through /admin, which records its own path in content.json
   Resolve either to a stem the pipeline understands. */
function stemFor(id, explicit) {
  if (explicit) {
    const file = explicit.split('/').pop();
    const { stem } = parseName(file);
    if (IMG.has(stem)) return stem;
  }
  return id;
}

const TRI = '<div class="tri"><i></i><i></i><i></i></div>';

/* Video stays a simple file drop: media/hero.mp4 */
const heroVideo = (() => {
  const p = join(HERE, 'media/hero.mp4');
  return existsSync(p) ? '/static/media/hero.mp4' : (data.org.hero_video || '');
})();

function heroMedia(lang) {
  const heroStem = stemFor('hero', data.org.hero_image);
  const still = IMG.has(heroStem)
    ? IMG.tag(heroStem, { alt: '', sizes: '100vw', eager: true }) : '';
  if (!still && !heroVideo) return '';
  const video = heroVideo
    ? `<video class="hero-video" autoplay muted loop playsinline preload="metadata">
         <source src="${heroVideo}" type="video/mp4"></video>` : '';
  return `<section class="hero bleed"><div class="hero-inner">${still}${video}</div></section>`;
}

function plate(stem, caption, lang, cls = '') {
  const wanted = lang === 'fr' ? 'Image d’archive à venir' : 'Archive image to come';
  if (!IMG.has(stem)) {
    return `<div class="awaiting ${cls}"><span>${esc(caption || wanted)}</span></div>`;
  }
  const ratio = cls.includes('tall') ? '4/5' : '16/9';
  const tag = IMG.tag(stem, {
    alt: caption || '',
    sizes: '(min-width:820px) 46vw, 100vw',
    ratio,
    className: `plate ${cls}`,
  });
  return caption ? `<figure>${tag}<figcaption>${esc(caption)}</figcaption></figure>` : tag;
}

function armsBlock(lang) {
  const items = data.ui.arms.map(a => `<article class="arm">
      ${TRI}
      <p class="tag">${esc(t(a.tag, lang, 'arm tag'))}</p>
      <h3>${esc(t(a.name, lang, 'arm name'))}</h3>
      <p>${esc(t(a.desc, lang, 'arm desc'))}</p>
    </article>`).join('');
  return `<section><h2>${esc(t(data.ui.arms_heading, lang, 'arms_heading'))}</h2><div class="arms">${items}</div></section>`;
}

function presentersBlock(lang) {
  if (!data.presenters || !data.presenters.length) return '';
  const items = data.presenters.map(x =>
    `<li><span class="v">${esc(x.name)}</span>${x.city ? `<span class="c">${esc(x.city)}</span>` : ''}</li>`
  ).join('');
  return `<section class="venues band band-night">
    <p class="label">${esc(t(data.ui.presenters_heading, lang, 'presenters_heading'))}</p>
    <ol>${items}</ol></section>`;
}

function productionsBlock(lang) {
  const items = data.productions.map(p => {
    const perf = (p.performances || []).map(x => {
      const where = x.venue ? `${esc(x.venue)}, ${esc(x.city)}` : esc(x.city);
      return `<li><span class="py">${x.year || '·'}</span><span class="pw">${where}</span></li>`;
    }).join('');
    const perfBlock = perf
      ? `<ul class="perf">${perf}</ul>`
      : `<p class="perf-none">${lang === 'fr' ? 'Historique à confirmer' : 'Performance history to be confirmed'}</p>`;
    const tour = p.touring
      ? `<p class="touring">${esc(t(data.ui.touring_label, lang, 'touring_label'))}</p>` : '';
    const meta = [
      p.premiere ? (lang === 'fr' ? `Créé en ${p.premiere}` : `First staged ${p.premiere}`) : '',
      (p.languages && p.languages[lang]) ? p.languages[lang] : '',
      p.cast ? (lang === 'fr' ? `${p.cast} artistes` : `${p.cast} performers`) : ''
    ].filter(Boolean).join(' · ');
    return `<article class="prod">
      <h3>${esc(p.title)}</h3>
      <p class="prod-sub">${esc(t(p.subtitle, lang, `production ${p.id} subtitle`))}</p>
      <div class="prod-grid">
        <div>
          ${plate(stemFor(p.id, p.image), '', lang, 'tall')}
        </div>
        <div>
          <p class="prod-blurb">${esc(t(p.blurb, lang, `production ${p.id} blurb`))}</p>
          <p class="meta">${esc(meta)}</p>
          ${perfBlock}
          ${tour}
        </div>
      </div>
    </article>`;
  }).join('');
  return `<section class="prods">${items}</section>`;
}

function prose(page, lang) {
  const paras = t(page.body, lang, 'body');
  if (!Array.isArray(paras) || !paras.length) return '';
  return `<div class="prose">` + paras.map(p => `<p>${esc(p)}</p>`).join('') + `</div>`;
}

/** Everything on the homepage below the intro, whichever opening is in use. */
function indexRest(lang) {
  const figs = figuresBlock(lang);
  return [
    `<section>${decadeSpine()}<p class="decade-cap">${lang === 'fr' ? 'Dix éditions du Brussels Diwali Festival' : 'Ten editions of the Brussels Diwali Festival'}</p></section>`,
    armsBlock(lang),
    presentersBlock(lang),
    figs ? `<section>${figs}</section>` : '',
    `<section><h2>${esc(t(data.ui.nav.festivals, lang, 'nav.festivals'))}</h2>${festivalCards(lang)}</section>`,
    `<section><a class="cta" href="${path(lang, 'partners')}">${esc(t(data.ui.cta_partners, lang, 'cta_partners'))}</a></section>`,
  ];
}

function buildContent(key, page, lang) {
  const parts = [];
  parts.push(key === 'index'
    ? `<p class="eyebrow">Art India · ${lang === 'fr' ? 'Bruxelles' : 'Brussels'}</p>`
    : `<p class="eyebrow">${esc(t(data.org.motto, lang, 'org.motto'))}</p>`);
  parts.push(`<h1>${esc(t(page.h1, lang, `${key}.h1`))}</h1>`);
  parts.push(`<div class="tri full-rule"><i></i><i></i><i></i></div>`);
  parts.push(`<p class="lede">${esc(t(page.lede, lang, `${key}.lede`))}</p>`);

  if (key === 'index') {
    parts.push(heroMedia(lang));
    parts.push(`<section>${prose(page, lang)}</section>`);
    parts.push(...indexRest(lang));
  } else if (key === 'organisation') {
    parts.push(`<section>${prose(page, lang)}</section>`);
    parts.push(boardBlock(lang));
    parts.push(legalBlock(lang));
  } else if (key === 'ten-years') {
    parts.push(decadeSpine());
    parts.push(`<section>${prose(page, lang)}</section>`);
    parts.push(presentersBlock(lang));
    const figs = figuresBlock(lang);
    if (figs) parts.push(`<section>${figs}</section>`);
  } else if (key === 'productions') {
    parts.push(`<section>${prose(page, lang)}</section>`);
    parts.push(productionsBlock(lang));
    parts.push(presentersBlock(lang));
    parts.push(`<section><a class="cta" href="mailto:${data.org.email_partners}">${esc(t(data.ui.cta_productions, lang, 'cta_productions'))}</a></section>`);
  } else if (key === 'festivals') {
    parts.push(`<section>${festivalCards(lang)}</section>`);
  } else if (key === 'partners') {
    parts.push(`<section>${prose(page, lang)}</section>`);
    const figs = figuresBlock(lang);
    if (figs) parts.push(`<section>${figs}</section>`);
    parts.push(presentersBlock(lang));
    parts.push(tiersBlock(lang));
    parts.push(`<section><a class="cta" href="mailto:${data.org.email_partners}">${esc(t(data.ui.cta_partners, lang, 'cta_partners'))}</a></section>`);
  } else if (key === 'press') {
    parts.push(`<section>${prose(page, lang)}</section>`);
    parts.push(`<section><a class="cta" href="mailto:${data.org.email_general}">${esc(t(data.ui.cta_press, lang, 'cta_press'))}</a></section>`);
  }
  return parts.filter(Boolean).join('\n');
}

/* ---------------- assembly ---------------- */

const orgJsonLd = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'NGO',
  name: data.org.legal_name,
  url: SITE,
  email: data.org.email_general,
  foundingDate: String(data.org.founded),
  vatID: data.org.vat,
  address: { '@type': 'PostalAddress', streetAddress: data.org.address, addressLocality: 'Brussels', addressCountry: 'BE' }
});

const out = join(HERE, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const wanted = [
  stemFor('hero', data.org.hero_image),
  ...data.festivals.map(f => stemFor(f.id, f.image)),
  ...(data.productions || []).map(p => stemFor(p.id, p.image)),
  ...(fmOn ? [FM.image] : [])];
for (const stem of wanted) { if (IMG.has(stem)) await IMG.prepare(stem); }
IMG.save();

let count = 0;
for (const lang of LANGS) {
  for (const key of ORDER) {
    const page = data.pages[key];
    if (!page) { problems.push(`Missing page: ${key}`); continue; }

    const fmHome = fmOn && key === 'index';
    const usualTitle = t(page.title, lang, `${key}.title`);
    const usualDesc = t(page.description, lang, `${key}.description`);
    const title = fmHome ? t(FM.title, lang, 'festival_mode.title') : usualTitle;
    const desc = fmHome ? t(FM.description, lang, 'festival_mode.description') : usualDesc;
    if (fmHome && usualDesc.length > 160) problems.push(`Description too long (${usualDesc.length}) — ${key} ${lang}`);
    if (desc.length > 160) problems.push(`Description too long (${desc.length}) — ${key} ${lang}`);
    if (!desc) problems.push(`No description — ${key} ${lang}`);

    const nav = ORDER.map(k =>
      `<a href="${path(lang, data.pages[k].slug)}"${k === key ? ' aria-current="page"' : ''}>${esc(t(data.ui.nav[k], lang, `nav.${k}`))}</a>`
    ).join('');

    const footnav = ORDER.map(k =>
      `<li><a href="${path(lang, data.pages[k].slug)}">${esc(t(data.ui.nav[k], lang, `nav.${k}`))}</a></li>`
    ).join('');

    const langs = LANGS.map(l =>
      `<a href="${path(l, page.slug)}"${l === lang ? ' aria-current="true"' : ''} hreflang="${l}">${l.toUpperCase()}</a>`
    ).join('');

    const alternates = LANGS.map(l =>
      `<link rel="alternate" hreflang="${l}" href="${SITE}${path(l, page.slug)}">`
    ).join('\n') + `\n<link rel="alternate" hreflang="x-default" href="${SITE}${path(DEFAULT, page.slug)}">`;

    const html = base
      .replace(/{{LANG}}/g, lang)
      .replace(/{{TITLE}}/g, esc(title))
      .replace(/{{DESCRIPTION}}/g, esc(desc))
      .replace(/{{CANONICAL}}/g, SITE + path(lang, page.slug))
      .replace(/{{ALTERNATES}}/g, alternates)
      .replace(/{{CSSV}}/g, CSS_HASH)
      .replace(/{{ROOT}}/g, lang === DEFAULT && !page.slug ? '' : (page.slug ? '../' : '') + (lang === DEFAULT ? '' : '../'))
      .replace(/{{ORGJSONLD}}/g, orgJsonLd)
      .replace(/{{SKIP}}/g, esc(t(data.ui.skip, lang, 'ui.skip')))
      .replace(/{{HOME}}/g, path(lang, ''))
      .replace(/{{NAV}}/g, nav)
      .replace(/{{FOOTNAV}}/g, footnav)
      .replace(/{{NAV_HEADING}}/g, lang === 'fr' ? 'Pages' : 'Pages')
      .replace(/{{LANGS}}/g, langs)
      .replace(/{{FMHEAD}}/g, fmOn ? FM_SCRIPT(Date.parse(FM.active_until)) : '')
      .replace(/{{FMBAR}}/g, fmBar(lang))
      .replace(/{{CONTENT}}/g, fmHome
        ? `<div id="fm-on">${fmIndex(page, lang)}</div>\n<template id="fm-off" data-title="${esc(usualTitle)}" data-desc="${esc(usualDesc)}">${buildContent(key, page, lang)}</template>`
        : buildContent(key, page, lang))
      .replace(/{{ADDRESS}}/g, esc(data.org.address))
      .replace(/{{VAT}}/g, esc(data.org.vat))
      .replace(/{{EMAIL_GENERAL}}/g, esc(data.org.email_general))
      .replace(/{{EMAIL_PARTNERS}}/g, esc(data.org.email_partners))
      .replace(/{{FOOTER_NOTE}}/g, esc(t(data.ui.footer_note, lang, 'footer_note')))
      .replace(/{{MOTTO}}/g, esc(t(data.org.motto, lang, 'org.motto')))
      .replace(/{{LOGO}}/g, data.org.logo
        ? `<div class="crest"><picture>
             <source srcset="/static/logo.svg" type="image/svg+xml">
             <img src="${data.org.logo}" srcset="${data.org.logo} 1x, /static/logo@2x.png 2x"
               alt="Art India" width="230" height="257" loading="lazy"></picture></div>`
        : '')
      .replace(/{{YEAR}}/g, new Date().getFullYear());

    // Prices live on diwali.artindia.be, next to the checkout. Never here.
    if (html.includes('€')) problems.push(`Price on artindia.be — ${key} ${lang}. Prices belong on diwali.artindia.be only.`);

    const dir = join(out, lang === DEFAULT ? '' : lang, page.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), html);
    count++;
  }
}

cpSync(join(HERE, 'static'), join(out, 'static'), { recursive: true });
if (existsSync(join(HERE, 'admin'))) {
  cpSync(join(HERE, 'admin'), join(out, 'admin'), { recursive: true });
}
if (existsSync(join(HERE, '.cache/img'))) {
  cpSync(join(HERE, '.cache/img'), join(out, 'static/img'), { recursive: true });
}
if (existsSync(join(HERE, 'media/hero.mp4'))) {
  mkdirSync(join(out, 'static/media'), { recursive: true });
  cpSync(join(HERE, 'media/hero.mp4'), join(out, 'static/media/hero.mp4'));
}

// sitemap + robots
const urls = LANGS.flatMap(l => ORDER.map(k => `<url><loc>${SITE}${path(l, data.pages[k].slug)}</loc></url>`));
writeFileSync(join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
writeFileSync(join(out, 'robots.txt'),
  `User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`\n${IMG.report()}`);
console.log(`\nBuilt ${count} pages across ${LANGS.length} languages → dist/`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of [...new Set(problems)]) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('No problems found.\n');

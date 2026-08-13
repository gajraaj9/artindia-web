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

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = 'https://artindia.be';
const LANGS = ['en', 'fr'];
const DEFAULT = 'en';
const ORDER = ['index', 'organisation', 'ten-years', 'festivals', 'partners', 'press'];

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
  return `<div class="cards">` + data.festivals.map(f => {
    const name = esc(t(f.name, lang, `festival ${f.id} name`));
    const head = f.url
      ? `<h3><a href="${f.url}">${name}</a></h3>`
      : `<h3>${name}</h3>`;
    return `<article class="card">
      <p class="meta">${esc(t(f.when, lang, 'when'))} · ${esc(t(f.where, lang, 'where'))}</p>
      ${head}
      <p>${esc(t(f.blurb, lang, `festival ${f.id} blurb`))}</p>
      <p class="status">${esc(t(f.status, lang, 'status'))}</p>
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

function prose(page, lang) {
  const paras = t(page.body, lang, 'body');
  if (!Array.isArray(paras) || !paras.length) return '';
  return `<div class="prose">` + paras.map(p => `<p>${esc(p)}</p>`).join('') + `</div>`;
}

function buildContent(key, page, lang) {
  const parts = [];
  parts.push(`<p class="eyebrow">Art India ASBL · Brussels</p>`);
  parts.push(`<h1>${esc(t(page.h1, lang, `${key}.h1`))}</h1>`);
  parts.push(`<p class="lede">${esc(t(page.lede, lang, `${key}.lede`))}</p>`);

  if (key === 'index') {
    parts.push(decadeSpine());
    parts.push(`<p class="decade-cap">${lang === 'fr' ? 'Dix éditions du Brussels Diwali Festival' : 'Ten editions of the Brussels Diwali Festival'}</p>`);
    parts.push(`<section>${prose(page, lang)}</section>`);
    const figs = figuresBlock(lang);
    if (figs) parts.push(`<section>${figs}</section>`);
    parts.push(`<section><h2>${esc(t(data.ui.nav.festivals, lang, 'nav.festivals'))}</h2>${festivalCards(lang)}</section>`);
    parts.push(`<section><a class="cta" href="${path(lang, 'partners')}">${esc(t(data.ui.cta_partners, lang, 'cta_partners'))}</a></section>`);
  } else if (key === 'organisation') {
    parts.push(`<section>${prose(page, lang)}</section>`);
    parts.push(boardBlock(lang));
    parts.push(legalBlock(lang));
  } else if (key === 'ten-years') {
    parts.push(decadeSpine());
    parts.push(`<section>${prose(page, lang)}</section>`);
    const figs = figuresBlock(lang);
    if (figs) parts.push(`<section>${figs}</section>`);
  } else if (key === 'festivals') {
    parts.push(`<section>${festivalCards(lang)}</section>`);
  } else if (key === 'partners') {
    parts.push(`<section>${prose(page, lang)}</section>`);
    const figs = figuresBlock(lang);
    if (figs) parts.push(`<section>${figs}</section>`);
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

let count = 0;
for (const lang of LANGS) {
  for (const key of ORDER) {
    const page = data.pages[key];
    if (!page) { problems.push(`Missing page: ${key}`); continue; }

    const desc = t(page.description, lang, `${key}.description`);
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
      .replace(/{{TITLE}}/g, esc(t(page.title, lang, `${key}.title`)))
      .replace(/{{DESCRIPTION}}/g, esc(desc))
      .replace(/{{CANONICAL}}/g, SITE + path(lang, page.slug))
      .replace(/{{ALTERNATES}}/g, alternates)
      .replace(/{{ROOT}}/g, lang === DEFAULT && !page.slug ? '' : (page.slug ? '../' : '') + (lang === DEFAULT ? '' : '../'))
      .replace(/{{ORGJSONLD}}/g, orgJsonLd)
      .replace(/{{SKIP}}/g, esc(t(data.ui.skip, lang, 'ui.skip')))
      .replace(/{{HOME}}/g, path(lang, ''))
      .replace(/{{NAV}}/g, nav)
      .replace(/{{FOOTNAV}}/g, footnav)
      .replace(/{{NAV_HEADING}}/g, lang === 'fr' ? 'Pages' : 'Pages')
      .replace(/{{LANGS}}/g, langs)
      .replace(/{{CONTENT}}/g, buildContent(key, page, lang))
      .replace(/{{ADDRESS}}/g, esc(data.org.address))
      .replace(/{{VAT}}/g, esc(data.org.vat))
      .replace(/{{EMAIL_GENERAL}}/g, esc(data.org.email_general))
      .replace(/{{EMAIL_PARTNERS}}/g, esc(data.org.email_partners))
      .replace(/{{FOOTER_NOTE}}/g, esc(t(data.ui.footer_note, lang, 'footer_note')))
      .replace(/{{YEAR}}/g, new Date().getFullYear());

    const dir = join(out, lang === DEFAULT ? '' : lang, page.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), html);
    count++;
  }
}

cpSync(join(HERE, 'static'), join(out, 'static'), { recursive: true });

// sitemap + robots
const urls = LANGS.flatMap(l => ORDER.map(k => `<url><loc>${SITE}${path(l, data.pages[k].slug)}</loc></url>`));
writeFileSync(join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`\nBuilt ${count} pages across ${LANGS.length} languages → dist/`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of [...new Set(problems)]) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('No problems found.\n');

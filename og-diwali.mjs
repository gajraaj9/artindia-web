#!/usr/bin/env node
/**
 * The share card for diwali.artindia.be.
 *
 *   node og-diwali.mjs   →  static/brand/og-diwali.png
 *                           diwali-holding/og-diwali.png
 *
 * 1200x630, the size Facebook, WhatsApp, LinkedIn and Slack all crop to.
 * Run it by hand when the wording changes; it is deliberately not part of
 * build-diwali.mjs, because the card is a photograph of the brand rather
 * than a page, and it should not silently change under a routine build.
 *
 * Deliberately carries NO on-sale date. The card outlives the sale window,
 * gets cached by every scraper that has ever seen the link, and cannot be
 * corrected once shared. Dates that move belong on the page, not in a PNG.
 *
 * Type: the site sets headings in Rozha One, which is not installed here
 * and is not vendored into the repo. The stack falls through to Didot,
 * the closest thing macOS ships to Rozha One's high-contrast didone
 * character. Install Rozha One, or vendor the .ttf, and this picks it up
 * with no change to the script.
 */

import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* sharp bundles its own fontconfig, which on macOS does not look at the
   system font directories. Point it at them before sharp is loaded — the
   library reads this on first use, so the import has to come after. */
const MAC_FONT_DIRS = ['/System/Library/Fonts/Supplemental', '/System/Library/Fonts']
  .filter(existsSync);
if (MAC_FONT_DIRS.length) {
  const dir = mkdtempSync(join(tmpdir(), 'og-fc-'));
  const conf = join(dir, 'fonts.conf');
  writeFileSync(conf, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
${MAC_FONT_DIRS.map(d => `  <dir>${d}</dir>`).join('\n')}
  <cachedir>${join(dir, 'cache')}</cachedir>
</fontconfig>
`);
  process.env.FONTCONFIG_FILE = conf;
}
const { default: sharp } = await import('sharp');

const W = 1200, H = 630;
const INDIGO = '#0B0E24';
const GOLD = '#E8A33B';
const CREAM = '#F6DFA6';
const PAPER = '#EDEEF6';

const SERIF = "'Rozha One', Didot, Georgia, serif";
const SANS = "'Mukta', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/* The same lamp that runs across the top of the hero, at card scale. */
const lamp = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})">
    <path d="M16 3 C20 9 22 12 22 16 a6 6 0 0 1-12 0 c0-4 2-7 6-13z" fill="${GOLD}"/>
    <path d="M16 9 C18 13 19 15 19 17 a3 3 0 0 1-6 0 c0-2 1-4 3-8z" fill="${CREAM}"/>
    <path d="M4 24 h24 c-1 6-6 9-12 9 s-11-3-12-9z" fill="#8A4B2A"/></g>`;

const LAMPS = 10, GAP = 60, SCALE = 1.15;
const lampW = 32 * SCALE;
const rowW = (LAMPS - 1) * GAP + lampW;
const lamps = Array.from({ length: LAMPS }, (_, i) =>
  lamp(W / 2 - rowW / 2 + i * GAP, 316, SCALE)).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="46%" r="62%">
      <stop offset="0%" stop-color="#2A2358"/>
      <stop offset="55%" stop-color="#171634"/>
      <stop offset="100%" stop-color="${INDIGO}"/>
    </radialGradient>
    <linearGradient id="rule" x1="0" x2="1">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${GOLD}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <text x="${W / 2}" y="232" text-anchor="middle" font-family="${SERIF}"
        font-size="92" fill="${PAPER}">Brussels <tspan font-style="italic" fill="${CREAM}">Diwali</tspan> Festival</text>

  ${lamps}

  <rect x="${W / 2 - 260}" y="394" width="520" height="1.5" fill="url(#rule)"/>

  <text x="${W / 2}" y="456" text-anchor="middle" font-family="${SANS}"
        font-size="44" font-weight="600" fill="${PAPER}">Atomium, 24-25 October 2026</text>

  <text x="${W / 2}" y="510" text-anchor="middle" font-family="${SANS}"
        font-size="31" font-weight="400" fill="${GOLD}">Weekend tickets from &#8364;10</text>
</svg>`;

const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

for (const rel of ['static/brand/og-diwali.png', 'diwali-holding/og-diwali.png']) {
  writeFileSync(join(HERE, rel), png);
  console.log(`wrote ${rel}  ${(png.length / 1024).toFixed(0)} KB`);
}

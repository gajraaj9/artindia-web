/* ------------------------------------------------------------------
   Image pipeline
   ------------------------------------------------------------------
   Drop originals — any size, straight off the camera — into media/.
   This resizes them to a ladder of widths, writes AVIF, WebP and JPEG,
   and returns a <picture> element with a proper srcset.

   Nothing is cropped here. The full frame is shipped and CSS decides
   what to show, so changing a crop is a word in a filename rather than
   a re-export.

       media/hero.jpg                    centred
       media/hero--bottom.jpg            anchored to the bottom
       media/diwali--60.jpg              anchored 60% down

   Results are cached by content hash, so a rebuild only touches images
   that actually changed.
------------------------------------------------------------------ */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const WIDTHS = [480, 800, 1200, 1600, 2400];
const RASTER = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff']);

const FOCUS = {
  top: 'top', bottom: 'bottom', left: 'left', right: 'right', center: 'center',
  'top-left': 'top left', 'top-right': 'top right',
  'bottom-left': 'bottom left', 'bottom-right': 'bottom right',
};

/** hero--bottom.jpg → { stem:'hero', position:'bottom' } */
export function parseName(file) {
  const name = basename(file, extname(file));
  const [stem, hint] = name.split('--');
  if (!hint) return { stem, position: 'center' };
  if (FOCUS[hint]) return { stem, position: FOCUS[hint] };
  if (/^\d{1,3}$/.test(hint)) return { stem, position: `center ${hint}%` };
  return { stem: name, position: 'center' };
}

export class Images {
  constructor(srcDir, outDir, publicPath = '/static/img') {
    this.srcDir = srcDir;
    this.outDir = outDir;
    this.publicPath = publicPath;
    this.cacheFile = join(process.cwd(), '.cache', 'images.json');
    this.cache = existsSync(this.cacheFile)
      ? JSON.parse(readFileSync(this.cacheFile, 'utf8')) : {};
    this.byStem = new Map();
    this.built = 0;
    this.reused = 0;

    if (!existsSync(srcDir)) return;
    for (const f of readdirSync(srcDir)) {
      if (!RASTER.has(extname(f).toLowerCase())) continue;
      const { stem, position } = parseName(f);
      this.byStem.set(stem, { file: f, position });
    }
  }

  has(stem) { return this.byStem.has(stem); }

  /** Resize once per width and format; skip anything already generated. */
  async prepare(stem) {
    const entry = this.byStem.get(stem);
    if (!entry) return null;
    if (entry.ready) return entry;

    const srcPath = join(this.srcDir, entry.file);
    const buf = readFileSync(srcPath);
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 10);
    const meta = await sharp(buf).metadata();
    const widths = WIDTHS.filter(w => w <= meta.width);
    if (!widths.length) widths.push(meta.width);

    mkdirSync(this.outDir, { recursive: true });
    const cached = this.cache[stem];
    const fresh = cached && cached.hash === hash
      && cached.files.every(f => existsSync(join(this.outDir, f)));

    const files = [];
    for (const w of widths) {
      for (const [fmt, opts] of [
        ['avif', { quality: 52, effort: 4 }],
        ['webp', { quality: 78 }],
        ['jpg',  { quality: 80, progressive: true, mozjpeg: true }],
      ]) {
        const name = `${stem}-${hash}-${w}.${fmt}`;
        files.push(name);
        const dest = join(this.outDir, name);
        if (fresh && existsSync(dest)) { this.reused++; continue; }
        const p = sharp(buf).rotate().resize({ width: w, withoutEnlargement: true });
        await (fmt === 'avif' ? p.avif(opts) : fmt === 'webp' ? p.webp(opts) : p.jpeg(opts))
          .toFile(dest);
        this.built++;
      }
    }

    Object.assign(entry, {
      ready: true, hash, widths,
      width: meta.width, height: meta.height,
      ratio: meta.width / meta.height,
    });
    this.cache[stem] = { hash, files };
    return entry;
  }

  /** A <picture> with srcset, intrinsic size and the focal point applied. */
  tag(stem, { alt = '', sizes = '100vw', ratio = null, className = '', eager = false } = {}) {
    const e = this.byStem.get(stem);
    if (!e || !e.ready) return '';
    const set = fmt => e.widths
      .map(w => `${this.publicPath}/${stem}-${e.hash}-${w}.${fmt} ${w}w`).join(', ');
    const largest = e.widths[e.widths.length - 1];
    const style = [
      ratio ? `aspect-ratio:${ratio}` : '',
      `object-position:${e.position}`,
    ].filter(Boolean).join(';');

    return `<picture class="${className}">
  <source type="image/avif" srcset="${set('avif')}" sizes="${sizes}">
  <source type="image/webp" srcset="${set('webp')}" sizes="${sizes}">
  <img src="${this.publicPath}/${stem}-${e.hash}-${largest}.jpg"
       srcset="${set('jpg')}" sizes="${sizes}"
       width="${e.width}" height="${e.height}" alt="${alt.replace(/"/g, '&quot;')}"
       ${eager ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"'}
       style="${style}"></picture>`;
  }

  save() {
    mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
    writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
  }

  report() {
    const n = this.byStem.size;
    if (!n) return 'No source images in media/';
    return `Images: ${n} source · ${this.built} generated · ${this.reused} cached`;
  }
}

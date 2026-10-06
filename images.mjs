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
  /**
   * `namespace` keeps a second source folder from colliding with the first.
   * Callers still ask for the bare stem; only the cache key and the emitted
   * filename carry the prefix, so media/programme/puja.jpg becomes
   * pg-puja-<hash>-800.webp and never fights media/puja.jpg for the name.
   */
  constructor(srcDir, outDir, publicPath = '/static/img', { namespace = '' } = {}) {
    this.srcDir = srcDir;
    this.outDir = outDir;
    this.publicPath = publicPath;
    this.ns = namespace;
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

  /** The on-disk name for a stem: namespaced, so two folders can share one. */
  key(stem) { return this.ns + stem; }

  has(stem) { return this.byStem.has(stem); }

  /** The prepared entry, or null if the stem was never processed. */
  entry(stem) {
    const e = this.byStem.get(stem);
    return e && e.ready ? e : null;
  }

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
    const cached = this.cache[this.key(stem)];
    const fresh = cached && cached.hash === hash
      && cached.files.every(f => existsSync(join(this.outDir, f)));

    const files = [];
    for (const w of widths) {
      for (const [fmt, opts] of [
        ['avif', { quality: 52, effort: 4 }],
        ['webp', { quality: 78 }],
        ['jpg',  { quality: 80, progressive: true, mozjpeg: true }],
      ]) {
        const name = `${this.key(stem)}-${hash}-${w}.${fmt}`;
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
    this.cache[this.key(stem)] = { hash, files };
    return entry;
  }

  /**
   * One URL for one width, for somewhere a srcset cannot go.
   *
   * A video poster is the case: the attribute takes a single src and nothing
   * else, so it gets a middling width rather than the 2400 the <img> falls
   * back to. A poster that is heavier than the first second of the video
   * defeats the point of having one.
   */
  src(stem, want = 1200) {
    const e = this.byStem.get(stem);
    if (!e || !e.ready) return '';
    const w = e.widths.reduce((best, x) =>
      (Math.abs(x - want) < Math.abs(best - want) ? x : best), e.widths[0]);
    return `${this.publicPath}/${this.key(stem)}-${e.hash}-${w}.jpg`;
  }

  /** A <picture> with srcset, intrinsic size and the focal point applied. */
  tag(stem, { alt = '', sizes = '100vw', ratio = null, className = '', eager = false } = {}) {
    const e = this.byStem.get(stem);
    if (!e || !e.ready) return '';
    const set = fmt => e.widths
      .map(w => `${this.publicPath}/${this.key(stem)}-${e.hash}-${w}.${fmt} ${w}w`).join(', ');
    const largest = e.widths[e.widths.length - 1];
    const style = [
      ratio ? `aspect-ratio:${ratio}` : '',
      `object-position:${e.position}`,
    ].filter(Boolean).join(';');

    return `<picture class="${className}">
  <source type="image/avif" srcset="${set('avif')}" sizes="${sizes}">
  <source type="image/webp" srcset="${set('webp')}" sizes="${sizes}">
  <img src="${this.publicPath}/${this.key(stem)}-${e.hash}-${largest}.jpg"
       srcset="${set('jpg')}" sizes="${sizes}"
       width="${e.width}" height="${e.height}" alt="${alt.replace(/"/g, '&quot;')}"
       ${eager ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"'}
       style="${style}"></picture>`;
  }

  /* Merged into whatever is on disk, not written over it: the cache file is
     shared between instances and a plain write would drop the other one's
     entries, which costs a full re-encode on the next build. */
  save() {
    mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
    const onDisk = existsSync(this.cacheFile)
      ? JSON.parse(readFileSync(this.cacheFile, 'utf8')) : {};
    writeFileSync(this.cacheFile, JSON.stringify({ ...onDisk, ...this.cache }, null, 2));
  }

  report() {
    const n = this.byStem.size;
    if (!n) return `No source images in ${this.srcDir}`;
    return `Images: ${n} source · ${this.built} generated · ${this.reused} cached`;
  }
}

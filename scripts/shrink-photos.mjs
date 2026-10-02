#!/usr/bin/env node
/**
 * Shrink camera originals in media/programme/ before they go into git.
 *
 *   node scripts/shrink-photos.mjs
 *
 * A photograph straight off the camera is 8 to 13 MB and six thousand pixels
 * wide. The build never ships one: images.mjs resizes to a ladder topping out
 * at 2400px and the browser picks a rung. What the original costs is the
 * repository, for ever, because git keeps every version of a binary it has
 * ever seen. So the file is cut down to the largest size the ladder can
 * actually use, once, before the first commit.
 *
 * Anything already 2400px or smaller is left exactly as it is, which makes
 * this safe to run again: a second pass has nothing to do.
 *
 * The EXIF rotation is baked into the pixels rather than carried as a tag,
 * because the metadata is stripped on the way out and a tag nobody reads
 * would leave a portrait photograph on its side.
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'media/programme');
const MAX = 2400;
const QUALITY = 88;
const RASTER = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff']);

const kb = n => `${(n / 1024).toFixed(0)} KB`;
const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;
const size = n => (n >= 1024 * 1024 ? mb(n) : kb(n));

if (!existsSync(DIR)) {
  console.log(`Nothing to do: ${DIR} does not exist.`);
  process.exit(0);
}

const files = readdirSync(DIR).filter(f => RASTER.has(extname(f).toLowerCase())).sort();
let shrunk = 0, before = 0, after = 0;

for (const file of files) {
  const path = join(DIR, file);
  const bytesBefore = statSync(path).size;
  const buf = readFileSync(path);
  const meta = await sharp(buf).metadata();

  /* Orientation 6 and 8 mean the long side on disk is the short side on
     screen, so the decision is made on the dimensions after rotation. */
  const upright = meta.orientation >= 5 && meta.orientation <= 8;
  const w = upright ? meta.height : meta.width;
  const h = upright ? meta.width : meta.height;

  if (Math.max(w, h) <= MAX) {
    console.log(`  keep   ${file.padEnd(26)} ${w}x${h}  ${size(bytesBefore)}`);
    before += bytesBefore;
    after += bytesBefore;
    continue;
  }

  /* fit:'inside' sizes the long side whichever one it is, so portrait and
     landscape need no separate case. Nothing is enlarged. */
  let pipe = sharp(buf)
    .rotate()
    .resize({ width: MAX, height: MAX, fit: 'inside', withoutEnlargement: true });

  /* The file keeps the format its name claims. Writing JPEG bytes into a .png
     would leave the folder lying about itself, and renaming a file is the
     photographer's call, not this script's. A photograph stored as PNG stays a
     large PNG; the line printed below says how much that costs. */
  const ext = extname(file).toLowerCase();
  pipe = ext === '.png' ? pipe.png({ compressionLevel: 9 })
    : ext === '.webp' ? pipe.webp({ quality: QUALITY })
    : ext === '.avif' ? pipe.avif({ quality: 60 })
    : ext === '.tif' || ext === '.tiff' ? pipe.tiff()
    : pipe.jpeg({ quality: QUALITY, progressive: true, mozjpeg: true });

  const out = await pipe.toBuffer();

  writeFileSync(path, out);
  const now = await sharp(out).metadata();
  console.log(`  shrink ${file.padEnd(26)} ${w}x${h} ${size(bytesBefore)}`
    + `  ->  ${now.width}x${now.height} ${size(out.length)}`
    + `  (${(100 - (out.length / bytesBefore) * 100).toFixed(0)}% smaller)`);
  shrunk++;
  before += bytesBefore;
  after += out.length;
}

console.log(`\n${files.length} file${files.length === 1 ? '' : 's'}, ${shrunk} shrunk: `
  + `${size(before)} -> ${size(after)}`
  + (before > after ? ` (${size(before - after)} saved)` : ''));

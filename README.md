# artindia-web

Static sites for Art India ASBL. No dependencies.

## Build

    node build.mjs

Writes `dist/`. EN at the root, FR under `/fr/`.
The build **fails** on missing translations or over-long meta descriptions — that is intentional.

## Edit content

Everything is in `data/content.json`. Templates never hold facts.
Set any value in `figures` to `null` to hide it.

## Deploy (Cloudflare Pages)

- Build command: `node build.mjs`
- Output directory: `dist`
- No environment variables needed.

`diwali-holding/index.html` is the standalone holding page for
diwali.artindia.be — deploy it separately for now.

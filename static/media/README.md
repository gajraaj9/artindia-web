# Media

Drop a file in this folder named after the thing it belongs to.
The build finds it — no JSON to edit.

    node build.mjs

prints "Media in use: …" so you can see what it picked up.

---

## Homepage hero

    hero.mp4      video, plays muted on a loop
    hero.jpg      still — the poster behind the video, or a still hero on its own

Either or both. With only `hero.jpg` you get a still hero. With neither, the
hero simply doesn't render and the page starts at the text.

**Video specs.** 8–12 seconds · muted · no titles or captions burned in ·
wide crop, about 2.35:1 · under 5 MB.

    ffmpeg -i source.mov \
      -vf "scale=1920:-2,crop=1920:816" -t 10 -an \
      -c:v libx264 -crf 30 -preset slow -pix_fmt yuv420p \
      -movflags +faststart hero.mp4

And a poster frame from the same clip:

    ffmpeg -i hero.mp4 -ss 2 -frames:v 1 -q:v 3 hero.jpg

The video is muted, loops, and never shows controls. Visitors who have
reduced motion switched on see the poster instead.

## Festivals

Name the file after the festival id:

    diwali.jpg          yoga.jpg          conservatory.jpg

Landscape, about 1600 px wide.

## Productions

Name the file after the production id:

    rama.jpg      taj.jpg      it-doesnt-hurt-to-be-nice.jpg
    mad-about-madras.jpg       ticket-2-bollywood.jpg

Portrait suits the layout best, about 1200 px wide.

---

## Formats

`.jpg` `.jpeg` `.png` `.webp` `.avif` for stills, `.mp4` `.webm` for video.
JPEG at quality 80 is right for photographs; use PNG only for graphics with
flat colour. Keep stills under about 400 KB.

## Overriding

If you need a different filename, set the path explicitly in
`data/content.json` — an explicit value always wins over the convention.

    "productions": [ { "id": "taj", "image": "/static/media/taj-bozar-2017.jpg" } ]

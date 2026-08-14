# Media

Drop files here, then point to them in `data/content.json`.
Paths always start `/static/media/`.

## Hero video — homepage
    static/media/hero.mp4

  "org": { "hero_video": "/static/media/hero.mp4",
           "hero_image": "/static/media/hero-poster.jpg" }

8–12 seconds · muted · no titles burned in · wide crop (about 2.35:1)
· under 5 MB. The poster shows on slow connections and when the visitor
has reduced motion switched on. Both fields are optional; set only
`hero_image` for a still hero.

Compress with:
    ffmpeg -i in.mov -vf "scale=1920:-2,crop=1920:816" -t 10 -an \
      -c:v libx264 -crf 30 -preset slow -movflags +faststart hero.mp4

## Festival images
    static/media/diwali.jpg   yoga.jpg   conservatory.jpg

  "festivals": [ { "id": "diwali", "image": "/static/media/diwali.jpg" } ]

Landscape, about 1600px wide.

## Production images
    static/media/taj.jpg   rama.jpg   ...

  "productions": [ { "id": "taj", "image": "/static/media/taj.jpg" } ]

Portrait suits the layout best, about 1200px wide.

Any slot left empty simply doesn't render — nothing breaks.

# Images

Drop originals straight in here — full resolution, straight off the camera.
No cropping, no resizing, no exporting. The build does all of it.

    node build.mjs

## Naming

Name the file after the thing it belongs to:

    hero.jpg              the homepage hero
    diwali.jpg            named after the festival id
    yoga.jpg              conservatory.jpg
    taj.jpg  rama.jpg     named after the production id

## Focal point

Nothing is cropped. The whole frame is shipped and CSS decides what shows,
so if the framing is wrong you rename the file rather than re-export it.

    hero.jpg              centred (the default)
    hero--bottom.jpg      anchored to the bottom — good for crowd shots
    hero--top.jpg         anchored to the top — good for skylines
    hero--60.jpg          anchored 60% down

Also accepted: `top`, `bottom`, `left`, `right`, `center`,
`top-left`, `top-right`, `bottom-left`, `bottom-right`.

## What the build produces

For every source image, five widths (480 to 2400px) in three formats
(AVIF, WebP, JPEG) — fifteen files — plus a `<picture>` element with the right
`srcset`, intrinsic dimensions so nothing jumps while loading, and lazy loading
below the fold.

A phone downloads roughly 28 KB where the original was 7.6 MB.

Results are cached by content hash in `.cache/`. The first build of a new image
takes a few seconds; every build after that is instant. Changing the focal point
costs nothing — it only alters a CSS value.

## Video

    media/hero.mp4

Copied across as-is; it isn't transcoded. 8–12 seconds, muted, wide crop,
under 5 MB.

    ffmpeg -i source.mov -vf "scale=1920:-2,crop=1920:816" -t 10 -an \
      -c:v libx264 -crf 30 -preset slow -pix_fmt yuv420p \
      -movflags +faststart hero.mp4

## Formats in

`.jpg` `.jpeg` `.png` `.webp` `.avif` `.tif`. HEIC from an iPhone needs
converting first — Preview on macOS will do it.

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

## Video in the hero

    media/hero.mp4            artindia.be
    media/diwali-hero.mp4     diwali.artindia.be

Drop the file in and it plays — muted, looping, no controls, filling the hero.

**Keep the still image too.** `hero.jpg` and `diwali-hero.jpg` are not replaced
by the video; they sit underneath it and do three jobs: they show while the
video loads, they show if a browser blocks autoplay, and they show for anyone
who has reduced motion switched on in their system settings. Without the still,
those visitors get a black rectangle.

The video is copied across as-is — it is not transcoded, so compress it first.

### Making the file

8–12 seconds, no sound, no titles or captions burned in, wide crop, **under
5 MB**. It plays silently and loops, so it wants to be a moving photograph
rather than a film: lamps being lit, the crowd at dusk, a slow pan across the
esplanade. Avoid hard cuts — the loop point will be obvious.

    ffmpeg -i source.mov \
      -vf "scale=1920:-2,crop=1920:816" -t 10 -an \
      -c:v libx264 -crf 30 -preset slow -pix_fmt yuv420p \
      -movflags +faststart diwali-hero.mp4

`-an` strips the audio. `-crf 30` is the quality dial: lower is better and
larger, 28–32 is the useful range. `+faststart` puts the index at the front of
the file so it begins playing before it has finished downloading — without it,
a phone stares at the poster for several seconds.

Check the size before committing:

    ls -lh media/diwali-hero.mp4

Over about 8 MB, raise the crf or shorten the clip. Mobile visitors on 4G at
the Heysel metro are the people you are optimising for.

### Optional: a smaller WebM

    ffmpeg -i diwali-hero.mp4 -c:v libvpx-vp9 -crf 36 -b:v 0 -an diwali-hero.webm

If both exist the browser takes whichever it prefers — usually WebM, at roughly
30% smaller. Purely an optimisation; the MP4 alone is fine.

## Formats in

`.jpg` `.jpeg` `.png` `.webp` `.avif` `.tif`. HEIC from an iPhone needs
converting first — Preview on macOS will do it.

# Sensory panel photographs

One folder per panel, numbered files inside:

    media/panels/see/01.jpg   02.jpg   03.jpg
    media/panels/hear/01.jpg  ...
    media/panels/taste/  drink/  feel/

Three to five per panel. Landscape, at least 1200px wide, straight off the
camera; the build copies them to /static/panels/<panel>/ and the gallery lazy
loads them.

Nothing renders until `flags.galleries_enabled` in data/diwali.json is true.
Dropping files in with the flag off changes nothing on the page, which is
deliberate: half a gallery looks worse than none.

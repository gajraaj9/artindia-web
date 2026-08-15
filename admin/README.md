# Editing the site in a browser

    https://artindia.be/admin/

Sveltia CMS. It reads and writes `data/content.json` and `media/` straight in the
GitHub repo — there is no database and no server to keep running. Saving makes a
commit; Cloudflare rebuilds and the change is live in a minute or two.

---

## Signing in — one-time setup

Sveltia can sign in with a GitHub personal access token, which avoids setting up
an OAuth application.

1. GitHub → Settings → Developer settings → **Personal access tokens** →
   Fine-grained tokens → **Generate new token**
2. Repository access: **Only select repositories** → `gajraaj9/artindia-web`
3. Permissions → Repository permissions → **Contents: Read and write**
4. Expiration: a year is reasonable. Note the date; the token stops working when
   it lapses and the fix is to generate another one.
5. Generate, copy the token, then paste it at `/admin/` when asked.

The token is held in your browser only. Signing in on a phone or a second
computer means pasting it again.

### Adding other people

For Shreya or a volunteer, either issue each person their own token by the steps
above, or set up GitHub OAuth so they can sign in with a GitHub account and no
token at all — see https://github.com/sveltia/sveltia-cms-auth, which runs on a
free Cloudflare Worker. Worth doing once more than two people are editing.

---

## What you can change

| Section | Covers |
|---|---|
| **Pages** | The home page — headline, opening paragraph, body |
| **Festivals** | Diwali, Yoga Fest, the Conservatory — text and photographs |
| **Productions** | The five stage works, their performance history and images |
| **Numbers & venues** | The figures on the site, and the venue band |
| **Other pages** | Organisation, Ten years, Partners, Press |
| **Contact & legal** | Address, VAT, board, motto, email addresses |

Everything is in English and French side by side. **The build refuses to publish
if a translation is missing**, so an English-only change will fail rather than
appear half-finished.

---

## Photographs

Upload full size, straight off the camera. The build resizes to five widths in
three formats and picks the right one per device — a 7 MB original reaches a
phone as about 28 KB.

If the framing is wrong, rename the file in `media/` to shift the focal point
rather than re-cropping:

    hero.jpg          centred
    hero--bottom.jpg  anchored low — good for crowds
    hero--top.jpg     anchored high — good for skylines
    hero--60.jpg      60% down

## Two things worth knowing

**Meta descriptions must be under 160 characters.** The build fails otherwise —
deliberately, since that text is what appears in search results.

**Leave a number empty to hide it.** Visitor and performer counts don't render
until they have a value, so nothing has to be invented.

# Claude Code brief: the programme page (built hidden)

Site: diwali.artindia.be. Repo: `~/artindia`. Generator: `build-diwali.mjs`.
Written 1 Oct 2026. Decisions in this brief are signed off by Ravi.

## 1. What to build

A full programme page for the Brussels Diwali Festival 2026, in EN, FR and NL, with one page per festival day. It is built and deployed now but stays **hidden**: no link points to it, search engines are told not to index it, and it is absent from the sitemap. Ravi opens it by typing the URL. Photos will arrive later; the page must look finished without any.

The page presents each day as a journey in four chapters. A visitor sees one day at a time and must always know which day they are looking at.

## 2. What must not change

- The landing page (`/`, `/fr/`, `/nl/`): layout, copy, nav and the existing "Your day, hour by hour" section stay exactly as they are.
- `/partners/` pages.
- `sitemap.xml` and `robots.txt` content, while the page is hidden.
- Prices, ticket links and everything under `functions/`, except the one `cta` id noted in section 7.
- No new dependency, no framework, no client-side rendering. The page must be complete with JavaScript switched off.

## 3. URLs

| Day | EN | FR | NL |
|---|---|---|---|
| Saturday | `/programme/` | `/fr/programme/` | `/nl/programme/` |
| Sunday | `/programme/sunday/` | `/fr/programme/sunday/` | `/nl/programme/sunday/` |

- The two days are separate pages on purpose. The "tabs" are plain links, so the switch works without JavaScript, each day has its own link for ads and WhatsApp, and the two days can never be on screen together.
- `/programme/` is the Saturday page. There is no separate `/programme/saturday/`.
- Follow the `partners` pattern in `render(lang, page)`: add a `PROGRAMME_OF` map per day, self-referencing canonical, `hreflang` alternates that point at the same day in the other languages, and a language switcher that keeps the visitor on the same day.
- The head `langScript` must never redirect away from a programme page (same rule as partners: only the English root redirects).

## 4. Hidden now, public later

Add `"programme_public": false` to `flags` in `data/diwali.json`.

| | `programme_public: false` (now) | `programme_public: true` (later) |
|---|---|---|
| Pages built and deployed | yes | yes |
| `<meta name="robots">` on the six pages | `noindex, nofollow` | none |
| In `sitemap.xml` | no | yes, all six with alternates |
| Header nav "Programme" on every page | unchanged (`#awaits` on the landing page) | links to the programme page of that language |
| Any other link to it (footer, landing, partners) | none | none added by this brief |

On the programme pages themselves the header nav renders as on `/partners/`, with "Programme" marked as the current page.

Do not flip the flag. Ravi does that.

## 5. Data: `data/programme.json`

Create this file with exactly the content in section 12. All copy is final and translated; do not rewrite, shorten or re-translate it. Every visitor-facing string is `{en, fr, nl}` and goes through the existing `t()`, so a missing translation fails the build.

How the build reads it:

- `days[].chapters` lists the act ids of chapters 1 to 3 for that day, in running order. Keep that order.
- An act that appears on only one of the two days gets that day's `only` label as a badge. Compute this in the build; it is not stored.
- `days[].feature` names the featured block for that day (`null` means none). The block renders at the top of its `chapter`, above the act cards.
- `feature.bio` is `null` for now. Render the bio paragraph only when it has text.
- `t2b` is the fourth chapter. It is identical on both pages.
- `chapters[].ground` is the section colour under the cards; `chapters[].band` is the colour of the opening band when its photo is missing.
- `hindi` strings are Devanagari and language-independent. Wrap them in `lang="hi"`.

Add `data/programme.json` to the `paths:` list in `.github/workflows/deploy-diwali.yml`, otherwise an edit to the programme will not deploy.

## 6. Page structure, top to bottom

Same shell as the other pages: header, footer, Diya widget, bottom sticky ticket bar. `<main id="programme-main">`, body class `page-programme`.

1. **Intro block** (indigo `#171B3D`)
   - `hero.kicker`, then `<h1>` `hero.headline`, then `hero.intro`.
   - Label `hero.choose`, then two large day cards side by side (two columns at every width, phones included). Each card is a link to that day's page and contains, in this order: the date, a status pill, the Hindi word (small), the English word (large), the tagline.
   - The card of the page being viewed is filled marigold with indigo text, carries `aria-current="page"` and the pill `ui.now_showing`. The other card is outlined, light text, pill `ui.tap_to_view`.
   - Below the cards: `hero.night_line`.
2. **Day bar** (night `#0B0E24`, 4 px marigold bottom border)
   - `position: sticky` at the top of the viewport, below the site header if the header is itself fixed. It must not collide with the bottom sticky ticket bar.
   - Left: `ui.viewing`, the day's `date` in Rozha One marigold, the day's `word`.
   - Right: two pill links, `button` of each day; the current one filled, with `aria-current="page"`.
   - Give it `id="day"`. Every link that switches day points at the other page with `#day`, so the visitor lands on the bar and not back at the top.
3. **Chapters 1, 2, 3** (one `<section>` each, from `chapters[]`)
   - **Opening band**: full width. With a photo: the photo as cover, plus a dark scrim rising from the bottom. Without: flat `band` colour. Content sits at the bottom left: a marigold pill with the day's `short` date, the label "`ui.chapter` N · `when`", the Hindi word, `<h2>` `title`, `promise`.
   - **Body** on the `ground` colour: the feature block if this day has one for this chapter, then the act cards in a grid.
   - **Act card**: square thumbnail (only if the photo exists), `tag`, `<h3>` `name`, `line`, and the "only on" badge when it applies.
4. **Chapter 4: Ticket2Bollywood** (night `#0B0E24`). This is the finale and the largest block on the page.
   - Opening band, the tallest: photo or flat night. Content: marigold pill `ui.both_days`, label "`ui.chapter` 4 · `t2b.when`", `t2b.kicker` in marigold, `<h2>` `t2b.title` in the largest type on the page.
   - `t2b.intro`, then four cards in running order, numbered in their label: "1 · `step`". Each card: photo (if present), label, `name`, `sub`, `line`. The card with `headline: true` is filled marigold with indigo text.
   - Closing row: the day's `that_was` on the left; on the right an outlined link with the **other** day's `see`, pointing at the other day's page `#day`.
5. **Ticket band** (indigo): `ui.ticket_heading`, then the existing ticket note and button. Reuse `d.tickets.notes[0]` and `d.tickets.cta_live`; do not write any price into this page by hand, so prices cannot drift from the landing page.
6. **Between the acts** (paper `#F2EFE6`): label `ui.between`, then the five `between[]` items in a row that wraps.

Heading order: one `<h1>`, chapters are `<h2>`, acts are `<h3>`.

## 7. Ticket links

The button in the ticket band uses `buyHref('programme', lang)`. Check that `functions/go/buy.js` accepts `programme` as a `cta` id and that the Funnel tab counts it; extend the allowed ids if needed. Nothing else in `functions/` changes.

## 8. Visual spec

Fonts and base tokens are the existing ones (`--display` Rozha One, `--text` Mukta, `--night`, `--marigold`, `--saffron`, `--ink`). Put the new CSS in `static/diwali.css`, classes prefixed `pg-`.

The rest of the site is dark. This page deliberately moves from light to dark as the day goes on: pale morning, gold afternoon, marigold evening, night. Keep that progression.

| Token | Value | Used for |
|---|---|---|
| indigo | `#171B3D` | intro block, ticket band, feature block, text on light grounds |
| night | `#0B0E24` | day bar, Ticket2Bollywood |
| dawn | `#FFF6E6` | chapter 1 ground |
| gold | `#FBE7BD` | chapter 2 ground |
| marigold | `#E8A33B` | chapter 3 ground, selected states, pills |
| card | `#FFFDF7` | act cards |
| paper | `#F2EFE6` | light text, "between" strip |
| brown | `#7A4300` | tags on light cards |
| warm light | `#FFD08A`, `#FFD9A8` | labels and intro lines on dark grounds |

Type and sizes (desktop / phone at 390 px):

| Element | Spec |
|---|---|
| `h1` | Rozha One, `clamp(36px, 5.6vw, 70px)`, line-height 1.04 |
| Day card: date | Mukta 700, uppercase, letter-spacing 0.1em, 17 px / 13 px |
| Day card: Hindi | Rozha One, 34 px / 23 px |
| Day card: English word | Rozha One, `clamp(26px, 4.6vw, 56px)` |
| Day card: tagline | 16 px; hidden below 480 px |
| Day bar: date | Rozha One, 26 px / 19 px, marigold |
| Band height | min 340 px / 260 px; Ticket2Bollywood min 520 px / 380 px |
| Band scrim | `linear-gradient(to top, rgba(11,14,36,.94), rgba(11,14,36,.7) 45%, rgba(11,14,36,0))` |
| Chapter label | Mukta 700, uppercase, 18 px / 14 px, `#FFD08A` |
| Chapter Hindi | Rozha One, 40 px / 28 px, marigold |
| Chapter `h2` | Rozha One, `clamp(40px, 5.8vw, 76px)`, paper |
| Chapter promise | 20 px / 17 px, `#FFD9A8` |
| Act grid | `repeat(auto-fit, minmax(300px, 1fr))`, gap 14 px: three, two, then one column |
| Act card | card colour, 1 px border, radius 12 px, padding 14 px; thumbnail 72 px square, radius 8 px |
| Act text | tag 12 px 700 uppercase brown; name 18 px 700 indigo; line 15 px `#4A4858` |
| "Only on" badge | pill, 12 px 600, indigo ground, paper text |
| Feature block | indigo ground, 3 px marigold border, radius 18 px; photo 210 x 240 px; pills for `feature.badge` and the day's `only`; Hindi 28 px marigold; name Rozha One `clamp(34px, 4.2vw, 52px)`; `title` 21 px 700 marigold; `line` 17 px |
| Ticket2Bollywood `h2` | Rozha One, `clamp(38px, 8.4vw, 108px)`, paper; must not overflow at 390 px |
| Ticket2Bollywood cards | `repeat(auto-fit, minmax(230px, 1fr))`, gap 18 px; ground `#1B2046`, border `#4A4F8A`, radius 16 px; photo 150 px tall; name Rozha One 30 px |

Content width follows the site's `--max` and `--pad`.

## 9. Photos

- Originals go in `media/programme/`, full resolution, named by id. Ravi is collecting them; build without them.
- Chapter bands: `chapter-blessing`, `chapter-heritage`, `chapter-colours`, `chapter-t2b`.
- Feature: `suryaprakash`.
- Acts: the act `id` (`opening`, `puja`, `kathak`, and so on). Ticket2Bollywood cards: the item `id` (`t2b-bollywood`, `dj-nitro`, `fireworks`, `dj-param`).
- The existing focal-point suffix applies (`kathak--top.jpg`).
- Use the existing image pipeline (`images.mjs`). It currently reads only the top level of `media/` and caches by stem, so give the programme folder its own namespace in the smallest way that keeps the cache and output names from colliding with the existing stems. Prepare only the stems the programme references.
- **A missing photo is normal, not an error.** No thumbnail on that card, flat colour on that band, nothing broken, no placeholder box. Print one summary line in the build log listing the missing stems.
- Bands: `sizes="100vw"`. Thumbnails: request the smallest width. Everything below the first band is `loading="lazy"`.
- Thumbnails are decorative (`alt=""`); bands use the `alt` from the data.
- No AI-generated images, ever.

## 10. Copy rules for this page

- No clock times anywhere on the page. Timings are internal.
- No em dashes in visitor-facing text.
- Never "weekend ticket". The wording is "come Saturday or Sunday, or both".
- The party is "Ticket2Bollywood". The word "Jashn" must not appear.
- "Avenue of Lights" must not appear: it is not happening in 2026.
- No cooking on stage: the culinary act is a film and a talk.
- "The best Indian DJ in Europe" is an unsourced claim signed off by Ravi on 1 Oct 2026. If anyone asks for backing, that goes to Ravi.

## 11. Tests and acceptance

Add `test/programme.test.mjs`. Build once, then assert on `dist-diwali/`:

1. The six pages exist.
2. With `programme_public: false`: each of the six carries `noindex`; `sitemap.xml` contains no `/programme`; no page outside the six contains a link to `/programme`.
3. The Saturday page contains "Dr. Suryaprakash" and "Shobha Yatra", and not "Kirtan with ISKCON" or "Brides of India". The Sunday page is the reverse.
4. Both pages contain "Ticket2Bollywood" and all four of its cards.
5. Each page links to the other day with `#day`, and marks exactly one day card `aria-current="page"`.
6. Inside `<main>` of all six pages: no em dash, no "Jashn", no "Avenue of Lights", no "weekend", and no clock time (`\b\d{1,2}[:.h]\d{2}\b`).
7. `/fr/programme/` contains "Racines"; `/nl/programme/` contains "Wortels".
8. The build passes with an empty or absent `media/programme/`.

Also check by eye at 390 px and 1280 px: the day cards stay side by side, nothing overflows horizontally, and the day bar stays on screen while scrolling.

`npm test` must stay green. Commit and push to `main` as usual.

Report back with: the files changed, the six live URLs, the list of missing photo stems from the build log, and anything in this brief you could not do as written.

## 12. `data/programme.json`

```json
{
  "meta": {
    "title": {"en": "Programme | Brussels Diwali Festival 2026", "fr": "Programme | Brussels Diwali Festival 2026", "nl": "Programma | Brussels Diwali Festival 2026"},
    "description": {"en": "Two days, four chapters: the full programme of the Brussels Diwali Festival, 24 and 25 October 2026 at the Atomium.", "fr": "Deux jours, quatre chapitres : le programme complet du Brussels Diwali Festival, les 24 et 25 octobre 2026 à l'Atomium.", "nl": "Twee dagen, vier hoofdstukken: het volledige programma van het Brussels Diwali Festival, 24 en 25 oktober 2026 aan het Atomium."}
  },
  "hero": {
    "kicker": {"en": "Programme · 24 and 25 October 2026 · Atomium Esplanade", "fr": "Programme · 24 et 25 octobre 2026 · Esplanade de l'Atomium", "nl": "Programma · 24 en 25 oktober 2026 · Esplanade van het Atomium"},
    "headline": {"en": "Two days. Four chapters. All of India.", "fr": "Deux jours. Quatre chapitres. Toute l'Inde.", "nl": "Twee dagen. Vier hoofdstukken. Heel India."},
    "intro": {"en": "From the opening blessing to the fireworks, each day is a journey through India. Choose your day, or come for both.", "fr": "De la bénédiction d'ouverture au feu d'artifice, chaque journée est un voyage à travers l'Inde. Choisissez votre jour, ou venez les deux.", "nl": "Van de openingszegen tot het vuurwerk: elke dag is een reis door India. Kies je dag, of kom allebei."},
    "choose": {"en": "Choose your day", "fr": "Choisissez votre jour", "nl": "Kies je dag"},
    "night_line": {"en": "Whichever day you choose, the night ends with fireworks and Ticket2Bollywood.", "fr": "Quel que soit le jour choisi, la nuit se termine par le feu d'artifice et Ticket2Bollywood.", "nl": "Welke dag je ook kiest, de nacht eindigt met vuurwerk en Ticket2Bollywood."}
  },
  "ui": {
    "now_showing": {"en": "Now showing", "fr": "Programme affiché", "nl": "Nu getoond"},
    "tap_to_view": {"en": "Tap to view", "fr": "Voir ce jour", "nl": "Bekijk deze dag"},
    "viewing": {"en": "You are viewing", "fr": "Vous consultez", "nl": "Je bekijkt"},
    "chapter": {"en": "Chapter", "fr": "Chapitre", "nl": "Hoofdstuk"},
    "both_days": {"en": "Saturday and Sunday", "fr": "Samedi et dimanche", "nl": "Zaterdag en zondag"},
    "between": {"en": "Between the acts", "fr": "Entre les spectacles", "nl": "Tussen de optredens"},
    "ticket_heading": {"en": "One ticket. Come Saturday or Sunday, or both.", "fr": "Un billet. Venez samedi ou dimanche, ou les deux.", "nl": "Eén ticket. Kom zaterdag of zondag, of allebei."}
  },
  "days": [
    {
      "id": "saturday",
      "slug": "",
      "date": {"en": "Saturday 24 October", "fr": "Samedi 24 octobre", "nl": "Zaterdag 24 oktober"},
      "short": {"en": "Saturday 24 Oct", "fr": "Samedi 24 oct.", "nl": "Zaterdag 24 okt"},
      "button": {"en": "Saturday", "fr": "Samedi", "nl": "Zaterdag"},
      "hindi": "परंपरा",
      "word": {"en": "Roots", "fr": "Racines", "nl": "Wortels"},
      "tagline": {"en": "Tradition, family and the classical masters.", "fr": "Tradition, famille et grands maîtres classiques.", "nl": "Traditie, familie en de klassieke meesters."},
      "only": {"en": "Only on Saturday", "fr": "Uniquement le samedi", "nl": "Alleen op zaterdag"},
      "that_was": {"en": "That was Saturday. Sunday has its own programme.", "fr": "Voilà pour le samedi. Le dimanche a son propre programme.", "nl": "Dat was zaterdag. Zondag heeft zijn eigen programma."},
      "see": {"en": "See Saturday: Roots", "fr": "Voir le samedi : Racines", "nl": "Bekijk zaterdag: Wortels"},
      "feature": "suryaprakash",
      "chapters": {
        "blessing": ["opening", "procession", "puja", "offering"],
        "heritage": ["vandana", "ganesha", "spice-route", "little-india", "ramayana", "magic", "saree", "conservatory"],
        "colours": ["tollywood", "ghoomar", "hiphop", "kathak", "dakshin", "devi", "address", "pind"]
      }
    },
    {
      "id": "sunday",
      "slug": "sunday",
      "date": {"en": "Sunday 25 October", "fr": "Dimanche 25 octobre", "nl": "Zondag 25 oktober"},
      "short": {"en": "Sunday 25 Oct", "fr": "Dimanche 25 oct.", "nl": "Zondag 25 okt"},
      "button": {"en": "Sunday", "fr": "Dimanche", "nl": "Zondag"},
      "hindi": "संगम",
      "word": {"en": "Encounters", "fr": "Rencontres", "nl": "Ontmoetingen"},
      "tagline": {"en": "Meetings of styles, collaborations and glamour.", "fr": "Rencontres de styles, collaborations et glamour.", "nl": "Ontmoetingen van stijlen, samenwerkingen en glamour."},
      "only": {"en": "Only on Sunday", "fr": "Uniquement le dimanche", "nl": "Alleen op zondag"},
      "that_was": {"en": "That was Sunday. Saturday has its own programme.", "fr": "Voilà pour le dimanche. Le samedi a son propre programme.", "nl": "Dat was zondag. Zaterdag heeft zijn eigen programma."},
      "see": {"en": "See Sunday: Encounters", "fr": "Voir le dimanche : Rencontres", "nl": "Bekijk zondag: Ontmoetingen"},
      "feature": null,
      "chapters": {
        "blessing": ["opening", "puja", "offering", "kirtan"],
        "heritage": ["ramayana", "odissi", "saree", "hiphop", "conservatory", "devi", "collaborations"],
        "colours": ["dakshin", "tollywood", "kathak", "brides", "ganesha", "pind", "ghoomar"]
      }
    }
  ],
  "chapters": [
    {
      "id": "blessing",
      "n": 1,
      "photo": "chapter-blessing",
      "ground": "#FFF6E6",
      "band": "#8A4B00",
      "when": {"en": "From noon", "fr": "Dès midi", "nl": "Vanaf de middag"},
      "hindi": "शुभ आरंभ",
      "title": {"en": "The Blessing", "fr": "La Bénédiction", "nl": "De Zegen"},
      "promise": {"en": "A spiritual journey to India.", "fr": "Un voyage spirituel en Inde.", "nl": "Een spirituele reis naar India."},
      "alt": {"en": "The puja at the festival temple", "fr": "La puja au temple du festival", "nl": "De puja in de festivaltempel"}
    },
    {
      "id": "heritage",
      "n": 2,
      "photo": "chapter-heritage",
      "ground": "#FBE7BD",
      "band": "#5C3A00",
      "when": {"en": "Afternoon", "fr": "Après-midi", "nl": "Namiddag"},
      "hindi": "विरासत",
      "title": {"en": "The Heritage", "fr": "L'Héritage", "nl": "Het Erfgoed"},
      "promise": {"en": "Masters, epics and flavours.", "fr": "Maîtres, épopées et saveurs.", "nl": "Meesters, epossen en smaken."},
      "alt": {"en": "A classical performance on the festival stage", "fr": "Un spectacle classique sur la scène du festival", "nl": "Een klassiek optreden op het festivalpodium"}
    },
    {
      "id": "colours",
      "n": 3,
      "photo": "chapter-colours",
      "ground": "#E8A33B",
      "band": "#171B3D",
      "when": {"en": "Evening", "fr": "Soirée", "nl": "Avond"},
      "hindi": "रंग",
      "title": {"en": "The Colours of India", "fr": "Les Couleurs de l'Inde", "nl": "De Kleuren van India"},
      "promise": {"en": "Culture and diversity on one stage.", "fr": "Culture et diversité sur une seule scène.", "nl": "Cultuur en diversiteit op één podium."},
      "alt": {"en": "A regional dance on the festival stage in the evening", "fr": "Une danse régionale sur la scène du festival, en soirée", "nl": "Een regionale dans op het festivalpodium, 's avonds"}
    }
  ],
  "feature": {
    "id": "suryaprakash",
    "chapter": "heritage",
    "photo": "suryaprakash",
    "badge": {"en": "Exclusive concert", "fr": "Concert exclusif", "nl": "Exclusief concert"},
    "hindi": "विद्वान",
    "name": "Dr. Suryaprakash",
    "title": {"en": "Vidwan of the Festival", "fr": "Vidwan du Festival", "nl": "Vidwan van het Festival"},
    "line": {"en": "The festival's guest maestro gives one concert only: the classical music of South India, live at the foot of the Atomium.", "fr": "Le maître invité du festival donne un seul concert : la musique classique de l'Inde du Sud, en live au pied de l'Atomium.", "nl": "De gastmaestro van het festival geeft één enkel concert: de klassieke muziek van Zuid-India, live aan de voet van het Atomium."},
    "bio": null
  },
  "acts": [
    {
      "id": "opening",
      "tag": {"en": "Opening", "fr": "Ouverture", "nl": "Opening"},
      "name": {"en": "Why We Light the Lamp", "fr": "Pourquoi nous allumons la lampe", "nl": "Waarom we de lamp aansteken"},
      "line": {"en": "The story of Diwali, told as the festival opens.", "fr": "L'histoire de Diwali, racontée à l'ouverture du festival.", "nl": "Het verhaal van Diwali, verteld bij de opening van het festival."}
    },
    {
      "id": "procession",
      "tag": {"en": "Procession", "fr": "Procession", "nl": "Processie"},
      "name": {"en": "Shobha Yatra: the Temple Procession", "fr": "Shobha Yatra : la procession du temple", "nl": "Shobha Yatra: de tempelprocessie"},
      "line": {"en": "To the festival temple, in music and colour.", "fr": "Vers le temple du festival, en musique et en couleurs.", "nl": "Naar de festivaltempel, met muziek en kleur."}
    },
    {
      "id": "puja",
      "tag": {"en": "Ceremony", "fr": "Cérémonie", "nl": "Ceremonie"},
      "name": {"en": "The Diwali Puja", "fr": "La puja de Diwali", "nl": "De Diwali-puja"},
      "line": {"en": "The traditional blessing. Everyone is welcome.", "fr": "La bénédiction traditionnelle. Tout le monde est le bienvenu.", "nl": "De traditionele zegening. Iedereen is welkom."}
    },
    {
      "id": "offering",
      "tag": {"en": "Classical dance", "fr": "Danse classique", "nl": "Klassieke dans"},
      "name": {"en": "An Offering in Dance", "fr": "Une offrande dansée", "nl": "Een offer in dans"},
      "line": {"en": "Classical dance performed as a prayer.", "fr": "La danse classique comme une prière.", "nl": "Klassieke dans, opgevoerd als een gebed."}
    },
    {
      "id": "kirtan",
      "tag": {"en": "Devotional music", "fr": "Musique dévotionnelle", "nl": "Devotionele muziek"},
      "name": {"en": "Kirtan with ISKCON", "fr": "Kirtan avec ISKCON", "nl": "Kirtan met ISKCON"},
      "line": {"en": "Devotional singing you are invited to join.", "fr": "Des chants dévotionnels auxquels vous êtes invités à vous joindre.", "nl": "Devotionele zang waarbij je mag meezingen."}
    },
    {
      "id": "vandana",
      "tag": {"en": "Classical dance", "fr": "Danse classique", "nl": "Klassieke dans"},
      "name": {"en": "Vandana: the Classical Invocation", "fr": "Vandana : l'invocation classique", "nl": "Vandana: de klassieke invocatie"},
      "line": {"en": "A dance of salutation opens the stage.", "fr": "Une danse de salutation ouvre la scène.", "nl": "Een begroetingsdans opent het podium."}
    },
    {
      "id": "ganesha",
      "tag": {"en": "Dance", "fr": "Danse", "nl": "Dans"},
      "name": {"en": "Deva Shree Ganesha", "fr": "Deva Shree Ganesha", "nl": "Deva Shree Ganesha"},
      "line": {"en": "A tribute to the remover of obstacles.", "fr": "Un hommage à celui qui lève les obstacles.", "nl": "Een eerbetoon aan de wegnemer van obstakels."}
    },
    {
      "id": "spice-route",
      "tag": {"en": "Film and talk", "fr": "Film et rencontre", "nl": "Film en gesprek"},
      "name": {"en": "The Spice Route: a Culinary Journey", "fr": "La Route des épices : un voyage culinaire", "nl": "De Specerijenroute: een culinaire reis"},
      "line": {"en": "India's food story, told in film and talk.", "fr": "L'histoire de la cuisine indienne, en film et en paroles.", "nl": "Het verhaal van de Indiase keuken, in film en gesprek."}
    },
    {
      "id": "little-india",
      "tag": {"en": "Children", "fr": "Enfants", "nl": "Kinderen"},
      "name": {"en": "Little India: the Next Generation", "fr": "Little India : la nouvelle génération", "nl": "Little India: de nieuwe generatie"},
      "line": {"en": "The festival's youngest performers.", "fr": "Les plus jeunes artistes du festival.", "nl": "De jongste artiesten van het festival."}
    },
    {
      "id": "ramayana",
      "tag": {"en": "Dance drama", "fr": "Théâtre dansé", "nl": "Dansdrama"},
      "name": {"en": "Ramayana: the Epic behind Diwali", "fr": "Ramayana : l'épopée à l'origine de Diwali", "nl": "Ramayana: het epos achter Diwali"},
      "line": {"en": "The story of Rama's return, in dance drama.", "fr": "Le retour de Rama, raconté en théâtre dansé.", "nl": "Het verhaal van Rama's terugkeer, als dansdrama."}
    },
    {
      "id": "magic",
      "tag": {"en": "Magic", "fr": "Magie", "nl": "Goochelen"},
      "name": {"en": "Jadoo: the Indian Magic Show", "fr": "Jadoo : le spectacle de magie indien", "nl": "Jadoo: de Indiase goochelshow"},
      "line": {"en": "Wonder for children of every age.", "fr": "De l'émerveillement pour les enfants de tous les âges.", "nl": "Verwondering voor kinderen van alle leeftijden."}
    },
    {
      "id": "saree",
      "tag": {"en": "Saree showcase", "fr": "Défilé de saris", "nl": "Sarishow"},
      "name": {"en": "Six Yards of Grace", "fr": "Six Yards of Grace", "nl": "Six Yards of Grace"},
      "line": {"en": "The saree in all its regional styles.", "fr": "Le sari dans tous ses styles régionaux.", "nl": "De sari in al zijn regionale stijlen."}
    },
    {
      "id": "conservatory",
      "tag": {"en": "Live music", "fr": "Musique live", "nl": "Livemuziek"},
      "name": {"en": "The Conservatory Concert", "fr": "Le concert du Conservatoire", "nl": "Het Conservatoriumconcert"},
      "line": {"en": "Art India Music Conservatory, live.", "fr": "L'Art India Music Conservatory, en live.", "nl": "Het Art India Music Conservatory, live."}
    },
    {
      "id": "odissi",
      "tag": {"en": "Odisha", "fr": "Odisha", "nl": "Odisha"},
      "name": {"en": "Odissi: Sculpture in Motion", "fr": "Odissi : la sculpture en mouvement", "nl": "Odissi: beeldhouwkunst in beweging"},
      "line": {"en": "Odisha's temple dance, in collaboration.", "fr": "La danse des temples de l'Odisha, en collaboration.", "nl": "De tempeldans van Odisha, in samenwerking."}
    },
    {
      "id": "hiphop",
      "tag": {"en": "Urban", "fr": "Urbain", "nl": "Urban"},
      "name": {"en": "Desi Beats: Hip Hop", "fr": "Desi Beats: Hip Hop", "nl": "Desi Beats: Hip Hop"},
      "line": {"en": "India's new generation, in its own language.", "fr": "La nouvelle génération indienne, dans son propre langage.", "nl": "De nieuwe generatie van India, in haar eigen taal."}
    },
    {
      "id": "devi",
      "tag": {"en": "Gujarat", "fr": "Gujarat", "nl": "Gujarat"},
      "name": {"en": "Devi: a Celebration of Motherhood", "fr": "Devi : une célébration de la maternité", "nl": "Devi: een viering van het moederschap"},
      "line": {"en": "Gujarat's tribute to the Mother Goddess.", "fr": "L'hommage du Gujarat à la Déesse Mère.", "nl": "Het eerbetoon van Gujarat aan de Moedergodin."}
    },
    {
      "id": "collaborations",
      "tag": {"en": "Collaboration", "fr": "Collaboration", "nl": "Samenwerking"},
      "name": {"en": "Culture United: the Collaborations", "fr": "Culture United : les collaborations", "nl": "Culture United: de samenwerkingen"},
      "line": {"en": "Traditions meeting on one stage.", "fr": "Des traditions qui se rencontrent sur une même scène.", "nl": "Tradities die elkaar ontmoeten op één podium."}
    },
    {
      "id": "kathak",
      "tag": {"en": "North India", "fr": "Inde du Nord", "nl": "Noord-India"},
      "name": {"en": "Kathak: Three Gharanas, One Stage", "fr": "Kathak : trois gharanas, une scène", "nl": "Kathak: drie gharana's, één podium"},
      "line": {"en": "Jaipur, Lucknow and Banaras side by side.", "fr": "Jaipur, Lucknow et Bénarès côte à côte.", "nl": "Jaipur, Lucknow en Benares zij aan zij."}
    },
    {
      "id": "ghoomar",
      "tag": {"en": "Rajasthan", "fr": "Rajasthan", "nl": "Rajasthan"},
      "name": {"en": "Ghoomar: the Royal Swirl of Rajasthan", "fr": "Ghoomar : le tourbillon royal du Rajasthan", "nl": "Ghoomar: de koninklijke werveling van Rajasthan"},
      "line": {"en": "The dance of the desert palaces.", "fr": "La danse des palais du désert.", "nl": "De dans van de woestijnpaleizen."}
    },
    {
      "id": "dakshin",
      "tag": {"en": "South India", "fr": "Inde du Sud", "nl": "Zuid-India"},
      "name": {"en": "Dakshin: a Journey through South India", "fr": "Dakshin : un voyage à travers l'Inde du Sud", "nl": "Dakshin: een reis door Zuid-India"},
      "line": {"en": "The dances of the South in one sweep.", "fr": "Les danses du Sud en un seul élan.", "nl": "De dansen van het zuiden in één beweging."}
    },
    {
      "id": "pind",
      "tag": {"en": "Punjab", "fr": "Pendjab", "nl": "Punjab"},
      "name": {"en": "Pind: a Journey to the Punjabi Village", "fr": "Pind : un voyage au village pendjabi", "nl": "Pind: een reis naar het Punjabi dorp"},
      "line": {"en": "The beat and the joy of rural Punjab.", "fr": "Le rythme et la joie du Pendjab rural.", "nl": "Het ritme en de vreugde van het landelijke Punjab."}
    },
    {
      "id": "tollywood",
      "tag": {"en": "Telugu cinema", "fr": "Cinéma télougou", "nl": "Telugu-cinema"},
      "name": {"en": "Tollywood Fire", "fr": "Tollywood Fire", "nl": "Tollywood Fire"},
      "line": {"en": "The pulse of Telugu cinema.", "fr": "Le pouls du cinéma télougou.", "nl": "De hartslag van de Telugu-cinema."}
    },
    {
      "id": "brides",
      "tag": {"en": "Bridal showcase", "fr": "Défilé nuptial", "nl": "Bruidsshow"},
      "name": {"en": "Brides of India", "fr": "Brides of India", "nl": "Brides of India"},
      "line": {"en": "One country, many weddings: a bridal journey.", "fr": "Un pays, tant de mariages : un voyage nuptial.", "nl": "Eén land, vele bruiloften: een reis langs de bruidstradities."}
    },
    {
      "id": "address",
      "tag": {"en": "Guests of honour", "fr": "Invités d'honneur", "nl": "Eregasten"},
      "name": {"en": "The Diwali Address", "fr": "L'allocution de Diwali", "nl": "De Diwali-toespraak"},
      "line": {"en": "Greetings from the guests of honour.", "fr": "Le mot des invités d'honneur.", "nl": "Een woord van de eregasten."}
    }
  ],
  "t2b": {
    "photo": "chapter-t2b",
    "when": {"en": "Night", "fr": "Nuit", "nl": "Nacht"},
    "kicker": {"en": "The return of", "fr": "Le retour de", "nl": "De terugkeer van"},
    "title": "Ticket2Bollywood",
    "intro": {"en": "Art India's Bollywood night is back, on both nights of the festival. Two different days. The same big night.", "fr": "La soirée Bollywood d'Art India est de retour, les deux soirs du festival. Deux journées différentes. La même grande nuit.", "nl": "De Bollywoodnacht van Art India is terug, op beide avonden van het festival. Twee verschillende dagen. Dezelfde grote nacht."},
    "alt": {"en": "Fireworks above the Atomium at night", "fr": "Feu d'artifice au-dessus de l'Atomium, la nuit", "nl": "Vuurwerk boven het Atomium bij nacht"},
    "items": [
      {
        "id": "t2b-bollywood",
        "headline": false,
        "step": {"en": "On stage", "fr": "Sur scène", "nl": "Op het podium"},
        "name": {"en": "Bollywood", "fr": "Bollywood", "nl": "Bollywood"},
        "sub": {"en": "The stage show", "fr": "Le spectacle", "nl": "De podiumshow"},
        "line": {"en": "The festival's dancers open the night on stage.", "fr": "Les danseurs du festival ouvrent la nuit sur scène.", "nl": "De dansers van het festival openen de nacht op het podium."}
      },
      {
        "id": "dj-nitro",
        "headline": false,
        "step": {"en": "Introducing", "fr": "Première", "nl": "Nieuw"},
        "name": {"en": "DJ Nitro", "fr": "DJ Nitro", "nl": "DJ Nitro"},
        "sub": {"en": "First time on the Diwali stage", "fr": "Pour la première fois sur la scène de Diwali", "nl": "Voor het eerst op het Diwali-podium"},
        "line": {"en": "The esplanade turns dance floor.", "fr": "L'esplanade devient piste de danse.", "nl": "De esplanade wordt een dansvloer."}
      },
      {
        "id": "fireworks",
        "headline": false,
        "step": {"en": "Fireworks", "fr": "Feu d'artifice", "nl": "Vuurwerk"},
        "name": {"en": "Diwali in the Sky", "fr": "Diwali dans le ciel", "nl": "Diwali in de lucht"},
        "sub": {"en": "Fireworks at the Atomium", "fr": "Feu d'artifice à l'Atomium", "nl": "Vuurwerk aan het Atomium"},
        "line": {"en": "Both nights, weather permitting.", "fr": "Les deux soirs, si la météo le permet.", "nl": "Beide avonden, als het weer het toelaat."}
      },
      {
        "id": "dj-param",
        "headline": true,
        "step": {"en": "Headline set", "fr": "Tête d'affiche", "nl": "Headliner"},
        "name": {"en": "DJ Param", "fr": "DJ Param", "nl": "DJ Param"},
        "sub": {"en": "The best Indian DJ in Europe", "fr": "Le meilleur DJ indien d'Europe", "nl": "De beste Indiase dj van Europa"},
        "line": {"en": "The main set. Dance until the lights go down.", "fr": "Le set principal. Dansez jusqu'à l'extinction des lumières.", "nl": "De hoofdset. Dans tot de lichten uitgaan."}
      }
    ]
  },
  "between": [
    {
      "title": {"en": "See", "fr": "Voir", "nl": "Zien"},
      "line": {"en": "Colourful stalls with costumes and crafts.", "fr": "Des échoppes colorées, costumes et artisanat.", "nl": "Kleurrijke kraampjes met kostuums en kunstnijverheid."}
    },
    {
      "title": {"en": "Hear", "fr": "Écouter", "nl": "Horen"},
      "line": {"en": "A dhol you feel before you hear it.", "fr": "Un dhol que l'on sent avant de l'entendre.", "nl": "Een dhol die je voelt voor je hem hoort."}
    },
    {
      "title": {"en": "Taste", "fr": "Goûter", "nl": "Proeven"},
      "line": {"en": "Chaat, dosa and jalebi, region by region.", "fr": "Chaat, dosa et jalebi, région par région.", "nl": "Chaat, dosa en jalebi, regio per regio."}
    },
    {
      "title": {"en": "Drink", "fr": "Boire", "nl": "Drinken"},
      "line": {"en": "Masala chai, sweet lassi and the festival bars.", "fr": "Masala chai, lassi sucré et les bars du festival.", "nl": "Masala chai, zoete lassi en de festivalbars."}
    },
    {
      "title": {"en": "Feel", "fr": "Ressentir", "nl": "Voelen"},
      "line": {"en": "A hand-decorated temple at the foot of the Atomium.", "fr": "Un temple décoré à la main au pied de l'Atomium.", "nl": "Een met de hand versierde tempel aan de voet van het Atomium."}
    }
  ]
}
```

# Claude Code brief: programme page, second pass (tone)

Site: diwali.artindia.be. Repo: `~/artindia`. Follows `docs/claude-code-brief-programme-page.md` (commits d9747c2, 556ee65).
Written 1 Oct 2026. Signed off by Ravi. Everything in the first brief still holds unless this one changes it.

## 1. Why

The first version reads like a religious gathering. After the intro, a visitor meets four devotional acts in a row, under the heading "The Blessing: a spiritual journey to India", and the party sits six phone screens further down. The festival has religious roots but is not a religious event. It is a fun, light, vibrant Indian celebration, open to everyone, and the page has to feel like that from the first screen.

The programme itself does not change. What changes is the wording of the opening, how much room it takes, and where the fun sits.

## 2. Summary of changes

| # | Change | Where |
|---|---|---|
| 1 | A "Don't miss" row of four tiles directly under the day cards | new block in the intro |
| 2 | Chapter 1 becomes "The Welcome", with two act cards instead of four | data only |
| 3 | New intro line and new day taglines that lead with the fun | data only |
| 4 | Chapter shortcuts in the day bar, so the party is one tap away | day bar |
| 5 | `meta.title` removed (unused since the per-day titles) | data only |

Not changing: URLs, the hidden state (`programme_public` stays `false`), the chapter order, chapters 2 and 3, the feature block, Ticket2Bollywood, the ticket band, the landing and partners pages.

## 3. Data

Replace `data/programme.json` with exactly the content in section 8. It was generated from the file currently in the repo, so the per-day `title` you added is kept. Do not rewrite or re-translate any copy.

What is different in the data:

- `meta.title` is gone. `meta.description` stays.
- `hero.intro` and both `days[].tagline` are rewritten.
- Chapter 1: `id` is now `welcome` (was `blessing`), with a new `hindi`, `title`, `promise`, `alt`, and photo stem `chapter-welcome`. Its section id therefore becomes `chapter-welcome`.
- Acts removed: `opening`, `procession`, `puja`, `offering`. Acts added: `lamps`, `parade`. Act `kirtan` is renamed. Each day's `chapters.welcome` now lists two acts.
- New `ui.dont_miss`, new `days[].highlights` (four tiles per day), new top-level `jump` (four shortcut links).

## 4. The "Don't miss" row

- Place it inside the intro block, under the day cards and the `hero.night_line`.
- Label: `ui.dont_miss`, styled like the existing "Choose your day" label.
- Four tiles from the current day's `highlights`, in the given order. Four across on desktop, two by two below 720 px.
- Each tile is one link to its `href`, an anchor on the same page. Add `id="between"` to the "Between the acts" section so the food tile has a target.
- Tile content: `kicker` (12 px, 700, uppercase, `#FFB25C`), `title` (Rozha One, 26 px desktop / 20 px phone), `line` (15 px; hidden below 480 px).
- With a photo: the photo as cover, a dark scrim rising from the bottom, text over the bottom. Reuse the band scrim.
- Without a photo, which is every tile today: a flat tile. The tile with `lead: true` is filled marigold with indigo text. The others are `#262C5C` with paper text and a 1 px `#4A4F8A` border.
- Tile shape: radius 16 px, min-height 220 px desktop / 150 px phone.
- Photos come from `media/programme/` by the `photo` stem, through the same namespace as the other programme images. Several tiles reuse stems that already exist in the list (`chapter-t2b`, `fireworks`, `magic`, `brides`); `food` is new. A missing photo is still normal, not an error.

## 5. Chapter shortcuts in the day bar

- Add the four `jump` links to the day bar, between the date and the day pills on desktop.
- On a phone they form a second row inside the bar: one line, no wrapping, scrolling sideways if they do not fit. The whole bar stays under 96 px tall at 390 px.
- Plain anchor links, no JavaScript, no "current chapter" highlighting.
- Style: Mukta 600, 14 px, `#C9CBE0`; visible keyboard focus.
- Every anchored section (`chapter-welcome`, `chapter-heritage`, `chapter-colours`, `chapter-t2b`, `between`) needs a `scroll-margin-top` equal to the fixed header plus the day bar, so the chapter title is not hidden under the bar after a jump.
- `aria-label` for this nav: reuse `ui.chapter`.

## 6. Photos

The list of stems changes with the data:

- Renamed: `chapter-blessing` is now `chapter-welcome`.
- Gone: `opening`, `procession`, `puja`, `offering`.
- New: `lamps`, `parade`, `food`.

No photo has been delivered yet, so nothing needs moving.

## 7. Tests and acceptance

Update `test/programme.test.mjs`:

1. Saturday contains "Dr. Suryaprakash", "The Festival Parade" and "Lighting the Lamps", and not "Kirtan Sing-Along" or "Brides of India". Sunday contains "Kirtan Sing-Along", "Brides of India" and "Lighting the Lamps", and not "Dr. Suryaprakash" or "The Festival Parade".
2. Inside `<main>` of all six pages, none of these appear: "Blessing", "spiritual", "Puja", "puja", "devotion", "dévotion", "devotionele", "prayer", "prière", "gebed", "Shobha Yatra", "Temple Procession". The earlier bans (em dash, "Jashn", "Avenue of Lights", "weekend", clock times) stay.
3. Each page has exactly four "Don't miss" tiles, and every tile `href` points at an id that exists on that page.
4. Each page has the four shortcut links in the day bar, and each points at an id that exists on that page.
5. The Saturday tiles include the magic show and not Brides of India; the Sunday tiles are the reverse.
6. The first chapter section on every page has `id="chapter-welcome"` and contains exactly two act cards.
7. The build still passes with an empty or absent `media/programme/`.

Check in a browser at 390 px and 1280 px, in all three languages: the first screen of a phone shows the headline and the day cards, and the "Don't miss" row starts within the second screen; nothing overflows sideways; tapping "Party" in the day bar lands with the Ticket2Bollywood title fully visible.

`npm test` must stay green. Keep the page hidden. Commit and push to `main`.

Report back with the files changed, the list of missing photo stems, and anything you could not do as written.

## 8. `data/programme.json` (full replacement)

```json
{
  "meta": {
    "description": {"en": "Two days, four chapters: the full programme of the Brussels Diwali Festival, 24 and 25 October 2026 at the Atomium.", "fr": "Deux jours, quatre chapitres : le programme complet du Brussels Diwali Festival, les 24 et 25 octobre 2026 à l'Atomium.", "nl": "Twee dagen, vier hoofdstukken: het volledige programma van het Brussels Diwali Festival, 24 en 25 oktober 2026 aan het Atomium."}
  },
  "hero": {
    "kicker": {"en": "Programme · 24 and 25 October 2026 · Atomium Esplanade", "fr": "Programme · 24 et 25 octobre 2026 · Esplanade de l'Atomium", "nl": "Programma · 24 en 25 oktober 2026 · Esplanade van het Atomium"},
    "headline": {"en": "Two days. Four chapters. All of India.", "fr": "Deux jours. Quatre chapitres. Toute l'Inde.", "nl": "Twee dagen. Vier hoofdstukken. Heel India."},
    "intro": {"en": "Music, dance, magic, food and fireworks. India's biggest celebration, open to everyone. Choose your day, or come for both.", "fr": "Musique, danse, magie, cuisine et feu d'artifice. La plus grande fête de l'Inde, ouverte à tous. Choisissez votre jour, ou venez les deux.", "nl": "Muziek, dans, magie, eten en vuurwerk. Het grootste feest van India, open voor iedereen. Kies je dag, of kom allebei."},
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
    "ticket_heading": {"en": "One ticket. Come Saturday or Sunday, or both.", "fr": "Un billet. Venez samedi ou dimanche, ou les deux.", "nl": "Eén ticket. Kom zaterdag of zondag, of allebei."},
    "dont_miss": {"en": "Don't miss", "fr": "À ne pas manquer", "nl": "Niet te missen"}
  },
  "jump": [
    {
      "href": "#chapter-welcome",
      "label": {"en": "Welcome", "fr": "Accueil", "nl": "Welkom"}
    },
    {
      "href": "#chapter-heritage",
      "label": {"en": "Heritage", "fr": "Héritage", "nl": "Erfgoed"}
    },
    {
      "href": "#chapter-colours",
      "label": {"en": "Colours", "fr": "Couleurs", "nl": "Kleuren"}
    },
    {
      "href": "#chapter-t2b",
      "label": {"en": "Party", "fr": "Fête", "nl": "Feest"}
    }
  ],
  "days": [
    {
      "id": "saturday",
      "slug": "",
      "date": {"en": "Saturday 24 October", "fr": "Samedi 24 octobre", "nl": "Zaterdag 24 oktober"},
      "short": {"en": "Saturday 24 Oct", "fr": "Samedi 24 oct.", "nl": "Zaterdag 24 okt"},
      "button": {"en": "Saturday", "fr": "Samedi", "nl": "Zaterdag"},
      "hindi": "परंपरा",
      "word": {"en": "Roots", "fr": "Racines", "nl": "Wortels"},
      "title": {"en": "Saturday programme: Roots | Brussels Diwali Festival 2026", "fr": "Programme du samedi : Racines | Brussels Diwali Festival 2026", "nl": "Programma zaterdag: Wortels | Brussels Diwali Festival 2026"},
      "tagline": {"en": "Magic, children on stage and a guest maestro, then the party.", "fr": "Magie, enfants sur scène et un maître invité, puis la fête.", "nl": "Magie, kinderen op het podium en een gastmaestro, daarna het feest."},
      "only": {"en": "Only on Saturday", "fr": "Uniquement le samedi", "nl": "Alleen op zaterdag"},
      "that_was": {"en": "That was Saturday. Sunday has its own programme.", "fr": "Voilà pour le samedi. Le dimanche a son propre programme.", "nl": "Dat was zaterdag. Zondag heeft zijn eigen programma."},
      "see": {"en": "See Saturday: Roots", "fr": "Voir le samedi : Racines", "nl": "Bekijk zaterdag: Wortels"},
      "feature": "suryaprakash",
      "chapters": {
        "welcome": ["lamps", "parade"],
        "heritage": ["vandana", "ganesha", "spice-route", "little-india", "ramayana", "magic", "saree", "conservatory"],
        "colours": ["tollywood", "ghoomar", "hiphop", "kathak", "dakshin", "devi", "address", "pind"]
      },
      "highlights": [
        {
          "kicker": {"en": "The party", "fr": "La fête", "nl": "Het feest"},
          "title": {"en": "Ticket2Bollywood", "fr": "Ticket2Bollywood", "nl": "Ticket2Bollywood"},
          "line": {"en": "The Bollywood night returns, with DJ Nitro and DJ Param.", "fr": "La soirée Bollywood revient, avec DJ Nitro et DJ Param.", "nl": "De Bollywoodnacht is terug, met DJ Nitro en DJ Param."},
          "photo": "chapter-t2b",
          "href": "#chapter-t2b",
          "lead": true
        },
        {
          "kicker": {"en": "The fireworks", "fr": "Le feu d'artifice", "nl": "Het vuurwerk"},
          "title": {"en": "Diwali in the Sky", "fr": "Diwali dans le ciel", "nl": "Diwali in de lucht"},
          "line": {"en": "Above the Atomium, both nights.", "fr": "Au-dessus de l'Atomium, les deux soirs.", "nl": "Boven het Atomium, beide avonden."},
          "photo": "fireworks",
          "href": "#chapter-t2b",
          "lead": false
        },
        {
          "kicker": {"en": "For families", "fr": "En famille", "nl": "Voor families"},
          "title": {"en": "Jadoo: the Indian Magic Show", "fr": "Jadoo : le spectacle de magie indien", "nl": "Jadoo: de Indiase goochelshow"},
          "line": {"en": "Wonder for children of every age.", "fr": "De l'émerveillement pour les enfants de tous les âges.", "nl": "Verwondering voor kinderen van alle leeftijden."},
          "photo": "magic",
          "href": "#chapter-heritage",
          "lead": false
        },
        {
          "kicker": {"en": "The food", "fr": "La cuisine", "nl": "Het eten"},
          "title": {"en": "A Taste of Every Region", "fr": "Les saveurs de toutes les régions", "nl": "De smaken van elke regio"},
          "line": {"en": "Chaat, dosa and jalebi, region by region.", "fr": "Chaat, dosa et jalebi, région par région.", "nl": "Chaat, dosa en jalebi, regio per regio."},
          "photo": "food",
          "href": "#between",
          "lead": false
        }
      ]
    },
    {
      "id": "sunday",
      "slug": "sunday",
      "date": {"en": "Sunday 25 October", "fr": "Dimanche 25 octobre", "nl": "Zondag 25 oktober"},
      "short": {"en": "Sunday 25 Oct", "fr": "Dimanche 25 oct.", "nl": "Zondag 25 okt"},
      "button": {"en": "Sunday", "fr": "Dimanche", "nl": "Zondag"},
      "hindi": "संगम",
      "word": {"en": "Encounters", "fr": "Rencontres", "nl": "Ontmoetingen"},
      "title": {"en": "Sunday programme: Encounters | Brussels Diwali Festival 2026", "fr": "Programme du dimanche : Rencontres | Brussels Diwali Festival 2026", "nl": "Programma zondag: Ontmoetingen | Brussels Diwali Festival 2026"},
      "tagline": {"en": "Brides, collaborations and glamour, then the party.", "fr": "Mariées, collaborations et glamour, puis la fête.", "nl": "Bruiden, samenwerkingen en glamour, daarna het feest."},
      "only": {"en": "Only on Sunday", "fr": "Uniquement le dimanche", "nl": "Alleen op zondag"},
      "that_was": {"en": "That was Sunday. Saturday has its own programme.", "fr": "Voilà pour le dimanche. Le samedi a son propre programme.", "nl": "Dat was zondag. Zaterdag heeft zijn eigen programma."},
      "see": {"en": "See Sunday: Encounters", "fr": "Voir le dimanche : Rencontres", "nl": "Bekijk zondag: Ontmoetingen"},
      "feature": null,
      "chapters": {
        "welcome": ["lamps", "kirtan"],
        "heritage": ["ramayana", "odissi", "saree", "hiphop", "conservatory", "devi", "collaborations"],
        "colours": ["dakshin", "tollywood", "kathak", "brides", "ganesha", "pind", "ghoomar"]
      },
      "highlights": [
        {
          "kicker": {"en": "The party", "fr": "La fête", "nl": "Het feest"},
          "title": {"en": "Ticket2Bollywood", "fr": "Ticket2Bollywood", "nl": "Ticket2Bollywood"},
          "line": {"en": "The Bollywood night returns, with DJ Nitro and DJ Param.", "fr": "La soirée Bollywood revient, avec DJ Nitro et DJ Param.", "nl": "De Bollywoodnacht is terug, met DJ Nitro en DJ Param."},
          "photo": "chapter-t2b",
          "href": "#chapter-t2b",
          "lead": true
        },
        {
          "kicker": {"en": "The fireworks", "fr": "Le feu d'artifice", "nl": "Het vuurwerk"},
          "title": {"en": "Diwali in the Sky", "fr": "Diwali dans le ciel", "nl": "Diwali in de lucht"},
          "line": {"en": "Above the Atomium, both nights.", "fr": "Au-dessus de l'Atomium, les deux soirs.", "nl": "Boven het Atomium, beide avonden."},
          "photo": "fireworks",
          "href": "#chapter-t2b",
          "lead": false
        },
        {
          "kicker": {"en": "Glamour", "fr": "Glamour", "nl": "Glamour"},
          "title": {"en": "Brides of India", "fr": "Brides of India", "nl": "Brides of India"},
          "line": {"en": "One country, many weddings: a bridal journey.", "fr": "Un pays, tant de mariages : un voyage nuptial.", "nl": "Eén land, vele bruiloften: een reis langs de bruidstradities."},
          "photo": "brides",
          "href": "#chapter-colours",
          "lead": false
        },
        {
          "kicker": {"en": "The food", "fr": "La cuisine", "nl": "Het eten"},
          "title": {"en": "A Taste of Every Region", "fr": "Les saveurs de toutes les régions", "nl": "De smaken van elke regio"},
          "line": {"en": "Chaat, dosa and jalebi, region by region.", "fr": "Chaat, dosa et jalebi, région par région.", "nl": "Chaat, dosa en jalebi, regio per regio."},
          "photo": "food",
          "href": "#between",
          "lead": false
        }
      ]
    }
  ],
  "chapters": [
    {
      "id": "welcome",
      "n": 1,
      "photo": "chapter-welcome",
      "ground": "#FFF6E6",
      "band": "#8A4B00",
      "when": {"en": "From noon", "fr": "Dès midi", "nl": "Vanaf de middag"},
      "hindi": "स्वागत",
      "title": {"en": "The Welcome", "fr": "La Bienvenue", "nl": "Het Welkom"},
      "promise": {"en": "Lamps, colour and music to open the day.", "fr": "Des lampes, des couleurs et de la musique pour ouvrir la journée.", "nl": "Lampen, kleur en muziek om de dag te openen."},
      "alt": {"en": "Lamps being lit at the opening of the festival", "fr": "L'allumage des lampes à l'ouverture du festival", "nl": "Lampen worden aangestoken bij de opening van het festival"}
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
      "id": "lamps",
      "tag": {"en": "Opening", "fr": "Ouverture", "nl": "Opening"},
      "name": {"en": "Lighting the Lamps", "fr": "L'allumage des lampes", "nl": "Het aansteken van de lampen"},
      "line": {"en": "The traditional opening of Diwali. Everyone is welcome.", "fr": "L'ouverture traditionnelle de Diwali. Tout le monde est le bienvenu.", "nl": "De traditionele opening van Diwali. Iedereen is welkom."}
    },
    {
      "id": "parade",
      "tag": {"en": "Parade", "fr": "Parade", "nl": "Optocht"},
      "name": {"en": "The Festival Parade", "fr": "La parade du festival", "nl": "De festivaloptocht"},
      "line": {"en": "Through the festival, in music and colour.", "fr": "À travers le festival, en musique et en couleurs.", "nl": "Door het festival, met muziek en kleur."}
    },
    {
      "id": "kirtan",
      "tag": {"en": "Music", "fr": "Musique", "nl": "Muziek"},
      "name": {"en": "Kirtan Sing-Along", "fr": "Kirtan à chanter ensemble", "nl": "Kirtan: zing mee"},
      "line": {"en": "Music you are invited to join.", "fr": "Une musique à laquelle vous êtes invités à vous joindre.", "nl": "Muziek waarbij je mag meezingen."}
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

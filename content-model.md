# Content model

Every field that appears on a page comes from one of these files. Templates never hardcode facts.

Translatable values are objects keyed by language: `{ "en": "...", "fr": "...", "nl": "..." }`.
Non-translatable values (dates, prices, URLs, numbers) are plain.

---

## `/data/org.json`

```json
{
  "legal_name": "Art India ASBL",
  "vat": "BE 1007.072.905",
  "address": {
    "street": "Avenue du Centaure 73",
    "postcode": "1200",
    "city": "Woluwe-Saint-Lambert",
    "country": "Belgium"
  },
  "founded": 2014,
  "contacts": {
    "general": "ravi@artindia.be",
    "partners": "partners@artindia.be"
  },
  "social": {
    "instagram": "",
    "facebook": "",
    "linkedin": ""
  },
  "board": [
    { "name": "", "role": { "en": "", "fr": "", "nl": "" } }
  ],
  "portfolio": ["diwali-2026", "yoga-2027", "food-2027"]
}
```

`board` stays empty until Ravi confirms names and roles. The generator should render the governance section only if the array is non-empty — an empty board block looks worse than no block.

---

## `/data/events/diwali-2026/info.json`

```json
{
  "id": "diwali-2026",
  "edition": 10,
  "first_edition": 2016,
  "name": {
    "en": "Brussels Diwali Festival",
    "fr": "Brussels Diwali Festival",
    "nl": "Brussels Diwali Festival"
  },
  "theme": {
    "en": "Culture United — Europe Celebrates Diwali",
    "fr": "Culture United — L'Europe célèbre Diwali",
    "nl": "Culture United — Europa viert Diwali"
  },
  "dates": { "start": "2026-10-24", "end": "2026-10-25" },
  "venue": {
    "name": "Atomium Esplanade",
    "city": "Brussels",
    "lat": 50.8949,
    "lng": 4.3415
  },
  "status": "presale_soon",
  "ticketing": {
    "sale_opens": "2026-09-05",
    "price_rise": "2026-10-18",
    "currency": "EUR",
    "tiers": [
      { "id": "early",  "price": 10, "channel": "online", "until": "2026-10-18" },
      { "id": "late",   "price": 12, "channel": "online", "from": "2026-10-18" },
      { "id": "gate",   "price": 15, "channel": "gate" },
      { "id": "family", "price": 25, "channel": "online", "cap": 1000 }
    ],
    "provider": "weezevent",
    "embed_url": ""
  },
  "site": { "cashless": true, "accepts_cash": false }
}
```

`status` drives what the templates show. One of:

| status | Page behaviour |
|---|---|
| `announced` | Dates + "tickets on sale 5 September" + email capture |
| `presale_soon` | As above, with countdown |
| `on_sale` | Buy button, Weezevent embed live |
| `late_pricing` | Prices switched to €12 / €15 |
| `live` | "Happening now" — gate info, timings, map |
| `past` | Archive mode, thank-you, next edition teaser |

Changing one string flips the whole site. This is deliberate — on 5 September you should not be editing templates.

---

## `/data/events/diwali-2026/vendors.json`

The highest-value file in the repo. One entry per stall becomes one page per language.

```json
[
  {
    "slug": "example-kitchen",
    "name": "Example Kitchen",
    "category": "food",
    "cuisine": ["south-indian", "vegetarian"],
    "signature_dish": {
      "en": "Masala dosa, folded to order",
      "fr": "Masala dosa, plié à la commande",
      "nl": "Masala dosa, ter plekke gevouwen"
    },
    "description": { "en": "", "fr": "", "nl": "" },
    "dietary": ["vegetarian", "vegan-options"],
    "image": "/static/vendors/example-kitchen.webp",
    "website": "",
    "instagram": "",
    "days": ["2026-10-24", "2026-10-25"],
    "published": false
  }
]
```

- `category`: `food` | `bar` | `truck` | `retail` | `craft`
- `dietary`: `vegetarian` | `vegan` | `vegan-options` | `halal` | `gluten-free`
- `published`: `false` keeps a vendor out of the build until their contract and deposit are settled. Vendors drop out in October; this flag is how you remove one in ten seconds without touching code.

The directory needs filters by category and by dietary tag. Two reasons this file earns its keep: it is search-engine surface you currently have none of, and vendors share their own page, which is free reach.

---

## `/data/events/diwali-2026/programme.json`

```json
[
  {
    "day": "2026-10-24",
    "stage": { "en": "Main stage", "fr": "Scène principale", "nl": "Hoofdpodium" },
    "slots": [
      {
        "start": "18:30",
        "end": "19:15",
        "title": { "en": "", "fr": "", "nl": "" },
        "artist": "",
        "country": "",
        "note": { "en": "", "fr": "", "nl": "" }
      }
    ]
  }
]
```

`country` supports the *Culture United* guest-country pairings — it drives a flag or country label next to the act.

---

## `/data/events/diwali-2026/sponsors.json`

```json
[
  {
    "name": "",
    "tier": "title",
    "logo": "/static/sponsors/.svg",
    "url": "",
    "logo_permission": false,
    "years": [2026]
  }
]
```

`tier`: `title` | `principal` | `activation` | `community` | `institutional`

`logo_permission` must be `true` before the logo renders. Publishing a partner logo without written permission is a real risk with corporates, and the generator should refuse rather than rely on memory.

---

## `/content/{lang}/*.md` or `.html`

Page copy, one file per page per language. Front matter carries the metadata:

```
title:        Partners & sponsors
description:  (150–160 chars — this is the search result text, write it properly)
slug:         partners
site:         artindia          # artindia | diwali | yoga | food
audience:     sponsors          # informs internal review, not rendered
```

Required pages, `artindia` shell:
`index` · `organisation` · `ten-years` · `festivals` · `partners` · `press`

Required pages, `diwali` full site:
`index` · `tickets` · `programme` · `food-and-bazaar` · `families` · `practical` · `culture-united` · `what-is-diwali` · `participate` · `faq` · `contact` · `terms` · `privacy`

---

## Validation the generator must enforce

Fail the build, loudly, if any of these are true. A silent failure here becomes a live error on the site.

1. A translatable field is missing a language.
2. A vendor has `published: true` but no image or no signature dish.
3. A sponsor has `logo_permission: false` but a logo path.
4. A price in `content/` disagrees with `info.json`.
5. A page has no `description`, or one over 160 characters.
6. An `<img>` has no `alt`.
7. An internal link 404s against the generated tree.

Rule 4 is the one that saves you. Prices appear in body copy in three languages; when they change on 18 October, the build should refuse rather than let a €10 survive on the Dutch page.

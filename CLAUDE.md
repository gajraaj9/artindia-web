# artindia-web

Public websites for Art India ASBL. One codebase, one deploy, multiple event brands.

## What this repo produces

| Domain | Content | Audience |
|---|---|---|
| `artindia.be` | The organisation: who we are, the decade, the festival portfolio, sponsors, institutions, press | Sponsors, funders, institutions, press |
| `diwali.artindia.be` | Brussels Diwali Festival 2026 | Ticket buyers, vendors, tourists |
| `yoga.artindia.be` | Brussels Yoga Fest (2027 — not built yet) | Wellness consumers |
| `food.artindia.be` | Indian Food Festival (2027 — not built yet) | Food audience |

`portal.artindia.be` is **not** in this repo. It is a separate application (`artindia-portal`) with a database and authentication. Never add a database, login, or server-side state to this repo — its entire value is that it is static and cannot fall over.

## Stack

- **Plain HTML + CSS + minimal vanilla JS.** No React, no Vue, no framework.
- **A small custom generator** (`build.js`, Node, zero or near-zero dependencies) that reads JSON data + HTML templates and writes the `dist/` tree.
- **Cloudflare Pages** hosting. `git push` to `main` deploys.
- Output must be fully static. No build-time network calls. No client-side framework.

The generator exists for exactly two reasons: multiplying pages across three languages, and generating the vendor directory from data. Do not grow it beyond that. If a page is a one-off, write it as plain HTML.

## Directory structure

```
/build.js                 generator — keep it readable, keep it small
/templates/               HTML templates with {{token}} placeholders
  base.html               shell: head, nav, footer, hreflang
  page.html               generic content page
  vendor.html             single vendor page
/partials/                nav, footer, language switcher
/data/
  org.json                Art India: legal, board, contacts, portfolio
  /events/
    diwali-2026/
      info.json           dates, venue, prices, status flags
      programme.json      stages, acts, times
      vendors.json        stalls — the directory source
      sponsors.json       logos + tiers, by event
    yoga-2027/            same shape, empty for now
/content/
  /en /fr /nl             page copy, one file per page per language
/static/                  images, fonts, favicons
/dist/                    generated output — gitignored
```

**Everything is keyed by event from day one.** Even though only `diwali-2026` exists, never write a flat `vendors.json` at the root. Retrofitting the event key later is a migration; doing it now is a folder name.

## Languages

Three: `en`, `fr`, `nl`. English is the default and lives at the root.

```
/            → EN
/fr/         → FR
/nl/         → NL
```

Rules:
- Every page emits `<link rel="alternate" hreflang="...">` for all three plus `x-default`.
- **FR is not optional.** Brucity, the Brussels Region and Loterie Nationale read French first. A missing or machine-translated FR page is a credibility problem, not a cosmetic one.
- Never machine-translate. If a translation is missing, the generator must fail loudly rather than fall back silently to English.
- Language switcher preserves the current page.

## Facts — use these, do not invent

Locked for Diwali 2026:

- 10th edition. First edition 2016.
- **24–25 October 2026**, Atomium Esplanade, Brussels.
- Two days.
- Tickets on sale **1 September 2026**. **€10 online** (1–30 Sep) → **€12 online** (1–23 Oct) → **€15 at the gate**. Children under 12 free, event band required. No family bundle. No booking fee, no service charge. No discount below €10, ever.
- **Card only across the whole site.** No cash.
- Theme: *Culture United* — tagline *Europe Celebrates Diwali*. Rendered on the site in sentence case: "Europe celebrates Diwali".
- **One stage.** Not two.
- No kitchen or trader count is published. The earlier "40+" was wrong (nearer 20) and the metric was dropped rather than corrected.
- **5,000+ dancing to Bollywood and bhangra**, and *the biggest Bollywood party in Europe*. Signed off by Ravi 22 Aug 2026 and live on the party pillar and the stats row. Both are unsourced claims: if anyone asks for backing, that request comes to Ravi.
- Organiser: Art India ASBL, Avenue du Centaure 73, 1200 Woluwe-Saint-Lambert. VAT BE 1007.072.905.
- Contacts: `ravi@artindia.be` (general), `partners@artindia.be` (sponsors and partners).

**TO CONFIRM before publishing** — do not put these on a live page until Ravi signs them off:
- Total visitor numbers (a figure around 25,000 per weekend has been used internally; needs a defensible source before it goes public). The 5,000+ dancing figure above is cleared; this one is not.
- Board names and roles
- Patronage wording for the Embassy of India
- Any past sponsor logo (permission required per logo)

**Note on dates:** Diwali itself falls on **8 November 2026**, two weeks after the festival. The FAQ must address this directly. Search traffic for "Diwali 2026" will show November; the site must own the branded query "Brussels Diwali Festival 2026".

## Conventions

- Semantic HTML. Landmarks, one `<h1>` per page, real `<button>` and `<a>`.
- Mobile first. The majority of ticket buyers are on a phone.
- Accessibility floor: visible keyboard focus, 4.5:1 contrast on body text, `prefers-reduced-motion` respected, alt text on every meaningful image.
- **No cookies unless unavoidable.** Analytics is Plausible (cookieless). Avoid GA4 and embedded YouTube — staying cookie-free means no consent banner, and a banner costs ticket conversions.
- Images: WebP, width-limited, `loading="lazy"` below the fold.
- No third-party JS beyond the ticketing embed and Plausible.
- Target: under 150 KB per page, LCP under 2s on 4G.

## Build order

1. **Holding page** on `diwali.artindia.be` — replaces the current Squarespace page still showing "FREE ENTRY, 11 & 12 October 2025". Highest priority; every day it stays live it trains the market to expect a free event.
2. **`artindia.be` shell** — 6 pages, EN + FR. Needed for live sponsor conversations and the Loterie Nationale dossier.
3. **Diwali full site** — launch 5 September with ticket sales.
4. **Vendor directory** — generated from `vendors.json`, one page per stall per language.

## Non-goals

- No CMS. Content is files in git.
- No user accounts, no forms that store data in this repo. Forms POST to Brevo or Weezevent.
- No blog until there is someone committed to writing it.
- Do not merge CIEC or VINEXA into this project. Different entity, different audience.

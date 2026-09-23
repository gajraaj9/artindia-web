# The WhatsApp bot

What it is: a FAQ answering machine on the festival's WhatsApp number, plus a
menu, a referral link lookup, and a way to hand a conversation to a person.

## Diya

The bot answers as Diya, the festival's digital host. The persona is the first
thing in the system prompt, above the rules and the FAQ: warm, brief, at most
one 🪔 a message, an AI assistant who says so if asked and never claims to be a
person, a life or a feeling.

She introduces herself on the menu that opens a 24h window, and whenever
somebody actually says hello:

> Namaste, I'm Diya, the festival's digital host 🪔 How can I help?

A menu that comes from `MENU` or after an answered question is just "How can
I help?" in their language — being told who she is four times in an hour reads
like a bot, which is the one thing the persona exists to avoid. She never signs
off.

Its entire knowledge is [`faq.md`](faq.md). It is told to answer from that and
nothing else, and to say `NOT_COVERED` when the answer is not in there — which
becomes the fallback message and a line in `/api/wa-unanswered`. It cannot
invent a price.

## The kill switch

`WA_BOT_ENABLED=false` (the default) turns off the model, and only the model.
The menu, the buttons, the referral link, "my chances", escalation, STOP and
delivery reports all keep working; free text gets the fallback message instead
of an answer. Nothing is spent at Anthropic while it is off.

Flip it in Cloudflare → diwali-2026 → Settings → Variables, then redeploy
(`gh workflow run deploy-diwali.yml --ref main`). Variables only take effect on
a new deployment.

## What the model writes, and what goes out

The system prompt asks for no markdown and no em dashes. Haiku ignored the
dash on the first live answer, so both are enforced in code after the fact: an
em dash between clauses becomes a comma, one between numbers becomes a hyphen
(so a time range survives), and `**bold**`, backticks and `#` headings are
stripped. WhatsApp renders none of that markup, and an em dash reads as a typo
on a phone.

The 🪔 goes the same way. It belongs to the greeting; the prompt says so and
the model reaches for it anyway, so it is stripped from answers.

If an answer ever comes out mangled, `tidyAnswer` in `functions/api/_bot.js` is
the only thing between the model and the message.

## Editing the FAQ

1. Edit `docs/faq.md`. One Q&A per block, plain facts, no promise that is not
   already written down. Keep the three language sections saying the same thing.
2. Commit and push. The build compiles it into `functions/api/_faq.js` — a
   Worker cannot read files, so the knowledge ships inside the bundle.
3. It is live on the next deploy. There is no cache to clear.

### Dated facts switch themselves over

The price change needs no deploy and no reminder. Text marked
`[UNTIL 30 SEP]` is used to the end of 30 September; text marked `[1 OCT]`
from 1 October, turning over at **Brussels** midnight. Whichever is not in
force is removed before the model sees the file, so the bot can never quote
12 EUR during the presale or 10 EUR after it.

Two shapes work:

```
A: [UNTIL 30 SEP] Presale 10 EUR until 30 September. At the gate: 15 EUR.
A: [1 OCT] 12 EUR online, 15 EUR at the gate.

A [UNTIL 30 SEP] 10 EUR [1 OCT] 12 EUR ticket, with children under 12 free.
```

A line with one tag belongs entirely to that variant. A line with both is a
swap inside a sentence, and **the second variant must be the same number of
words as the first** — that is the only thing saying where it ends, since the
sentence carries on afterwards. Punctuation stuck to the end of the second
variant is handed back to the sentence, so the French comma lands right.

Also removed: **any line containing `[CONFIRM]`** — facts nobody has signed
off, such as visitor numbers — and **everything above the first
`# ===== EN =====` banner**, which is editing guidance rather than knowledge.

The switch is recomputed per Brussels day rather than once per worker, so a
worker that started on 30 September follows the change at midnight instead of
serving yesterday's price until Cloudflare recycles it.

`npm test` fails if `_faq.js` has drifted from `faq.md`.

## Environment

| Name | Value |
|---|---|
| `WA_BOT_ENABLED` | `true` / `false`. Default false |
| `ANTHROPIC_API_KEY` | secret |
| `WA_BOT_MODEL` | `claude-haiku-4-5-20251001` |
| `WA_BOT_DAILY_LIMIT` | `20` — model replies per phone per UTC day |
| `ESCALATION_EMAIL` | `diwali@artindia.be` |
| `BREVO_SENDER_EMAIL` | optional. The from-address on the escalation email; must be a verified sender in Brevo. Defaults to `ESCALATION_EMAIL` |

Already set and reused: `WA_TOKEN`, `WA_PHONE_ID`, `WA_APP_SECRET`,
`WA_VERIFY_TOKEN`, `WA_ADMIN_TOKEN`, `BREVO_API_KEY`, `BREVO_BUYERS_LIST_ID`.

## What happens to an inbound message

1. **Deduped** on Meta's message id — Meta redelivers, and answering twice
   looks unhinged.
2. **STOP / ARRET / ARRÊT / UNSUBSCRIBE**, on its own: `WA_OPTIN` goes false in
   Brevo, one confirmation goes out in their language, and the number is marked
   opted out. A sentence *about* stopping is not an opt-out — the match is exact.
3. **Writing in again after opting out** re-opens the conversation. `WA_OPTIN`
   stays false; that is a marketing consent and only a purchase sets it back.
4. **Language**: when there are words, they decide — the message, else what
   this number last used, else English. Brevo's `LANG` is not consulted for
   text at all: Ticket Tailor's payload has no language field, so every buyer
   is stored as `en` whatever they speak, and trusting it answered "Bonjour !"
   with an English menu. It is used only when there are no words to read — a
   button tap or a photo at first contact. Whatever is settled on is cached in
   `bot:lang:<phone>`, so the buttons after a Dutch question stay Dutch. Put
   Brevo back in front the day Ticket Tailor exposes the checkout locale.
5. **A bare greeting** — hi, hello, hey, bonjour, salut, hallo, hoi, namaste,
   with or without punctuation and an emoji — gets the menu and nothing else.
   It is an opening, not a question: putting "I can't answer that here" under
   someone's hello is the rudest thing the bot can do. A greeting with a
   question attached ("hi what time are the fireworks") is a question.
6. **First message after a two hour gap** gets the menu, then the answer. The
   window is refreshed on every message, so it runs from the last one: no
   second menu mid-conversation, and somebody who comes back after lunch is
   met rather than dropped mid-thought.
7. **Buttons** are answered without the model: `MY_LINK`, `MY_CHANCES`,
   `TICKETS`, `INFO`, `TALK_HUMAN`, `MENU`.
8. **Free text** goes to the FAQ, under the daily ceiling — *unless* it is a
   question about them rather than the festival, in which case the model hands
   it back and the same code the buttons run answers it. See below.
9. **A photo, a voice note, a dropped pin**: one apology per day, not one per
   photo.

## Questions about them, not the festival

Four questions have answers the FAQ cannot hold, because they are facts about
one buyer: how many tickets they bought, their own referral link, their own
draw entries, and "show me the buttons again". The model is told to recognise
those and reply with a token instead of an answer —

```
ACTION:MY_TICKETS   ACTION:MY_LINK   ACTION:MY_CHANCES   ACTION:MENU
```

— and the webhook runs the same handler the button runs. So "how many tickets
did I buy" and tapping **My tickets** give the same reply and cannot drift
apart. The model never sees anybody's ticket count or code; it only names the
button.

A token only counts when it is the whole reply. One mentioned in passing is
treated as prose, so the model cannot be talked into routing by a visitor
typing it. A prospect who asks gets the "no ticket on this number" reply with
the ticket link, same as tapping the button. A routed question still counts
against `WA_BOT_DAILY_LIMIT`: it cost a model call.

## Answering someone

There is no "Talk to the team" button any more — it took a third of the menu
on every conversation to serve the rare one. Typing **HUMAN**, **HUMAIN** or
**MENS** still escalates, and the fallback message says so.

An escalation emails `ESCALATION_EMAIL` with the visitor's name, number,
language and last five messages, plus a link:

```
https://diwali.artindia.be/admin/reply?to=+32474919900
```

That page has the number already filled in. Paste the admin token once and the
browser keeps it; everything is checked server side by `/api/wa-send`, so the
page itself holds nothing secret and being public costs nothing.

If the reply comes back **"Too late to reply here"**, WhatsApp's 24 hour
customer service window has expired for that number: a free-form message
cannot be delivered until they write in again. That is Meta's rule, not ours.
`/api/wa-send` still works from a terminal if you prefer:

```sh
curl -X POST https://diwali.artindia.be/api/wa-send \
  -H "X-Admin-Token: $WA_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"to":"+32474919900","text":"Hello, the fireworks are at 21:00."}'
```

## The dashboard

**`/admin/wa`** — one page, unlocked with the same admin token as the reply
page. Three tabs:

- **Conversations** — one row per number, newest first, with the name from
  Brevo when we have it, buyer or prospect, language, and the last line. A row
  whose last message came from *them* is flagged **needs a look**: nobody has
  answered it. Tap to open the transcript, both halves, labelled by what each
  line was — an answer the model wrote, a canned button reply, an apology, a
  team reply. Each row links straight to the reply page.
- **Welcome** — every buyer the welcome template went to, with sent /
  delivered / read / failed counts on top and Meta's own error text on the
  failures.
- **Unanswered** — the same list as `/api/wa-unanswered`, so the FAQ can be
  grown from real questions.

A **Bot: ON / OFF** badge at the top reads `WA_BOT_ENABLED`, so "why is
everything getting the fallback" is answered before it is asked.

It reads `GET /api/wa-admin` in a single call — it gets opened on a phone, on
4G, usually because something needs answering now, and three round trips there
is three chances to stall. The page builds every row as DOM nodes rather than
HTML: message text is written by strangers and must never be parsed as markup.

## Growing the FAQ

```sh
curl -H "X-Admin-Token: $WA_ADMIN_TOKEN" \
  'https://diwali.artindia.be/api/wa-unanswered?since=2026-09-21&format=text'
```

Every question the bot could not answer, and everyone who asked for a person,
newest first. A question that appears three times is a question `faq.md` is
missing. Drop `&format=text` for JSON.

## KV keys

All in the `REFERRALS` namespace.

| Key | Holds | Expires |
|---|---|---|
| `bot:msg:<message_id>` | dedupe marker | 24h |
| `bot:lang:<phone>` | last language used | 90d |
| `bot:seen:<phone>` | conversation in progress, refreshed per message | 2h |
| `bot:seen:<phone>:media` | already apologised for a photo today | 24h |
| `bot:optout:<phone>` | said STOP | 90d |
| `bot:history:<phone>` | last 5 inbound texts | 24h |
| `bot:count:<phone>:<YYYY-MM-DD>` | model replies used today | 48h |
| `bot:count:<phone>:<day>:limited` | already told them the limit | 48h |
| `bot:log:<phone>` | `{phone, name, buyer, lang, updatedAt, messages[]}` — last 40 lines both ways | 30d |
| `bot:welcome:<phone>` | `{ts, name, template, waMessageId, status, last_status_ts}` | 30d |
| `bot:unanswered:<ts>` | `{phone, lang, text, reason}` | 90d |
| `bot:escalation:<ts>` | `{phone, name, lang, last_message, history}` | 90d |
| `refcount:<CODE>` | paid adult tickets referred by that code | never |

`refcount:` is written by `/api/tt-order` alongside Brevo's `REFERRED_BY`, so
"my chances" is answered from KV rather than calling Brevo on every button tap.
Seed it once from the totals already in Brevo:

```sh
scripts/backfill-refcount.sh --dry     # look first
scripts/backfill-refcount.sh
```

## Cost

Every answer sends the whole FAQ as the system prompt, so the FAQ is marked
cacheable and the per-language instruction sits after it — one cached prefix
shared across all three languages. `WA_BOT_DAILY_LIMIT` is the backstop: twenty
replies per number per UTC day, then one apology and silence until midnight
UTC. The bot logs its token counts, cache hits included, on every answer.

---

# Diya on the website

The same host, the same FAQ, the same persona and the same routing tokens as
WhatsApp — imported from `functions/api/_bot.js`, not copied, so the two
cannot drift apart. What differs is what a web page is allowed to know.

## The script tag

Already on all three language pages, emitted by `build-diwali.mjs`:

```html
<script src="/diya.js" defer></script>
```

The widget injects its own stylesheet and one launcher — Diya's avatar with
"Chat with Diya", 52px high, 16px off the bottom-right corner, avatar only
below 480px — and keeps itself off `/admin`, `/r` and `/i`. Nothing else to
add.

There is no separate WhatsApp button on the page. WhatsApp is offered as a
chip **inside** the panel, under the greeting and again whenever Diya cannot
answer, linking to `wa.me/32490616661?text=Hi` in a new tab. Two moments where
it helps, rather than a second permanent button competing with the launcher.

The launcher watches the site's own mobile ticket bar (`#stickybar`, fixed to
the bottom below 720px once the hero scrolls away) and lifts above it while it
is showing, dropping back to 16px when it is not. There is no cookie bar to
avoid: analytics here is cookie-free by design.

## Environment

| Name | Value |
|---|---|
| `WEB_BOT_ENABLED` | `true` / `false`. Separate from `WA_BOT_ENABLED` |
| `WEB_BOT_DAILY_LIMIT` | `30` — model calls per session per UTC day |
| `CHAT_SESSION_SECRET` | secret, `openssl rand -hex 32`. Signs the session token |
| `BREVO_PROSPECTS_LIST_ID` | `9` — where a consented webchat lead lands |

Reused: `ANTHROPIC_API_KEY`, `WA_BOT_MODEL`, `BREVO_API_KEY`,
`BREVO_BUYERS_LIST_ID`, `WA_ADMIN_TOKEN`.

## What the website will not do

- **Never says a referral code or a draw entry count**, not even to somebody
  who has identified as a buyer. A public page has no proof of who is reading
  it: a shared screen, a borrowed laptop, a session token pasted to a friend.
  Both the button and the model's routing token answer with "your personal
  link and your entries are in the WhatsApp and the email you received after
  buying". The code never leaves the server.
- **Never writes to Brevo without a tick.** The consent box is what makes
  list 9 a marketing list. Without it the submission is treated as an
  identify: looked up, never stored.
- **Never creates a contact from identify.** Typing an address into a public
  chat box is not consent.
- **Never asks for a phone number.**
- **Answers only our own pages.** Origin must be `diwali.artindia.be`,
  `artindia.be` or localhost; anything else is a 403, so the endpoint cannot
  be dropped onto somebody else's site and billed to our Anthropic key.

## Sessions and limits

The session is an HMAC-signed token, 24 hours, carrying the id, the state and
a counter. The browser keeps it in `sessionStorage`. Editing it to claim
`buyer` breaks the signature and the server starts a clean anonymous session.
The email behind a buyer stays in KV: a token travels, an address should not.

Two ceilings, both in KV: `WEB_BOT_DAILY_LIMIT` model calls per session per
day, and 200 per hashed IP per day. Over either, the fallback goes out and
nothing reaches the model.

## KV keys

| Key | Holds | Expires |
|---|---|---|
| `web:sess:<id>` | `{email, name, lang}` for an identified buyer | 24h |
| `web:log:<id>` | `{ts, lang, state, lead, buyer, messages[40]}` | 30d |
| `web:count:<id>:<day>` | model calls used | 48h |
| `web:ip:<hash>:<day>` | calls from one address | 48h |

Unanswered web questions go to the same `bot:unanswered:<ts>` as WhatsApp,
tagged `channel: "web"`.

## The dashboard

A fourth tab, **Web**, in `/admin/wa`: sessions today and over 7 days, leads
captured, buyers identified, unanswered web questions, and the transcripts. A
**Web: ON / OFF** badge reads `WEB_BOT_ENABLED`.

# The WhatsApp bot

What it is: a FAQ answering machine on the festival's WhatsApp number, plus a
menu, a referral link lookup, and a way to hand a conversation to a person.

## Diya

The bot answers as Diya, the festival's digital host. The persona is the first
thing in the system prompt, above the rules and the FAQ: warm, brief, at most
one 🪔 a message, an AI assistant who says so if asked and never claims to be a
person, a life or a feeling.

She introduces herself once per 24h window, on the menu that opens it:

> Namaste, I'm Diya, the festival's digital host 🪔 How can I help?

Every later menu in the same window is just "How can I help?" in their
language. Being told who she is four times in an hour reads like a bot, which
is the one thing the persona exists to avoid. She never signs off.

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

## Editing the FAQ

1. Edit `docs/faq.md`. One Q&A per block, plain facts, no promise that is not
   already written down. Keep the three language sections saying the same thing.
2. Commit and push. The build compiles it into `functions/api/_faq.js` — a
   Worker cannot read files, so the knowledge ships inside the bundle.
3. It is live on the next deploy. There is no cache to clear.

Two kinds of line are removed before the model ever sees them:

- **anything inside `<!-- ... -->`** — this is how the 1 October prices are held
  back. Quoting 12 EUR during the 10 EUR presale is the most expensive mistake
  the bot could make, so those lines are commented out until the day.
- **any line containing `[CONFIRM]`** — facts nobody has signed off. Visitor
  numbers live here until they have a defensible source.

On 1 October: uncomment the `[1 OCT]` lines in all three languages and delete
the presale lines above them.

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
4. **Language**: what they told us when they bought, else what they last used,
   else what this message looks like, else English.
5. **A bare greeting** — hi, hello, hey, bonjour, salut, hallo, hoi, namaste,
   with or without punctuation and an emoji — gets the menu and nothing else.
   It is an opening, not a question: putting "I can't answer that here" under
   someone's hello is the rudest thing the bot can do. A greeting with a
   question attached ("hi what time are the fireworks") is a question.
6. **First message of the day** gets the menu, then the answer.
7. **Buttons** are answered without the model: `MY_LINK`, `MY_CHANCES`,
   `TICKETS`, `INFO`, `TALK_HUMAN`, `MENU`.
8. **Free text** goes to the FAQ, under the daily ceiling.
9. **A photo, a voice note, a dropped pin**: one apology per day, not one per
   photo.

## Answering someone

An escalation emails `ESCALATION_EMAIL` with the last five things that number
said and the exact command to answer:

```sh
curl -X POST https://diwali.artindia.be/api/wa-send \
  -H "X-Admin-Token: $WA_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"to":"+32474919900","text":"Hello, the fireworks are at 21:00."}'
```

`409 window_closed` means WhatsApp's 24 hour customer service window has
expired for that number: a free-form message cannot be delivered until they
write in again. That is Meta's rule, not ours.

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
| `bot:seen:<phone>` | already greeted today | 24h |
| `bot:seen:<phone>:media` | already apologised for a photo today | 24h |
| `bot:optout:<phone>` | said STOP | 90d |
| `bot:history:<phone>` | last 5 inbound texts | 24h |
| `bot:count:<phone>:<YYYY-MM-DD>` | model replies used today | 48h |
| `bot:count:<phone>:<day>:limited` | already told them the limit | 48h |
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

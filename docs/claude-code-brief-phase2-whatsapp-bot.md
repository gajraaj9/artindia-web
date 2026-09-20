# Brief: WhatsApp bot, Phase 2b (inbound handling)

Repo `~/artindia`, Cloudflare Pages project `diwali-2026`. Extend the existing `/api/wa-webhook` (Phase 1, commit fcb6b9b). Do not touch the outbound welcome flow or `/api/tt-order` except where stated. Read `docs/faq.md` first; it is the bot's only knowledge.

## 1. Files

- `docs/faq.md` : the knowledge base (already in `docs/`). Loaded at build time into the function (import as raw text or copy into `functions/_faq.md` at build); never fetched at runtime.
- `functions/api/wa-webhook.ts` : add inbound message handling.
- `functions/api/wa-send.ts` : new, admin reply endpoint.
- `functions/api/wa-unanswered.ts` : new, admin read endpoint.
- `docs/wa-bot.md` : short runbook (env vars, how to edit the FAQ, kill switch).

## 2. Env vars (add in Cloudflare, secrets marked *)

- `WA_BOT_ENABLED` = `true` / `false` (kill switch, default false)
- `ANTHROPIC_API_KEY` *
- `WA_BOT_MODEL` = `claude-haiku-4-5-20251001`
- `WA_BOT_DAILY_LIMIT` = `20` (replies per phone per UTC day)
- `ESCALATION_EMAIL` = `diwali@artindia.be`
- Existing: `WA_TOKEN`, `WA_PHONE_ID`, `WA_APP_SECRET`, `WA_ADMIN_TOKEN`, Brevo vars.

KV: reuse `REFERRALS`. Keys: `bot:lang:<phone>`, `bot:count:<phone>:<YYYY-MM-DD>`, `bot:unanswered:<ts>`, `bot:escalation:<ts>`, `refcount:<CODE>`.

## 3. Inbound handling, in this order

Signature verification and the `statuses[]` logic from Phase 1 stay as they are. For each `messages[]` entry:

1. **Dedupe** on `message.id` (KV, 24h TTL). Always return 200 fast; do the work with `waitUntil`.
2. **STOP**: text matching `^(stop|arret|arrêt|unsubscribe)$` (case-insensitive, trimmed). Set Brevo `WA_OPTIN=false`, reply once in the contact's language: "You will not receive further WhatsApp messages from Art India." Store `bot:optout:<phone>` so no later reply is sent, ever, except to a new non-STOP message from that phone (that re-opens the conversation, but WA_OPTIN stays false until they buy again).
3. **Language**: use Brevo `LANG` if the phone is a known contact (look up by SMS/WHATSAPP attribute), else the language detected from the message by the model, else EN. Cache in `bot:lang:<phone>`.
4. **Button replies** (`interactive.button_reply.id`):
   - `MY_LINK` : look up the contact's `REFERRAL_CODE` in Brevo; reply "Your personal link: https://diwali.artindia.be/r/<CODE>. Every friend who buys with it adds one entry for you." If not a buyer: "We can't find a ticket on this number. Tickets: https://tickets.artindia.be".
   - `MY_CHANCES` : entries = `TICKET_COUNT` (adult tickets) + `refcount:<CODE>` from KV. Reply "You have N entries in the draw. Share your link to add more." Non-buyer: same fallback as above.
   - `TALK_HUMAN` : see step 7.
   - `MENU` : send the menu (step 6).
5. **Free text** when `WA_BOT_ENABLED=true`:
   - Check `bot:count:<phone>:<day>` < `WA_BOT_DAILY_LIMIT`, else reply the fallback message once and stop.
   - Call the Anthropic Messages API, model `WA_BOT_MODEL`, max_tokens 300. System prompt: "You answer questions about the Brussels Diwali Festival 2026 for Art India. Use ONLY the FAQ below. Reply in <LANG>. Maximum 3 short sentences, no markdown, no em dashes. Never invent prices, times, or promises. If the FAQ does not cover the question, reply exactly: NOT_COVERED." Then the full `faq.md` with `[CONFIRM]` markers and HTML comments stripped.
   - If the reply is `NOT_COVERED` (or empty/error): send the fallback (below), write `bot:unanswered:<ts>` = `{phone, lang, text}`.
   - Otherwise send the reply as plain text, then increment the daily counter.
   - Free text when `WA_BOT_ENABLED=false`: send the fallback only.

   Fallback, per language:
   - EN: "Thanks for your message. I can't answer that here. Write to diwali@artindia.be or see diwali.artindia.be. Reply MENU for quick options."
   - FR: "Merci pour votre message. Je ne peux pas répondre à cela ici. Écrivez à diwali@artindia.be ou consultez diwali.artindia.be. Répondez MENU pour les options rapides."
   - NL: "Bedankt voor uw bericht. Daar kan ik hier niet op antwoorden. Mail naar diwali@artindia.be of kijk op diwali.artindia.be. Antwoord MENU voor snelle opties."

6. **Menu**: sent on the first inbound message from a phone in a 24h window (KV `bot:seen:<phone>`, 24h TTL) and on the text `menu`, before or instead of an answer. Interactive message, type `button`, header "Brussels Diwali Festival", body in the contact's language "How can I help?", buttons (max 3): known buyer → `MY_LINK` "My link", `MY_CHANCES` "My chances", `TALK_HUMAN` "Talk to the team"; unknown → `TICKETS` "Tickets" (replies with the tickets FAQ answer + link), `INFO` "Festival info" (replies with dates/place/fireworks answer), `TALK_HUMAN`. If the first message is itself a question, answer it first, then send the menu.

7. **Escalation** (`TALK_HUMAN`, or the text `human` / `humain` / `mens`): reply "A team member will reply here during office hours. For urgent matters: diwello@artindia.be" (fix typo: diwali@artindia.be); write `bot:escalation:<ts>` = `{phone, name, lang, last_message}`; send an email via Brevo transactional API to `ESCALATION_EMAIL`, subject "WhatsApp: <phone> needs a reply", body with the last 5 messages from that phone (keep a rolling `bot:history:<phone>` of the last 5 inbound texts, 24h TTL) and the curl to answer via `/api/wa-send`.

8. **Everything else** (images, audio, stickers, location): send the fallback once per 24h window.

## 4. Admin endpoints (header `X-Admin-Token: <WA_ADMIN_TOKEN>`, else 401)

- `POST /api/wa-send` body `{ "to": "+32...", "text": "..." }` : sends a plain text message. Works only inside the 24h customer-service window; if Meta returns error 131047, respond 409 with a clear message. This is how Sajin answers escalations.
- `GET /api/wa-unanswered?since=<ISO>` : returns unanswered questions and escalations, newest first, as JSON and as a plain-text list. Ravi reads this to grow the FAQ.

## 5. Referral counter

In `/api/tt-order`, when an order carries a `ref=` code (referral_tag) and creates paid adult tickets, increment `refcount:<CODE>` by the number of adult tickets. Backfill from Brevo `REFERRED_BY` values already stored, once, via a script `scripts/backfill-refcount.sh`.

## 6. Tests

- Unit: STOP regex, language pick order, daily limit reset, FAQ stripping of `[CONFIRM]` lines and HTML comments.
- Manual, with `WA_BOT_ENABLED=false`: send "hello" from Ravi's phone, expect menu + fallback; tap "My link", expect the JKRM7W link; tap "My chances", expect the count; send "human", expect the escalation email at diwali@artindia.be; use `/api/wa-send` to reply.
- Manual, with `WA_BOT_ENABLED=true`: "What time are the fireworks?" (answer), "Quel est le prix ?" (FR answer), "Can I bring my drone?" (fallback + logged), "STOP" (opt-out, WA_OPTIN false in Brevo, no further replies).

## 7. Out of scope

FR/NL welcome templates, reminder sequence, `/draw` page, an inbox UI, WhatsApp calling.

## Deliverables

Commit, push to main, deploy, then report: the exact env vars to set, the stripped FAQ character count, and the KV keys used.

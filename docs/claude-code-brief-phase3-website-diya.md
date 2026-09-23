# Brief: Diya on the website (Phase 3)

Same repo, same Pages project. Reuse the WhatsApp bot's FAQ loader, date filter, Diya system prompt and routing tokens; do not copy them, import them. Read docs/wa-bot.md first.

## 1. What to build

1. `functions/api/chat.js`: POST endpoint the widget talks to.
2. `public/diya.js` + `public/diya.css`: a self-contained widget loaded by one script tag on every page of diwali.artindia.be.
3. A floating WhatsApp button next to the widget launcher, linking to https://wa.me/32490616661?text=Hi (the same bot on the person's phone).
4. Avatar: `assets/diya.png` (256×256, already in the repo or provided by Ravi).
5. Dashboard: a fourth tab "Web" in /admin/wa.html.

## 2. Env vars
- `WEB_BOT_ENABLED` (kill switch, separate from WA_BOT_ENABLED)
- `WEB_BOT_DAILY_LIMIT` = 30 (model calls per session per day)
- `BREVO_PROSPECTS_LIST_ID` = 9 (list 12 = buyers, already set)
- `CHAT_SESSION_SECRET` (HMAC for session tokens)

## 3. /api/chat

Request: `{ session, lang, message }` or `{ session, lang, action }` or `{ session, lang, lead: {name, email, consent} }` or `{ session, lang, identify: {email} }`.
Response: `{ reply, buttons: [{id,label}], state: {known: "buyer"|"prospect"|"anonymous", askedLead: bool}, session }`.

- `session`: signed token (HMAC, 24h) carrying a random id, the state and a message counter. Created on first call. No cookies, no localStorage requirement; the widget keeps it in sessionStorage.
- Origin check: accept only Origin diwali.artindia.be and artindia.be (plus localhost in dev). Return 403 otherwise.
- Rate limit: per session `WEB_BOT_DAILY_LIMIT` model calls per day, plus a per-IP cap of 200/day in KV. Over the cap: the fallback reply, no model call.
- Language: `lang` from the page (`<html lang>`), but a message clearly in another of EN/FR/NL answers in that language (same detector as WhatsApp).
- Free text: same system prompt as WhatsApp, with two web-specific lines appended: "You are on the festival website." and "Never reveal a referral link, referral code, or draw entries; on those questions say: your personal link and your entries are in the WhatsApp and the email you received after buying." The routing tokens ACTION:MENU, ACTION:MY_TICKETS, ACTION:MY_LINK, ACTION:MY_CHANCES are handled server-side as below; the model never sees Brevo data.
- Actions (buttons or routed tokens):
  - MENU: anonymous/prospect → buttons TICKETS "Tickets", GETTING_THERE "Getting there", FOOD "Food & drink", ASK "Ask me anything". Buyer → GETTING_THERE, PROGRAMME "Programme", DRAW "Lucky draw", ASK.
  - TICKETS / GETTING_THERE / FOOD / PROGRAMME / DRAW: the matching FAQ answer(s), with a "Buy tickets" link on TICKETS when not a buyer.
  - MY_TICKETS: buyer → "You have N adult and M child tickets, valid on both days. The QR code is in your Ticket Tailor email." Not a buyer → "I can't find a ticket for this email. Tickets: https://tickets.artindia.be".
  - MY_LINK / MY_CHANCES: always the WhatsApp/email redirect line above, never the data, even for buyers.
- Fallback when the FAQ doesn't cover it: same text as WhatsApp minus "Type HUMAN"; instead a button CONTACT "Email the team" (mailto:diwali@artindia.be) and WHATSAPP "Chat on WhatsApp". Log the question to bot:unanswered with `channel: web`.
- Greeting (first call of a session): "Namaste, I'm Diya, the festival's digital host 🪔 Ask me anything about the Brussels Diwali Festival." + MENU buttons. Trilingual (reuse the WhatsApp strings).

## 4. Lead capture (state machine, server-side)

1. After the first *answered* free-text question or the first FAQ button (not the greeting), and only once per session, the reply carries `askLead: true` with a prompt: "Want me to keep you posted on the festival? Leave your name and email." (FR/NL versions). The widget renders name, email, a consent checkbox labelled "Send me festival news from Art India, unsubscribe anytime", buttons "Keep me posted" and "Maybe later", plus a link "I already have a ticket" that switches to the identify form (email only).
2. `lead` submit: require consent = true and a valid email. Look the email up in Brevo:
   - in list 12 → state buyer; reply "Welcome back, {first name}, you have a ticket 🪔" + buyer MENU. Do not add to any list.
   - in Brevo but not in list 12 → add to list 9 if missing, set FIRSTNAME if empty, SOURCE=webchat, LANG. Reply "Thanks {first name}, you're on the list." + MENU.
   - not in Brevo → create in list 9 with FIRSTNAME, LANG, SOURCE=webchat, CONVERTED=false. Same reply.
   Without consent: do not create or update anything; treat as identify only.
3. `identify` submit (email only): same lookup; found in list 12 → buyer; otherwise → "I can't find a ticket for this email. Tickets: https://tickets.artindia.be" and stay anonymous. Never create a contact from identify.
4. "Maybe later": `askedLead` = true in the session; never ask again this session.
5. Never ask for a phone number on the web.

## 5. Widget

- One script tag: `<script src="/diya.js" defer></script>`; it injects its own CSS and a launcher button bottom-right (Diya's avatar, 56 px, label "Chat with Diya" on desktop). WhatsApp button bottom-right above it, WhatsApp green, label "WhatsApp".
- Panel 380×600 on desktop, full-screen sheet on mobile. Header: avatar, "Diya", subtitle "Brussels Diwali Festival · AI host". Close button.
- Messages as bubbles; buttons as chips under the last bot message; typing indicator while waiting; links open in a new tab.
- Lead form inside the panel, not a modal. Inline validation. Enter to send.
- Colours from the site's existing tokens (marigold/deep red/ink); no external fonts or CDNs; total under 40 KB; no framework.
- State in sessionStorage: session token, transcript (last 30 messages), so a page navigation keeps the conversation.
- Accessibility: focus trap in the panel, aria-live on the message list, Escape closes, launcher has aria-label.
- Do not load the widget on /admin/* or /r/* pages.

## 6. Logging and dashboard

- Per session: KV `web:log:<session id>` {ts, lang, state, messages[last 40], lead: yes/no, buyer: yes/no}, 30-day TTL.
- Dashboard tab "Web": sessions today / 7 days, leads captured, buyers identified, unanswered questions (channel web), and a list of recent sessions expandable to the transcript. Counts at the top.
- Analytics: fire a `diya_open`, `diya_question`, `diya_lead` event to the site's existing analytics if any (check what the site uses; if none, skip).

## 7. Tests

- Origin check, session signature, rate limit, consent required for list writes, buyer lookup by list membership, MY_LINK never returns a code on the web, askLead fires exactly once, identify never creates a contact, date filter applied (10 EUR / 12 EUR by date), 🪔 stripped from answers.
- Manual: from a private browser window, ask "how much are tickets", get the lead prompt, submit with consent, check the contact appears in Brevo list 9 with SOURCE=webchat; then in a new window use "I already have a ticket" with gajraaj@gmail.com and confirm the buyer menu and that "what is my link" does not reveal JKRM7W.

## 8. Out of scope
Facebook Messenger, phone capture, file uploads, human live chat in the widget (escalation is email + WhatsApp).

Deliver: commit, deploy with WEB_BOT_ENABLED=false, then report the script tag to add, env vars, KV keys, and bundle size.

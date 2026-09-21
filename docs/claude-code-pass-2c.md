# WhatsApp bot, pass 2c

Read docs/claude-code-brief-phase2-whatsapp-bot.md (section 0 was added after your first build) and docs/faq.md (updated). Then make all of the following changes in one pass, deploy, and report.

## 1. Diya persona (brief section 0)
Put the persona block at the top of the system prompt. The first menu in a 24h window uses Diya's greeting as body; later menus use "How can I help?". Add to the system prompt: "Do not add facts, adjectives or reassurances not in the FAQ."

## 2. Greetings
Pure greetings (hi, hello, hey, bonjour, salut, hallo, hoi, namaste, and the same with punctuation or one emoji) get the menu only. No fallback, no model call.

## 3. Language
Free-text answers follow the language of the incoming message (detect EN/FR/NL from the text, default EN), never Brevo LANG. Store it in bot:lang:<phone> so later buttons follow it. Brevo LANG is used only for the greeting and menu on first contact when no text has been read yet.

## 4. Menu
Body: Diya greeting + "Tap a button, or type your question below." (FR: "Appuyez sur un bouton ou tapez votre question ci-dessous." NL: "Tik op een knop of typ uw vraag hieronder.")

Buyer buttons:
- MY_TICKETS: "My tickets" / "Mes billets" / "Mijn tickets"
- MY_LINK: "My lucky draw link" / "Mon lien tombola" / "Mijn tombolalink"
- MY_CHANCES: "My winning chances" / "Mes chances" / "Mijn winkansen"

MY_TICKETS reply, from Brevo TICKET_COUNT and CHILD_COUNT: "You have 2 adult and 1 child ticket, valid on both days. Show the QR code from your Ticket Tailor email at the entrance. Didn't receive it? Write to diwali@artindia.be." Trilingual.

Prospect buttons: BUY_TICKETS "Buy tickets", FESTIVAL_INFO "Festival info", GETTING_THERE "Getting there", each replying with the matching FAQ answer (tickets + link; dates, place, hours, fireworks; public transport + parking). Trilingual.

Remove TALK_HUMAN from both menus. Typed "human", "humain", "mens" (case-insensitive) still escalates. The fallback message ends with "Type HUMAN to reach the team." (FR: "Tapez HUMAIN pour joindre l'équipe." NL: "Typ MENS om het team te bereiken.")

## 5. Escalation email and reply page
Drop the curl block from the escalation email. Keep name, phone, language, last messages.

Add a page /admin/reply.html: fields phone and message, a Send button, admin token entered once and kept in localStorage, POSTs to /api/wa-send, shows sent/failed, and a clear message if the 24h window has closed (Meta error 131047). The escalation email links to https://diwali.artindia.be/admin/reply.html?to=<phone> with the number prefilled.

## 6. Tests
Update the tests for the new button ids, greeting handling and language rule. Report the live commit and the exact texts of the three buyer buttons in each language as deployed.

## 7. Admin dashboard: /admin/wa.html
One page, unlocked with the admin token (same localStorage as the reply page), reading a new endpoint GET /api/wa-admin (X-Admin-Token) that returns JSON. Mobile-friendly, plain HTML, no framework.

Data to keep, so the page has something to show:
- Every inbound and outbound message per phone in KV `bot:log:<phone>` (array of {ts, dir, kind, text}, capped at the last 40, 30-day TTL). Outbound includes template sends, menus, model answers, fallbacks and admin replies.
- Welcome template sends in KV `bot:welcome:<phone>` = {ts, name, template, status, last_status_ts}, updated from the status callbacks (sent / delivered / read / failed with the error code).

The page shows three tabs:
1. Conversations: one row per phone, newest activity first: name (from Brevo if known), phone, buyer/prospect, language, last message preview, time, and whether the last message was from the person (needs a look) or from us. Tap a row to expand the full log. A "Reply" link opens /admin/reply.html?to=<phone>.
2. Welcome messages: one row per buyer: name, phone, when sent, status (sent / delivered / read / failed + error). Counts at the top: sent, delivered, read, failed. Failed rows show the Meta error text.
3. Unanswered: the existing bot:unanswered and bot:escalation entries, newest first, so the FAQ can be extended from real questions.

A "Bot: ON / OFF" indicator at the top reads WA_BOT_ENABLED.

# Brief: Team registration module (hidden)

Same repo, same Pages project (`diwali-2026`). Read `docs/wa-bot.md` and `functions/api/_shared.js` first and reuse what is there (`json`, `normalisePhone`, `isEmail`, `safeEqual`, `listAll`, `CODE_ALPHABET`, the WhatsApp send in `tt-order.js`, the Brevo calls). Import, do not copy.

Save this file as `docs/claude-code-brief-team-registration.md`.

## 0. What it is, in one paragraph

Everyone who gets a free pass (core team, crew, artists, child artists, VIPs, press, guests) registers through a hidden link. Ravi sends one link to each team lead; the lead forwards it to his people. Each person gives name, email and WhatsApp number. Nobody gets anything until Ravi or Keerthi approves that person in an admin page. Approval issues a free Ticket Tailor ticket of the right type, puts the person in Brevo, and Diya sends a WhatsApp with their pass and (for some teams) a personal 10% code to share.

Team leads have no approval rights and never see the queue.

VIPs are the exception to the form: they never apply. Ravi or Keerthi enters each VIP, the VIP receives a formal invitation by email and answers it (RSVP). See section 5A.

## 1. Rules that must hold

1. No ticket, no code, no WhatsApp before a named approver (Ravi or Keerthi) approves that individual person. A +1 is a person and goes through the same queue. For a VIP, the invitation sent by an approver is the approval: the ticket is issued when the VIP accepts.
2. Approving twice must never issue two tickets or two codes.
3. A person is never marked approved unless Ticket Tailor returned an issued ticket id.
4. People registered here never go into Brevo list 12 (buyers), never get the buyer welcome, a referral link or lucky draw entries.
5. Pages are hidden: no link from the site, `noindex, nofollow`, excluded from the sitemap, Diya widget not loaded on them.
6. Visitor-facing copy: no em dashes, the word "weekend" never appears, three languages (EN default, FR, NL) using the strings in section 9. Do not machine-translate anything not given there; ask.
7. Ship dark: `TEAM_REG_ENABLED=false` and `TEAM_DRY_RUN=true` on first deploy.

## 2. Teams

Seed `data/teams.json` with this. `expected` is a starting guess and will change, so it must be editable from the admin page without a deploy (the KV value overrides the seed).

| key | Team | Expected | Ticket type env var | +1 | 10% code | Who fills the form |
|---|---|---|---|---|---|---|
| core | Core team | 15 | TT_TYPE_CORE | no | yes | the person |
| crew | Technical crew (Stijn) | 10 | TT_TYPE_CREW | no | no | the person |
| dj | DJ Param and team | 7 | TT_TYPE_DJ | no | yes | the person |
| media | Media team | 10 | TT_TYPE_MEDIA | no | yes | the person |
| artist | Main artists | 30 | TT_TYPE_ARTIST | yes, one | yes | the person |
| collab | Collab artists | 20 | TT_TYPE_COLLAB | no | yes | the person |
| aimc | AIMC music team (Art India Music Conservatory) | 15 | TT_TYPE_AIMC | no | yes | the person |
| child | Child artists | 50 | TT_TYPE_CHILD | no | yes, to the parent | a parent |
| vip | VIPs | 30 | TT_TYPE_VIP | no | no | nobody: invited by an approver, answers by RSVP (section 5A) |
| press | Press | 20 | TT_TYPE_PRESS | no | no | the person |
| guest | Guests | 30 | TT_TYPE_GUEST | no | no | the person |
| plus1 | Artist +1 | one per main artist | TT_TYPE_PLUS1 | n/a | no | the +1 |

`plusOne`, `promoCode` and `wall` are per-team flags in the data file, so Ravi can change which teams get them. `wall` is true for core, crew, dj, media, artist, collab and aimc; false for child, vip, press, guest and plus1. A VIP invitation can cover several places (in 2025, 41 invitations became 59 guests), so the VIP ticket type needs a quantity of about twice the number of invitations.

## 3. Storage

New KV namespace `ACCRED`, bound to the Pages project. Separate from `REFERRALS` because it holds personal data that will be exported and later deleted as a block.

- `link:<token>` → `{ team, label, lead, expected, open, createdBy, createdAt }`. Token: 20 chars from `CODE_ALPHABET`, random. Several links per team are normal (one per collab group, one per teacher, one per board member who invites guests).
- `person:<id>` → the record below.
- `phone:<e164>` → `[ids]`, `email:<lowercased>` → `[ids]` for duplicate checks and for Diya's lookup.
- `code:<PROMO>` → `{ id, discountId }`.
- `plus1:<token>` → `{ artistId, used }`.
- `teamcfg:<key>` → overrides for `expected`.

Person record:

```
{ id, team, linkToken, label,
  firstName, lastName, email, phone (E.164), role, lang,
  child: { firstName, lastName, dob } | null,   // child team only; dob as YYYY-MM-DD; the contact is the parent
  plusOneOf: <artist id> | null,
  vip: { honorific, salutation, jobTitle, organisation, greeting, opening, personalNote, emailOpener,
         places, from, to, onStage, invitedBy,
         rsvpToken, sentAt, remindedAt, answeredAt, answeredVia: "link" | "phone" | "email",
         attending, companions: [{ firstName, lastName, issuedTicketId }] } | null,
  wallToken: string | null,
  status: "pending" | "approving" | "approved" | "rejected" | "revoked"
          | "draft" | "invited" | "declined",     // the last three are VIP only
  decidedBy, decidedAt, note,
  flags: ["dup_phone", "dup_email", "other_team", "over_expected", "already_buyer"],
  tt: { issuedTicketId, barcode } | null,
  promo: { code, discountId } | null,
  plus1Token: string | null,
  steps: { ticket, discount, brevo, email, whatsapp },   // each: "done" | "failed:<reason>" | null
  createdAt, ip }
```

The child's date of birth is required on the child team. It is data about a minor, so it lives only in the `ACCRED` record and the admin export: never send it to Brevo, Ticket Tailor, WhatsApp, an email body or a log line.

## 4. Public side

### 4.1 Page `/team/?k=<token>`

One static page plus a small script, in the site's own look (tokens from the existing CSS, no new fonts, no framework). Mobile first.

- On load: `GET /api/team-form?k=<token>` → `{ ok, team, label, closed, lang strings key }`. Unknown token, closed link, or `TEAM_REG_ENABLED` off → the "link not active" message, nothing else.
- The page shows the team name and label ("Collab artists · <group>") so the person knows they are in the right place.
- Fields, all required: first name, last name, email, WhatsApp number, role or act (free text, 2 to 60 chars). Child team: child's first and last name and date of birth (three selects, day, month, year, so it works the same on every phone), then "Parent or guardian" first name, last name, email, WhatsApp number. Show the `dob_why` line under the date.
- Required checkbox with the consent line (section 9). No pre-ticked box.
- "Add another person" after a successful submit resets the form and keeps the link, so a lead can enter several people in a row. One person per submit.
- Honeypot field. No third-party script, no captcha service.
- Language: from `<html lang>` with the site's usual switcher.

### 4.2 `POST /api/team-register`

Body `{ k, firstName, lastName, email, phone, role, child?, consent, lang, hp }`.

- Origin check as in `/api/chat`. Honeypot filled → 200 and store nothing.
- Validate: `isEmail`, `normalisePhone` must return a number, consent true. Child team: `child.dob` is a real date and the child is under 18 on 24 October 2026; otherwise refuse with the `dob_invalid` message.
- Refuse (same polite message, no detail) when: link closed, registration closed (`TEAM_CLOSE_AT`, default `2026-10-18T23:59:00+02:00`), the link already holds `2 × expected` people (minimum 10), or this phone or email was already rejected.
- Same phone and same name on the same link → treat as a repeat submit: return success, store nothing new.
- Flags, never blocks: same phone or email on another person (`dup_phone`, `dup_email`; on the child team a shared parent phone is normal, so flag only when the child's name also matches), same person in another team (`other_team`), link above its expected number (`over_expected`), email found in Brevo list 12 (`already_buyer`).
- Per-IP cap of 40 submits a day in KV.
- Store as `pending`. Send the "received" email (section 8). Upsert the Brevo contact with `REG_STATUS=pending`. No WhatsApp at this stage.
- Response `{ ok: true }` and the page shows the "received" message.

### 4.3 +1 page `/team/plus1/?k=<plus1 token>`

Same form without role. Creates a `plus1` person with `plusOneOf`, status `pending`. The token is marked used at submit and dead after `TEAM_CLOSE_AT`. If the +1 is rejected, the token is reopened so the artist can name someone else.

## 5. Admin side

### 5.1 Access

`TEAM_ADMIN_TOKENS` is a JSON secret: `{"ravi":"<token>","keerthi":"<token>"}`. Header `X-Admin-Token`; compare with `safeEqual` against each; the matching name is the approver recorded on every decision. Do not reuse `WA_ADMIN_TOKEN` (it has been pasted in chat transcripts). Unset → 503 on every admin route.

### 5.2 Page `/admin/team.html`

Same pattern as `/admin/wa.html` (token kept on the device, one call for everything, usable on a phone).

- **Queue** tab: pending people, oldest first, grouped by team with "14 registered, 10 expected" per team and per link. Each row: name, role, team and label, WhatsApp, email, the child's date of birth and age on 24 October on the child team, flags as chips, "+1 of <artist>" where relevant. Buttons Approve and Reject (reject asks for a short note). No bulk "approve all".
- **People** tab: everyone, filter by team and status, search by name or phone. Per person: step statuses, Retry (re-runs only failed steps), Revoke.
- **Links** tab: create a link (team, label, lead name, expected), copy it, close or reopen it, edit `expected`. No links for the VIP team.
- **Add person** (on People): for anyone who should not fill a form (not for VIPs, who have their own tab). Same fields; created as approved by the logged-in approver and run through the approval steps.
- **Export CSV**: first name, last name, email, WhatsApp, team, label, role, child's name and date of birth (child team), salutation, title, organisation and RSVP (VIPs), status, approver, promo code, tickets sold with the code. This is the contact list of everyone who works for the festival.

### 5.3 `GET /api/team-admin` and `POST /api/team-admin`

GET returns teams, links and people in one payload. POST actions: `approve`, `reject`, `retry`, `revoke`, `link_create`, `link_update`, `person_add`, `expected_set`, and for VIPs `vip_save`, `vip_import`, `vip_send`, `vip_remind`, `vip_mark`, `vip_template_save`, `vip_test_send`.

### 5.4 Approve, step by step

1. Read the record. Only `pending` may proceed. Write `approving` with a lock stamp first; a second request that finds `approving` or `approved` returns the current record and does nothing. A lock older than 2 minutes with no ticket may be retried.
2. **Ticket.** First `GET /v1/issued_tickets?reference=<person id>`; if one exists and is not voided, adopt it. Otherwise `POST /v1/issued_tickets` with `event_id`, `ticket_type_id` (from the team's env var), `full_name` (the child's name on the child team), `email`, `send_email=true`, `reference=<person id>`. Read the Ticket Tailor API docs for the exact encoding and field names before writing this; the fields above are what the endpoint lists. Find the event id with `GET /v1/events`, do not guess it from the box office URL. On any failure (no inventory, no credits, 4xx, 5xx): status back to `pending`, the error shown in the queue, stop.
3. **Discount code**, only when the team has `promoCode`. Code = first name, uppercase ASCII letters only, max 10, then `-` and 4 chars from `CODE_ALPHABET` (example `SHREYA-7KQ4`). `POST /v1/discounts`: 10 percent, restricted to the ticket types in `TT_DISCOUNT_TICKET_TYPES` (single adult online tickets only, never the Family or Friends tickets), limited to `TEAM_CODE_MAX_ORDERS` orders (default 10), expiring `2026-10-23T23:59:00+02:00`. On a code collision pick new random chars.
4. **Main artist only:** create the `plus1:<token>`.
5. **Brevo:** upsert into `BREVO_ACCRED_LIST_ID` with the attributes in section 7. Never add to the buyers list. If the contact is already a buyer, leave their buyer attributes alone.
6. **Email:** the "approved" email (section 8).
7. **WhatsApp:** template `diwali_team_pass_en` when the person has a code, `diwali_team_pass_plain_en` when not. Same send and logging path as the buyer welcome, so the delivery status shows in `/api/wa-status` and the dashboard. `TEAM_DRY_RUN=true` logs instead of sending.
8. Status `approved`, `decidedBy`, `decidedAt`.

Steps 3 to 7 failing never undo the ticket. Each is recorded in `steps` and can be retried alone.

`TEAM_DRY_RUN=true`: steps 2, 3 and 7 are simulated (fake ids prefixed `dry_`), steps 5 and 6 run for real only for addresses in `TEAM_TEST_EMAILS`.

### 5.5 Reject and revoke

- Reject: status `rejected`, note stored, phone and email remembered so the same person cannot re-register. Nothing is sent to them.
- Revoke (after approval): void the issued ticket, delete the discount code, Brevo `REG_STATUS=revoked`, status `revoked`.

## 5A. VIP invitations and RSVP

VIPs are invited as Special Guests to the Exclusive Diwali Evening on Saturday 24 October 2026, 18:00 to 21:30. The invitation is a formal letter as a PDF, signed by the four board members, attached to a short email. The VIP answers through an RSVP link or by replying to the email.

This replaces the 2025 practice of one Google Doc per VIP exported to PDF and sent by hand, with a tracker sheet ("DIWALI2025 - INVITATION TRACKER"). Keep what that practice had: a warm letter, a personal line where Ravi wants one, families of up to four, and an "on stage" mark.

### Entering a VIP

**Invitations** tab on `/admin/team.html`. One form per invitation, all fields required unless marked:

- Honorific, optional: free text with suggestions (H.E., His Excellency, Her Excellency, Brigadier, Dr., Prof.).
- Salutation: free text with suggestions (Mr, Mrs, Ms, Mr and Mrs, Madam; Monsieur, Madame; de heer, mevrouw).
- First name, last name.
- Title (their function, for example "Ambassador of India to Belgium"), optional.
- Organisation, optional.
- Email.
- Places: 1 to 6, default 1. A couple is 2, a family is 3 or 4.
- Greeting line: the line that opens the letter, suggested from the fields ("Dear Mr <last>," / "Dear Mrs and Mr <last>," / "Dear Excellency Mr <first> <last>,") and always editable.
- Opening word: default "Namaste!" (editable per invitation, for example "Jai Hind!").
- Personal paragraph, optional: one or two sentences for this VIP only, printed after the second paragraph of the letter.
- Email opener, optional: one or two personal sentences at the top of the cover email ("We met at ...").
- Language: EN, FR or NL. Default EN.
- Time: from and to, prefilled with the default (18:00 and 21:30) and editable per invitation. The default itself is editable on the tab and changing it does not touch invitations already sent.
- On stage: yes or no (internal only, for the stage team).
- WhatsApp number, optional. Invited by (the host on the Art India side) and a note, both optional.

Saved as `draft`. Also a paste box that takes rows copied from a spreadsheet (same columns, tab separated) and creates drafts, with a preview of what was understood before anything is saved, so last year's tracker can be reused. A duplicate email among VIPs is refused.

### The invitation PDF

One A4 page, generated per invitation in the Function with `pdf-lib` (plus `@pdf-lib/fontkit` for the fonts). No headless browser. Load the fonts and images from the site's own static assets, not bundled into the Function, to stay inside the bundle limit.

Layout, top to bottom, modelled on the 2025 letter but in the current brand (current logo from `static/brand/`, Rozha One and Mukta, indigo #171B3D, saffron #E8A33B, paper #F2EFE6, never the old logo):

1. Letterhead: "ART INDIA · Sharing India with the world" at the left, the logo at the right.
2. Greeting line in bold, then the opening word on its own line.
3. Body paragraphs, with "Brussels Diwali Festival", "Special Guest" and "Exclusive Diwali Evening" in bold.
4. Three bold lines for date, time and place. Draw small icons as vector shapes or leave them out; no emoji (the fonts have none).
5. Closing paragraphs.
6. Four signatures in a row: each name set in a handwriting font (add an open-licence one such as Caveat to the static assets) in saffron or indigo, and under it the name in bold and the title.
7. One line: "RSVP: <button linking to the VIP's RSVP page> or guests@artindia.be".
8. Footer: the partner logos of the top tiers in `data/partners.json` (patronage, main partner, supported by), the same set as the landing-page strip. No other logos.

Text must wrap by measured width and never overflow the page: if the letter does not fit on one page at the minimum font size, refuse to send and say so on the tab. File name: `Invitation Brussels Diwali Festival 2026 - <last name>.pdf`.

The letter template per language is stored in KV and editable on the Invitations tab (`vip_template_save`), seeded with the copy below. Merge fields: `{greeting}`, `{opening}`, `{personal}`, `{from}`, `{to}`. Times print as 18:00 in EN, 18h00 in FR, 18.00 uur in NL.

**EN**

> {greeting}
>
> {opening}
>
> This year the Brussels Diwali Festival celebrates its tenth edition. Over these years it has grown into the largest Indian festival in Europe, a unique celebration of light, culture and togetherness.
>
> This journey, from a small gathering to a landmark international event at the Atomium, has been made possible thanks to the constant support and encouragement of our friends, partners and well-wishers.
>
> {personal}
>
> It is with great pleasure that we invite you as a Special Guest to our Exclusive Diwali Evening on:
>
> Saturday 24 October 2026
> From {from} to {to}
> Atomium Esplanade, Brussels
>
> The evening will bring together distinguished guests, artists and communities for a night of joy, culture and unity under the festive lights of Diwali. Your gracious presence will make this occasion even more memorable.
>
> We sincerely look forward to welcoming you.
>
> With deepest respect and warm regards,

**FR**

> {greeting}
>
> {opening}
>
> Cette année, le Brussels Diwali Festival célèbre sa dixième édition. Au fil des ans, il est devenu le plus grand festival indien d'Europe, une célébration unique de la lumière, de la culture et du vivre-ensemble.
>
> Ce parcours, d'un petit rassemblement à un événement international de référence au pied de l'Atomium, a été rendu possible grâce au soutien et aux encouragements constants de nos amis, partenaires et sympathisants.
>
> {personal}
>
> C'est avec grand plaisir que nous vous convions, parmi nos invités d'honneur, à notre Soirée exclusive de Diwali :
>
> Samedi 24 octobre 2026
> De {from} à {to}
> Esplanade de l'Atomium, Bruxelles
>
> La soirée réunira des invités de marque, des artistes et des communautés pour une nuit de joie, de culture et d'unité sous les lumières de Diwali. Votre présence rendra cette occasion encore plus mémorable.
>
> Nous nous réjouissons de vous accueillir.
>
> Avec notre profond respect et nos salutations les plus cordiales,

**NL**

> {greeting}
>
> {opening}
>
> Dit jaar viert het Brussels Diwali Festival zijn tiende editie. In die jaren is het uitgegroeid tot het grootste Indiase festival van Europa, een unieke viering van licht, cultuur en verbondenheid.
>
> Deze weg, van een kleine bijeenkomst tot een internationaal evenement aan het Atomium, was mogelijk dankzij de voortdurende steun en aanmoediging van onze vrienden, partners en sympathisanten.
>
> {personal}
>
> Met groot genoegen nodigen wij u uit als een van onze eregasten op onze Exclusieve Diwali-avond:
>
> Zaterdag 24 oktober 2026
> Van {from} tot {to}
> Esplanade van het Atomium, Brussel
>
> De avond brengt genodigden, kunstenaars en gemeenschappen samen voor een avond vol vreugde, cultuur en eenheid onder de feestelijke lichtjes van Diwali. Uw aanwezigheid zal deze gelegenheid nog gedenkwaardiger maken.
>
> Wij kijken ernaar uit u te verwelkomen.
>
> Met de meeste hoogachting en hartelijke groeten,

Signature block (editable on the tab; Ravi confirms it once before the first send, and sending is blocked until then):

| Name | EN | FR | NL |
|---|---|---|---|
| Shreya | Founder & Artistic Director | Fondatrice et directrice artistique | Oprichter en artistiek directeur |
| Ravi Kaushik | Executive Producer | Producteur exécutif | Uitvoerend producent |
| Sridhar Sairam | Board Member & Music Director, AIMC | Membre du conseil d'administration et directeur musical, AIMC | Bestuurslid en muziekdirecteur, AIMC |
| Taruna Kaushik | Board Member & Director, Administration | Membre du conseil d'administration et directrice de l'administration | Bestuurslid en directeur administratie |

### The email that carries it

Through the Brevo API, sender `VIP_SENDER_EMAIL` (falls back to `BREVO_SENDER_EMAIL`), reply-to `VIP_REPLY_TO`, the PDF as attachment, plain layout with a plain-text part. It should read like a personal email, as in 2025, not like a newsletter: no banner image, no footer block beyond the legal minimum.

| | EN | FR | NL |
|---|---|---|---|
| subject | Invitation to the Brussels Diwali Festival: Exclusive Evening on Saturday 24 October | Invitation au Brussels Diwali Festival : soirée exclusive du samedi 24 octobre | Uitnodiging voor het Brussels Diwali Festival: exclusieve avond op zaterdag 24 oktober |
| body | {greeting} {emailOpener} On behalf of Art India and the organising team of the Brussels Diwali Festival 2026, it is our honour to invite you as a Special Guest to the Exclusive Diwali Evening on Saturday 24 October, from {from} to {to}, on the Atomium Esplanade in Brussels. Please find the formal invitation attached. May we ask you to confirm your presence with the button below, or by replying to this email. | {greeting} {emailOpener} Au nom d'Art India et de l'équipe organisatrice du Brussels Diwali Festival 2026, nous avons l'honneur de vous convier, parmi nos invités d'honneur, à la Soirée exclusive de Diwali le samedi 24 octobre, de {from} à {to}, sur l'esplanade de l'Atomium à Bruxelles. Vous trouverez l'invitation officielle en pièce jointe. Pourriez-vous nous confirmer votre présence via le bouton ci-dessous ou en répondant à ce message ? | {greeting} {emailOpener} Namens Art India en het organisatieteam van het Brussels Diwali Festival 2026 hebben wij de eer u uit te nodigen als een van onze eregasten op de Exclusieve Diwali-avond op zaterdag 24 oktober, van {from} tot {to}, op de esplanade van het Atomium in Brussel. De officiële uitnodiging vindt u in bijlage. Mogen wij u vragen uw aanwezigheid te bevestigen via de knop hieronder of door deze e-mail te beantwoorden? |
| button | Reply to the invitation | Répondre à l'invitation | De uitnodiging beantwoorden |
| sign-off | With warm regards, The Board of Art India ASBL | Bien cordialement, Le conseil d'administration d'Art India ASBL | Met hartelijke groeten, Het bestuur van Art India vzw |

The sign-off is editable on the tab.

### Sending

Nothing is sent on save. The approver opens a preview that shows the email and the PDF exactly as that VIP will get them, then presses **Send invitation** on one draft or on a selection. A **Send test to me** button sends the same email and PDF to the approver's own address. Status becomes `invited`. An invitation already sent can be corrected and sent again (for a changed time, for example); the RSVP link stays the same.

### RSVP page `/rsvp/?k=<rsvpToken>`

The link in the email and in the PDF goes to this page. The answer is recorded only when the VIP presses the confirm button on the page, by POST to `/api/team-rsvp`. A GET never changes anything: mail scanners open every link in an email and would otherwise answer for the VIP.

- Shows the greeting name, the date and the time.
- One place: "I will attend" / "I am unable to attend" (FR: "Je serai présent(e)" / "Je ne pourrai pas être présent(e)"; NL: "Ik zal aanwezig zijn" / "Ik kan niet aanwezig zijn").
- More than one place: "How many of you will attend?" with 0 up to the number of places (FR: "Combien de personnes seront présentes ?"; NL: "Met hoeveel personen komt u?"), then first and last name for each person besides the VIP (label "Name of your guest" / "Nom de votre invité(e)" / "Naam van uw gast").
- After yes: "Thank you. We look forward to welcoming you. Your pass will arrive by email." FR: "Merci. Nous nous réjouissons de vous accueillir. Votre pass vous parviendra par e-mail." NL: "Dank u. Wij kijken ernaar uit u te verwelkomen. Uw pas ontvangt u per e-mail."
- After no: "Thank you for letting us know." FR: "Merci de nous avoir informés." NL: "Dank u voor uw bericht."
- The answer may be changed until `VIP_RSVP_BY`; afterwards the page shows the recorded answer and the reply address.
- Token: 24 chars, random. Unknown token: the "link not active" message.

### What an answer does

- **Attending:** run the approval steps of 5.4 for the VIP team: ticket, Brevo, the approved email in formal wording. No discount code, no WhatsApp marketing template. The approver recorded is the one who sent the invitation.
- **More than one attending:** one VIP ticket per person, all sent to the VIP's email, each in that person's name. The invitation covers the places the approver set, so these people do not go to the approval queue; they are listed under the VIP on the tab.
- **Fewer than before:** tickets no longer needed are voided.
- **Not attending:** status `declined`, nothing else is sent.
- **Answer by phone or email:** the approver sets it with `vip_mark` (number attending and names, or declined, with the channel). Same effect as the page.
- **No answer:** one reminder email after 5 days, only once, only before `VIP_RSVP_BY`. The tab lists who has not answered so they can be called.

The Invitations tab shows per invitation: status, sent, reminded, answered and how, places, number attending, on stage; and totals of invited, accepted, declined, no answer, people attending, passes issued. Two exports: the full VIP list with every attending person on a row (honorific, salutation, last name, first name, title, organisation, on stage), and the on-stage list alone.

## 6. Diya for team members

In the WhatsApp bot, before the buyer or prospect decision, look the sender up in `ACCRED` by phone. An approved person is "team".

- Menu for a team member with a code: buttons `MY_PASS` "My pass", `MY_CODE` "My code", `CODE_SALES` "Tickets sold" (FR: "Mon pass", "Mon code", "Billets vendus"; NL: "Mijn pas", "Mijn code", "Tickets verkocht"). Without a code: `MY_PASS` plus the first two prospect buttons.
- `MY_PASS`: pass type, that the QR ticket is in their email (name the address), and, for a main artist, the state of the +1 (link not used yet, with the link; pending; approved, with the +1's first name).
- `MY_CODE`: the code and a ready-to-forward line: "Use my code <CODE> for 10% off your Brussels Diwali Festival ticket: https://diwali.artindia.be/go/buy?cta=team".
- `CODE_SALES`: orders and tickets sold with their code. Source: the redemption count on the discount object from `GET /v1/discounts/<id>` if the API returns one; check the live response. If it does not, count from the order webhook when the payload carries the discount code. Report which of the two worked. Cache 10 minutes in KV.
- Pending person who writes in: "Your registration is waiting for approval." Rejected or unknown: normal prospect behaviour, no mention of registration.
- VIPs get no team menu and no message from Diya unless they write first; then normal prospect behaviour.
- A team member is never offered My lucky draw link or My winning chances. If the same phone is also a buyer, typed questions about their bought tickets still work.
- Add routing tokens `ACTION:MY_PASS`, `ACTION:MY_CODE`, `ACTION:CODE_SALES` for free text, team members only.
- Add `cta=team` to `/go/buy` so these sales are tagged `site-team` in the funnel.
- The web widget never reveals a code or pass; it points to WhatsApp and email, as it does for referral links.

## 6A. Hook for "People of Art India" (do not build the page)

A separate brief will add a photo step: approved people on the teams flagged `wall` upload a photo of themselves from a past Art India event. For now only prepare for it:

- On approval, for a team with `wall: true`, generate and store `wallToken` (24 chars, random) on the person.
- Read `WALL_ENABLED` (default false) and `WALL_URL`. Only when enabled: the approved email gets one extra line with `<WALL_URL>?k=<wallToken>`, and Diya's team menu answer for `MY_PASS` ends with the same link. Leave the wording as a string key `wall_invite` with a placeholder text; the real copy comes with the other brief.
- Never generate a `wallToken` for the child team.

## 7. Brevo

List id in `BREVO_ACCRED_LIST_ID`. Attributes (Ravi creates them, all text): `TEAM`, `REG_STATUS`, `ACT_OR_ROLE`, `INVITED_BY` (the link label), `PROMO_CODE`, `TT_TICKET_ID`, `PLUS_ONE_LINK`, and for VIPs `HONORIFIC`, `SALUTATION`, `JOB_TITLE`, `ORGANISATION`, `RSVP` (invited, accepted, declined), `VIP_PLACES`. Also set FIRSTNAME, LASTNAME, LANG, and the phone on the same attribute the buyer flow uses. Child team: the contact is the parent, `ACT_OR_ROLE` = "Parent of <child first name>"; several children under one parent stay one contact, the per-child records live in KV. The date of birth is never written to Brevo.

## 8. Emails

Transactional through the Brevo API, sender `BREVO_SENDER_EMAIL`, plain layout, in the person's language (strings in section 9).

1. **Received**, on registration.
2. **Approved**, on approval: pass type, "your QR ticket arrives in a separate email from Ticket Tailor", the code block when they have one, the +1 link when they have one, and a per-team line from `data/teams.json` (`arrival` text: where and when to collect the band). Leave `arrival` empty in the seed; Ravi fills it.
3. **+1 invitation** is not a separate email: the artist forwards the link.

## 9. Copy

| Key | EN | FR | NL |
|---|---|---|---|
| title | Team registration | Inscription des équipes | Teamregistratie |
| intro | Register here for your pass to the Brussels Diwali Festival, 24 and 25 October 2026. One form per person. | Inscrivez-vous ici pour recevoir votre pass pour le Brussels Diwali Festival, les 24 et 25 octobre 2026. Un formulaire par personne. | Registreer hier voor je pas voor het Brussels Diwali Festival op 24 en 25 oktober 2026. Eén formulier per persoon. |
| first | First name | Prénom | Voornaam |
| last | Last name | Nom | Achternaam |
| email | Email | E-mail | E-mail |
| phone | WhatsApp number | Numéro WhatsApp | WhatsApp-nummer |
| role | Your role or act | Votre rôle ou numéro | Je rol of act |
| child | Child's name | Nom de l'enfant | Naam van het kind |
| dob | Child's date of birth | Date de naissance de l'enfant | Geboortedatum van het kind |
| dob_why | Used only to register child artists for the festival. | Utilisée uniquement pour l'inscription des enfants artistes au festival. | Wordt alleen gebruikt om kindartiesten voor het festival te registreren. |
| dob_invalid | Please check the date of birth. | Veuillez vérifier la date de naissance. | Controleer de geboortedatum. |
| parent | Parent or guardian | Parent ou tuteur | Ouder of voogd |
| consent | Art India may contact me by email and WhatsApp about my pass and the festival, and keeps my details to reach me for future Art India events. I can ask to be removed at any time: diwali@artindia.be | Art India peut me contacter par e-mail et WhatsApp au sujet de mon pass et du festival, et conserve mes coordonnées pour me joindre lors de ses prochains événements. Je peux demander leur suppression à tout moment : diwali@artindia.be | Art India mag mij via e-mail en WhatsApp contacteren over mijn pas en het festival, en bewaart mijn gegevens om mij te bereiken voor volgende evenementen van Art India. Ik kan op elk moment vragen om ze te verwijderen: diwali@artindia.be |
| submit | Register | S'inscrire | Registreren |
| another | Add another person | Ajouter une autre personne | Nog iemand toevoegen |
| received | Thank you. Your registration is waiting for approval by the festival team. You will hear from us by email and WhatsApp. | Merci. Votre inscription est en attente de validation par l'équipe du festival. Vous recevrez une réponse par e-mail et WhatsApp. | Bedankt. Je registratie wacht op goedkeuring door het festivalteam. Je hoort van ons via e-mail en WhatsApp. |
| inactive | This link is not active. Please contact the person who sent it to you. | Ce lien n'est pas actif. Contactez la personne qui vous l'a envoyé. | Deze link is niet actief. Neem contact op met de persoon die hem stuurde. |
| closed | Registration is closed. Please contact your team lead. | Les inscriptions sont clôturées. Contactez votre responsable d'équipe. | De registratie is gesloten. Neem contact op met je teamverantwoordelijke. |
| mail_received_subject | We received your registration | Nous avons bien reçu votre inscription | We hebben je registratie ontvangen |
| mail_approved_subject | Your pass for the Brussels Diwali Festival | Votre pass pour le Brussels Diwali Festival | Je pas voor het Brussels Diwali Festival |
| mail_code | Your personal code {CODE} gives your friends and family 10% off a festival ticket until 23 October. | Votre code personnel {CODE} offre à vos proches 10 % de réduction sur un billet festival jusqu'au 23 octobre. | Met je persoonlijke code {CODE} krijgen je vrienden en familie 10% korting op een festivalticket tot 23 oktober. |
| mail_plus1 | You may bring one guest. Send them this link to register; it works once: {LINK} | Vous pouvez inviter une personne. Envoyez-lui ce lien pour s'inscrire ; il ne fonctionne qu'une fois : {LINK} | Je mag één gast meebrengen. Stuur deze link om te registreren; hij werkt één keer: {LINK} |

Email bodies: write them from these lines plus the pass type and the `arrival` line. Sign "Brussels Diwali Festival, Art India ASBL". No personal names.

## 10. Environment

New, all set by Ravi in Cloudflare before switching on:

`TEAM_REG_ENABLED`, `TEAM_DRY_RUN`, `TEAM_TEST_EMAILS`, `TEAM_ADMIN_TOKENS`, `TEAM_CLOSE_AT`, `TEAM_CODE_MAX_ORDERS`, `VIP_RSVP_BY` (default `2026-10-16T23:59:00+02:00`), `VIP_REPLY_TO` (`guests@artindia.be`), `VIP_SENDER_EMAIL`, `WALL_ENABLED`, `WALL_URL`, `TT_API_KEY` (write access, new key, not the read-only one), `TT_EVENT_ID`, `TT_TYPE_CORE`, `TT_TYPE_CREW`, `TT_TYPE_DJ`, `TT_TYPE_MEDIA`, `TT_TYPE_ARTIST`, `TT_TYPE_COLLAB`, `TT_TYPE_AIMC`, `TT_TYPE_CHILD`, `TT_TYPE_VIP`, `TT_TYPE_PRESS`, `TT_TYPE_GUEST`, `TT_TYPE_PLUS1`, `TT_DISCOUNT_TICKET_TYPES`, `BREVO_ACCRED_LIST_ID`, `WA_TEMPLATE_TEAM`, `WA_TEMPLATE_TEAM_PLAIN`. KV binding `ACCRED`.

A missing ticket type id for a team disables approval for that team only, with a clear message in the queue.

## 11. Tests

`node --test`, same style as `test/tt-order.test.mjs`, Ticket Tailor, Brevo and Meta mocked:

- register: validation, honeypot, closed link, cap, repeat submit, rejected phone refused, each flag; child team needs a valid date of birth under 18.
- the date of birth appears in the admin payload and the export, and in no Brevo, Ticket Tailor, WhatsApp or email call.
- approve: the full step order; double approve issues once; Ticket Tailor failure leaves `pending`; a failed later step keeps the ticket and is retryable; adoption of an existing ticket by reference.
- teams without `promoCode` create no discount; only main artists get a +1 token; +1 goes to the queue and is never auto-approved.
- admin auth: no token, wrong token, each named token recorded as approver.
- bot: team menu, the three actions, pending and rejected behaviour, a team member never gets draw buttons.
- VIP: save does not send; send is blocked until the signature block is saved; the PDF is one page, carries the addressee, the per-invitation time and a working RSVP link, in each language; a GET on the RSVP page changes nothing; yes issues one ticket even when confirmed twice; an invitation with three places answered for two issues two tickets, each in the right name; lowering the number or declining voids the extra ones; the personal paragraph and the opening word print when set and leave no gap when empty; the reminder goes once; `vip_mark` behaves like the page; a changed time on a resent invitation keeps the same RSVP link.
- wall hook: token only on `wall` teams, never on the child team, and no link in any message while `WALL_ENABLED` is false.
- nothing in this module writes to the buyers list.

## 12. Report back

1. Files added and changed, and the test count.
2. What the live Ticket Tailor API actually returned for: the issued ticket (fields, whether the email went out), the discount (field names, whether a redemption count exists), and whether an API-issued ticket triggered the order webhook `/api/tt-order` (it must not; if it does, make `tt-order` ignore it).
3. Screenshots of `/team/?k=…` on a phone width, of `/admin/team.html`, of the VIP invitation email in FR and EN as rendered in a mail client, the invitation PDF itself in EN and FR (one place and several places, with and without a personal paragraph), and of `/rsvp/`.
4. Confirm the deploy by fetching the live URLs yourself. Do not end on "deploy still running".

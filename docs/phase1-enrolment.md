# Phase 1 — buyer enrolment (Brevo + WhatsApp)

What happens when someone buys a ticket, and what has to be set up by hand for
it to work. Everything below runs on `diwali.artindia.be`, in the Cloudflare
Pages project `diwali-2026`.

## The path an order takes

1. Ticket Tailor posts `order.created` to **`/api/tt-order`**.
2. The buyer is upserted into Brevo list **12** with their phone, WhatsApp
   opt-in, checkout language and their own referral code.
3. Anyone else named on a ticket with their own address is upserted too —
   same list, no WhatsApp.
4. If the order arrived on somebody's referral code, that person's
   `REFERRED_BY` goes up by the number of adult tickets.
5. If the buyer said yes to WhatsApp, the approved `diwali_welcome_en`
   template goes out with their first name and their link.
6. Replies and delivery reports come back to **`/api/wa-webhook`**, which is
   the only thing that ever turns `WA_OPTIN` off.

`/r/<CODE>` is the link in that message. It resolves the code in KV and
bounces to the box office with the campaign tags attached.

## Manual setup

### 1. KV namespace

Workers & Pages → KV → **Create** a namespace called `REFERRALS`, then
diwali-2026 → Settings → **Bindings** → add it as `REFERRALS` for **both**
Production and Preview.

Two key shapes live in it:

```
code:<CODE>          { email, firstname, createdAt }
order:<tt_order_id>  { sentAt, waMessageId }
```

`order:` is the idempotency key for the send — while it exists, that order
will never produce a second WhatsApp. Deleting one is how you deliberately
re-send.

Until the binding exists the site keeps working: orders still reach Brevo, and
the referral code and the WhatsApp are skipped with a warning in the log.

### 2. Environment variables

diwali-2026 → Settings → Variables and secrets, **Production and Preview**:

| Name | Value |
|---|---|
| `WA_TOKEN` | permanent system-user token (Passwords) — secret |
| `WA_PHONE_ID` | `1316460834883808` |
| `WA_WABA_ID` | `1394943695946021` |
| `WA_VERIFY_TOKEN` | random 32 chars, generated below — secret |
| `WA_DRY_RUN` | `true` until the first live test passes, then `false` |
| `WA_APP_SECRET` | optional but worth setting — see below |
| `TT_LOG_PAYLOAD` | `true` for one delivery, then remove |

Already set, unchanged: `BREVO_API_KEY`, `BREVO_LIST_ID` (9),
`BREVO_BUYERS_LIST_ID` (12), `TT_WEBHOOK_SECRET`.

Generate the verify token with:

```sh
openssl rand -hex 16
```

`WA_APP_SECRET` is the app secret from Meta → App → Settings → Basic. It is
not required, but `/api/wa-webhook` is a public URL that can switch consent
flags off, and with the secret set every callback is checked against Meta's
`X-Hub-Signature-256` before it is acted on. Without it the function logs a
warning on every call and trusts the body.

### 3. Meta webhook

After the deploy is live: Meta → App → WhatsApp → Configuration → Edit.

- Callback URL: `https://diwali.artindia.be/api/wa-webhook`
- Verify token: the `WA_VERIFY_TOKEN` value
- Subscribe to: **messages**

Meta calls the URL with `hub.mode=subscribe` and expects the challenge echoed
back. If it refuses, the token does not match or the deploy has not finished.

### 4. Brevo attributes

Created automatically on the first order that needs them — `WA_OPTIN`,
`REFERRAL_CODE`, `REFERRED_BY`, `LANG`, `TICKET_ID`, `MARKETING_OPTIN`. Brevo
silently discards attributes it has not been told about, so this runs once per
cold start rather than being left to chance. `SMS` and `WHATSAPP` are Brevo's
own reserved fields and are never created.

## Testing

```sh
npm test          # 31 tests, no network: phone, codes, both webhooks
```

Then the live path, in this order:

1. `WA_DRY_RUN=true`. Replay a saved Ticket Tailor payload with a test address
   and Ravi's own mobile. Check the Cloudflare log for `wa dry-run` and the
   full outgoing payload, and check the Brevo contact shows `SMS`, `WHATSAPP`,
   `WA_OPTIN`, `LANG`, `TICKET_ID` and `REFERRAL_CODE`. A dry run claims
   nothing in KV, so replay as often as needed.
2. `WA_DRY_RUN=false`. Replay **once**. The message should arrive.
3. Replay the same payload again. Nothing should arrive, and the response
   should carry `"whatsapp": false`.
4. Open `https://diwali.artindia.be/r/<CODE>` and confirm it lands on the box
   office with `ref` and `utm_campaign` set to the code.
5. Reply `STOP` to the message and confirm `WA_OPTIN` goes false in Brevo.

## Confirmed payload shape

Read off a real `order.created` delivery (`or_83266022`, 19 September 2026).

```
order.id                                 or_83266022
order.buyer_details.{first_name,last_name,email,phone}     phone already E.164
order.buyer_details.custom_questions[]   { question, answer }   answers are "Yes"/"No"
order.marketing_opt_in                   the STRING "true"
order.referral_tag                       whatever arrived as ?ref=
order.line_items[]                       { quantity, total, description }
order.issued_tickets[]                   { id, first_name, last_name, email,
                                           description, listed_price, ticket_type_id }
order.meta_data                          []  — always empty
```

Two things to keep in mind:

- **The custom questions hang off `buyer_details`, not off the order.** Reading
  them at the order level is what made the first opted-in buyer come out as
  `not_eligible`.
- **There is no `utm_*` anywhere.** `referral_tag` is the only campaign signal,
  and it carries whatever the box office URL had as `?ref=` — so
  `event_page_widget` for the site's own checkout, and the referral code for
  anyone who came through `/r/<CODE>`. Attribution reads `referral_tag` only.

Still unconfirmed, and marked `STILL A GUESS` in the code: the order total field
and the checkout language. There is no language field in the payload at all, so
`LANG` is `en` for every order until Ticket Tailor exposes one.

## Reading the log

A skipped WhatsApp names its own cause rather than a single `not_eligible`:

| Reason | Means |
|---|---|
| `no_kv_binding` | `REFERRALS` is not bound |
| `no_optin` | the lucky draw question was not answered yes — the log then prints every question label the order actually carried, so a moved or renamed question is one glance |
| `no_phone` | `buyer_details.phone` missing or not E.164 |
| `no_referral_code` | KV could not issue one |
| `no_wa_phone_id` / `no_wa_token` | the variable is unset |

The same reason comes back in the webhook's JSON response as
`whatsapp_skipped`, so a replay says why without anyone reading the tail.

## Known soft spots

- **Brevo phone numbers are unique account-wide.** `SMS` and `WHATSAPP` cannot
  sit on two contacts, and a collision makes Brevo reject the *whole* upsert
  with `duplicate_parameter` — not just the phone. That used to be read as
  success, so an order could log `ok` while the contact kept a stale number and
  took none of the rest of the update. Now every upsert logs its status and
  body, and a phone conflict is retried without `SMS`/`WHATSAPP` so the
  remaining attributes land; the fallback logs loudly and sets
  `phone_dropped: true` on the response. **A contact showing the wrong number is
  therefore a real state to look for** — it means the number is on another
  contact and needs clearing there first.
- **Referral credit is read-add-write.** Two orders crediting the same person
  in the same second could lose one count. At this volume that is a
  leaderboard rounding error, not money.
- **A failed send is not retried.** WhatsApp is best effort by design: nothing
  in the WhatsApp step is allowed to fail the webhook, because a non-200 makes
  Ticket Tailor redeliver the order.

## Not in phase 1

FR and NL templates (`LANG` is already stored, so switching is one line in
`sendWelcome`), the `/draw` rules page, reminder templates, the countdown
sequence.

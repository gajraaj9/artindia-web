# Capturing registrations

The form on diwali.artindia.be posts to `/api/register`, a small function that
runs on Cloudflare's edge and adds the address to a Brevo list. The API key
lives in Cloudflare and never reaches the browser.

Until the two variables below are set, the form still **accepts** addresses and
returns success — they're written to the Cloudflare log rather than lost — but
nothing reaches Brevo. Set them and it starts working; no code change.

## 1. Brevo

1. brevo.com → free account (300 emails a day, unlimited contacts)
2. **Contacts → Lists → Create a list**, call it `Diwali 2026`.
   Note the numeric id shown in the URL or the list table.
3. **SMTP & API → API keys → Generate a new API key.** Copy it.

## 2. Cloudflare

Workers & Pages → **diwali-2026** → Settings → Variables and secrets → Add:

| Name | Type | Value |
|---|---|---|
| `BREVO_API_KEY` | Secret | the key from step 1.3 |
| `BREVO_LIST_ID` | Plain text | the list id, e.g. `3` |

Redeploy after adding them:

    ./deploy.sh --holding

## 3. Check it

Register with your own address on the live site, then look in Brevo → Contacts.
It should be there within seconds, tagged `SOURCE = diwali-2026` and with the
signup date.

## Consent

The wording is deliberately narrow — "we will write to you the morning tickets
open". Under GDPR that's what you may do with it.

**Before 5 September, decide whether you want broader consent.** A single line
covering "news about Art India events" would let you market the Yoga Fest to
this list in January; the current wording would not. That's the difference
between renting the audience back from Meta next year and owning it.

If you widen it, say so plainly on the form and keep the record of what people
agreed to.

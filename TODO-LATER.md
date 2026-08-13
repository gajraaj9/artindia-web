# TODO — later

Deferred items. Nothing here blocks the 5 September ticket launch.
Keep in the repo root so it surfaces during normal work.

---

## 1. Google Workspace DKIM

**Why:** `google._domainkey.artindia.be` returns nothing — Google DKIM was never
set up. SPF is now live (added 13 Aug 2026), so outbound mail authenticates on
SPF alone. DKIM is the second signal, and the one that survives forwarding.

Matters because sponsor, Brucity and Loterie Nationale mail goes to corporate
and government servers that weigh authentication heavily. Also matters before
any bulk send to a ticket-buyer list.

**Do:**
1. Google Admin console → Apps → Google Workspace → Gmail → Authenticate email
2. Select `artindia.be`, key length 2048, **Generate new record**
3. Copy the TXT value
4. Cloudflare → DNS → Records → Add record
   - Type: `TXT`
   - Name: `google._domainkey`
   - Content: the generated value
   - Proxy: n/a (TXT is never proxied)
5. Back in Google Admin → **Start authentication**
6. Verify: `dig google._domainkey.artindia.be TXT +short`

**Then, weeks later:** DMARC is currently `p=none` (monitor only). Once SPF and
DKIM have both been passing for 2–4 weeks and the Brevo DMARC reports look
clean, consider tightening to `p=quarantine`. Do not tighten before then — it
would start sending legitimate Art India mail to spam.

**Time:** ~10 minutes. **Do this week.**

---

## 2. Close the Squarespace subscription

**Why:** `diwali.artindia.be` currently 301-redirects to
`www.diwali.artindia.be`, which returns **404**. The site serves nothing. It is
a paid subscription for a dead page, and it will be fully replaced when the
holding page deploys to Cloudflare Pages (M2/M3).

**Before cancelling — export anything worth keeping:**
- [ ] **Media library** — ten years of festival photos and video. This is the
      raw material for the decade archive on `artindia.be` and for the sponsor
      and press packs. Highest-value item by far.
- [ ] **Form submissions** — old signups, contact enquiries, vendor
      applications. Any of it is list data.
- [ ] **Copy** — past programme descriptions, line-ups, artist bios.
- [ ] Note the site's URL structure if any old links are worth 301-ing from the
      new site.

Squarespace's XML export does not reliably include images — download the media
library directly rather than relying on it.

**Then cancel:** Squarespace → Settings → Billing → Subscriptions → cancel.

**Note:** cancelling does not affect DNS. The old `diwali` CNAME lives in
GoDaddy's now-inert zone and is already bypassed — Cloudflare has been
authoritative since 13 Aug 2026. A fresh `diwali` record pointing at Cloudflare
Pages gets created at M2/M3.

**Time:** ~30 min export, 5 min cancel. **No deadline, but do it before the
next renewal date.**

---

## Status at time of writing — 13 August 2026

| | | |
|---|---|---|
| M1 | Local build running | in progress |
| M2 | GitHub + Cloudflare Pages | next |
| M3 | DNS cutover | **done** — NS on Cloudflare, MX intact, SPF live |
| M4 | artindia.be live | pending |
| M5 | Money accounts (Ticket Tailor + Stripe) | pending |
| M6 | Diwali site live, tickets on sale | **5 September** |

**Live issue, not deferred:** `diwali.artindia.be` returns 404 to anyone looking
for the festival. Deploying the holding page is the priority.

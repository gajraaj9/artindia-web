#!/usr/bin/env bash
#
# Seed refcount:<CODE> in KV from the REFERRED_BY totals already in Brevo.
#
#   scripts/backfill-refcount.sh --dry     show what would be written
#   scripts/backfill-refcount.sh
#
# Run this ONCE, when the WhatsApp bot goes live. From then on /api/tt-order
# keeps both numbers in step, and running it again would not double anything
# (it writes totals, it does not add to them) but it would overwrite a counter
# that had moved on since Brevo was last written.
#
# Needs, in the environment:
#   BREVO_API_KEY          same key the functions use
#   BREVO_BUYERS_LIST_ID   the buyers list, 12
#   CLOUDFLARE_API_TOKEN   a token with Workers KV Storage:Edit
#   CLOUDFLARE_ACCOUNT_ID
#   KV_NAMESPACE_ID        the id of the REFERRALS namespace, from the
#                          Cloudflare dashboard: Workers & Pages -> KV
#
set -euo pipefail

DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; OFF=$'\033[0m'
die() { printf "${RED}✗ %s${OFF}\n" "$*" >&2; exit 1; }

for v in BREVO_API_KEY BREVO_BUYERS_LIST_ID; do
  [ -n "${!v:-}" ] || die "$v is not set."
done
if [ "$DRY" = 0 ]; then
  for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID KV_NAMESPACE_ID; do
    [ -n "${!v:-}" ] || die "$v is not set. Use --dry to see the values without writing."
  done
fi
command -v python3 >/dev/null || die "python3 is needed."

printf "\n${BOLD}Reading contacts from Brevo list %s${OFF}\n" "$BREVO_BUYERS_LIST_ID"

# Brevo pages at 500 a time. Every contact with both a referral code and a
# non-zero REFERRED_BY becomes one line of "CODE COUNT".
PAIRS="$(
  offset=0
  while :; do
    page="$(curl -sS -H "api-key: $BREVO_API_KEY" -H 'accept: application/json' \
      "https://api.brevo.com/v3/contacts/lists/${BREVO_BUYERS_LIST_ID}/contacts?limit=500&offset=${offset}")"
    printf '%s' "$page" | python3 -c '
import json, sys
page = json.load(sys.stdin)
for c in page.get("contacts", []):
    a = c.get("attributes", {}) or {}
    code = str(a.get("REFERRAL_CODE") or "").strip().upper()
    try:
        n = int(float(a.get("REFERRED_BY") or 0))
    except (TypeError, ValueError):
        n = 0
    if code and n > 0:
        print(code, n)
'
    count="$(printf '%s' "$page" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("contacts", [])))')"
    [ "$count" -eq 500 ] || break
    offset=$((offset + 500))
  done
)"

if [ -z "$PAIRS" ]; then
  printf "${DIM}  no contacts carry a referral code and a non-zero REFERRED_BY${OFF}\n\n"
  exit 0
fi

printf "%s\n" "$PAIRS" | sed 's/^/  /'
TOTAL="$(printf "%s\n" "$PAIRS" | wc -l | tr -d ' ')"
printf "\n${BOLD}%s code(s)${OFF}\n" "$TOTAL"

if [ "$DRY" = 1 ]; then
  printf "${DIM}Dry run — nothing written.${OFF}\n\n"
  exit 0
fi

printf "  Write these to KV? ${DIM}[y/N]${OFF} "
read -r YN < /dev/tty || YN=""
case "$YN" in [yY]*) ;; *) printf "${DIM}stopped${OFF}\n\n"; exit 0 ;; esac

printf "%s\n" "$PAIRS" | while read -r CODE COUNT; do
  [ -n "$CODE" ] || continue
  npx wrangler kv key put --namespace-id="$KV_NAMESPACE_ID" --remote \
    "refcount:${CODE}" "$COUNT" >/dev/null
  printf "${GRN}  ✓${OFF} refcount:%s = %s\n" "$CODE" "$COUNT"
done

printf "\n${GRN}${BOLD}Done.${OFF} /api/tt-order keeps them in step from here.\n\n"

#!/usr/bin/env bash
#
# Replay a saved Ticket Tailor webhook payload at /api/tt-order.
#
#   scripts/replay.sh scripts/payload-or_83267317.json
#   scripts/replay.sh --dry scripts/payload-or_83267317.json     sign, send nothing
#   scripts/replay.sh -y scripts/payload-or_83267317.json         no confirmation
#   scripts/replay.sh --url http://localhost:8788/api/tt-order p.json
#
# Needs TT_WEBHOOK_SECRET in the environment. Box office settings -> API ->
# Webhooks -> the webhook -> signing secret. Same value as the Cloudflare
# variable of that name; if they differ the endpoint answers bad_signature.
#
#   export TT_WEBHOOK_SECRET='...'      (leading space keeps it out of history)
#
# THIS WRITES TO PRODUCTION. The contact is upserted in the live Brevo buyers
# list, and if the payload opted in to WhatsApp and WA_DRY_RUN is false, a real
# message goes to a real phone. Set WA_DRY_RUN=true in Cloudflare first if that
# is not what you want.
#
set -euo pipefail

URL="https://diwali.artindia.be/api/tt-order"
FILE=""; DRY=0; YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry)     DRY=1 ;;
    -y|--yes)  YES=1 ;;
    --url)     shift; URL="${1:-}" ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        echo "unknown option: $1" >&2; exit 2 ;;
    *)         FILE="$1" ;;
  esac
  shift
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
YEL=$'\033[33m'; OFF=$'\033[0m'
die() { printf "${RED}✗ %s${OFF}\n" "$*" >&2; exit 1; }

[ -n "$FILE" ] || die "No payload file. Try: scripts/replay.sh scripts/payload-or_83267317.json"
[ -f "$FILE" ] || die "No such file: $FILE"
command -v python3 >/dev/null || die "python3 is needed to compute the HMAC."
python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$FILE" \
  || die "$FILE is not valid JSON."

if [ -z "${TT_WEBHOOK_SECRET:-}" ]; then
  die "TT_WEBHOOK_SECRET is not set.
    Ticket Tailor -> Box office settings -> API -> Webhooks tab -> the webhook
    pointing at /api/tt-order -> its signing secret. Then:
        export TT_WEBHOOK_SECRET='...'
    (the leading space keeps it out of your shell history)"
fi

# What is about to be sent, before it is sent.
read -r ORDER BUYER PHONE OPTIN <<<"$(python3 - "$FILE" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
o = p.get('payload', p)
b = o.get('buyer_details', {}) or {}
qs = b.get('custom_questions') or []
wa = next((q.get('answer') for q in qs
           if 'lucky draw' in str(q.get('question','')).lower()
           or 'whatsapp' in str(q.get('question','')).lower()), '-')
print(o.get('id','?'), b.get('email','?'), b.get('phone','?'), wa)
PY
)"

printf "\n${BOLD}Replaying %s${OFF}\n" "$ORDER"
printf "  ${DIM}payload${OFF}   %s\n  ${DIM}to${OFF}        %s\n" "$FILE" "$URL"
printf "  ${DIM}buyer${OFF}     %s\n  ${DIM}phone${OFF}     %s\n  ${DIM}WhatsApp${OFF}  %s\n" \
  "$BUYER" "$PHONE" "$OPTIN"

# Ticket Tailor signs timestamp + raw body with HMAC-SHA256, hex, and sends it
# as  TicketTailor-Webhook-Signature: t=<unix>,v1=<hex>.  The body has to be
# signed byte for byte as it goes out, so the file is read in binary here and
# posted with --data-binary, which sends it unaltered. The secret is read from
# the environment inside python rather than passed as an argument, so it never
# appears in the process list.
TS="$(date +%s)"
SIG="$(python3 - "$TS" "$FILE" <<'PY'
import hashlib, hmac, os, sys
ts, path = sys.argv[1], sys.argv[2]
with open(path, 'rb') as f:
    body = f.read()
key = os.environ['TT_WEBHOOK_SECRET'].encode()
print(hmac.new(key, ts.encode() + body, hashlib.sha256).hexdigest())
PY
)"
HEADER="t=${TS},v1=${SIG}"
printf "  ${DIM}signature${OFF} %s\n" "$HEADER"

if [ "$DRY" = 1 ]; then
  printf "\n${YEL}Dry run — nothing sent.${OFF}\n\n"
  exit 0
fi

case "$URL" in
  https://diwali.artindia.be/*)
    if [ "$YES" != 1 ]; then
      printf "\n${YEL}This writes to the live Brevo list and may send a real WhatsApp.${OFF}\n"
      printf "  Continue? ${DIM}[y/N]${OFF} "
      read -r YN < /dev/tty || YN=""
      case "$YN" in [yY]*) ;; *) printf "${DIM}stopped${OFF}\n\n"; exit 0 ;; esac
    fi ;;
esac

# A signature older than five minutes is refused, so the clock starts here.
BODY_FILE="$(mktemp)"; trap 'rm -f "$BODY_FILE"' EXIT
CODE="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' --max-time 30 \
  -X POST "$URL" \
  -H 'content-type: application/json' \
  -H "TicketTailor-Webhook-Signature: ${HEADER}" \
  --data-binary @"$FILE")"

printf "\n${BOLD}HTTP %s${OFF}\n" "$CODE"
python3 -m json.tool < "$BODY_FILE" 2>/dev/null || cat "$BODY_FILE"
echo

case "$CODE" in
  200) printf "${GRN}✓ accepted${OFF} — read whatsapp.sent and whatsapp.reason above.\n\n" ;;
  401) printf "${RED}✗ rejected${OFF} — TT_WEBHOOK_SECRET does not match the Cloudflare one,\n  or your clock is more than five minutes out.\n\n" ;;
  *)   printf "${YEL}! unexpected status${OFF}\n\n" ;;
esac

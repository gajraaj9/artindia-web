#!/usr/bin/env bash
#
# Art India — deploy
#
#   ./deploy.sh                    build, commit and push
#   ./deploy.sh ~/Downloads/x.zip  apply a zip first, then the above
#   ./deploy.sh --latest           apply the newest artindia zip in ~/Downloads
#   ./deploy.sh --holding          also push the Diwali holding page
#   ./deploy.sh --dry              build and show changes, change nothing
#
# Any combination works, e.g.  ./deploy.sh --latest --holding
#
set -euo pipefail

# The script copies a new version of itself over itself at step 1. Bash reads a
# script incrementally from disk, so without this wrapper it would carry on
# reading the *new* file from the old byte offset and land mid-word. Wrapping
# everything in a function forces bash to parse the whole file up front.
main() {


BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
YEL=$'\033[33m'; BLU=$'\033[36m'; OFF=$'\033[0m'

say()  { printf "%s\n" "$*"; }
step() { printf "\n${BOLD}${BLU}%s${OFF}\n" "$*"; }
ok()   { printf "${GRN}  ✓${OFF} %s\n" "$*"; }
warn() { printf "${YEL}  !${OFF} %s\n" "$*"; }
die()  { printf "\n${RED}  ✗ %s${OFF}\n\n" "$*" >&2; exit 1; }

ZIP=""; HOLDING=0; DRY=0; USE_LATEST=0
for arg in "$@"; do
  case "$arg" in
    --holding) HOLDING=1 ;;
    --dry)     DRY=1 ;;
    --latest)  USE_LATEST=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         ZIP="$arg" ;;
  esac
done

cd "$(dirname "$0")"
[ -f build.mjs ]        || die "build.mjs not found — run this from the artindia folder."
[ -d .git ]             || die "This folder is not a git repository."
command -v node >/dev/null || die "Node is not installed."
command -v npm  >/dev/null || die "npm is not installed."

# generated output must never be committed
for p in "dist/" "dist-diwali/" ".cache/" "node_modules/" ".wrangler/" ".DS_Store" "package-lock.json"; do
  grep -qxF "$p" .gitignore 2>/dev/null || echo "$p" >> .gitignore
done
git ls-files --error-unmatch dist >/dev/null 2>&1 && git rm -rq --cached dist || true

# ---------------------------------------------------------------- 1. new files
if [ "$USE_LATEST" = 1 ] && [ -z "$ZIP" ]; then
  ZIP=$(ls -t "$HOME"/Downloads/artindia*.zip 2>/dev/null | head -1 || true)
  [ -n "$ZIP" ] || die "No artindia*.zip found in ~/Downloads."
  say "${DIM}Newest zip: $(basename "$ZIP")${OFF}"
fi

if [ -n "$ZIP" ]; then
  step "1 · Applying $(basename "$ZIP")"
  [ -f "$ZIP" ] || die "File not found: $ZIP"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  unzip -oq "$ZIP" -d "$TMP"
  SRC="$TMP/artindia-web"
  [ -d "$SRC" ] || SRC=$(find "$TMP" -maxdepth 2 -name build.mjs -exec dirname {} \; | head -1)
  [ -n "$SRC" ] && [ -d "$SRC" ] || die "Couldn't find the site files inside that zip."
  cp -R "$SRC"/. .
  ok "files copied"
else
  step "1 · Using the files already in this folder"
fi

# ---------------------------------------------------------------- 2. build
step "2 · Building"
if [ -f package.json ] && [ ! -d node_modules ]; then
  say "  installing build dependencies (first run only)…"
  npm install --silent
fi
rm -rf dist
if ! OUTPUT=$(node build.mjs 2>&1); then
  say "$OUTPUT"
  die "Build failed. Nothing has been pushed — fix the problem above and run again."
fi
say "$OUTPUT" | sed 's/^/  /'
PAGES=$(printf "%s" "$OUTPUT" | grep -oE 'Built [0-9]+' | grep -oE '[0-9]+' || echo "?")
ok "$PAGES pages built"

# ---------------------------------------------------------------- 3. changes
step "3 · Changes"
if [ -z "$(git status --porcelain)" ]; then
  ok "nothing changed — the live site already matches these files"
  CHANGED=0
else
  git status --short | sed 's/^/  /'
  CHANGED=1
fi

if [ "$DRY" = 1 ]; then
  step "Dry run — stopping here. Nothing committed, nothing pushed."
  printf "${DIM}  Preview it with:  cd dist && python3 -m http.server 8000${OFF}\n\n"
  exit 0
fi

# ---------------------------------------------------------------- 4. push
if [ "$CHANGED" = 1 ]; then
  step "4 · Commit and push"
  printf "  Message ${DIM}[Update site]${OFF}: "
  read -r MSG < /dev/tty || MSG=""
  [ -n "$MSG" ] || MSG="Update site"

  printf "  Push to GitHub? ${DIM}[Y/n]${OFF} "
  read -r YN < /dev/tty || YN=""
  case "$YN" in
    [nN]*) warn "stopped — changes are staged locally but not pushed"; exit 0 ;;
  esac

  git add -A
  git commit -q -m "$MSG"
  git push -q
  ok "pushed — Cloudflare will rebuild artindia.be in about a minute"
else
  step "4 · Nothing to push"
fi

# ---------------------------------------------------------------- 5. holding page
if [ "$HOLDING" = 1 ]; then
  step "5 · Deploying diwali.artindia.be"
  if [ -f build-diwali.mjs ]; then
    node build-diwali.mjs | sed 's/^/  /'
    npx wrangler pages deploy dist-diwali --project-name=diwali-2026 --commit-dirty=true
  else
    npx wrangler pages deploy diwali-holding --project-name=diwali-2026 --commit-dirty=true
  fi
  ok "diwali.artindia.be updated"
fi

# ---------------------------------------------------------------- 6. verify
step "Checking the live site"
sleep 4
for url in "https://artindia.be" "https://diwali.artindia.be"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "$url" || echo "000")
  if [ "$CODE" = "200" ]; then ok "$url  →  $CODE"
  else warn "$url  →  $CODE  (Cloudflare may still be building)"; fi
done

TITLE=$(curl -s --max-time 12 https://artindia.be | sed -n 's/.*<title>\(.*\)<\/title>.*/\1/p' | head -1 || true)
[ -n "$TITLE" ] && say "${DIM}  live title: $TITLE${OFF}"

printf "\n${GRN}${BOLD}Done.${OFF}\n\n"
}

main "$@"

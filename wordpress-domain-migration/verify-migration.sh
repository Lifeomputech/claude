#!/usr/bin/env bash
#
# verify-migration.sh — read-only audit of a WordPress domain move.
#
# Answers three questions without changing anything:
#   1. Which asset URLs on the NEW site still point at the OLD domain?
#   2. Is the OLD site still live, and does it redirect yet?
#   3. Do both hostnames serve valid TLS?
#
# Makes GET/HEAD requests only. Safe to run before and after the fix.
#
# Usage:
#   ./verify-migration.sh                      # uses the defaults below
#   ./verify-migration.sh --old OLD --new NEW
#   ./verify-migration.sh --paths /,/shop/,/about/
#
# Exit codes: 0 = no stale URLs found, 1 = stale URLs found, 2 = could not check.

set -uo pipefail

OLD_DOMAIN="digitalsoftwarevault.com"
NEW_DOMAIN="bokashibransa.co.za"
PATHS="/"
TIMEOUT=45
VERBOSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --old)     OLD_DOMAIN="$2"; shift 2 ;;
    --new)     NEW_DOMAIN="$2"; shift 2 ;;
    --paths)   PATHS="$2";      shift 2 ;;
    --timeout) TIMEOUT="$2";    shift 2 ;;
    --verbose|-v) VERBOSE=1;    shift ;;
    --local)   LOCAL_FILE="$2"; shift 2 ;;   # audit a saved HTML file instead of fetching
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ANSI only when attached to a terminal.
if [ -t 1 ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; Z=$'\033[0m'
else
  R=""; G=""; Y=""; B=""; Z=""
fi

STALE_TOTAL=0
CHECKED_ANY=0

hr() { printf '%s\n' "------------------------------------------------------------"; }

# Escape a hostname for use in a basic/extended regex.
esc() { printf '%s' "$1" | sed 's/[.[\*^$()+?{}|\\]/\\&/g'; }

OLD_RE="$(esc "$OLD_DOMAIN")"

# Classify a URL into an asset kind by its extension, ignoring any query string.
classify() {
  case "$(printf '%s' "${1%%\?*}" | tr 'A-Z' 'a-z')" in
    *.css)                                  echo "stylesheet" ;;
    *.js|*.mjs)                             echo "script" ;;
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.avif|*.svg|*.ico|*.bmp) echo "image" ;;
    *.woff|*.woff2|*.ttf|*.otf|*.eot)       echo "font" ;;
    *.mp4|*.webm|*.mov|*.mp3|*.m4a)         echo "media" ;;
    *.pdf|*.zip|*.csv|*.xml|*.json)         echo "file" ;;
    *)                                      echo "link/other" ;;
  esac
}

# Pull every absolute or protocol-relative URL out of stdin, one per line.
# Also un-escapes JSON-style backslash slashes so page-builder payloads match.
extract_urls() {
  sed 's/\\\//\//g' \
    | grep -oE '(https?:)?//[A-Za-z0-9._-]+[^"'"'"' <>)]*' \
    | sed 's/[),;]*$//'
}

audit_html() {
  local label="$1" file="$2"
  local headfile="$TMP/head.html" line

  # Split off <head> portably: find the line number in a lowercased copy.
  line="$(tr 'A-Z' 'a-z' < "$file" | grep -n '</head>' | head -n1 | cut -d: -f1)"
  if [ -n "$line" ]; then
    head -n "$line" "$file" > "$headfile"
  else
    cp "$file" "$headfile"
    printf '%s  note: no </head> found; treating whole document as head%s\n' "$Y" "$Z"
  fi

  local head_hits body_hits
  head_hits="$(extract_urls < "$headfile" | grep -E "$OLD_RE" | sort -u)"
  body_hits="$(extract_urls < "$file"     | grep -E "$OLD_RE" | sort -u)"

  if [ -z "$body_hits" ]; then
    printf '%s  CLEAN%s  no reference to %s anywhere in %s\n' "$G" "$Z" "$OLD_DOMAIN" "$label"
    return 0
  fi

  # Raw occurrence count, including repeats.
  local raw
  raw="$(grep -o -E "$OLD_RE" "$file" | wc -l | tr -d ' ')"

  local n_head n_all
  n_head="$(printf '%s\n' "$head_hits" | grep -c . || true)"
  n_all="$(printf '%s\n' "$body_hits"  | grep -c . || true)"

  printf '%s  STALE%s  %s unique stale URL(s), %s in <head>; %s raw occurrence(s)\n' \
    "$R" "$Z" "$n_all" "$n_head" "$raw"
  STALE_TOTAL=$((STALE_TOTAL + n_all))

  # In-head URLs are the ones that break rendering, so show those first.
  if [ -n "$head_hits" ]; then
    printf '\n  %sIn <head> — these are what break the styling:%s\n' "$B" "$Z"
    printf '%s\n' "$head_hits" | while IFS= read -r u; do
      [ -n "$u" ] || continue
      printf '    [%-10s] %s\n' "$(classify "$u")" "$u"
    done
  fi

  # Anything outside the head: images in content, hardcoded anchors.
  local rest
  rest="$(comm -13 <(printf '%s\n' "$head_hits" | sort) <(printf '%s\n' "$body_hits" | sort) 2>/dev/null)"
  if [ -n "$rest" ]; then
    printf '\n  %sIn <body>:%s\n' "$B" "$Z"
    printf '%s\n' "$rest" | while IFS= read -r u; do
      [ -n "$u" ] || continue
      printf '    [%-10s] %s\n' "$(classify "$u")" "$u"
    done
  fi

  # A stale <link rel=canonical> or og:url signals siteurl/home are still wrong.
  if grep -iE '<link[^>]+canonical' "$file" | grep -qE "$OLD_RE"; then
    printf '\n  %s!%s canonical URL still points at the old domain — wp_options.siteurl/home not updated\n' "$Y" "$Z"
  fi
  if grep -iE 'og:url|og:image' "$file" | grep -qE "$OLD_RE"; then
    printf '  %s!%s Open Graph tags still reference the old domain — social shares will link there\n' "$Y" "$Z"
  fi
  return 1
}

printf '%s== WordPress migration verification ==%s\n' "$B" "$Z"
printf 'old domain: %s\nnew domain: %s\ndate:       %s\n' \
  "$OLD_DOMAIN" "$NEW_DOMAIN" "$(date -u '+%Y-%m-%d %H:%M UTC')"

# ---------------------------------------------------------------- local mode
if [ -n "${LOCAL_FILE:-}" ]; then
  hr; printf '%sSaved file:%s %s\n' "$B" "$Z" "$LOCAL_FILE"
  if [ ! -r "$LOCAL_FILE" ]; then
    printf '%s  cannot read %s%s\n' "$R" "$LOCAL_FILE" "$Z"; exit 2
  fi
  CHECKED_ANY=1
  audit_html "$LOCAL_FILE" "$LOCAL_FILE"
  hr
  if [ "$STALE_TOTAL" -gt 0 ]; then
    printf '%sRESULT: %s stale URL(s). Run Step 2 of README.md.%s\n' "$R" "$STALE_TOTAL" "$Z"; exit 1
  fi
  printf '%sRESULT: clean.%s\n' "$G" "$Z"; exit 0
fi

command -v curl >/dev/null 2>&1 || { printf '%scurl is required%s\n' "$R" "$Z"; exit 2; }

# -------------------------------------------------- 1. new site asset audit
hr
printf '%s1. Stale asset URLs on the new site%s\n' "$B" "$Z"
OLD_IFS="$IFS"; IFS=','
for p in $PATHS; do
  IFS="$OLD_IFS"
  [ -n "$p" ] || continue
  url="https://${NEW_DOMAIN}${p}"
  printf '\n  %s%s%s\n' "$B" "$url" "$Z"
  code="$(curl -sSL --max-time "$TIMEOUT" -o "$TMP/page.html" -w '%{http_code}' "$url" 2>"$TMP/err")"
  rc=$?
  if [ "$rc" -ne 0 ] || [ "${code:-000}" = "000" ]; then
    printf '%s  UNREACHABLE%s  %s\n' "$R" "$Z" "$(head -c 200 "$TMP/err" 2>/dev/null)"
    IFS=','; continue
  fi
  printf '  HTTP %s, %s bytes\n' "$code" "$(wc -c < "$TMP/page.html" | tr -d ' ')"
  CHECKED_ANY=1
  audit_html "$url" "$TMP/page.html"
  IFS=','
done
IFS="$OLD_IFS"

# ----------------------------------------------------- 2. old site status
hr
printf '%s2. Is the old site still live?%s\n' "$B" "$Z"
old_code="$(curl -sS -o "$TMP/old.html" -D "$TMP/old.hdr" --max-time "$TIMEOUT" \
  -w '%{http_code}' "https://${OLD_DOMAIN}/" 2>"$TMP/oerr")"
if [ -z "${old_code:-}" ] || [ "${old_code:-000}" = "000" ]; then
  printf '%s  unreachable%s  %s\n' "$Y" "$Z" "$(head -c 200 "$TMP/oerr" 2>/dev/null)"
else
  loc="$(grep -i '^location:' "$TMP/old.hdr" | tail -n1 | sed 's/^[Ll]ocation: *//' | tr -d '\r')"
  case "$old_code" in
    301|308)
      if printf '%s' "$loc" | grep -qE "$(esc "$NEW_DOMAIN")"; then
        printf '%s  GOOD%s  HTTP %s permanent redirect to %s (Step 8 done)\n' "$G" "$Z" "$old_code" "$loc"
      else
        printf '%s  HTTP %s redirects to %s — not the new domain\n' "$Y" "$old_code" "$loc" "$Z"
      fi ;;
    302|307)
      printf '%s  HTTP %s TEMPORARY redirect to %s — should be 301, SEO authority does not pass%s\n' \
        "$Y" "$old_code" "$loc" "$Z" ;;
    200)
      title="$(tr '\n' ' ' < "$TMP/old.html" | grep -oiE '<title>[^<]*' | head -n1 | sed 's/<[Tt][Ii][Tt][Ll][Ee]>//')"
      printf '%s  STILL LIVE%s  HTTP 200, serving content%s\n' "$Y" "$Z" \
        "${title:+ — title: \"$(printf '%s' "$title" | cut -c1-70)\"}"
      printf '    The new site may be silently borrowing assets from here.\n'
      printf '    Keep it up until the fix is verified, then 301 it (README Step 8).\n' ;;
    404|410)
      printf '  HTTP %s — old site no longer serving. Any still-stale asset is now a hard failure.\n' "$old_code" ;;
    *)
      printf '  HTTP %s\n' "$old_code" ;;
  esac
fi

# --------------------------------------------------------- 3. TLS coverage
hr
printf '%s3. TLS on both hostnames%s\n' "$B" "$Z"
for h in "$NEW_DOMAIN" "www.$NEW_DOMAIN"; do
  v="$(curl -sS -o /dev/null --max-time "$TIMEOUT" \
    -w '%{ssl_verify_result}|%{http_code}' "https://$h/" 2>"$TMP/terr")"
  # http_code 000 means no connection was made at all, in which case
  # ssl_verify_result is a meaningless 0 — do not read it as success.
  if [ -z "$v" ] || [ "${v%%|*}" = "" ] || [ "${v##*|}" = "000" ]; then
    printf '%s  ??  %-30s could not check%s  %s\n' "$Y" "$h" "$Z" \
      "$(head -c 120 "$TMP/terr" 2>/dev/null)"
  elif [ "${v%%|*}" = "0" ]; then
    printf '%s  OK  %s%s  (HTTP %s)\n' "$G" "$h" "$Z" "${v##*|}"
  else
    printf '%s  BAD %s%s  certificate verify result %s — reissue covering both names (README Step 6)\n' \
      "$R" "$h" "$Z" "${v%%|*}"
  fi
done

# ------------------------------------------------------------------ verdict
hr
if [ "$CHECKED_ANY" -eq 0 ]; then
  printf '%sRESULT: could not fetch the new site — nothing verified.%s\n' "$Y" "$Z"
  printf 'Save the page in a browser and re-run with: --local saved.html\n'
  exit 2
fi
if [ "$STALE_TOTAL" -gt 0 ]; then
  printf '%sRESULT: %s stale URL reference(s) still present.%s\n' "$R" "$STALE_TOTAL" "$Z"
  printf 'Diagnosis confirmed. Run Step 2 of README.md (Better Search Replace, all tables,\n'
  printf 'dry run first), then re-run this script — it should come back clean.\n'
  exit 1
fi
printf '%sRESULT: no stale URLs found. Asset URLs are all on the new domain.%s\n' "$G" "$Z"
printf 'Work the remaining checklist in README.md: permalinks, caches, WooCommerce webhooks.\n'
exit 0

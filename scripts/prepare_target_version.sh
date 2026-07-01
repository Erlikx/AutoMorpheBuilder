#!/usr/bin/env bash
#
# scripts/prepare_target_version.sh — gather inputs for the
# download-supported-apk.js step (pin version, morphe-cli jar, manual
# fallback URL).
#
# Replaces the inline `run:` block in the workflow's "Prepare inputs for
# download-supported-apk.js" step. The job previously wrote three
# GITHUB_OUTPUT entries (`pinned`, `jar`, `url`); this script does the
# same.
#
# Environment:
#   APP_ID        required  package id
#   PATCH_REPO    required  patch repo (for slug → mpp lookup)
#   TOOLS_DIR     required  dir containing morphe-cli-*-all.jar
#   CONFIG_FILE   optional  default ./config.json
#   GITHUB_OUTPUT required

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"

APP_ID="${APP_ID:-}"
PATCH_REPO="${PATCH_REPO:-}"
TOOLS_DIR="${TOOLS_DIR:-./tools}"

for var in APP_ID PATCH_REPO; do
  if [ -z "${!var}" ]; then
    log_error "Required env var $var is empty."
    exit 1
  fi
done

pin="$(pinned_version "$APP_ID" 2>/dev/null || true)"
if [ -z "$pin" ] || [ "$pin" = "null" ]; then pin=""; fi

jar="$(ls -1 "$TOOLS_DIR"/morphe-cli-*-all.jar 2>/dev/null | head -n1 || true)"
if [ -z "$jar" ]; then jar=""; fi

url="$(jq -r --arg pkg "$APP_ID" '.download_urls?[$pkg]?["latest_supported"] // empty' "$CONFIG_FILE" 2>/dev/null || true)"
if [ -z "$url" ] || [ "$url" = "null" ]; then url=""; fi

json_set_output pinned "$pin"
json_set_output jar "$jar"
json_set_output url "$url"

log "Prepared target-version inputs for $APP_ID:"
log "  pinned: ${pin:-<none>}"
log "  jar:    ${jar:-<none>}"
log "  url:    ${url:-<none>}"
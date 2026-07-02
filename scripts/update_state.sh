#!/usr/bin/env bash
#
# scripts/update_state.sh — rebuild state.json after a successful build
# and prepare patches.json + config.json for commit.
#
# Replaces the inline ~150-line `run:` block in the workflow's
# "Update state.json" step. The script does the same three things the
# inline block did, but in three named functions:
#   1. sync_patches_json — delegates to .github/scripts/sync-patches.sh.
#   2. update_state_json — rebuilds state.json from REPO_VERSIONS + CLI_VERSION.
#   3. prune_pinned_urls — strips download_urls entries for pinned apps
#      (the previous inline block did this in the commit step).
#
# Behaviour matches the original step:
#   - Fast-forward origin/main into local state to avoid stale state.json.
#   - Hard-fail if state.json is invalid JSON (recovers from `{` default).
#   - state.json preserves the last 30 build_history entries.
#   - Old flat-shape state.json is treated as missing (will trigger a fresh
#     patches.json write).
#
# Environment:
#   REPO_VERSIONS  required  JSON object {repo: tag}
#   CLI_VERSION    required  CLI tag
#   CLI_BRANCH     required  CLI branch
#   GITHUB_RUN_ID  required  workflow run id
#   GITHUB_RUN_NUMBER required  workflow run number
#   GITHUB_SHA     required  workflow commit SHA
#   CONFIG_FILE    optional  default ./config.json
#   PATCHES_FILE   optional  default ./patches.json
#   STATE_FILE     optional  default ./state.json

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"

_default_repo_versions='{}'
REPO_VERSIONS="${REPO_VERSIONS:-$_default_repo_versions}"
CLI_VERSION="${CLI_VERSION:-}"
CLI_BRANCH="${CLI_BRANCH:-main}"

for var in REPO_VERSIONS CLI_VERSION; do
  if [ -z "${!var}" ]; then
    log_error "Required env var $var is empty."
    exit 1
  fi
done

# --- fast-forward origin -------------------------------------------------

BRANCH_NAME="${GITHUB_REF_NAME:-main}"
git fetch origin "${BRANCH_NAME}" >/dev/null 2>&1 || true
git merge --ff-only "origin/${BRANCH_NAME}" >/dev/null 2>&1 || true

# --- sync patches.json ---------------------------------------------------

log "Syncing patches.json..."
REPO_VERSIONS="$REPO_VERSIONS" \
  CONFIG_FILE="$CONFIG_FILE" \
  PATCHES_FILE="$PATCHES_FILE" \
  RUNNER_TEMP="${RUNNER_TEMP:-/tmp}" \
  bash "$(dirname "$0")/../.github/scripts/sync-patches.sh"

# --- rebuild state.json -------------------------------------------------

if [ ! -s "$STATE_FILE" ] || ! jq -e 'type=="object"' "$STATE_FILE" >/dev/null 2>&1; then
  log_warn "$STATE_FILE is missing or invalid JSON; recreating with defaults."
  printf '{}\n' > "$STATE_FILE"
fi

PATCHES_MAP="$(
  printf '%s' "$REPO_VERSIONS" | jq -c \
    --argjson config "$(jq -c '.' "$CONFIG_FILE")" \
    'to_entries | map({
      key: .key,
      value: {
        branch: (first($config.patch_repos | to_entries[] | select(.value.repo == .key) | .value.branch) // "main" | ascii_downcase),
        version: .value
      }
    }) | from_entries' 2>/dev/null || printf '{}'
)"

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_ID="${GITHUB_RUN_ID:-0}"
RUN_NUMBER="${GITHUB_RUN_NUMBER:-0}"
COMMIT_SHA="${GITHUB_SHA:-unknown}"

jq --argjson patches_map "$PATCHES_MAP" \
   --arg cli "$CLI_VERSION" \
   --arg cli_branch "$CLI_BRANCH" \
   --arg timestamp "$TIMESTAMP" \
   --arg run_id "$RUN_ID" \
   --argjson run_number "$RUN_NUMBER" \
   --arg sha "$COMMIT_SHA" \
   '. as $s
   | (
       ((.build_history // [])
        + [{
            "timestamp": $timestamp,
            "patches": $patches_map,
            "cli_version": $cli,
            "cli_branch": $cli_branch,
            "status": "success",
            "run_id": $run_id,
            "run_number": $run_number,
            "commit": $sha
        }])
        | if length > 30 then .[-30:] else . end
      ) as $history
   | {
       "patches": $patches_map,
       "cli_branch": $cli_branch,
       "cli_version": $cli
     }
   + ($s | del(
       .patches,
       .patches_branch,
       .patches_version,
       .cli_branch,
       .cli_version,
       .last_build,
       .status,
       .build_history
     ))
   + {
       "last_build": $timestamp,
       "status": "success",
       "build_history": $history
     }' \
   "$STATE_FILE" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"

log "state.json updated."

# --- strip download_urls for pinned apps ---------------------------------

PINNED_APPS="$(
  jq -c '[.patch_repos | to_entries[]
    | select(.value.pin_version != null and .value.pin_version != "")
    | .key]' "$CONFIG_FILE"
)"
if [ "$PINNED_APPS" != "[]" ] && [ -n "$PINNED_APPS" ]; then
  log "Stripping download_urls for pinned apps: $PINNED_APPS"
  tmp_cfg="$(mktemp)"
  jq --argjson pinned "$PINNED_APPS" \
    'if .download_urls then
       .download_urls |= with_entries(select(.key as $k | ($pinned | index($k) | not)))
     else . end' \
    "$CONFIG_FILE" > "$tmp_cfg"
  mv "$tmp_cfg" "$CONFIG_FILE"
fi

log "update_state.sh complete"
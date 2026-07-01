#!/usr/bin/env bash
#
# scripts/check_versions.sh — resolve the latest Morphe / CLI release
# tags and decide whether a build is needed.
#
# Replaces the ~140-line inline `run:` block in the workflow's
# check-versions job. The behaviour is identical:
#   1. Validate config.json shape.
#   2. For every unique patch_repo+branch, resolve the latest matching
#      tag using resolve-tag.sh.
#   3. Resolve the CLI tag.
#   4. Emit a matrix-include JSON array of build entries.
#   5. Compare to state.json; if any version changed (or the run is a
#      manual dispatch) mark should-build=true, otherwise false.
#
# Outputs (written to $GITHUB_OUTPUT):
#   should-build    "true" | "false"
#   matrix-include  JSON array of {name, appId, patchRepo, patchBranch, patchSlug, patchTag}
#   repo-versions   JSON object { "owner/repo": "tag" }
#   cli-version     CLI release tag
#   cli-branch      CLI branch (echoed back for downstream steps)

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"
. "$(dirname "$0")/lib/github.sh"

require_command gh
require_command jq
require_command curl
validate_required_config

CLI_REPO="$(jq -r '.cli.repo' "$CONFIG_FILE")"
CLI_BRANCH_RAW="$(jq -r '.cli.branch | ascii_downcase' "$CONFIG_FILE")"
if [ "$CLI_BRANCH_RAW" = "main" ] || [ "$CLI_BRANCH_RAW" = "dev" ]; then
  CLI_BRANCH="$CLI_BRANCH_RAW"
else
  log_warn "Invalid cli.branch '$CLI_BRANCH_RAW'. Falling back to 'main'."
  CLI_BRANCH="main"
fi

# Sourced here because it uses GH_TOKEN. resolve-tag.sh is a function
# library, not an executable script.
# shellcheck source=../.github/scripts/resolve-tag.sh
. "$(dirname "$0")/../.github/scripts/resolve-tag.sh"

# --- resolve tags for every patch repo ------------------------------------

REPO_PAIRS="$(list_repo_branches)"
[ -z "$REPO_PAIRS" ] && { log_error "No valid patch_repos entries found in $CONFIG_FILE."; exit 1; }

declare -A REPO_TAGS=()
while IFS='|' read -r repo branch; do
  log "Resolving tag for ${repo} (branch=${branch})..."
  tag="$(resolve_release_tag "$repo" "$branch")"
  log "  ${repo} -> ${tag}"
  REPO_TAGS["$repo"]="$tag"
done <<< "$REPO_PAIRS"

CLI_TAG="$(resolve_release_tag "$CLI_REPO" "$CLI_BRANCH")"
log "CLI (${CLI_REPO}) -> ${CLI_TAG}"

# --- build matrix-include -------------------------------------------------

MATRIX_INCLUDE="$(
  jq -c '
    .patch_repos
    | to_entries
    | map({
        name: .value.name,
        appId: .key,
        patchRepo: .value.repo,
        patchBranch: (.value.branch | ascii_downcase),
        patchSlug: (.value.repo | gsub("/"; "-"))
      })
  ' "$CONFIG_FILE"
)"

# Inject the resolved patchTag per matrix entry. Using jq's --argjson
# ensures the tag map is parsed exactly once.
TAGS_JSON="$(
  for repo in "${!REPO_TAGS[@]}"; do
    printf '{"repo":"%s","tag":"%s"}\n' "$repo" "${REPO_TAGS[$repo]}"
  done | jq -sc 'map({(.repo): .tag}) | add // {}'
)"

MATRIX_WITH_TAGS="$(
  jq -c --argjson tags "$TAGS_JSON" \
    'map(. + {patchTag: ($tags[.patchRepo] // "")})' \
    <<<"$MATRIX_INCLUDE"
)"

if [ "$(jq 'length' <<<"$MATRIX_WITH_TAGS")" = "0" ]; then
  log_warn "No apps configured in patch_repos; skipping build."
  json_set_output should-build false
  json_set_output matrix-include '[]'
  json_set_output repo-versions '{}'
  json_set_output cli-version "$CLI_TAG"
  json_set_output cli-branch "$CLI_BRANCH"
  exit 0
fi

# Build the {owner/repo: tag} map for state comparison + downstream use.
REPO_VERSIONS="$TAGS_JSON"

# --- compare to state.json -----------------------------------------------

PREV_REPO_VERSIONS='{}'
PREV_CLI_VERSION='none'
PREV_CLI_BRANCH_STATE='main'
if [ -s "$STATE_FILE" ] && jq -e 'type=="object"' "$STATE_FILE" >/dev/null 2>&1; then
  PREV_CLI_VERSION="$(jq_get '.cli_version // "none"' "$STATE_FILE")"
  PREV_CLI_BRANCH_STATE="$(jq_get '.cli_branch // "main"' "$STATE_FILE")"
  if jq -e '.patches | type == "object"' "$STATE_FILE" >/dev/null 2>&1; then
    PREV_REPO_VERSIONS="$(jq -c '.patches | map_values(.version)' "$STATE_FILE")"
  else
    log_warn "state.json uses old flat structure; treating patch versions as unknown (will trigger build)."
    PREV_REPO_VERSIONS='{}'
  fi
elif [ -f "$STATE_FILE" ]; then
  log_warn "$STATE_FILE is missing or invalid JSON; using defaults."
fi

VERSION_CHANGED=false
for repo in "${!REPO_TAGS[@]}"; do
  current="${REPO_TAGS[$repo]}"
  prev="$(jq -r --arg r "$repo" '.[$r] // "none"' <<<"$PREV_REPO_VERSIONS")"
  if [ "$current" != "$prev" ]; then
    log "::notice::Patch version changed: ${repo}: ${prev} -> ${current}"
    VERSION_CHANGED=true
  fi
done

if [ "$CLI_TAG" != "$PREV_CLI_VERSION" ] || [ "$CLI_BRANCH" != "$PREV_CLI_BRANCH_STATE" ]; then
  log "::notice::CLI version changed: ${PREV_CLI_BRANCH_STATE}/${PREV_CLI_VERSION} -> ${CLI_BRANCH}/${CLI_TAG}"
  VERSION_CHANGED=true
fi

# --- decide + emit -------------------------------------------------------

if [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ]; then
  log "::notice::Manual run detected; forcing build."
  SHOULD_BUILD=true
elif [ "$VERSION_CHANGED" = "true" ]; then
  SHOULD_BUILD=true
else
  log "::notice::No version/channel changes detected. Skipping build."
  SHOULD_BUILD=false
fi

json_set_output matrix-include "$MATRIX_WITH_TAGS"
json_set_output repo-versions "$REPO_VERSIONS"
json_set_output cli-version "$CLI_TAG"
json_set_output cli-branch "$CLI_BRANCH"
json_set_output should-build "$SHOULD_BUILD"
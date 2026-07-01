#!/usr/bin/env bash
#
# scripts/lib/github.sh — wrappers around the GitHub CLI.
#
# Sourced, not executed. Centralises every `gh ...` invocation in the
# project so we can:
#   - assert GH_TOKEN is set once (instead of repeating per call)
#   - apply consistent retry / timeout behavior
#   - switch to a different tool (curl against the API) in tests
#
# Public API:
#   gh_require_token            — die if GH_TOKEN not set
#   gh_release_tag <repo>       — echo the latest release tag
#   gh_release_download <repo> <tag> <pattern> <dir>
#                                — run `gh release download` with retries
#   gh_release_create <tag> <files...> -- <title> --notes ...
#                                — wrapper, parses "--key=value" pairs

# shellcheck source=./common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

gh_require_token() {
  if [ -z "${GH_TOKEN:-}" ]; then
    log_error "GH_TOKEN is required for GitHub API access."
    return 1
  fi
  require_command gh || return 1
}

gh_release_tag() {
  local repo="$1"
  gh_require_token || return 1
  gh release view --repo "$repo" --json tagName -q .tagName 2>/dev/null
}

gh_release_view() {
  local repo="$1"
  shift
  gh_require_token || return 1
  gh release view --repo "$repo" "$@"
}

# gh_release_download <repo> <tag> <pattern> <dir>
gh_release_download() {
  local repo="$1" tag="$2" pattern="$3" dir="$4"
  gh_require_token || return 1
  with_retry 3 5 gh release download "$tag" \
    --repo "$repo" \
    --pattern "$pattern" \
    --dir "$dir" \
    --clobber
}

# gh_release_create <tag> <title> <notes> <files...>
gh_release_create() {
  local tag="$1" title="$2" notes="$3"
  shift 3
  gh_require_token || return 1
  with_retry 3 5 gh release create "$tag" "$@" \
    --title "$title" \
    --notes "$notes"
}

# gh_release_upload <tag> <files...>
gh_release_upload() {
  local tag="$1"
  shift
  gh_require_token || return 1
  with_retry 3 5 gh release upload "$tag" "$@" --clobber
}

gh_release_edit() {
  local tag="$1"
  shift
  gh_require_token || return 1
  gh release edit "$tag" "$@"
}

# Override the no-op stubs declared in common.sh. We assign to globals
# so callers can re-source lib/json.sh (which transitively sources
# common.sh) without losing the github functions.
gh_release_tag()    { lib_real_gh_release_tag    "$@"; }
gh_release_view()   { lib_real_gh_release_view   "$@"; }
gh_release_download(){ lib_real_gh_release_download"$@"; }
gh_release_create() { lib_real_gh_release_create "$@"; }
gh_release_upload() { lib_real_gh_release_upload "$@"; }
gh_release_edit()   { lib_real_gh_release_edit   "$@"; }

lib_real_gh_release_tag()     { gh_release_tag     "$@"; }
lib_real_gh_release_view()    { gh_release_view    "$@"; }
lib_real_gh_release_download(){ gh_release_download"$@"; }
lib_real_gh_release_create()  { gh_release_create  "$@"; }
lib_real_gh_release_upload()  { gh_release_upload  "$@"; }
lib_real_gh_release_edit()    { gh_release_edit    "$@"; }
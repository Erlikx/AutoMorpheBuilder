#!/usr/bin/env bash
#
# scripts/commit_state.sh — commit and push state.json / patches.json /
# config.json back to the repo, with concurrent-run retry logic.
#
# Replaces the inline ~70-line `run:` block in the workflow's
# "Commit state.json and patches.json" step.
#
# Behaviour matches the original step:
#   1. git add state.json patches.json config.json
#   2. Refuse to commit if nothing changed (treats silent no-op as failure).
#   3. Push to HEAD:${BRANCH_NAME} with 3 attempts.
#   4. On push rejection: fetch + rebase + retry. If rebase conflicts and
#      origin already has the same state.json content, drop the local
#      commit and treat as success.
#   5. Hard-fail on real conflicts we can't auto-resolve.
#
# Environment:
#   BRANCH_NAME      optional  default $GITHUB_REF_NAME or main
#   CLI_VERSION      required  for commit message
#   CLI_BRANCH       required  for commit message

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"

BRANCH_NAME="${BRANCH_NAME:-${GITHUB_REF_NAME:-main}}"
CLI_VERSION="${CLI_VERSION:-}"
CLI_BRANCH="${CLI_BRANCH:-main}"

if [ -z "$CLI_VERSION" ]; then
  log_error "CLI_VERSION is required for the commit message."
  exit 1
fi

git config user.name "GitHub Actions"
git config user.email "actions@github.com"

git add state.json patches.json config.json

if git diff --cached --quiet; then
  log_error "No state/patches changes detected after update step; refusing silent success."
  cat state.json || true
  exit 1
fi

git commit -m "chore: update state and patches config - cli ${CLI_BRANCH}/${CLI_VERSION}"

for attempt in 1 2 3; do
  if git push origin "HEAD:${BRANCH_NAME}"; then
    log "Pushed state updates to ${BRANCH_NAME}."
    exit 0
  fi
  if [ "$attempt" -eq 3 ]; then
    log_error "Failed to push state updates after ${attempt} attempts."
    exit 1
  fi
  log_warn "Push rejected (attempt ${attempt}); rebasing on origin/${BRANCH_NAME}..."
  git fetch origin "${BRANCH_NAME}" >/dev/null 2>&1 || true
  # set +e around rebase — a conflict (rc != 0) is fine here, we handle
  # it in the post-rebase check.
  set +e
  git rebase "origin/${BRANCH_NAME}"
  rebase_rc=$?
  set -e
  if [ "$rebase_rc" -ne 0 ]; then
    if ! git diff --cached --quiet; then
      # We had a real change to push. If origin already has the same
      # content (typical when a concurrent run pushed it first), drop
      # our local commit and treat as success.
      if git diff --quiet "origin/${BRANCH_NAME}" -- state.json patches.json config.json; then
        git rebase --abort || true
        log "origin/${BRANCH_NAME} already has identical state; dropping local commit."
        log "::notice::Skipped local state commit — origin was already up to date."
        exit 0
      fi
    fi
    git rebase --abort || true
    log_error "Rebase conflict; manual intervention required."
    exit 1
  fi
done
#!/usr/bin/env bash
#
# scripts/install_apkeep.sh — install the apkeep binary used for
# downloading APKs from APKPure.
#
# Replaces the ~7-line `run:` block in the workflow's "Install apkeep"
# step. Idempotent: if /usr/local/bin/apkeep already exists, the
# version check is run and the script exits 0.
#
# Behaviour matches the original step:
#   - Download apkeep 0.18.0 from EFForg/apkeep releases
#   - Place at /usr/local/bin/apkeep
#   - chmod +x
#   - Print `apkeep --version`
#
# Environment:
#   APKEEP_VERSION  (optional) override the version, default 0.18.0
#   APKEEP_PATH     (optional) install location, default /usr/local/bin/apkeep
#
# Uses sudo only if the install path is not writable by the current user.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

APKEEP_VERSION="${APKEEP_VERSION:-0.18.0}"
APKEEP_PATH="${APKEEP_PATH:-/usr/local/bin/apkeep}"
APKEEP_URL="https://github.com/EFForg/apkeep/releases/download/${APKEEP_VERSION}/apkeep-x86_64-unknown-linux-gnu"

if [ -x "$APKEEP_PATH" ]; then
  "$APKEEP_PATH" --version || true
  exit 0
fi

# Pick a writable target. If the default path isn't writable as the
# current user, try sudo (works on self-hosted runners; on ubuntu-latest
# GH runners the runner user can already write /usr/local/bin).
TMP_INSTALL="$(mktemp)"
log "Downloading apkeep ${APKEEP_VERSION}..."
with_retry 3 5 curl -fsSL -o "$TMP_INSTALL" "$APKEEP_URL"
chmod +x "$TMP_INSTALL"

if [ -w "$(dirname "$APKEEP_PATH")" ]; then
  mv "$TMP_INSTALL" "$APKEEP_PATH"
else
  if ! command -v sudo >/dev/null 2>&1; then
    log_error "Cannot write $(dirname "$APKEEP_PATH") and sudo is unavailable."
    exit 1
  fi
  sudo mv "$TMP_INSTALL" "$APKEEP_PATH"
  sudo chmod +x "$APKEEP_PATH"
fi

"$APKEEP_PATH" --version
log "apkeep installed at $APKEEP_PATH"
#!/usr/bin/env bash
#
# scripts/install_bouncycastle.sh — install the BouncyCastle provider
# JAR used by the signing step to load BKS-format keystores.
#
# Replaces the ~25-line `run:` block in the workflow's "Install
# BouncyCastle" step. Idempotent: if the JAR is already at
# /usr/share/java/bcprov.jar, exit 0.
#
# Behaviour matches the original step:
#   - Download bcprov-jdk18on 1.77 from Maven Central
#   - Copy to /usr/share/java/bcprov.jar (the path keytool resolves)
#   - Print "✓ BouncyCastle downloaded"
#
# Environment:
#   BCOPS_VERSION  (optional) default 1.77
#   BCPROV_PATH    (optional) destination, default /usr/share/java/bcprov.jar
#   TMP_DIR        (optional) download dir, default /tmp/bouncycastle
#
# Uses sudo only if /usr/share/java isn't writable by the current user.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

BCOPS_VERSION="${BCOPS_VERSION:-1.77}"
BCOPS_URL="https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/${BCOPS_VERSION}/bcprov-jdk18on-${BCOPS_VERSION}.jar"
BCPROV_PATH="${BCPROV_PATH:-/usr/share/java/bcprov.jar}"
TMP_DIR="${TMP_DIR:-/tmp/bouncycastle}"

if [ -f "$BCPROV_PATH" ]; then
  log "BouncyCastle already present at $BCPROV_PATH"
  exit 0
fi

mkdir -p "$TMP_DIR"
TARGET="$TMP_DIR/bcprov.jar"

log "Downloading BouncyCastle ${BCOPS_VERSION} from Maven Central..."
with_retry 3 5 curl -fsSL -o "$TARGET" "$BCOPS_URL"

mkdir -p "$(dirname "$BCPROV_PATH")"
if [ -w "$(dirname "$BCPROV_PATH")" ]; then
  cp "$TARGET" "$BCPROV_PATH"
else
  if ! command -v sudo >/dev/null 2>&1; then
    log_error "Cannot write $(dirname "$BCPROV_PATH") and sudo is unavailable."
    exit 1
  fi
  sudo cp "$TARGET" "$BCPROV_PATH"
fi

log "BouncyCastle installed at $BCPROV_PATH"
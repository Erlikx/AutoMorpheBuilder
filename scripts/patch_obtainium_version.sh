#!/usr/bin/env bash
#
# scripts/patch_obtainium_version.sh — rewrite versionCode/versionName in
# a patched APK's binary AndroidManifest.xml so Obtainium detects the new
# release.
#
# Replaces the inline ~150-line `run:` block in the workflow's "Patch APK
# version for Obtainium" step. The actual binary AXML manipulation is
# delegated to patch-apk-manifest.js (an existing, focused tool). This
# script handles the versionCode math + the post-patch zipalign + apksigner
# re-sign.
#
# Behaviour matches the original step:
#   1. Verify zip CLI is on PATH (needed by patch-apk-manifest.js).
#   2. Read current versionCode via aapt.
#   3. Compute INCREMENT = (strip-v + only-digits from PATCH_TAG) % 10000 + 1.
#   4. NEW_VC = current + INCREMENT, clamped to MAX_VERSION_CODE (2^31-1).
#   5. NEW_VERSION_NAME = "<APK_VERSION>+<PATCH_TAG>".
#   6. Run patch-apk-manifest.js with --version-code + --version-name.
#   7. Verify both attributes landed correctly via aapt.
#   8. zipalign -f 4 → /tmp/aligned_*.apk
#   9. apksigner sign --ks <PKCS12> --ks-key-alias ... --ks-pass / --key-pass ...
#  10. mv aligned APK back into place.
#
# Signed builds remain enforced — apksigner is required and signing
# failures cause the step to fail.
#
# Environment:
#   APK            required  absolute path to the patched APK
#   APK_VERSION    required  base APK version
#   PATCH_TAG      required  morphe patch tag (e.g. v1.32.0)
#   KEYSTORE_FILE  required  PKCS12 keystore for apksigner
#   KEY_ALIAS      required  key alias
#   KEYSTORE_PASSWORD required  keystore password
#   KEY_PASSWORD   optional  key password (defaults to KEYSTORE_PASSWORD)
#   RUNNER_TEMP    optional  default /tmp

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/apk.sh"

APK="${APK:-}"
APK_VERSION="${APK_VERSION:-}"
PATCH_TAG="${PATCH_TAG:-}"
KEYSTORE_FILE="${KEYSTORE_FILE:-}"
KEY_ALIAS="${KEY_ALIAS:-}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-}"
KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"
RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"

for var in APK APK_VERSION PATCH_TAG KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD; do
  if [ -z "${!var}" ]; then
    log_error "Required env var $var is empty."
    exit 1
  fi
done

require_command aapt
require_command zipalign
require_command apksigner
require_zip

if [ ! -f "$APK" ]; then
  log_error "APK not found at $APK"
  exit 1
fi

NEW_VERSION_NAME="${APK_VERSION}+${PATCH_TAG}"
log "Patching APK version for Obtainium compatibility"
log "  APK: $APK"
log "  versionName: $APK_VERSION -> $NEW_VERSION_NAME"

# --- compute deterministic versionCode bump -------------------------------

CURRENT_VC="$(read_apk_version_code "$APK")"
if [ -z "$CURRENT_VC" ]; then
  log_error "Could not read versionCode from APK"
  aapt dump badging "$APK" 2>&1 | grep -E '^package: ' || true
  exit 1
fi

# Strip leading 'v' from the patch tag, keep only digits, mod+1.
INCREMENT="$(printf '%s' "$PATCH_TAG" | sed -E 's/^v//; s/[^0-9]+//g')"
INCREMENT="$((INCREMENT % 10000 + 1))"

MAX_VERSION_CODE=2147483647
if [ "$CURRENT_VC" -ge "$MAX_VERSION_CODE" ]; then
  NEW_VC="$MAX_VERSION_CODE"
  log_warn "Current versionCode already at signed 32-bit max; patching versionName only."
elif [ $((CURRENT_VC + INCREMENT)) -gt "$MAX_VERSION_CODE" ]; then
  NEW_VC="$MAX_VERSION_CODE"
  log_warn "versionCode bump would overflow; clamping to $MAX_VERSION_CODE."
else
  NEW_VC=$((CURRENT_VC + INCREMENT))
fi
log "  versionCode: $CURRENT_VC -> $NEW_VC"

# --- patch the binary AXML ------------------------------------------------

MODIFIED_APK="$RUNNER_TEMP/modified_$$.apk"
ALIGNED_APK="$RUNNER_TEMP/aligned_$$.apk"

node "$(dirname "$0")/../.github/scripts/patch-apk-manifest.js" \
  "$APK" "$MODIFIED_APK" \
  --version-code "$NEW_VC" \
  --version-name "$NEW_VERSION_NAME"

# Verify both attributes landed. `|| VERIFIED=""` keeps the diagnostic
# below useful even when aapt can re-parse the patched AXML but the
# regex doesn't match — that's still a patch failure, not a crash.
VERIFIED="$(aapt dump badging "$MODIFIED_APK" 2>/dev/null \
  | sed -nE "s/.*versionCode='([0-9]+)' versionName='([^']+)'.*/\1 \2/p" | head -1)" \
  || VERIFIED=""
if [ -z "$VERIFIED" ]; then
  log_error "aapt dump badging failed for $MODIFIED_APK"
  aapt dump badging "$MODIFIED_APK" 2>&1 | head -40 || true
  exit 1
fi
if [ "$VERIFIED" != "$NEW_VC $NEW_VERSION_NAME" ]; then
  log_error "patch-apk-manifest.js did not produce expected versionCode/versionName"
  log_error "  expected: $NEW_VC $NEW_VERSION_NAME"
  log_error "  got:      $VERIFIED"
  exit 1
fi
log "  verified: $VERIFIED"

# --- zipalign + re-sign ---------------------------------------------------

log "Zipaligning..."
zipalign -f 4 "$MODIFIED_APK" "$ALIGNED_APK"

log "Re-signing APK..."
KEY_PASS_IN="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"
apksigner sign \
  --ks "$KEYSTORE_FILE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KEYSTORE_PASSWORD" \
  --key-pass "pass:$KEY_PASS_IN" \
  "$ALIGNED_APK"

mv "$ALIGNED_APK" "$APK"
rm -rf "$MODIFIED_APK"
log "APK version patched and re-signed successfully"
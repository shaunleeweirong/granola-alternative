#!/usr/bin/env bash
# Sends one artefact to Apple's notary service, waits for the verdict, and
# staples the ticket to it.
#
# Stapling is the part people skip. Without it macOS asks Apple's servers
# whether the app is notarised the first time it runs, so the app fails to open
# on a Mac that happens to be offline, or behind a firewall, or on a plane.
# The ticket is small; attach it and the check is local forever after.
#
# A rejection prints the notary log. That log is the only thing that says WHICH
# binary was wrong, and without it a rejection is an unactionable "Invalid".
#
#   notarize.sh <artifact> <label> [thing-to-staple]
#
# Apple wants an archive, but a ticket cannot be stapled to a .zip. So when the
# thing submitted is an archive of a bundle, pass the bundle as the third
# argument and the ticket lands on that instead.
#
# Expects in the environment, none of which are echoed:
#   APPLE_API_KEY_PATH    the .p8 private key file
#   APPLE_API_KEY_ID      the key ID
#   APPLE_API_ISSUER_ID   the issuer ID for the App Store Connect team

set -euo pipefail

artifact="$1"
label="$2"
staple_target="${3:-$1}"

test -e "$artifact" || { echo "::error::$label not found at $artifact"; exit 1; }
test -e "$staple_target" || { echo "::error::nothing to staple at $staple_target"; exit 1; }
for required in APPLE_API_KEY_PATH APPLE_API_KEY_ID APPLE_API_ISSUER_ID; do
  if [ -z "${!required:-}" ]; then
    echo "::error::$required is not set, so $label cannot be notarised"
    exit 1
  fi
done
test -s "$APPLE_API_KEY_PATH" || {
  echo "::error::the API key file is empty; check APPLE_API_KEY_P8 is valid base64"
  exit 1
}

credentials=(
  --key "$APPLE_API_KEY_PATH"
  --key-id "$APPLE_API_KEY_ID"
  --issuer "$APPLE_API_ISSUER_ID"
)

echo "Submitting $label to Apple. This usually takes a few minutes."

response=$(mktemp)
set +e
xcrun notarytool submit "$artifact" "${credentials[@]}" \
  --wait --timeout 45m --output-format json >"$response"
submit_rc=$?
set -e

# A malformed or empty response means the submission itself failed, usually
# because the credentials are wrong. Say so rather than printing a parse error.
read -r id status < <(
  python3 - "$response" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as handle:
        result = json.load(handle)
except Exception:
    result = {}
print(result.get("id", "-"), result.get("status", "-"))
PY
)

if [ "$id" = "-" ]; then
  echo "::error::Apple did not accept the submission of $label (exit $submit_rc)"
  echo "Check APPLE_API_KEY_ID and APPLE_API_ISSUER_ID, and that the key has the Developer role."
  cat "$response"
  exit 1
fi

echo "Submission $id finished with status: $status"

if [ "$status" != "Accepted" ]; then
  echo "::error::$label was rejected by the notary service (status: $status)"
  echo "--- notary log ---"
  xcrun notarytool log "$id" "${credentials[@]}" || echo "(the log could not be fetched)"
  exit 1
fi

xcrun stapler staple "$staple_target"
xcrun stapler validate "$staple_target"

echo "$label is notarised and stapled."

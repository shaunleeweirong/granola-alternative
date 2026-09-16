#!/usr/bin/env bash
# Proves a bundled binary can launch on a machine that has never seen this
# build tree.
#
# The naive version of this check copied the binary to a temp directory and ran
# it. That proves nothing: the build tree is still on the runner, so a library
# referenced by absolute path, or by @rpath pointing into that tree, resolves
# happily here and fails on a user's Mac. A signed, present, unlaunchable binary
# shipped twice before this script existed.
#
#   assert-standalone.sh <binary> <label> [directory-to-hide]

set -euo pipefail

binary="$1"
label="$2"
hide="${3:-}"

test -x "$binary" || { echo "::error::$label is missing or not executable: $binary"; exit 1; }

# 1. Static check. Every library it loads must be part of macOS, or travel
#    inside the app bundle. Anything else is a dependency on this machine.
strays=$(otool -L "$binary" | tail -n +2 | awk '{print $1}' |
  grep -vE '^(/usr/lib/|/System/Library/|@executable_path/|@loader_path/)' || true)
if [ -n "$strays" ]; then
  echo "::error::$label depends on libraries that are not part of macOS:"
  echo "$strays"
  otool -L "$binary"
  exit 1
fi

# 2. Any rpath pointing at this checkout resolves here and nowhere else.
rpaths=$(otool -l "$binary" | awk '/LC_RPATH/{f=1} f&&/path /{print $2; f=0}' || true)
for rpath in $rpaths; do
  case "$rpath" in
    @executable_path*|@loader_path*) ;;
    *) echo "::error::$label has an rpath outside the bundle: $rpath"; exit 1 ;;
  esac
done

# 3. The real test: run it with the build tree gone.
probe=$(mktemp -d)
cp "$binary" "$probe/"

restore=""
put_it_back() {
  if [ -n "$restore" ] && [ -e "$restore" ]; then
    mv "$restore" "$hide"
    restore=""
  fi
}
# Even on a failure path: leaving the build tree moved would break the cache
# save and every later step, turning one clear error into several confusing ones.
trap put_it_back EXIT

if [ -n "$hide" ] && [ -e "$hide" ]; then
  restore="$(mktemp -d)/hidden"
  mv "$hide" "$restore"
fi

set +e
"$probe/$(basename "$binary")" --help >"$probe/out.txt" 2>&1
rc=$?
set -e

put_it_back

if grep -qiE "library not loaded|image not found|dyld|symbol not found" "$probe/out.txt"; then
  echo "::error::$label cannot launch without its build tree"
  cat "$probe/out.txt"
  otool -L "$binary"
  exit 1
fi
if [ $rc -ne 0 ] && [ ! -s "$probe/out.txt" ]; then
  echo "::error::$label exited $rc and printed nothing"
  exit 1
fi

echo "$label runs standalone."

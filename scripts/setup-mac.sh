#!/usr/bin/env bash
#
# One-command setup for macOS.
#
# Installs and builds everything the app needs to transcribe a meeting:
# the Swift system-audio helper, the whisper.cpp speech engine, and a model.
# Safe to run more than once; anything already done is skipped.
#
# Usage:  npm run setup:mac

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/resources/bin"
CACHE_DIR="$ROOT/.cache"
MODEL_DIR="$HOME/Library/Application Support/granola-alternative/models"
MODEL_NAME="ggml-large-v3-turbo-q8_0.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME"
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp.git"

step=0
say()  { printf '\n\033[1m[%s] %s\033[0m\n' "$1" "$2"; }
note() { printf '      %s\n' "$1"; }
ok()   { printf '      \033[32m✓ %s\033[0m\n' "$1"; }
warn() { printf '      \033[33m! %s\033[0m\n' "$1"; }
die()  { printf '\n\033[31mStopped: %s\033[0m\n\n%s\n\n' "$1" "${2:-}" >&2; exit 1; }

next() { step=$((step + 1)); say "$step/6" "$1"; }

trap 'printf "\n\033[31mSomething failed at step %s.\033[0m\nCopy everything above and send it over; it will say exactly what went wrong.\n\n" "$step" >&2' ERR

# ---------------------------------------------------------------- 1. checks

next "Checking your Mac"

[ "$(uname -s)" = "Darwin" ] || die "this is not a Mac" \
  "The app records system audio using a macOS feature, so it needs a Mac running macOS 14.2 or later."

MACOS_VERSION="$(sw_vers -productVersion)"
MAJOR="${MACOS_VERSION%%.*}"
MINOR="$(printf '%s' "$MACOS_VERSION" | cut -d. -f2)"
MINOR="${MINOR:-0}"
if [ "$MAJOR" -lt 14 ] || { [ "$MAJOR" -eq 14 ] && [ "$MINOR" -lt 2 ]; }; then
  die "macOS $MACOS_VERSION is too old" \
    "Recording system audio needs macOS 14.2 (Sonoma) or later.
Update via  Apple menu > System Settings > General > Software Update."
fi
ok "macOS $MACOS_VERSION"

if ! xcode-select -p >/dev/null 2>&1; then
  die "Apple's developer tools are not installed" \
    "Run this, click Install in the popup, wait for it to finish, then run this setup again:

  xcode-select --install"
fi
ok "Apple developer tools"

command -v node >/dev/null 2>&1 || die "Node.js is not installed" \
  "Install Homebrew from https://brew.sh then run:  brew install node"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js $(node -v) is too old" "Run:  brew install node"
ok "Node $(node -v)"

if ! command -v cmake >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    note "cmake is needed to build the speech engine. Installing it now..."
    brew install cmake
  else
    die "cmake is not installed" \
      "cmake builds the speech engine. Install Homebrew from https://brew.sh then run:

  brew install cmake"
  fi
fi
ok "cmake $(cmake --version | head -1 | awk '{print $3}')"

# ------------------------------------------------------- 2. app dependencies

next "Installing the app's dependencies"
if [ -d "$ROOT/node_modules/better-sqlite3" ]; then
  ok "already installed"
else
  note "this takes a minute or two..."
  (cd "$ROOT" && npm install --no-audit --no-fund)
  ok "installed"
fi

# ------------------------------------------------------- 3. system audio tap

next "Building the system-audio helper"
if [ -x "$BIN_DIR/meeting-audio-tap" ]; then
  ok "already built"
else
  (cd "$ROOT" && node scripts/build-audio-tap.mjs)
  [ -x "$BIN_DIR/meeting-audio-tap" ] || die "the audio helper did not build" \
    "This part has never been compiled before, so an error here is expected and fixable.
Copy the messages above and send them over."
  ok "built"
fi

# ---------------------------------------------------------- 4. speech engine

next "Building the speech recognition engine"
if [ -x "$BIN_DIR/whisper-server" ]; then
  ok "already built"
else
  mkdir -p "$CACHE_DIR"
  if [ -d "$CACHE_DIR/whisper.cpp/.git" ]; then
    note "updating the existing copy..."
    git -C "$CACHE_DIR/whisper.cpp" pull --ff-only || warn "could not update; using the copy already here"
  else
    note "downloading whisper.cpp..."
    git clone --depth 1 "$WHISPER_REPO" "$CACHE_DIR/whisper.cpp"
  fi

  note "compiling (this is the slow part, usually 3 to 10 minutes)..."
  cmake -S "$CACHE_DIR/whisper.cpp" -B "$CACHE_DIR/whisper.cpp/build" \
    -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_SERVER=ON >/dev/null
  cmake --build "$CACHE_DIR/whisper.cpp/build" --config Release -j "$(sysctl -n hw.ncpu)" >/dev/null

  SERVER_BINARY="$(find "$CACHE_DIR/whisper.cpp/build" -name 'whisper-server' -type f -perm -u+x | head -1)"
  [ -n "$SERVER_BINARY" ] || die "the speech engine built, but no server binary was produced" \
    "Send over everything above and it can be sorted out."

  mkdir -p "$BIN_DIR"
  cp "$SERVER_BINARY" "$BIN_DIR/whisper-server"
  chmod +x "$BIN_DIR/whisper-server"
  ok "built"
fi

# ------------------------------------------------------------- 5. the model

next "Downloading the speech model"
if [ -s "$MODEL_DIR/$MODEL_NAME" ]; then
  ok "already downloaded ($(du -h "$MODEL_DIR/$MODEL_NAME" | cut -f1))"
else
  mkdir -p "$MODEL_DIR"
  note "about 834 MB, downloading..."
  # Write to a temp name first so an interrupted download is never mistaken
  # for a finished one.
  curl -fL --progress-bar "$MODEL_URL" -o "$MODEL_DIR/$MODEL_NAME.partial"
  mv "$MODEL_DIR/$MODEL_NAME.partial" "$MODEL_DIR/$MODEL_NAME"
  ok "downloaded ($(du -h "$MODEL_DIR/$MODEL_NAME" | cut -f1))"
fi

# ------------------------------------------------------------- 6. final check

next "Checking everything"
trap - ERR
(cd "$ROOT" && node scripts/doctor.mjs) || true

printf '\n\033[1mSetup finished.\033[0m\n'
printf 'Start the app with:  \033[1mnpm start\033[0m\n\n'

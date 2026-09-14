#!/bin/bash
#
# Read-only check of what is already installed on this Mac.
#
# Changes nothing. Prints which setup steps can be skipped and which still
# need doing. Written for macOS's stock bash 3.2, so no modern bash features.
#
# Can be pasted straight into Terminal before the repo is even cloned.

printf '\n\033[1mChecking what you already have...\033[0m\n\n'

pass() { printf '  \033[32m✓\033[0m  %-34s %s\n' "$1" "$2"; }
fail() { printf '  \033[31m✗\033[0m  %-34s \033[33m%s\033[0m\n' "$1" "$2"; }
info() { printf '     \033[2m%s\033[0m\n' "$1"; }

todo=""
add_todo() { todo="$todo $1"; }

# ------------------------------------------------------------ the Mac itself

if [ "$(uname -s)" != "Darwin" ]; then
  fail "macOS" "this is not a Mac"
  info "The app needs a Mac running macOS 14.2 or later."
  printf '\n'
  exit 1
fi

os_version=$(sw_vers -productVersion)
os_major=$(echo "$os_version" | cut -d. -f1)
os_minor=$(echo "$os_version" | cut -d. -f2)
[ -z "$os_minor" ] && os_minor=0

if [ "$os_major" -gt 14 ] || { [ "$os_major" -eq 14 ] && [ "$os_minor" -ge 2 ]; }; then
  pass "macOS $os_version" "new enough"
else
  fail "macOS $os_version" "too old"
  info "Recording system audio needs macOS 14.2 (Sonoma) or later."
  info "Apple menu > System Settings > General > Software Update"
  printf '\n'
  exit 1
fi

# ------------------------------------------------------- step 2: Apple tools

if xcode-select -p >/dev/null 2>&1; then
  if command -v swiftc >/dev/null 2>&1; then
    pass "Apple developer tools" "SKIP step 2"
  else
    fail "Apple developer tools" "DO step 2"
    info "Found, but the Swift compiler is missing. Reinstalling will fix it."
    add_todo 2
  fi
else
  fail "Apple developer tools" "DO step 2"
  add_todo 2
fi

# --------------------------------------------------------- step 3: Homebrew

brew_bin=""
if command -v brew >/dev/null 2>&1; then
  brew_bin=$(command -v brew)
elif [ -x /opt/homebrew/bin/brew ]; then
  brew_bin=/opt/homebrew/bin/brew
elif [ -x /usr/local/bin/brew ]; then
  brew_bin=/usr/local/bin/brew
fi

if [ -n "$brew_bin" ]; then
  pass "Homebrew $($brew_bin --version 2>/dev/null | head -1 | awk '{print $2}')" "SKIP step 3"
  if ! command -v brew >/dev/null 2>&1; then
    info "Installed at $brew_bin but not on your PATH. Run this once:"
    info "  echo 'eval \"\$($brew_bin shellenv)\"' >> ~/.zprofile && eval \"\$($brew_bin shellenv)\""
  fi
else
  fail "Homebrew" "DO step 3"
  add_todo 3
fi

# --------------------------------------------------- step 4: Node and cmake

node_ok=0
if command -v node >/dev/null 2>&1; then
  node_version=$(node --version 2>/dev/null)
  node_major=$(echo "$node_version" | sed 's/^v//' | cut -d. -f1)
  if [ -n "$node_major" ] && [ "$node_major" -ge 22 ] 2>/dev/null; then
    pass "Node.js $node_version" ""
    node_ok=1
  else
    fail "Node.js $node_version" "too old, needs 22+"
    info "Fix with:  brew upgrade node"
  fi
else
  fail "Node.js" "not installed"
fi

cmake_ok=0
if command -v cmake >/dev/null 2>&1; then
  pass "cmake $(cmake --version 2>/dev/null | head -1 | awk '{print $3}')" ""
  cmake_ok=1
else
  fail "cmake" "not installed"
fi

if [ "$node_ok" -eq 1 ] && [ "$cmake_ok" -eq 1 ]; then
  printf '     \033[32mSKIP step 4\033[0m\n'
else
  printf '     \033[33mDO step 4\033[0m\n'
  add_todo 4
fi

# --------------------------------------------------------------- extra info

if command -v git >/dev/null 2>&1; then
  pass "git $(git --version 2>/dev/null | awk '{print $3}')" ""
else
  fail "git" "comes with step 2"
fi

if [ -d "$HOME/Documents/granola-alternative/.git" ]; then
  info ""
  info "You already have the app downloaded at ~/Documents/granola-alternative"
  info "so you can skip step 5 too. Just run:  cd ~/Documents/granola-alternative"
fi

# ------------------------------------------------------------------ summary

printf '\n\033[1mWhat to do\033[0m\n\n'

if [ -z "$todo" ]; then
  printf '  Nothing to install. \033[32mSkip straight to step 5\033[0m (download the app).\n'
else
  printf '  Do these steps: \033[33m%s\033[0m\n' "$(echo "$todo" | sed 's/^ //' | sed 's/ /, /g')"
  printf '  Skip everything else, then continue from step 5.\n'
fi

printf '\n'

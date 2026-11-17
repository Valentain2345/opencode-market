#!/bin/sh
# Registers this checkout, or a downloaded copy, as a local OpenCode plugin.
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required. Install it from https://nodejs.org and run this again." >&2
  exit 1
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$root/scripts/install.mjs" ]; then
  exec node "$root/scripts/install.mjs" "$@"
fi

# Piped from curl: download a copy, then install from there.
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for the one-line install." >&2
  exit 1
fi
target=${OPENCODE_MARKET_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-market}
archive=https://github.com/Valentain2345/opencode-market/archive/refs/heads/main.tar.gz
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $archive"
curl -fsSL "$archive" | tar -xz -C "$tmp"
mkdir -p "$target"
cp -R "$tmp/opencode-market-main/." "$target/"
exec node "$target/scripts/install.mjs" "$@"

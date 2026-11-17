#!/bin/sh
# Registers this checkout as a local OpenCode plugin.
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required. Install it from https://nodejs.org and run this again." >&2
  exit 1
fi

exec node "$(dirname "$0")/scripts/install.mjs" "$@"

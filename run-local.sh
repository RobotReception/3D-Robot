#!/usr/bin/env bash
# One-command local run: installs dependencies on first use, starts the Studio and opens http://localhost:5173
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is required: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
( sleep 3; (xdg-open http://localhost:5173 || open http://localhost:5173) >/dev/null 2>&1 || true ) &
npm run dev

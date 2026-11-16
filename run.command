#!/bin/bash
set -e
cd "$(dirname "$0")"
# Node.js may be installed per-user (no admin rights) in ~/.local/node
export PATH="$HOME/.local/node/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Please install Node.js LTS from https://nodejs.org/ then double-click run.command again."
  read -p "Press Return to close..."
  exit 1
fi
if [ ! -d node_modules ] || [ ! -d node_modules/@spotify/basic-pitch ]; then
  echo "First run: installing alphaTab and Vite (internet required once)..."
  npm install
fi
# alphaTab copies its music font and soundfont into public/ on first build;
# the dev server only serves public/ if it exists at startup.
if [ ! -f public/font/Bravura.woff2 ] || [ ! -f public/basic-pitch/model.json ]; then
  npm run build >/dev/null
fi
( sleep 2; open "http://127.0.0.1:5173" ) &
npm run dev

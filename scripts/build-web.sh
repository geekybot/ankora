#!/usr/bin/env bash
# One static site for ankora.utpal.dev: the landing (site/) at /, the app (app/) at /app/.
# Output: dist-web/ (upload this folder to any static host). Testnet ids come from app/.env.production.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist-web
mkdir -p dist-web
rsync -a --exclude shots --exclude .taste-skill site/ dist-web/
(cd app && npx vite build --outDir ../dist-web/app --emptyOutDir)
echo "built dist-web/: landing at /, app at /app/"

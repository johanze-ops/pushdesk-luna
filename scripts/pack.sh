#!/bin/bash
# Package the Add On as pushdesk-luna.lunaaddon, with only the Add On's own files (not the
# helper's source, tests or build tools).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/dist/pushdesk-luna"
rm -rf "$ROOT/dist" && mkdir -p "$STAGE"
cp -R "$ROOT/index.html" "$ROOT/logic.js" "$ROOT/main.js" "$ROOT/manifest.json" "$ROOT/README.md" "$ROOT/LICENSE" "$ROOT/favourites" "$ROOT/vendor" "$STAGE/"
cd "$STAGE" && npx --prefix "$ROOT" ua-builder pack
mv "$STAGE"/*.lunaaddon "$ROOT/dist/pushdesk-luna.lunaaddon"
unzip -l "$ROOT/dist/pushdesk-luna.lunaaddon" | awk 'NR>3 && $4 != "" {print $4}'

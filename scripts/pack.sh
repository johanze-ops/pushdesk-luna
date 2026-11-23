#!/bin/bash
# Package the Add On as dist/pushdesk-luna.lunaaddon, with only the Add On's own files (not the
# helper's source, tests or build tools).
#
# LUNA may be running PushDesk from dist/pushdesk-luna (a dev install links there), so that
# folder is never deleted: the package is built in a temporary folder and dist/pushdesk-luna is
# updated in place.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/pushdesk-luna"
mkdir -p "$STAGE" "$ROOT/dist/pushdesk-luna"
cp -R "$ROOT/index.html" "$ROOT/logic.js" "$ROOT/main.js" "$ROOT/manifest.json" "$ROOT/README.md" "$ROOT/LICENSE" "$ROOT/favourites" "$ROOT/vendor" "$ROOT/images" "$STAGE/"
(cd "$STAGE" && npx --prefix "$ROOT" ua-builder pack)
mv "$STAGE"/*.lunaaddon "$ROOT/dist/pushdesk-luna.lunaaddon"
rsync -a --delete "$STAGE/" "$ROOT/dist/pushdesk-luna/"
unzip -l "$ROOT/dist/pushdesk-luna.lunaaddon" | awk 'NR>3 && $4 != "" {print $4}'

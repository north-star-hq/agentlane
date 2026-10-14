#!/bin/sh
# Usage: web-on-linux.sh <evidence folder> [<folder holding the browser archives>]
set -eu

evidence="$1"
archives="${2:-}"
mkdir -p "$evidence"
evidence="$(cd "$evidence" && pwd)"
root="$(cd "$(dirname "$0")/../.." && pwd)"

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

cd "$root"
pnpm install --frozen-lockfile
pnpm run build

cd "$root/examples/expo-app"
pnpm install --frozen-lockfile
cli="$root/examples/expo-app/node_modules/.bin/agentlane"

sleep 86400 &
owner=$!
trap 'kill "$owner"' EXIT
export AGENTLANE_OWNER_PID="$owner"

if [ -n "$archives" ]; then
  "$cli" browser install --json --from "$archives" >"$evidence/browser-install.json"
else
  "$cli" browser install --json >"$evidence/browser-install.json"
fi
core="$(node -p 'require(process.argv[1]).playwrightCore' "$evidence/browser-install.json")"
as_root "$(command -v node)" "$core/cli.js" install-deps chromium

"$cli" up --platform web
"$cli" doctor --platform web
"$cli" screenshot --browser --out "$evidence/web.png"
"$cli" release

node -e '
const file = process.argv[1];
const png = require("fs").readFileSync(file);
if (png.length < 1000 || png.toString("latin1", 1, 4) !== "PNG") throw new Error(file + " is not a screenshot");
console.log(file + ": a " + png.length + "-byte PNG");
' "$evidence/web.png"

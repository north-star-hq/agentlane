#!/bin/sh
# Usage: clean-install.sh <evidence folder> <web|ios> <agentlane version or npm dist-tag>
set -eu

evidence="$1"
platform="$2"
spec="$3"
mkdir -p "$evidence"
evidence="$(cd "$evidence" && pwd)"
root="$(cd "$(dirname "$0")/../.." && pwd)"

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

tries=0
until version="$(npm view "agentlane@$spec" version 2>/dev/null)" && [ -n "$version" ]; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "agentlane@$spec isn't on npm after 5 minutes" >&2
    exit 1
  fi
  sleep 10
done
echo "Installing agentlane@$version from npm"

cd "$root/examples/expo-app"
pnpm add --save-dev "agentlane@$version"
cli="$root/examples/expo-app/node_modules/.bin/agentlane"
installed="$("$cli" --version)"
echo "$installed" >"$evidence/version.txt"
if [ "$installed" != "$version" ]; then
  echo "the installed CLI says $installed, not $version" >&2
  exit 1
fi

sleep 86400 &
owner=$!
trap 'kill "$owner"' EXIT
export AGENTLANE_OWNER_PID="$owner"

if [ "$platform" = web ] && [ "$(uname)" = Linux ]; then
  "$cli" browser install --json >"$evidence/browser-install.json"
  core="$(node -p 'require(process.argv[1]).playwrightCore' "$evidence/browser-install.json")"
  as_root "$(command -v node)" "$core/cli.js" install-deps chromium
fi

"$cli" up --platform "$platform"
"$cli" doctor --platform "$platform"
if [ "$platform" = web ]; then
  shot="$evidence/web.png"
  "$cli" screenshot --browser --out "$shot"
else
  shot="$evidence/$platform.jpg"
  "$cli" screenshot --device --out "$shot"
fi
"$cli" release

node -e '
const file = process.argv[1];
const image = require("fs").readFileSync(file);
const png = image.toString("latin1", 1, 4) === "PNG";
const jpeg = image[0] === 0xff && image[1] === 0xd8;
if (image.length < 1000 || !(png || jpeg)) throw new Error(file + " is not a screenshot");
console.log(file + ": a " + image.length + "-byte " + (png ? "PNG" : "JPEG"));
' "$shot"

#!/bin/sh
# Usage, inside the image with the repository at /work: docker-web-lane-inside.sh <evidence folder>
set -eu

evidence="$1"
cd /work
pnpm install --frozen-lockfile
pnpm run build

cd /work/examples/expo-app
pnpm install --frozen-lockfile

sleep 86400 &
owner=$!
trap 'kill "$owner"' EXIT
export AGENTLANE_OWNER_PID="$owner"

agentlane up --platform web
agentlane doctor --platform web --json >"$evidence/doctor.json" || true
agentlane doctor --platform web
agentlane screenshot --browser --out "$evidence/web.png"
agentlane release

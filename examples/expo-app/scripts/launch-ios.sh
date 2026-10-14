#!/usr/bin/env bash
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=ios-common.sh
. "$(dirname "$0")/ios-common.sh"

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  die "usage: scripts/launch-ios.sh <simulator-udid> <metro-port> [api-port]"
fi
UDID="$1"
METRO_PORT="$2"
API_PORT="${3:-}"
METRO_URL="http://localhost:$METRO_PORT"

sim_state "$UDID" >/dev/null || die "no simulator with UDID $UDID"
[ "$(curl -fsS --max-time 2 "$METRO_URL/status" 2>/dev/null)" = packager-status:running ] ||
  die "Metro is not running on :$METRO_PORT: start it with node_modules/.bin/expo start --dev-client --port $METRO_PORT"

approve_scheme_and_boot "$UDID"
xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || die "$BUNDLE_ID is not installed on $UDID: run scripts/build-ios.sh $UDID"

args=()
[ -n "$API_PORT" ] && args+=(-apiBaseUrl "http://localhost:$API_PORT")

xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl launch "$UDID" "$BUNDLE_ID" ${args[@]+"${args[@]}"} >/dev/null
link="$SCHEME://expo-development-client/?url=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$METRO_URL")"
xcrun simctl openurl "$UDID" "$link"
note "launched $BUNDLE_ID on $UDID: Metro $METRO_URL${API_PORT:+, API http://localhost:$API_PORT}"

#!/usr/bin/env bash
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=ios-common.sh
. "$(dirname "$0")/ios-common.sh"

[ $# -eq 1 ] || die "usage: scripts/build-ios.sh <simulator-udid>"
UDID="$1"
sim_state "$UDID" >/dev/null || die "no simulator with UDID $UDID"
cd "$(dirname "$0")/.."
[ -d node_modules ] || die "node_modules is missing: run pnpm install --frozen-lockfile"

# CocoaPods fails in Ruby's unicode_normalize under a non-UTF-8 locale.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

node_modules/.bin/expo prebuild --platform ios --no-install
(cd ios && pod install)

xcodebuild \
  -workspace ios/ExpoExample.xcworkspace \
  -scheme ExpoExample \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath build/ios \
  -quiet \
  build

approve_scheme_and_boot "$UDID"
xcrun simctl install "$UDID" build/ios/Build/Products/Debug-iphonesimulator/ExpoExample.app
note "installed $BUNDLE_ID on $UDID"

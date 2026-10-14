#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

[ $# -le 1 ] || die "usage: scripts/build-android.sh [<emulator-serial>]"
cd "$(dirname "$0")/.."
[ -d node_modules ] || die "node_modules is missing: run pnpm install --frozen-lockfile"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -x "$ANDROID_HOME/platform-tools/adb" ] || die "no Android SDK at $ANDROID_HOME: install it, or set ANDROID_HOME"

java_home=""
for candidate in "${AGENTLANE_JAVA_HOME:-}" "${JAVA_HOME:-}" /opt/homebrew/opt/openjdk@17 /usr/local/opt/openjdk@17; do
  if [ -z "$candidate" ] || [ ! -x "$candidate/bin/java" ]; then continue; fi
  if "$candidate/bin/java" -version 2>&1 | grep -q 'version "17'; then
    java_home=$candidate
    break
  fi
done
[ -n "$java_home" ] || die "no JDK 17 found: brew install openjdk@17, or set JAVA_HOME to a JDK 17 home"
export JAVA_HOME="$java_home"

case "$(uname -m)" in
  arm64 | aarch64) abi=arm64-v8a ;;
  *) abi=x86_64 ;;
esac

node_modules/.bin/expo prebuild --platform android --no-install
(cd android && ./gradlew --no-daemon --console=plain -PreactNativeArchitectures="$abi" :app:assembleDebug)

mkdir -p build/android
cp android/app/build/outputs/apk/debug/app-debug.apk build/android/app-debug.apk
echo "built build/android/app-debug.apk ($abi)" >&2

# shellcheck shell=bash
BUNDLE_ID=com.example.expoapp
SCHEME=expoexample

die() {
  echo "error: $*" >&2
  exit 1
}

note() { echo "$*" >&2; }

sim_state() {
  xcrun simctl list devices -j | python3 -c '
import json, sys
udid = sys.argv[1]
for devices in json.load(sys.stdin)["devices"].values():
    for d in devices:
        if d["udid"] == udid:
            print(d["state"])
            sys.exit(0)
sys.exit(1)
' "$1"
}

sim_boot() {
  [ "$(sim_state "$1")" = Booted ] || xcrun simctl boot "$1"
  xcrun simctl bootstatus "$1" -b >/dev/null
}

# Pre-approves the "Open in <app>?" prompt for our scheme, the way @expo/cli does.
# iOS reads this plist when the simulator boots, so a newly written approval needs a
# boot to take effect. Returns 1 when it wrote a new approval.
approve_scheme() {
  local udid="$1"
  local plist="$HOME/Library/Developer/CoreSimulator/Devices/$udid/data/Library/Preferences/com.apple.launchservices.schemeapproval.plist"
  local key=":com.apple.CoreSimulator.CoreSimulatorBridge-->$SCHEME"
  local pb=/usr/libexec/PlistBuddy current=""
  if [ -f "$plist" ]; then current="$("$pb" -c "Print $key" "$plist" 2>/dev/null)" || current=""; fi
  [ "$current" = "$BUNDLE_ID" ] && return 0
  mkdir -p "$(dirname "$plist")"
  if [ -n "$current" ]; then
    "$pb" -c "Set $key $BUNDLE_ID" "$plist" >/dev/null
  else
    "$pb" -c "Add $key string $BUNDLE_ID" "$plist" >/dev/null
  fi
  [ "$("$pb" -c "Print $key" "$plist" 2>/dev/null)" = "$BUNDLE_ID" ] || die "could not write the scheme approval to $plist"
  return 1
}

approve_scheme_and_boot() {
  local udid="$1"
  if ! approve_scheme "$udid" && [ "$(sim_state "$udid")" = Booted ]; then
    note "rebooting $udid so the $SCHEME:// approval takes effect"
    xcrun simctl shutdown "$udid"
  fi
  sim_boot "$udid"
}

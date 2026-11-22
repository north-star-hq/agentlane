#!/bin/sh
# Usage: release-notes.sh <version> [changelog]
set -eu

version="$1"
root="$(cd "$(dirname "$0")/../.." && pwd)"
changelog="${2:-$root/CHANGELOG.md}"
stable="${version%%-*}"

section() {
  awk -v heading="## $1" '
    fence == "" && $0 == heading { found = 1; next }
    found && fence == "" && /^## / { exit }
    /^```/ || /^~~~/ {
      marker = substr($0, 1, 3)
      if (fence == "") fence = marker
      else if (marker == fence) fence = ""
    }
    found { print }
  ' "$changelog" | sed '/./,$!d'
}

notes="$(section "$stable")"
if [ -z "$notes" ] && [ "$stable" != "$version" ]; then
  notes="$(section Unreleased)"
fi

if [ -z "$notes" ]; then
  if [ "$stable" = "$version" ]; then
    echo "$changelog has no section for $version" >&2
  else
    echo "$changelog has no section for $stable or Unreleased, which $version would take its notes from" >&2
  fi
  exit 1
fi
printf '%s\n' "$notes"

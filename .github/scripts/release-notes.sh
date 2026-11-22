#!/bin/sh
# Usage: release-notes.sh <version> [changelog]
set -eu

version="$1"
root="$(cd "$(dirname "$0")/../.." && pwd)"
changelog="${2:-$root/CHANGELOG.md}"
section="${version%%-*}"

notes="$(awk -v heading="## $section" '
  $0 == heading { found = 1; next }
  found && /^## / { exit }
  found { print }
' "$changelog")"
notes="$(printf '%s\n' "$notes" | sed '/./,$!d')"

if [ -z "$notes" ]; then
  if [ "$section" = "$version" ]; then
    echo "$changelog has no section for $version" >&2
  else
    echo "$changelog has no section for $section, which $version leads to" >&2
  fi
  exit 1
fi
printf '%s\n' "$notes"

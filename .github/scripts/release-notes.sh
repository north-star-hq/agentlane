#!/bin/sh
# Usage: release-notes.sh <version> [changelog]
set -eu

version="$1"
root="$(cd "$(dirname "$0")/../.." && pwd)"
changelog="${2:-$root/CHANGELOG.md}"
stable="${version%%-*}"

section() {
  awk -v heading="## $1" '
    !done && fence == "" && $0 == heading { found = 1; next }
    found && fence == "" && /^## / { found = 0; done = 1 }
    {
      indent = 0
      while (substr($0, indent + 1, 1) == " ") indent++
      rest = substr($0, indent + 1)
      char = substr(rest, 1, 1)
      run = 0
      if (char == "`" || char == "~") while (substr(rest, run + 1, 1) == char) run++
      after = substr(rest, run + 1)
      if (indent <= 3 && run >= 3) {
        if (fence == "") {
          if (char == "~" || index(after, "`") == 0) { fence = char; fence_run = run }
        } else if (char == fence && run >= fence_run && after ~ /^ *$/) {
          fence = ""
        }
      }
    }
    found && $0 != "" { started = 1 }
    found && started { print }
    END { if (fence != "") exit 2 }
  ' "$changelog"
}

unclosed() {
  echo "$changelog has a code fence that is never closed" >&2
  exit 1
}

notes="$(section "$stable")" || unclosed
if [ -z "$notes" ] && [ "$stable" != "$version" ]; then
  notes="$(section Unreleased)" || unclosed
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

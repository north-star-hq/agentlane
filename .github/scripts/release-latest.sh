#!/bin/sh
# Usage: origin-tags.sh | release-latest.sh <version>
set -eu

version="$1"
tags="$(sed 's|^.*refs/tags/||' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-.+)?$' || true)"
if ! printf '%s\n' "$tags" | grep -qxF "v$version"; then
  echo "The tags read do not include v$version, so they cannot say whether it is the highest." >&2
  exit 1
fi
highest="$(printf '%s\n' "$tags" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
if [ "$highest" = "v$version" ]; then
  echo true
else
  echo false
fi

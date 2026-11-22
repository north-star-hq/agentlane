#!/bin/sh
# Usage: git tag -l | release-latest.sh <stable version>
set -eu

version="$1"
highest="$({ printf 'v%s\n' "$version"; cat; } | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
if [ "$highest" = "v$version" ]; then
  echo true
else
  echo false
fi

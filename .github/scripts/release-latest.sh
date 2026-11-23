#!/bin/sh
# Usage: git ls-remote --tags --refs origin 'v*' | release-latest.sh <version>
set -eu

version="$1"
highest="$({ printf 'v%s\n' "$version"; sed 's|^.*refs/tags/||'; } | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
if [ "$highest" = "v$version" ]; then
  echo true
else
  echo false
fi

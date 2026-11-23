#!/bin/sh
# Usage: origin-tags.sh | release-latest.sh <version>
set -eu

tries=1
until lines="$(git ls-remote --tags --refs origin 'v*')"; do
  if [ "$tries" -ge 3 ]; then
    echo "Could not read origin's v* tags after $tries tries." >&2
    exit 1
  fi
  tries=$((tries + 1))
  sleep 10
done
printf '%s\n' "$lines"

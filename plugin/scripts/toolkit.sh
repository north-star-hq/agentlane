#!/bin/sh
for start in "$@"; do
  [ -n "$start" ] || continue
  dir=$(CDPATH='' cd -- "$start" 2>/dev/null && pwd -P) || continue
  while :; do
    if [ -x "$dir/node_modules/.bin/agentlane" ]; then
      printf '%s\n' "$dir/node_modules/.bin/agentlane"
      exit 0
    fi
    [ "$dir" = / ] && break
    dir=$(dirname -- "$dir")
  done
done
exit 1

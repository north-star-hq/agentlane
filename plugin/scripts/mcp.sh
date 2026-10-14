#!/bin/sh
# A server that exits before its handshake is remembered as failed machine-wide and hidden for about 15 minutes
# (https://github.com/anthropics/claude-code/issues/80822), so a project without the toolkit gets a server that explains.
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
project=${CLAUDE_PROJECT_DIR:-$PWD}
case $project in
  *\$\{*) project=$PWD ;;
esac
if toolkit=$("$here/toolkit.sh" "$project" "$PWD"); then
  exec "$toolkit" mcp
fi
exec node "$here/missing-toolkit-mcp.mjs" "$project"

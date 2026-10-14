#!/bin/sh
# Claude Code reads exit 2 from a hook as "block", so every failure of the toolkit maps to 1, a non-blocking error.
event=$1
input=$(cat)
if [ "$event" = pre-tool-use ]; then
  case $input in
    *simctl* | *adb* | *emulator* | *avdmanager* | *playwright-cli* | *@playwright/cli* | *agent-browser*) ;;
    *) exit 0 ;;
  esac
fi
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
toolkit=$("$here/toolkit.sh" "$PWD" "${CLAUDE_PROJECT_DIR:-}") || exit 0
if printf '%s' "$input" | "$toolkit" hook "$event"; then
  exit 0
fi
exit 1

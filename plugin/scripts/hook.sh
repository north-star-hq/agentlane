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
project=${CLAUDE_PROJECT_DIR:-$PWD}
# Claude Code runs a plugin's hooks beside the project settings' hooks for the same event, and holds a plugin's
# session-end hook to 1.5 s whatever timeout it declares, so where init wrote the hooks into the settings this copy
# steps aside.
for settings in "$project/.claude/settings.json" "$project/.claude/settings.local.json"; do
  if grep -qsF "\" hook $event --agent claude" "$settings"; then
    exit 0
  fi
done
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
if ! toolkit=$("$here/toolkit.sh" "$PWD" "${CLAUDE_PROJECT_DIR:-}"); then
  toolkit=$(git -C "$project" worktree list --porcelain 2>/dev/null | while IFS= read -r line; do
    dir=${line#worktree }
    if [ "$dir" != "$line" ] && [ -x "$dir/node_modules/.bin/agentlane" ]; then
      printf '%s' "$dir/node_modules/.bin/agentlane"
      break
    fi
  done)
  if [ -z "$toolkit" ]; then
    exit 0
  fi
fi
if printf '%s' "$input" | "$toolkit" hook "$event"; then
  exit 0
fi
exit 1

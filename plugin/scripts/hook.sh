#!/bin/sh
# Claude Code reads exit 2 from a hook as "block", so every failure of the toolkit maps to 1, a non-blocking error.
event=$1
input=$(cat)
if [ "$event" = pre-tool-use ]; then
  case $(printf '%s' "$input" | sed -e h -e 's/\\\\//g' -e 's/\\n//g' -e x -e 's/\\\\\\\\//g' -e 's/\\\\n//g' -e G -e 's/\\//g' -e "s/[\$'\"]//g" -e p -e :x -e h -e 's/{\([-+0-9A-Za-z]*\)\.\.[-+0-9A-Za-z.]*}/\1/g' -e 's/{\([^{},]*\)\(,[^{},]*\)\{0,8\}}/\1/g' -e p -e g -e ty -e :y -e 's/{[^{},]*,\([^{},]*\(,[^{},]*\)\{0,7\}\)}/{\1}/g' -e tx -e d) in
    *simctl* | *adb* | *emulator* | *avdmanager* | *playwright-cli* | *@playwright/cli* | *agent-browser*) ;;
    *) exit 0 ;;
  esac
fi
project=${CLAUDE_PROJECT_DIR:-$PWD}
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

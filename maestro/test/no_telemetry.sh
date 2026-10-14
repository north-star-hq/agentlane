#!/usr/bin/env bash
# Usage: maestro/test/no_telemetry.sh <unpacked maestro dir, the one holding lib/>
# Exits 1 if lib/ holds an analytics client jar, a telemetry class, or a telemetry endpoint string.
set -euo pipefail

[ $# -eq 1 ] || {
  printf 'usage: %s <unpacked maestro dir>\n' "$0" >&2
  exit 2
}
lib=$1/lib
[ -d "$lib" ] || {
  printf 'no_telemetry.sh: %s has no lib/ directory\n' "$1" >&2
  exit 2
}

class_paths=(
  '*com/posthog/*'
  '*maestro/cli/util/ErrorReporter*'
  '*maestro/cli/util/ScreenReporter*'
  '*maestro/cli/update/*'
  '*maestro/cli/mcp/viewer/ViewerHint*'
)
strings=(
  'us.i.posthog.com'
  'phc_XKhdIS7op'
  '/maestro/error'
  '/maestro/screen'
  '/v2/maestro/version'
  'mobile-dev-inc/maestro/main/CHANGELOG.md'
  'surface this link'
  'Surface this URL'
  'Anonymous analytics enabled'
  'X-UUID'
)

scan=$(mktemp -d)
patterns=$(mktemp)
trap 'rm -rf "$scan" "$patterns"' EXIT
found=0

shopt -s nullglob
jars=("$lib"/*.jar)
analytics_jars=("$lib"/posthog*.jar)
if [ ${#analytics_jars[@]} -gt 0 ]; then
  printf 'analytics client jars in lib/: %s\n' "${analytics_jars[*]##*/}"
  found=1
fi

for jar in "${jars[@]}"; do
  unzip -qq -o "$jar" -d "$scan/${jar##*/}" 2>/dev/null || true
done

find_args=()
for path in "${class_paths[@]}"; do
  [ ${#find_args[@]} -eq 0 ] || find_args+=(-o)
  find_args+=(-path "$path")
done
classes=$(cd "$scan" && find . -type f \( "${find_args[@]}" \) | sort)
if [ -n "$classes" ]; then
  printf 'telemetry classes: %s, for example:\n' "$(printf '%s\n' "$classes" | wc -l | tr -d ' ')"
  printf '%s\n' "$classes" | sed -n '1,4s/^/    /p'
  found=1
fi

printf '%s\n' "${strings[@]}" >"$patterns"
hits=$(grep -rlF -f "$patterns" "$scan" || true)
if [ -n "$hits" ]; then
  for string in "${strings[@]}"; do
    files=$(printf '%s\n' "$hits" | while IFS= read -r file; do
      if grep -qF -- "$string" "$file"; then printf '%s\n' "${file#"$scan"/}"; fi
    done | sed -n '1,3p')
    [ -z "$files" ] || printf "telemetry string '%s' in: %s\n" "$string" "$(printf '%s' "$files" | tr '\n' ' ')"
  done
  found=1
fi

printf '%d jars scanned; %s\n' "${#jars[@]}" "$([ "$found" -eq 0 ] && echo 'no telemetry found' || echo 'telemetry found')"
exit "$found"

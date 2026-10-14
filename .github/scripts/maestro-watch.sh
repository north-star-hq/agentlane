#!/bin/sh
# Usage: maestro-watch.sh, with GH_TOKEN and GH_REPO set
set -eu

root="$(cd "$(dirname "$0")/../.." && pwd)"
env_file="$root/maestro/upstream.env"
ours="$(sed -n 's/^MAESTRO_TAG=//p' "$env_file")"
build="$(sed -n 's/^BUILD_VERSION=//p' "$env_file")"
latest="$(gh release view --repo mobile-dev-inc/Maestro --json tagName --jq .tagName)"

newest="$(printf '%s\n%s\n' "${ours#cli-}" "${latest#cli-}" | sort -V | tail -n 1)"
if [ "$latest" = "$ours" ] || [ "$newest" = "${ours#cli-}" ]; then
  echo "Maestro's latest release is $latest; our patches are on $ours."
  exit 0
fi

title="Maestro $latest is out; our patches are on $ours"
existing="$(gh issue list --state all --search "\"Maestro $latest is out\" in:title" --json number --jq 'length')"
if [ "$existing" != 0 ]; then
  echo "An issue for $latest exists already."
  exit 0
fi

gh issue create --title "$title" --body "Maestro released [$latest](https://github.com/mobile-dev-inc/Maestro/releases/tag/$latest). Our build is \`$build\`, patched on \`$ours\`.

To move to it:

1. Set \`MAESTRO_TAG\` and \`MAESTRO_COMMIT\` in \`maestro/upstream.env\`, and raise \`BUILD_VERSION\`.
2. Rebase \`maestro/patches/\` onto the new tag, and drop any patch the release made unnecessary.
3. Build and check the zip with \`maestro/build.sh\` and \`maestro/verify-release.sh --from-dir\`.
4. Tag \`maestro-v<BUILD_VERSION>\`, which runs the release workflow, then move the pin in \`src/driver/release.ts\`."
echo "Opened an issue for $latest."

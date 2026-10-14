#!/usr/bin/env bash
set -euo pipefail

started=$(date +%s)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
out_dir="$here/out"
work_root="$here/work"
src="$work_root/Maestro"
logs="$work_root/logs"
# shasum is a Perl script, and Perl prints a locale warning on every call when
# LC_ALL names a locale macOS doesn't have.
export PERL_BADLANG=0

usage() {
  cat <<'EOF'
Usage: maestro/build.sh [--out DIR] [--release]

Clones the Maestro tag pinned in maestro/upstream.env, applies maestro/patches/,
rebuilds the iOS runner from source, runs the unit tests (the runner's Swift
library, the iOS driver and client, the Android quick tap, flow env vars, the
MCP server and the CLI session's runner port), checks the distribution carries no telemetry, and writes
DIR/maestro-<version>.zip and DIR/maestro-<version>.zip.sha256.
DIR defaults to maestro/out.

A local build's version is BUILD_VERSION with build metadata naming this
checkout, for example 2.11.0-agentlane.1+local.abc1234 (.dirty when the
checkout has uncommitted changes), so it can never pass as the release.
--release builds the plain BUILD_VERSION, and only the release workflow may
pass it: it needs GITHUB_ACTIONS=true and GITHUB_REF=refs/tags/maestro-v<BUILD_VERSION>.

JDK 17 comes from JAVA_HOME, else /usr/libexec/java_home -v 17, else Homebrew's
openjdk@17. Details: maestro/README.md.
EOF
}

release=false
while [ $# -gt 0 ]; do
  case "$1" in
    --release)
      release=true
      shift
      ;;
    --out)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      out_dir=$2
      shift 2
      ;;
    --out=*)
      out_dir=${1#--out=}
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'build.sh: unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

die() {
  printf '\nbuild.sh: error: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '==> %s\n' "$*"
}

sha256() {
  shasum -a 256 | cut -d ' ' -f 1
}

indent_tail() {
  tail -n "$1" "$2" | sed 's/^/    /' >&2
}

read_pin() {
  maestro_repo='' maestro_tag='' maestro_commit='' build_version=''
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      MAESTRO_REPO) maestro_repo=$value ;;
      MAESTRO_TAG) maestro_tag=$value ;;
      MAESTRO_COMMIT) maestro_commit=$value ;;
      BUILD_VERSION) build_version=$value ;;
      *) die "maestro/upstream.env has an unknown key '$key'." ;;
    esac
  done <"$here/upstream.env"

  [ -n "$maestro_repo" ] || die "maestro/upstream.env is missing MAESTRO_REPO."
  [[ $maestro_commit =~ ^[0-9a-f]{40}$ ]] ||
    die "MAESTRO_COMMIT in maestro/upstream.env must be a full 40-character commit SHA."
  [[ $build_version =~ ^([0-9]+\.[0-9]+\.[0-9]+)-[a-z]+\.[1-9][0-9]*$ ]] ||
    die "BUILD_VERSION '$build_version' in maestro/upstream.env must look like 2.11.0-agentlane.1."
  upstream_version=${BASH_REMATCH[1]}
  [ "$maestro_tag" = "cli-$upstream_version" ] ||
    die "BUILD_VERSION $build_version doesn't match MAESTRO_TAG '$maestro_tag'. When you move to a new tag, set BUILD_VERSION to <tag version>-agentlane.1."
}

stamp_version() {
  if [ "$release" = true ]; then
    if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${GITHUB_REF:-}" != "refs/tags/maestro-v$build_version" ]; then
      die "--release builds the plain $build_version, and only the release workflow on tag maestro-v$build_version may do that. Run without --release for a local build."
    fi
    version=$build_version
    return
  fi
  local sha
  sha=$(git -C "$here" rev-parse --short=7 HEAD 2>/dev/null) ||
    die "a local build names its checkout's commit in its version, and $here is not in a git checkout."
  version="$build_version+local.$sha"
  if [ -n "$(git -C "$here/.." status --porcelain 2>/dev/null)" ]; then
    version="$version.dirty"
  fi
}

find_jdk17() {
  local candidate='' origin='' prefix settings spec home
  if [ -n "${JAVA_HOME:-}" ]; then
    candidate=$JAVA_HOME
    origin="JAVA_HOME=$JAVA_HOME"
  elif candidate=$(/usr/libexec/java_home -v 17 2>/dev/null); then
    origin="/usr/libexec/java_home -v 17"
  else
    candidate=''
    for prefix in "$(brew --prefix openjdk@17 2>/dev/null || true)" /opt/homebrew/opt/openjdk@17 /usr/local/opt/openjdk@17; do
      if [ -n "$prefix" ] && [ -x "$prefix/bin/java" ]; then
        candidate=$prefix
        origin="Homebrew's openjdk@17 ($prefix)"
        break
      fi
    done
    [ -n "$candidate" ] ||
      die "no JDK 17 found. Install one with 'brew install openjdk@17', or set JAVA_HOME to a JDK 17 home."
  fi

  local fix="Set JAVA_HOME to a JDK 17 home (for example /opt/homebrew/opt/openjdk@17), or unset it so the script finds one."
  { [ -x "$candidate/bin/java" ] && [ -x "$candidate/bin/javac" ]; } ||
    die "$origin is not a JDK: it has no bin/java and bin/javac. $fix"
  settings=$("$candidate/bin/java" -XshowSettings:properties -version 2>&1) ||
    die "$origin: '$candidate/bin/java -version' failed. $fix"
  spec=$(printf '%s\n' "$settings" | sed -n 's/^ *java\.specification\.version = //p')
  home=$(printf '%s\n' "$settings" | sed -n 's/^ *java\.home = //p')
  [ "$spec" = 17 ] || die "$origin is Java ${spec:-of unknown version}, and Maestro builds with JDK 17. $fix"
  JAVA_HOME=$home
  export JAVA_HOME
  java_origin=$origin
}

check_xcode() {
  command -v xcodebuild >/dev/null ||
    die "xcodebuild not found. Install Xcode, then run 'sudo xcode-select -s /Applications/Xcode.app'."
  xcodebuild -version >/dev/null 2>&1 ||
    die "xcodebuild can't run; Command Line Tools alone can't build the iOS runner. Install Xcode, then run 'sudo xcode-select -s /Applications/Xcode.app' and 'sudo xcodebuild -runFirstLaunch'."
  xcrun --sdk iphonesimulator --show-sdk-path >/dev/null 2>&1 ||
    die "Xcode has no iOS Simulator SDK. Install it with 'xcodebuild -downloadPlatform iOS'."
}

lock_work() {
  mkdir -p "$work_root"
  if ! shlock -f "$work_root/build.lock" -p $$; then
    die "another build.sh (pid $(cat "$work_root/build.lock" 2>/dev/null || echo unknown)) is building in $work_root. Wait for it to finish or stop it; if no build.sh is running, delete $work_root/build.lock."
  fi
  lock_file="$work_root/build.lock"
  trap 'rm -f "$lock_file"' EXIT
}

prepare_source() {
  mkdir -p "$logs"
  if [ -d "$src/.git" ] && git -C "$src" cat-file -e "$maestro_commit^{commit}" 2>/dev/null; then
    step "Resetting $src to $maestro_tag"
    git -C "$src" am --abort >/dev/null 2>&1 || true
    git -C "$src" checkout -q --force --detach "$maestro_commit"
    git -C "$src" clean -q -ffdx
  else
    step "Cloning Maestro $maestro_tag into $src"
    local refs remote_sha
    refs=$(git ls-remote "$maestro_repo" "refs/tags/$maestro_tag" "refs/tags/$maestro_tag^{}" 2>"$logs/ls-remote.log") ||
      die "can't reach $maestro_repo: $(tail -n 1 "$logs/ls-remote.log"). The first build clones Maestro over the network; check the connection or proxy and run again. Later builds reuse $src."
    remote_sha=$(printf '%s\n' "$refs" | awk '$2 ~ /\^\{\}$/ { peeled = $1 } { first = first ? first : $1 } END { print peeled ? peeled : first }')
    [ -n "$remote_sha" ] || die "$maestro_repo has no tag $maestro_tag. Fix MAESTRO_TAG in maestro/upstream.env."
    [ "$remote_sha" = "$maestro_commit" ] ||
      die "upstream tag $maestro_tag points at $remote_sha, not the pinned $maestro_commit. Review what changed upstream before you update MAESTRO_COMMIT in maestro/upstream.env."
    rm -rf "$src"
    git clone -q --depth 1 --branch "$maestro_tag" -c advice.detachedHead=false "$maestro_repo" "$src" 2>"$logs/clone.log" ||
      die "git clone of $maestro_repo failed: $(tail -n 1 "$logs/clone.log"). Check the network and run again."
  fi

  local head cli_version
  head=$(git -C "$src" rev-parse HEAD)
  [ "$head" = "$maestro_commit" ] ||
    die "$src is at $head, not the pinned $maestro_commit. Delete $src and run again."
  cli_version=$(sed -n 's/^CLI_VERSION=//p' "$src/maestro-cli/gradle.properties")
  [ "$cli_version" = "$upstream_version" ] ||
    die "$maestro_tag builds CLI version '$cli_version', but BUILD_VERSION says $upstream_version. Fix BUILD_VERSION in maestro/upstream.env."
}

apply_patches() {
  step "Applying maestro/patches"
  local patch name number previous=0 count=0
  for patch in "$here"/patches/*.patch; do
    [ -e "$patch" ] || die "maestro/patches/ has no .patch files."
    name=$(basename "$patch")
    [[ $name =~ ^([0-9]{4})-[A-Za-z0-9._-]+\.patch$ ]] ||
      die "$name must be named NNNN-<slug>.patch."
    number=$((10#${BASH_REMATCH[1]}))
    [ "$number" -gt "$previous" ] || die "$name reuses or reorders patch number ${BASH_REMATCH[1]}."
    previous=$number
    if ! git -C "$src" -c user.name=maestro-build -c user.email=maestro-build@localhost -c commit.gpgsign=false \
      am --quiet "$patch" >"$logs/am.log" 2>&1; then
      grep '^error:' "$logs/am.log" | sed 's/^/    /' >&2 || indent_tail 20 "$logs/am.log"
      git -C "$src" am --abort >/dev/null 2>&1 || true
      die "$name doesn't apply to $maestro_tag with the patches before it. Rebase it as described in maestro/README.md under 'Rebasing onto a new Maestro tag'."
    fi
    count=$((count + 1))
  done
  printf '    %d patches applied\n' "$count"
}

check_notice() {
  {
    printf '%s\n' \
      "This is a modified version of Maestro (https://github.com/mobile-dev-inc/Maestro)" \
      "by mobile.dev inc., licensed under the Apache License, Version 2.0. The license" \
      "text is in LICENSE-maestro." \
      "" \
      "Files changed from Maestro $maestro_tag:"
    git -C "$src" diff --name-only "$maestro_commit" HEAD
  } >"$work_root/NOTICE.expected"
  if ! cmp -s "$work_root/NOTICE.expected" "$here/NOTICE"; then
    diff -u "$here/NOTICE" "$work_root/NOTICE.expected" >&2 || true
    die "maestro/NOTICE doesn't list the files the patches change. Fix: cp '$work_root/NOTICE.expected' '$here/NOTICE'"
  fi
}

runner_dir=maestro-ios-driver/src/main/resources/driver-iPhoneSimulator
runner_artifacts=(
  "$runner_dir/Debug-iphonesimulator/maestro-driver-iosUITests-Runner.zip"
  "$runner_dir/Debug-iphonesimulator/maestro-driver-ios.zip"
  "$runner_dir/maestro-driver-ios-config.xctestrun"
)
fresh_hashes=()

build_runner() {
  step "Building the iOS runner from source (log: $logs/runner.log)"
  if ! (cd "$src" && env -u DEVELOPMENT_TEAM DESTINATION="generic/platform=iOS Simulator" DERIVED_DATA_DIR=driver-iPhoneSimulator \
    bash maestro-ios-xctest-runner/build-maestro-ios-runner.sh) >"$logs/runner.log" 2>&1; then
    { grep -E '(^|: )error: ' "$logs/runner.log" | sort -u | awk 'NR <= 10' | sed 's/^/    /' >&2; } ||
      indent_tail 30 "$logs/runner.log"
    die "the iOS runner failed to build; the log is $logs/runner.log. If a patch changes maestro-ios-xctest-runner/, fix that patch. If Xcode can't build for the Simulator, run 'sudo xcodebuild -runFirstLaunch' and 'xcodebuild -downloadPlatform iOS'."
  fi

  local artifact fresh prebuilt
  : >"$work_root/runner.sha256"
  for artifact in "${runner_artifacts[@]}"; do
    [ -s "$src/$artifact" ] || die "the runner build didn't produce $artifact (log: $logs/runner.log)."
    fresh=$(sha256 <"$src/$artifact")
    prebuilt=$(git -C "$src" show "$maestro_commit:$artifact" | sha256)
    case "$artifact" in
      *.zip)
        [ "$fresh" != "$prebuilt" ] ||
          die "$artifact is identical to the prebuilt one in $maestro_tag, so the runner wasn't rebuilt (log: $logs/runner.log)."
        ;;
    esac
    printf '%s fresh=%s prebuilt=%s\n' "$artifact" "$fresh" "$prebuilt" >>"$work_root/runner.sha256"
    fresh_hashes+=("$fresh")
  done
}

test_runner_library() {
  step "Running the runner's Swift unit tests (log: $logs/swift-test.log)"
  if ! (cd "$src/maestro-ios-xctest-runner/MaestroDriverLib" && xcrun swift test --scratch-path "$work_root/swift") \
    >"$logs/swift-test.log" 2>&1; then
    { grep -E 'error:|failed' "$logs/swift-test.log" | awk 'NR <= 10' | sed 's/^/    /' >&2; } || indent_tail 30 "$logs/swift-test.log"
    die "the runner's Swift unit tests (MaestroDriverLib) failed; the log is $logs/swift-test.log."
  fi
  grep -q "Test Suite 'RunnerTokenTests' passed" "$logs/swift-test.log" ||
    die "the runner token's Swift tests (RunnerTokenTests) didn't run. Check that 0020 still adds them."
  grep -E "^[[:space:]]*Executed [0-9]+ tests?, with" "$logs/swift-test.log" | tail -n 1 | sed 's/^[[:space:]]*/    MaestroDriverLib: /'
}

require_test() {
  local results=$1 name=$2 what=$3 patch=$4 class
  class=$(basename "$results" .xml)
  class=${class##*.}
  grep -qF "testcase name=\"$name()\"" "$results" 2>/dev/null ||
    die "$what ($class) didn't run. Check that $patch still adds it."
}

build_distribution() {
  step "Running the iOS driver, iOS client, Android quick tap, flow env, MCP and CLI session unit tests and building the distribution (log: $logs/gradle.log)"
  if ! (cd "$src" && ./gradlew --no-daemon --console=plain \
    -Pkotlin.compiler.execution.strategy=in-process \
    -PmaestroBuildVersion="$version" \
    -x :maestro-ios-driver:buildIosDriver \
    :maestro-ios-driver:test --rerun \
    :maestro-client:test --rerun --tests 'maestro.xctestdriver.*' --tests 'maestro.drivers.IOSDriverTest' \
    --tests 'maestro.drivers.AndroidDriverWindowSettleTest' --tests 'maestro.TapRetryTest' \
    :maestro-orchestra-models:test --rerun --tests 'maestro.orchestra.util.EnvTest' \
    :maestro-cli:test --rerun --tests 'maestro.cli.mcp.*' --tests 'maestro.cli.session.MaestroSessionManagerTest' \
    :maestro-cli:distZip) >"$logs/gradle.log" 2>&1; then
    grep -E 'FAILED|^e: |error:|What went wrong' -A 3 "$logs/gradle.log" | head -n 40 | sed 's/^/    /' >&2 || true
    die "the Gradle build or its unit tests failed; the log is $logs/gradle.log and the test reports are under $src/<module>/build/reports/tests/test/."
  fi

  local driver="$src/maestro-ios-driver/build/test-results/test" client="$src/maestro-client/build/test-results/test"
  local env="$src/maestro-orchestra-models/build/test-results/test" cli="$src/maestro-cli/build/test-results/test" report
  report=$(sed -n 's/.*<testsuite name="\([^"]*\)" tests="\([0-9]*\)" skipped="\([0-9]*\)" failures="\([0-9]*\)" errors="\([0-9]*\)".*/\1 tests=\2 skipped=\3 failures=\4 errors=\5/p' \
    "$driver"/TEST-*.xml "$client"/TEST-maestro.xctestdriver.*.xml "$client"/TEST-maestro.drivers.IOSDriverTest.xml \
    "$client"/TEST-maestro.drivers.AndroidDriverWindowSettleTest.xml "$client"/TEST-maestro.TapRetryTest.xml \
    "$env"/TEST-maestro.orchestra.util.EnvTest.xml \
    "$cli"/TEST-maestro.cli.mcp.*.xml "$cli"/TEST-maestro.cli.session.MaestroSessionManagerTest.xml)
  printf '%s\n' "$report" | sed 's/^/    /'
  if printf '%s\n' "$report" | grep -Eq 'failures=[1-9]|errors=[1-9]'; then
    die "unit tests failed; the reports are under $src/<module>/build/reports/tests/test/."
  fi
  local installer="$driver/TEST-xcuitest.installer.LocalXCTestInstallerTest.xml"
  local sessions="$cli/TEST-maestro.cli.mcp.McpMaestroSessionManagerTest.xml"
  require_test "$sessions" 'reserveXCTestPort never hands out the same port twice, even when called concurrently' \
    "#3647's port test" 0001
  require_test "$sessions" 'an iOS session that fails to start stops its driver before its port can go to another session' \
    "the failed start's port test" 0003
  require_test "$installer" 'uninstall stops the xcodebuild it started even when the runner no longer answers' \
    "the dead runner's xcodebuild test" 0005
  require_test "$installer" 'a runner that never comes up fails the start, and the xcodebuild launched for it is stopped' \
    "the failed start's xcodebuild test" 0005
  require_test "$client/TEST-maestro.drivers.IOSDriverTest.xml" \
    "the view hierarchy carries each element's XCUIElement type as its class" "the element type test" 0006
  require_test "$client/TEST-maestro.drivers.AndroidDriverWindowSettleTest.xml" \
    'a zero waitToSettleTimeoutMs skips the window settle loop and asks the device nothing' "the Android quick tap test" 0007
  require_test "$client/TEST-maestro.drivers.AndroidDriverWindowSettleTest.xml" \
    'a zero waitToSettleTimeoutMs without an app id skips the hierarchy comparison and asks the device nothing' \
    "the Android settle-after-tap test" 0008
  require_test "$client/TEST-maestro.TapRetryTest.xml" \
    'retryTapIfNoChange with a zero settle timeout taps again when the first tap changed nothing' "the quick tap retry test" 0008
  require_test "$cli/TEST-maestro.cli.mcp.tools.RunToolTest.xml" \
    "inline run echoes only the env the caller passed, and the flow still gets the shell's MAESTRO_ variables" \
    "the run tool's env test" 0009
  require_test "$driver/TEST-xcuitest.RunnerTokenTest.xml" 'a random token carries 256 bits and differs on every launch' \
    "the runner token test" 0020
  require_test "$installer" 'a runner that refuses the token holds the port, so start fails without launching a runner' \
    "the port-taken test" 0020
  require_test "$installer" 'a runner that takes the port with another token while ours starts fails the start and stops our xcodebuild' \
    "the port-taken-during-start test" 0020
  require_test "$cli/TEST-maestro.cli.mcp.McpSessionRunnerTakenTest.xml" \
    "a session whose port another Maestro's runner took is rebuilt on a new port, and that runner is left alone" \
    "the MCP rebuild test" 0020
  require_test "$client/TEST-maestro.xctestdriver.XCTestDriverClientTest.xml" \
    'every request to the runner carries the runner token' "the runner token header test" 0020
  require_test "$env/TEST-maestro.orchestra.util.EnvTest.xml" \
    'withInjectedShellEnvVars never hands the runner token to flows' "the flow env token test" 0020
  require_test "$cli/TEST-maestro.cli.session.MaestroSessionManagerTest.xml" \
    'an iOS session without a driver host port takes a free port, not the 22087 every such session used to share' \
    "the CLI session's runner port test" 0021
  require_test "$cli/TEST-maestro.cli.session.MaestroSessionManagerTest.xml" \
    'an iOS session uses the driver host port its caller passed' "the CLI session's explicit port test" 0021
}

verify_distribution() {
  step "Checking the distribution"
  local dist="$src/maestro-cli/build/distributions/maestro.zip" stage="$work_root/stage"
  [ -s "$dist" ] || die "Gradle didn't produce $dist (log: $logs/gradle.log)."
  rm -rf "$stage"
  mkdir -p "$stage"
  unzip -q "$dist" -d "$stage"

  reported=$("$stage/maestro/bin/maestro" --version 2>/dev/null | tail -n 1) ||
    die "the built 'maestro --version' failed."
  [ "$reported" = "$version" ] ||
    die "the built 'maestro --version' prints '$reported', not $version. Check 0004-build-version.patch."

  local jar="$stage/maestro/lib/maestro-ios-driver.jar" artifact entry shipped i=0
  for artifact in "${runner_artifacts[@]}"; do
    entry=${artifact#maestro-ios-driver/src/main/resources/}
    shipped=$(unzip -p "$jar" "$entry" | sha256) || die "$jar has no $entry."
    [ "$shipped" = "${fresh_hashes[$i]}" ] ||
      die "the distribution's $entry isn't the runner built in this run."
    i=$((i + 1))
  done
  printf '    maestro --version: %s\n' "$reported"
  printf '    runner: the %d runner files in lib/maestro-ios-driver.jar match this run'"'"'s build, and its zips differ from the prebuilt ones in %s\n' \
    "${#runner_artifacts[@]}" "$maestro_tag"

  if ! "$here/test/no_telemetry.sh" "$stage/maestro" >"$logs/no-telemetry.log" 2>&1; then
    sed 's/^/    /' "$logs/no-telemetry.log" >&2
    die "the distribution still carries telemetry (log: $logs/no-telemetry.log). Check the patches 0010-0014, and whether a new Maestro tag added another reporting path."
  fi
  sed 's/^/    telemetry: /' "$logs/no-telemetry.log"
}

package() {
  local name="maestro-$version.zip" pkg="$work_root/package"
  mkdir -p "$out_dir"
  out_dir=$(cd "$out_dir" && pwd)
  rm -rf "$pkg"
  mkdir -p "$pkg/maestro"
  cp "$src/maestro-cli/build/distributions/maestro.zip" "$pkg/$name"
  cp "$here/LICENSE-maestro" "$here/NOTICE" "$pkg/maestro/"
  (cd "$pkg" && zip -q "$name" maestro/LICENSE-maestro maestro/NOTICE)

  cp "$pkg/$name" "$out_dir/.$name.partial"
  mv -f "$out_dir/.$name.partial" "$out_dir/$name"
  (
    cd "$out_dir"
    shasum -a 256 "$name" >".$name.sha256.partial"
    mv -f ".$name.sha256.partial" "$name.sha256"
    shasum -a 256 -c "$name.sha256" >/dev/null
  ) || die "writing or checking $out_dir/$name.sha256 failed."
  zip_path="$out_dir/$name"
}

read_pin
stamp_version
[ "$(uname -s)" = Darwin ] || die "the iOS runner builds only on macOS."
for tool in git zip unzip shasum cmp awk shlock; do
  command -v "$tool" >/dev/null || die "'$tool' is not on PATH."
done
find_jdk17
check_xcode
if [ "$release" = true ]; then
  step "Building the release Maestro $version from $maestro_tag (JDK 17 from $java_origin)"
else
  step "Building a local Maestro $version from $maestro_tag (JDK 17 from $java_origin); only the release workflow builds $build_version"
fi

lock_work
prepare_source
apply_patches
check_notice
build_runner
test_runner_library
build_distribution
verify_distribution
package

step "Done in $(($(date +%s) - started)) s"
printf '    zip:    %s\n    sha256: %s\n' "$zip_path" "$(cut -d ' ' -f 1 "$zip_path.sha256")"

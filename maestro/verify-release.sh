#!/usr/bin/env bash
set -euo pipefail

# shasum is a Perl script, and Perl prints a locale warning on every call when
# LC_ALL names a locale macOS doesn't have.
export PERL_BADLANG=0

usage() {
  cat <<'EOF'
Usage: maestro/verify-release.sh [--repo OWNER/NAME] <maestro-vVERSION>
       maestro/verify-release.sh --from-dir DIR

Checks a patched Maestro build the way the toolkit does on first use: the
zip matches its .sha256, unpacks to maestro/bin/maestro, 'maestro --version'
prints VERSION, and 'maestro mcp --no-viewer' answers an MCP initialize
request. Then prints the sha256 to pin.

With a tag, downloads the release's assets with 'gh release download' (from
--repo, else the repository gh resolves from this checkout). With --from-dir,
checks the single maestro-<VERSION>.zip and its .sha256 in DIR, as written by
maestro/build.sh.

JDK 17 comes from JAVA_HOME, else /usr/libexec/java_home -v 17, else
Homebrew's openjdk@17.
EOF
}

die() {
  printf 'verify-release.sh: error: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '==> %s\n' "$*"
}

tag='' from_dir='' repo=''
while [ $# -gt 0 ]; do
  case "$1" in
    --from-dir)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      from_dir=$2
      shift 2
      ;;
    --repo)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      repo=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      printf 'verify-release.sh: unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      [ -z "$tag" ] || { usage >&2; exit 2; }
      tag=$1
      shift
      ;;
  esac
done
if [ -n "$from_dir" ]; then
  { [ -z "$tag" ] && [ -z "$repo" ]; } || { usage >&2; exit 2; }
else
  [ -n "$tag" ] || { usage >&2; exit 2; }
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/maestro-verify.XXXXXX")
mcp_pid=''
cleanup() {
  if [ -n "$mcp_pid" ] && kill -0 "$mcp_pid" 2>/dev/null; then
    kill "$mcp_pid" 2>/dev/null || true
    wait "$mcp_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

find_jdk17() {
  local candidate='' prefix spec
  if [ -n "${JAVA_HOME:-}" ]; then
    candidate=$JAVA_HOME
  elif ! candidate=$(/usr/libexec/java_home -v 17 2>/dev/null); then
    candidate=''
    for prefix in /opt/homebrew/opt/openjdk@17 /usr/local/opt/openjdk@17; do
      if [ -x "$prefix/bin/java" ]; then
        candidate=$prefix
        break
      fi
    done
  fi
  if [ -z "$candidate" ] || [ ! -x "$candidate/bin/java" ]; then
    die "no JDK 17 found. Install one with 'brew install openjdk@17', or set JAVA_HOME to a JDK 17 home."
  fi
  spec=$("$candidate/bin/java" -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java\.specification\.version = //p')
  [ "$spec" = 17 ] ||
    die "JAVA_HOME $candidate is Java ${spec:-of unknown version}; Maestro runs on JDK 17. Set JAVA_HOME to a JDK 17 home."
  JAVA_HOME=$candidate
  export JAVA_HOME
}

if [ -n "$from_dir" ]; then
  [ -d "$from_dir" ] || die "$from_dir is not a directory."
  assets=$(cd "$from_dir" && pwd)
  zips=()
  for zip in "$assets"/maestro-*.zip; do
    [ -e "$zip" ] && zips+=("$zip")
  done
  [ "${#zips[@]}" -eq 1 ] ||
    die "$assets must hold exactly one maestro-<VERSION>.zip; it holds ${#zips[@]}."
  name=$(basename "${zips[0]}")
  version=${name#maestro-}
  version=${version%.zip}
else
  [[ $tag =~ ^maestro-v(.+)$ ]] || die "tag '$tag' must look like maestro-v2.11.0-agentlane.1."
  version=${BASH_REMATCH[1]}
  name="maestro-$version.zip"
  assets="$work/assets"
  step "Downloading $name and $name.sha256 from release $tag"
  gh_args=(release download "$tag" --dir "$assets" --pattern "$name" --pattern "$name.sha256")
  [ -z "$repo" ] || gh_args+=(--repo "$repo")
  (cd "$(dirname "${BASH_SOURCE[0]}")" && gh "${gh_args[@]}") || die "'gh ${gh_args[*]}' failed."
fi

zip_path="$assets/$name"
sum_path="$zip_path.sha256"
[ -s "$zip_path" ] || die "$zip_path is missing or empty."
[ -s "$sum_path" ] || die "$sum_path is missing or empty."

step "Checking the sha256 of $name"
read -r expected sum_name <"$sum_path" || true
[[ $expected =~ ^[0-9a-f]{64}$ ]] || die "$sum_path doesn't start with a sha256."
[ "$sum_name" = "$name" ] || die "$sum_path names '$sum_name', not $name."
actual=$(shasum -a 256 <"$zip_path" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] ||
  die "checksum mismatch for $name: the file hashes to $actual, but $name.sha256 says $expected."
printf '    %s\n' "$actual"

step "Unpacking"
unzip -q "$zip_path" -d "$work/unpacked" || die "unzip of $name failed."
maestro="$work/unpacked/maestro/bin/maestro"
[ -x "$maestro" ] || die "$name has no executable maestro/bin/maestro."
for file in LICENSE-maestro NOTICE; do
  [ -s "$work/unpacked/maestro/$file" ] || die "$name has no maestro/$file."
done

find_jdk17

step "Checking maestro --version"
reported=$("$maestro" --version 2>/dev/null | tail -n 1) || die "'maestro --version' failed."
[ "$reported" = "$version" ] ||
  die "version mismatch: 'maestro --version' prints '$reported', but $name is version $version."
printf '    %s\n' "$reported"

step "Running an MCP initialize handshake against maestro mcp --no-viewer"
mkfifo "$work/mcp.in"
mkdir -p "$work/mcp-cwd"
(cd "$work/mcp-cwd" && exec "$maestro" mcp --no-viewer) <"$work/mcp.in" >"$work/mcp.out" 2>"$work/mcp.err" &
mcp_pid=$!
exec 3>"$work/mcp.in"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify-release","version":"1"}}}' >&3
response=''
for _ in $(seq 1 600); do
  response=$(grep -E '"id": ?1[,}]' "$work/mcp.out" | head -n 1 || true)
  [ -z "$response" ] || break
  kill -0 "$mcp_pid" 2>/dev/null || break
  sleep 0.1
done
exec 3>&-
if [ -z "$response" ]; then
  sed 's/^/    /' "$work/mcp.err" | tail -n 20 >&2
  die "maestro mcp --no-viewer gave no initialize response within 60 s."
fi
[[ $response == *'"result"'* && $response == *'"protocolVersion"'* ]] ||
  die "maestro mcp --no-viewer answered initialize without a result: $response"
server_info=$(printf '%s\n' "$response" | sed -n 's/.*"serverInfo":\({[^}]*}\).*/\1/p')
printf '    serverInfo: %s\n' "${server_info:-?}"

step "Verified $name"
printf 'sha256 to pin: %s\n' "$actual"

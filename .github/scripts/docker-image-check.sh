#!/bin/sh
# Usage: docker-image-check.sh <image>
set -eu

image="$1"
root="$(cd "$(dirname "$0")/../.." && pwd)"

fail() {
  echo "::error::$*" >&2
  exit 1
}

want="$(node -p 'require(process.argv[1]).version' "$root/package.json")"
got="$(docker run --rm "$image" --version)" || fail "docker run --rm $image --version exited $?"
[ "$got" = "$want" ] || fail "the image's agentlane --version printed '$got', but package.json's version is $want"
echo "--version: $got"

uid="$(docker run --rm --entrypoint id "$image" -u)" || fail "docker run --entrypoint id $image failed"
[ "$uid" != 0 ] || fail "the image runs as root; its USER should be node"
echo "id: $(docker run --rm --entrypoint id "$image")"

node - "$image" <<'EOF'
const { spawnSync } = require('node:child_process');
const image = process.argv[2];
const requests = [
  { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'docker-image-check', version: '1' } } },
  { method: 'notifications/initialized' },
  { id: 2, method: 'tools/list' },
];
const fail = message => {
  console.error(`::error::${message}`);
  process.exit(1);
};
const ran = spawnSync('docker', ['run', '-i', '--rm', image], {
  input: requests.map(r => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n',
  encoding: 'utf8',
  timeout: 120_000,
});
if (ran.error) fail(`docker run -i --rm ${image}, the MCP server, did not finish: ${ran.error.message}`);
if (ran.status !== 0) fail(`the MCP server exited ${ran.status} after stdin closed; stderr: ${ran.stderr.trim()}`);
const answers = new Map();
for (const line of ran.stdout.split('\n').filter(l => l.trim() !== '')) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(`the MCP server wrote a line that is not JSON on stdout: ${line}`);
  }
  answers.set(message.id, message);
}
const init = answers.get(1)?.result;
if (!init?.serverInfo) fail(`the MCP server gave no initialize result; stdout: ${ran.stdout.trim()}; stderr: ${ran.stderr.trim()}`);
const tools = answers.get(2)?.result?.tools;
if (!Array.isArray(tools)) fail(`the MCP server gave no tools/list result; stdout: ${ran.stdout.trim()}`);
const names = tools.map(t => t.name).sort();
const expected = ['look', 'run', 'screenshot'];
if (names.join(',') !== expected.join(',')) fail(`tools/list named ${names.join(', ')}; expected ${expected.join(', ')}`);
console.log(`MCP: ${init.serverInfo.name} ${init.serverInfo.version}, protocol ${init.protocolVersion}, tools ${names.join(', ')}`);
EOF

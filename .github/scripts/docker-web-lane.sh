#!/bin/sh
# Usage: docker-web-lane.sh <image> <evidence folder>
set -eu

image="$1"
evidence="$2"
mkdir -p "$evidence"
evidence="$(cd "$evidence" && pwd)"
root="$(cd "$(dirname "$0")/../.." && pwd)"

fail() {
  echo "::error::$*" >&2
  exit 1
}

docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --volume "$root:/work" \
  --volume "$evidence:/evidence" \
  --env EXPO_NO_TELEMETRY=1 \
  --entrypoint sh \
  "$image" /work/.github/scripts/docker-web-lane-inside.sh /evidence \
  || fail "the web lane in the container failed; the log above names the step"

node - "$evidence" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const evidence = process.argv[2];
const fail = message => {
  console.error(`::error::${message}`);
  process.exit(1);
};
const doctor = JSON.parse(fs.readFileSync(path.join(evidence, 'doctor.json'), 'utf8'));
for (const name of ['browser driver', 'browser libraries', 'browser']) {
  const check = doctor.checks.find(c => c.name === name);
  if (!check) fail(`doctor in the container had no '${name}' check`);
  if (!check.ok) fail(`doctor in the container failed '${name}': ${check.detail}`);
  console.log(`doctor: ${name}: ${check.detail}`);
}
const file = path.join(evidence, 'web.png');
const png = fs.readFileSync(file);
if (png.length < 1000 || png.toString('latin1', 1, 4) !== 'PNG') fail(`${file} is not a screenshot`);
console.log(`${file}: a ${png.length}-byte PNG`);
EOF

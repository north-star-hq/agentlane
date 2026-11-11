#!/bin/sh
set -eu

die() {
  echo "lane-pg: $*" >&2
  exit 1
}

[ $# -eq 1 ] || die "usage: scripts/lane-pg.sh create|drop"

server="${LANE_PG_SERVER:-postgres://localhost:5432}"
prefix="${LANE_PG_PREFIX:-app}"
migrations="${LANE_PG_MIGRATIONS:-migrations}"
lane_db="${prefix}_${AGENTLANE_LANE:?}"

sql() {
  psql "$server/postgres" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"
}

exists() {
  [ -n "$(sql "SELECT 1 FROM pg_database WHERE datname = '$1'")" ]
}

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi
}

fingerprint() {
  [ -d "$migrations" ] || die "no migrations folder at $migrations"
  {
    find "$migrations" -type f | LC_ALL=C sort | while IFS= read -r file; do
      printf '%s %s\n' "$(sha <"$file" | cut -c1-64)" "$file"
    done
    printf 'migrate %s\n' "${LANE_PG_MIGRATE:-}"
  } | sha | cut -c1-12
}

migrate() {
  if [ -n "${LANE_PG_MIGRATE:-}" ]; then
    DATABASE_URL="$1" sh -c "$LANE_PG_MIGRATE"
  else
    find "$migrations" -type f -name '*.sql' | LC_ALL=C sort | while IFS= read -r file; do
      psql "$1" -X -q -v ON_ERROR_STOP=1 -f "$file"
    done
  fi
}

build_template() {
  template="$1"
  build="${template}_build"
  if exists "$template"; then return; fi
  sql "DROP DATABASE IF EXISTS \"$build\" WITH (FORCE)"
  sql "CREATE DATABASE \"$build\""
  migrate "$server/$build"
  sql "ALTER DATABASE \"$build\" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false"
  sql "ALTER DATABASE \"$build\" RENAME TO \"$template\""
}

case "$1" in
  create)
    fp="$(fingerprint)"
    template="${prefix}_template_$fp"
    if ! exists "$template"; then
      psql "$server/postgres" -X -q -v ON_ERROR_STOP=1 >/dev/null <<EOF
SELECT pg_advisory_lock($((0x$fp)));
\! sh "$0" build-template </dev/null >&2
EOF
      exists "$template" || die "could not build the template $template; see the output above"
    fi
    sql "DROP DATABASE IF EXISTS \"$lane_db\" WITH (FORCE)"
    sql "CREATE DATABASE \"$lane_db\" TEMPLATE \"$template\""
    echo "DATABASE_URL=$server/$lane_db" >>"${AGENTLANE_EXPORTS:?}"
    ;;
  drop)
    sql "DROP DATABASE IF EXISTS \"$lane_db\" WITH (FORCE)"
    ;;
  build-template)
    build_template "${prefix}_template_$(fingerprint)"
    ;;
  *)
    die "usage: scripts/lane-pg.sh create|drop"
    ;;
esac

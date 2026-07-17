#!/usr/bin/env bash
# scripts/db-test.sh — apply migrations to a plain Postgres and run the RLS
# attack suite. This is what CI calls.
#
# Usage:
#   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres ./scripts/db-test.sh
#   ./scripts/db-test.sh postgres://postgres:postgres@localhost:5432/postgres
#
# Against a REAL Supabase database: SKIP _bootstrap.sql (Supabase already owns
# the auth schema/roles/extensions) and do NOT hand-apply migrations — the
# Supabase GitHub integration applies supabase/migrations/*.sql. Run only:
#   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_attack.sql
set -euo pipefail

DATABASE_URL="${1:-${DATABASE_URL:-}}"
if [ -z "$DATABASE_URL" ]; then
  echo "usage: DATABASE_URL=postgres://user:pass@host:port/db $0" >&2
  echo "   or: $0 postgres://user:pass@host:port/db" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

echo "==> applying CI bootstrap (plain-PG shim — never run on real Supabase)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/_bootstrap.sql

for f in $(ls supabase/migrations/*.sql | sort); do
  echo "==> applying migration: $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "==> running RLS attack suite"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_attack.sql

echo "db-test.sh: SUCCESS — bootstrap, migrations, and RLS attack suite all passed"

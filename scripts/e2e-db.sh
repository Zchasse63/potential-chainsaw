#!/usr/bin/env bash
# WS-2 — reset a LOCAL Supabase DB to the migration set + the E2E harness seed,
# ready for a Playwright run. NEVER point this at a shared or production DB.
#
# The member API route reaches data through the Supabase JS client (PostgREST),
# so E2E needs a full LOCAL SUPABASE stack (`supabase start`), not a bare
# Postgres. `supabase db reset` is the canonical path that applies
# supabase/migrations/*.sql into that stack; we then layer the test-only seed.
#
# Env:
#   E2E_DATABASE_URL  direct Postgres URL of the local stack
#                     (default: the Supabase-local default on 54322)
set -euo pipefail

DB_URL="${E2E_DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

echo "[e2e-db] applying migrations via supabase db reset (local stack)"
if command -v supabase >/dev/null 2>&1; then
  supabase db reset --no-seed
else
  echo "[e2e-db] supabase CLI not found — falling back to a raw psql migration apply."
  echo "         (This path does NOT start PostgREST; the API needs the full stack.)"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/_bootstrap.sql
  for f in supabase/migrations/*.sql; do
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"
  done
fi

echo "[e2e-db] applying supabase/tests/seed.e2e.sql"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/seed.e2e.sql

echo "[e2e-db] ready — one published 'Morning Contrast' session for tenant e2e00000-…-000000000001"

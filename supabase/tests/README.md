# supabase/tests — portable RLS attack suite

Plain-SQL cross-tenant attack tests for the Phase 0 tenancy core. No pgTAP, no
Docker dependency, no Supabase CLI: everything runs through
`psql -v ON_ERROR_STOP=1`, so the same files run against a throwaway
`postgres:17` container and against a real Supabase database.

## Files

- `_bootstrap.sql` — CI/local-only shim recreating what hosted Supabase already
  provides: the `anon` / `authenticated` / `service_role` roles (service role
  with `BYPASSRLS`), the `auth` schema, `auth.users`, `auth.uid()` /
  `auth.role()` reading `request.jwt.claims`, and `pgcrypto`. Idempotent.
  **Never run it against a real Supabase database** — Supabase owns those
  objects and the shim would redefine them.
- `rls_attack.sql` — the attack suite. Wrapped in `BEGIN … ROLLBACK`, so it is
  non-destructive and safe on a shared dev branch. Seeds tenant A + tenant B
  (second tenant from day 0, per the threat model), then asserts:
  every `tenant_id` table has RLS + a policy (generic guard, invariant #7),
  public matviews are unreadable by client roles (guard exists; no matviews in
  phase 0), cross-tenant SELECT/INSERT/UPDATE/DELETE are denied, the definer
  helpers re-verify tenancy, `audit_events` is append-only even for one's own
  tenant, and anon gets nothing. Any failure does `RAISE EXCEPTION 'RLS-FAIL: …'`
  and psql exits non-zero; success ends with `RLS ATTACK SUITE PASSED (N)`.

## Run locally (plain Postgres 17)

Needs a Postgres 17 server with the contrib modules `citext`, `btree_gist`,
`pgcrypto` (all ship in the `postgres:17` image and in Homebrew
`postgresql@17`), and a superuser connection:

```sh
docker run --rm -d --name kelo-pg \
  -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres ./scripts/db-test.sh
docker rm -f kelo-pg
```

`scripts/db-test.sh` runs `_bootstrap.sql` → every `supabase/migrations/*.sql`
in filename order → `rls_attack.sql`, each with `ON_ERROR_STOP=1`.

## CI

Provision a `postgres:17` service container, wait for it to accept connections,
then call `scripts/db-test.sh` with its `DATABASE_URL`. That is the whole job —
no Supabase CLI, no pgTAP install.

## Against real Supabase (dev/preview branch)

Do **not** run `_bootstrap.sql` and do **not** hand-apply migrations — the
Supabase GitHub integration applies `supabase/migrations/`. Run the suite alone;
it is read-only in effect thanks to the outer `ROLLBACK`:

```sh
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_attack.sql
```

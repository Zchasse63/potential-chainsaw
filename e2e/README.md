# E2E (Playwright) — WS-2 scaffold

End-to-end browser tests for the **member surface**, kept deliberately separate
from the required CI so a browser/stack flake can never block a merge.

> **Status: ready-to-enable infrastructure.** The seed is verified against the
> real `member_schedule` RPC (see below), the config/spec use the real routes
> and selectors, and none of it touches the required `CI` workflow. The
> end-to-end **run itself** is verified in an environment with a browser + a
> local Supabase stack — the build agent that scaffolded this has neither, so it
> proved every part it could (seed → RPC, no-CI-break) and left the live run to
> the first CI/owner execution.

## Why this needs a full local Supabase (not just Postgres)

The anonymous schedule route (`apps/api/src/routes/member.ts` → `GET
/api/v1/member/schedule`) reads through the **Supabase JS client**
(`client().rpc("member_schedule", …)`), i.e. PostgREST — not a raw pg
connection. So the stack under test is:

```
local Supabase (Postgres + PostgREST + Auth)
        ▲                         ▲
        │ supabase/migrations     │ service-role client
        │ + seed.e2e.sql          │
   scripts/e2e-db.sh         apps/api (Hono, :8787, /api/v1)
                                   ▲
                                   │ KELO_API_ORIGIN
                             apps/member (TanStack Start SSR, :4174)
                                   ▲
                                   │ Playwright (chromium)
                              e2e/smoke.spec.ts
```

## What the smoke proves

`e2e/smoke.spec.ts` asserts the member app SSRs the anonymous public schedule
and shows the one row seeded by `supabase/tests/seed.e2e.sql` — offering
**"Morning Contrast"**, with its honest `Book Morning Contrast` link pointing at
`/book/<session_id>`. Passing it means the whole chain is sound
(Supabase → `member_schedule` → API → `member-core` → SSR loader →
`schedule-page.tsx`).

The seed was verified against the **live production schema**: `member_schedule`
over a `now()..now()+7d` window returns exactly this one session.

## Run against the LIVE project (read-only) — no seed, no local Supabase

The public schedule is public marketing data (zero attendee/person data), so the
read path is safe to E2E against production. This mode needs **no Docker, no
local Supabase, no seed** — just the API + member app pointed at the live
project, and `KELO_E2E_NO_WEBSERVER=1` so Playwright reuses the servers you
started. **Verified green** this way (`e2e/live-schedule.spec.ts`):

```bash
# 1. API against the live project (reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
#    from .env; anon key defaults from SUPABASE_PUBLISHABLE_KEY)
( set -a; . ./.env; set +a
  export SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-$SUPABASE_PUBLISHABLE_KEY}" PORT=8787
  pnpm --filter @kelo/api build && node apps/api/dist/server.js ) &

# 2. member app pointed at that API + the real tenant
KELO_API_ORIGIN=http://127.0.0.1:8787 \
KELO_TENANT_ID=<the studio's tenant id> \
KELO_TENANT_TIMEZONE=America/New_York \
  pnpm --filter @kelo/member dev --port 4174 &

# 3. the browser test — reuses the running servers
KELO_E2E_NO_WEBSERVER=1 KELO_MEMBER_ORIGIN=http://localhost:4174 \
  pnpm exec playwright test live-schedule
```

`live-schedule.spec.ts` asserts the chain renders **truthfully** — header +
EITHER real session rows OR the honest "nothing published yet" empty state, and
never a provenance-violation refusal or an error page. It is resilient to the
live book being empty (pre-cutover) or full.

> The **write/auth flows (WS-10)** are NOT safe against prod — they mutate real
> ledgers/Stripe, send a real OTP, and Playwright would snapshot real member PII
> into artifacts (public repo). Run those against an isolated **Supabase branch**
> (or the seeded local stack below), never the live project.

## Run it locally (seeded, isolated)

```bash
# 0. one-time: the browser binary
pnpm exec playwright install --with-deps chromium

# 1. bring up a THROWAWAY local Supabase (applies supabase/migrations)
supabase start

# 2. reset + seed the harness data
pnpm run e2e:db          # scripts/e2e-db.sh

# 3. build the API (its dev server runs the compiled dist)
pnpm --filter @kelo/api build

# 4. export the local Supabase creds so the API can reach PostgREST
export SUPABASE_URL="$(supabase status -o env | sed -n 's/^API_URL=//p')"
export SUPABASE_ANON_KEY="$(supabase status -o env | sed -n 's/^ANON_KEY=//p')"
export SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | sed -n 's/^SERVICE_ROLE_KEY=//p')"

# 5. run — Playwright starts both dev servers (see playwright.config.ts webServer)
pnpm run e2e
```

### Env the config threads

| var | consumer | value |
| --- | --- | --- |
| `PORT` | apps/api dev server | `8787` |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | apps/api | from `supabase status` |
| `KELO_API_ORIGIN` | apps/member SSR | `http://127.0.0.1:8787` |
| `KELO_TENANT_ID` | apps/member SSR | `e2e00000-0000-4000-8000-000000000001` (the seeded tenant) |
| `KELO_TENANT_TIMEZONE` | apps/member SSR | `UTC` |

## Enabling it in CI (opt-in, non-required)

Add `.github/workflows/e2e.yml` with `on: workflow_dispatch` so it stays a
manual, non-blocking job (keep the `CI` workflow the required gate). Sketch:

```yaml
name: E2E (Playwright, member surface)
on: workflow_dispatch          # manual only — never a required PR check
permissions: { contents: read }
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.15.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      - run: supabase start                         # applies supabase/migrations
      - run: psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
             -v ON_ERROR_STOP=1 -f supabase/tests/seed.e2e.sql
      - run: pnpm --filter @kelo/api build
      - run: pnpm exec playwright install --with-deps chromium
      - run: |
          {
            echo "SUPABASE_URL=$(supabase status -o env | sed -n 's/^API_URL=//p')"
            echo "SUPABASE_ANON_KEY=$(supabase status -o env | sed -n 's/^ANON_KEY=//p')"
            echo "SUPABASE_SERVICE_ROLE_KEY=$(supabase status -o env | sed -n 's/^SERVICE_ROLE_KEY=//p')"
          } >> "$GITHUB_ENV"
      - run: pnpm exec playwright test
        env: { CI: "true" }
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with: { name: playwright-report, path: playwright-report/, retention-days: 7 }
```

## Next: WS-10 flow specs

This scaffold covers the **public** (unauthenticated) path only. The
authenticated flows (OTP sign-in, booking, waitlist) need one more seam: the
member OTP is sha256-at-rest, so an E2E must read the code out of band. Add an
`apps/api/src/server.e2e.ts` that wires `sendMemberOtp` → a Mailpit SMTP
inbox, then Playwright reads the code from Mailpit's HTTP API. That is WS-10 —
built on exactly this harness.

## Isolation guarantees (why this can't break `CI`)

- Vitest's include globs (`vitest.config.ts`) never match `e2e/` → `pnpm -w
  test` ignores these specs.
- `e2e/**` + `playwright.config.ts` are in the ESLint ignore list → `pnpm -w
  lint` skips them.
- `e2e/tsconfig.json` is standalone (not referenced by the root tsconfig) →
  `tsc -b` (`pnpm -w typecheck`) never compiles them.
- `e2e/` is not a workspace package → `pnpm -r build` never touches it.

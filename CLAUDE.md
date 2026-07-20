# Kelo — agent contract

This file is the standing contract for any AI coding agent working in this repo. The plans it
points to are code-verified sources of truth; markdown that contradicts schema, contracts, or
tests is wrong (fix the drift, don't compound it).

## Authoritative documents

- **Build plan:** [plans/plan-final.md](plans/plan-final.md) — architecture, data model, phases,
  gates. Do not deviate without recording the change in its §10 changelog.
- **UX plan:** [plans/plan-ux-final.md](plans/plan-ux-final.md) — IA, flows, interaction rules,
  component allowlist, token architecture.
- **Member surface plan:** [plans/plan-member-app.md](plans/plan-member-app.md) — the member web
  (TanStack Start SSR, `apps/member`) + iOS/Android (Expo) apps: the custom API-minted session /
  OTP / claiming spine, `packages/member-core` (framework-agnostic client shared by web + mobile),
  and the shared `packages/ui` design system. Member clients ship **zero Supabase material**.
- **Glofox API:** [docs/glofox/README.md](docs/glofox/README.md) — live-verified shapes and
  traps. Never guess a Glofox payload shape; every mapper cites a pinned sample in
  `docs/glofox/samples/`.
- **Intelligence content:** [plans/plan-intelligence.md](plans/plan-intelligence.md) — segment
  rules, briefing pipeline, revenue dictionary.
- **Security gates:** [plans/threat-model.md](plans/threat-model.md) — phase-keyed checklists.
- **Live status / what's next:** [plans/execution-remainder.md](plans/execution-remainder.md) —
  the wave-by-wave remaining-work DAG and sequencing; the current source of truth for "what's next"
  (the build has progressed through the phase-7 cutover machinery into the phase-8 member surface).

## Standing invariants (violations are defects, not choices)

1. **The release rule:** no "fixed/done" claim without (a) captured evidence, (b) a test that
   failed before the fix, (c) a production-visible health signal.
2. **No fixture/demo data reachable from app code paths** — seed data exists only in staging/CI.
3. **Every API response carries the freshness envelope** `{ data, meta: { as_of, source, stale } }`;
   UI renders data only through the `DataBoundary` provenance contract.
4. **Exactly one scheduler:** the Netlify tick + Postgres `jobs` queue. Never add a second cron.
5. **Money/booking mutations are Postgres RPCs** with idempotency keys; no optimistic UI for
   money or bookings; Stripe webhooks are the confirmation authority.
6. **Ledgers are append-only** — no mutable balance columns anywhere.
7. **RLS on every table, membership-based;** every new table/matview/RPC gets a generated
   cross-tenant attack test. `SECURITY DEFINER` functions re-verify tenancy in-body.
8. **Glofox client rules:** `success !== true` throws; the transactions report's `namespace` is
   non-optional at the type level; timestamps parse at the Zod boundary; unknown
   `glofox_event` values quarantine, never classify.
9. **Schema ships with the feature that writes it** — no speculative tables or empty screens.
10. **One pattern per job:** compose from the UX plan's component allowlist; new patterns need a
    written reason.
11. **Member clients ship zero Supabase material** — `apps/member` (and the future Expo app) hold
    no anon key, URL, or `@supabase` import; they reach data only through `apps/api`. CI greps the
    built member bundle. Member auth is API-minted opaque `kmb_` sessions (sha256 at rest,
    host-only cookie) — no member JWTs, no PostgREST tokens.

## Workflow

- Migrations live in `supabase/migrations/` (schema-as-code; deployed by the Supabase GitHub
  integration on merge to `main`; PRs get preview branches). After any schema change, run the
  portable RLS attack suite (`supabase/tests/rls_attack.sql`) — it dynamically covers every
  tenant-scoped table and every new RPC/policy.
- Secrets: `.env` locally, Netlify/Supabase env in deploys, Supabase Vault for per-tenant
  credentials. The service role key never appears client-side; CI greps built artifacts.
- Zod schemas in `packages/contracts` are the single source of truth for shapes.
- Workspace layout: **apps/** — `api` (the one Hono API, base `/api/v1`), `web` (operator SPA),
  `member` (member SSR). **packages/** — `contracts`, `ui` (tokens + Tailwind preset + brands +
  surface-neutral react components), `db`, `comms`, `glofox`, `stripe`, `member-core`. **workers/**
  (the single scheduler tick + `jobs` processors), **netlify/** (function entrypoints).

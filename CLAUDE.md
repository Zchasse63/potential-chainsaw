# Kelo — agent contract

This file is the standing contract for any AI coding agent working in this repo. The plans it
points to are code-verified sources of truth; markdown that contradicts schema, contracts, or
tests is wrong (fix the drift, don't compound it).

## Authoritative documents

- **Build plan:** [plans/plan-final.md](plans/plan-final.md) — architecture, data model, phases,
  gates. Do not deviate without recording the change in its §10 changelog.
- **UX plan:** [plans/plan-ux-final.md](plans/plan-ux-final.md) — IA, flows, interaction rules,
  component allowlist, token architecture.
- **Glofox API:** [docs/glofox/README.md](docs/glofox/README.md) — live-verified shapes and
  traps. Never guess a Glofox payload shape; every mapper cites a pinned sample in
  `docs/glofox/samples/`.
- **Intelligence content:** [plans/plan-intelligence.md](plans/plan-intelligence.md) — segment
  rules, briefing pipeline, revenue dictionary.
- **Security gates:** [plans/threat-model.md](plans/threat-model.md) — phase-keyed checklists.

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

## Workflow

- Migrations live in `supabase/migrations/` (schema-as-code; deployed by the Supabase GitHub
  integration on merge to `main`; PRs get preview branches).
- Secrets: `.env` locally, Netlify/Supabase env in deploys, Supabase Vault for per-tenant
  credentials. The service role key never appears client-side; CI greps built artifacts.
- Zod schemas in `packages/contracts` are the single source of truth for shapes.

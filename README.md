# Kelo

A studio-operations platform for boutique recovery/wellness studios (sauna + cold plunge) —
booking, payments, memberships, marketing, compliance, retail — with an AI intelligence layer
built in. Built to replace the incumbent booking system (Glofox) via a staged strangler-fig
takeover, then sold as multi-tenant SaaS.

## Documentation map (read in this order)

| Doc | What it is |
|---|---|
| [plans/plan-final.md](plans/plan-final.md) | **The authoritative build plan** — architecture, data model, API, import/migration, payments, phases, risks |
| [plans/plan-ux-final.md](plans/plan-ux-final.md) | The authoritative UX/UI plan — IA, flows, interaction rulebook, component/token system |
| [plans/plan-intelligence.md](plans/plan-intelligence.md) | Segment catalog, briefing pipeline, revenue dictionary, evals |
| [docs/glofox/README.md](docs/glofox/README.md) | **Glofox API source of truth** — spec, live-verified shapes, traps, pinned samples |
| [plans/threat-model.md](plans/threat-model.md) | Threat model + phase-keyed security review gates |
| [plans/legal-readiness.md](plans/legal-readiness.md) | Legal artifact inventory (Florida) + retention matrix |
| [plans/owner-questions.md](plans/owner-questions.md) | Open owner decisions and their status |

Plans were produced by a 4-model planning council (2026-07) and adversarially verified; the
`plans/` directory retains the full council record (independent plans, blind critiques, briefs).

## Stack

Supabase (Postgres + Auth + RLS) · Netlify (hosting + functions) · Stripe (Connect) ·
Anthropic Claude · Vite + React SPA (operator) · Hono API · pnpm workspace.
Schema-as-code: `supabase/migrations/` deploys via the Supabase GitHub integration.

## Status

**Phase 0 (Foundations + reality probes): built** — workspace + `@kelo/contracts` (pinned Glofox
sample contracts), tenancy + membership RLS + the generated cross-tenant attack suite (53 asserts
green on Postgres 17, incl. intra-tenant hardening), the jobs queue + single scheduler tick
(double-tick disjointness proven), the Hono API (freshness envelope, server-derived tenant,
`/health`), and the operator web shell + Health v0 on the design-token contract. Items needing an
owner/external action for live proof (Netlify deploy, Sentry DSN, heartbeat check, 10DLC filing,
PITR drill) are tracked in [BLOCKERS.md](BLOCKERS.md) — built up to, not faked.
Next: **Phase 1 (Import, correct & observable)**. Phase table: [plans/plan-final.md](plans/plan-final.md) §6.

## Setup

Secrets live in `.env` (never committed) — see `.env.example` once it lands. Requires Node 20+,
pnpm.

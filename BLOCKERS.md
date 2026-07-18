# Kelo — Running Blockers

Things that need an owner action or an external credential the repo doesn't hold. Each is built
**up to** its gate; the code/artifact is in the tree and waiting. We route around and keep building.
Never mark a gated item "passed" — it's "awaiting owner/external."

Legend: 🟥 blocks a phase gate · 🟧 blocks live proof only (code is built) · ✅ resolved

_Last updated: 2026-07-17 (Phase 0 in progress)._

## Phase 0

| # | Item | Owner/external action needed | Status | What's built & waiting |
|---|---|---|---|---|
| P0-1 | **Sentry DSN** (web + functions) | Create Sentry project(s); provide `SENTRY_DSN` / `VITE_SENTRY_DSN` | 🟧 | Sentry init code wired behind env; no-ops without DSN. Live error capture unprovable until DSN set. |
| P0-2 | **Dead-man heartbeat check** | Create a Healthchecks.io (or BetterStack) check; provide `HEARTBEAT_PING_URL` | 🟧 | Scheduler tick pings the URL each run; the "unplug the tick → alert fires" gate proof needs the real check. |
| P0-3 | **Netlify site** | Create/link the Netlify site to the GitHub repo; set env (service role, heartbeat, Sentry) | 🟧 | `netlify.toml` + functions (api, scheduler-tick) in-tree; deploy + live scheduled-function proof needs the site. |
| P0-4 | **10DLC registration** | EIN, use-case + sample messages, opt-in flow description; file with Twilio | 🟥 (phase 3 gate) | **Skeleton privacy page BUILT** (`apps/web/public/privacy.html` — SMS STOP/HELP language, no-third-party-sharing clause per carrier requirements); it gets a public URL with the Netlify deploy (P0-3/P0-9). Filing itself is an owner action with weeks of lead time. |
| P0-5 | **Stripe account-ownership answer** | Confirmed 2026-07-17: **Glofox-gated** (negative branch active). PAN-portability request to Glofox/ABC still to be filed as early as possible. | ✅ (answer) / 🟥 (PAN request) | Reconciliation is Glofox-only pre-phase-5; failed payments from the Glofox report ERROR rows. PAN-portability request is an owner/Glofox action. |
| P0-6 | **Glofox contract / ToS extraction-rights review** (owner-questions A3) | Locate the Glofox contract; review extraction + write rights; open the write-capability conversation with ABC/Glofox | 🟥 | Read probes pinned; non-mutating write-capability discovery (docs/endpoint existence) is buildable. Contractual permission is an owner action. |
| P0-7 | **Glofox webhook signing secret** (A3b) | Email `glofox.apisupport@abcfitness.com` for the studio's webhook secret | 🟧 (phase 1) | Webhook-inbox pattern designed; secret needed to verify HMAC-SHA256 signatures. |
| P0-8 | **PITR + restore drill #1** | Enable Supabase PITR (paid tier feature) on project `ysnijttvprwymwheyyfm`; run a rehearsed restore | 🟧 | Restore-drill runbook to be written; PITR toggle + drill require the owner + a paid plan. |
| P0-9 | **Domains** (owner-questions C1) | Buy `getkelo.com` + `kelo.studio` | 🟧 | Not code-blocking; needed before the public skeleton privacy page + member surface. |
| P0-10 | **Supabase branching / preview DBs disabled** | Enable branching on the Supabase GitHub integration (dashboard → Branches) so PRs get preview DBs (plan-final §1) | 🟧 | **Half-resolved 2026-07-17:** merge-to-main **does** auto-apply migrations (all 6 Phase-0 migrations landed on production minutes after the PR #1 merge, verified via MCP `list_migrations`), and the full attack suite was then run against the production DB non-destructively: **RLS ATTACK SUITE PASSED (PRODUCTION) — 53 assertions**, rollback verified clean. Only the preview-DB-per-PR flow remains off; CI's Postgres-17 `db` job covers PR-time verification meanwhile. |

## Phase 1

| # | Item | Owner/external action needed | Status | What's built & waiting |
|---|---|---|---|---|
| P1-3 | **Moonshot / Kimi K3 account suspended** — `429 insufficient balance` (hit mid-1.6, 2026-07-17) | Recharge the Moonshot account, OR authorize routing coding to Sol/Codex (OpenAI) or Grok instead | 🟥 (blocks further delegated coding) | Kimi is the implementer; it's down. Units 1.4/1.5/1.6 completed just before/at the suspension (verified green). Remaining pure-code units need an implementer; 1.7 is director-run (no Kimi). Director can finish small remainders or route to Sol/Codex per the pipeline's documented fallback. |

## Phase 2+ (recorded early so we don't forget)

| # | Item | Owner/external action | Status |
|---|---|---|---|
| P2-1 | **Anthropic zero-data-retention terms** | Sign ZDR terms when the account is set up | 🟥 (phase 2) |
| P1-1 | **Gold-label session** (~2h, ~80 people) | Owner labels true relationships → the ≥99% derivation gate | 🟥 (phase 1 gate) |
| P1-2 | **Glofox catalog mapping** (~30 min) | Label each catalog item recurring/unlimited/pack/drop-in/intro | 🟥 (phase 1) |
| P2-2 | **Brand-voice card** | 3–5 tone adjectives, we-say/never-say, sign-off, emoji stance, discount philosophy | 🟥 (phase 2–3) |
| P5-1 | **Sales-tax practice** (A6) | Are sessions/retail taxed? Who files? | 🟥 (phase 5) |
| P8-1 | **The Sauna Guys brand assets** | Logo, colors, type for the member-surface skin | 🟧 (phase 8) |

## Owner policy defaults in force (owner-questions §B — using documented defaults until changed)

Briefing 6:00 AM studio time · dunning grace 14d · quiet hours 9 PM–9 AM · marketing cooldown 7d ·
cancel free ≥12h / late-cancel or no-show forfeits 1 credit (no cash fees v1) · refund step-up
$100 · native pack expiry 12 mo · min age 16+ unaccompanied (13–15 w/ guardian) · at-risk 21d ·
hooked 3 visits/30d · stale-credits 30d · credits-expiring 14d · high-value top 10% T12M revenue ·
AI budget $50/tenant/mo · SMS US-only · comms retention 2y / AI artifacts 1y. Studio = Tampa, FL.

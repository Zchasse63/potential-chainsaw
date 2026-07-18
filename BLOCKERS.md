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

## Phase 3

| # | Item | Owner/external action needed | Status | What's built & waiting |
|---|---|---|---|---|
| P3-1 | **CRITICAL pre-SMS-live: canonical E.164 phone (unit 3.1b)** | None — ✅ **RESOLVED 2026-07-18** (merged d1730be, migration 0023 applied) | ✅ / 🟨 (2 polish follow-ups) | Fixed: one immutable `to_e164_us` shared by the generated `people.phone_e164` column + the SMS suppression join; STOP normalizes + matches across tenants + **fails open**; both exact bugs locked by regression tests. Live backfill: 1,334/1,366 people have a canonical SMS identity, 16 correctly NULL. Two polish follow-ups (chips): stricter NANP validation (a `+10000000000` junk placeholder shared by 36 people still passes) and per-tenant Twilio numbers (for attributing truly unmatched STOPs). Neither blocks; both should land before SMS-live. |
| P3-2 | **Resend + Twilio accounts + 10DLC** | Create Resend account (domain verify) + Twilio account; file 10DLC (P0-4). Provide keys. | 🟥 (phase-3 live-send gate) | Adapters run DRY-RUN without keys — the entire comms pipeline (policy, suppression, webhooks, send-processor) is built and test-proven now; live send needs the accounts. 10DLC has weeks of lead time — file early. |

## Phase 1

| # | Item | Owner/external action needed | Status | What's built & waiting |
|---|---|---|---|---|
| P1-3 | **Moonshot / Kimi K3 account suspended** — `429 insufficient balance` (hit mid-1.6, 2026-07-17) | Recharge the Moonshot account, OR authorize routing coding to Sol/Codex (OpenAI) or Grok instead | 🟥→ resolved by switching to Sol/Codex | Superseded: Sol/Codex became the implementer from 1.8 onward. Now see P4-IMPL. |
| P4-IMPL | **BOTH delegated implementers now down** — Sol/Codex hit **"Quota exceeded. Check your plan and billing details"** mid-Phase-4 (2026-07-18); Kimi still suspended | Owner action: top up the Codex/OpenAI billing (fastest), OR authorize the director to hand-write remaining units, OR add a third provider | 🟥 (blocks ALL delegated coding) | Phases 0–4.1 are DONE + merged + green (441 tests). Units **4.2 (scheduling)** and **4.3 (waivers)** are PARTIAL: each has a complete migration + core (4.2: 6 tables + publish RPC + 18-handler API; 4.3: 3 tables incl. append-only signatures + 4 RPCs) but is MISSING tests/web/helper and is **NOT merged** (WIP committed to branches `p4-sched`/`p4-waiver`, isolated in worktrees). Completion briefs staged (`scratchpad/brief4-2b.txt`). Nothing broken on main. Resume the moment an implementer is available. |

## Phase 2+ (recorded early so we don't forget)

| # | Item | Owner/external action | Status |
|---|---|---|---|
| P2-1 | **Anthropic API** | ✅ key received 2026-07-18 (validated live; stored .env-only; owner advised to rotate later since it passed through chat). **ZDR terms still unsigned** — mitigated by design: the briefing synthesis payload is PII-FREE (ids, counts, dollars, segment keys — no names/contacts); sign ZDR before any PII-bearing drafting (phase 3 outreach). | 🟨 (key ✓ / ZDR pending) |
| P1-1 | **Gold-label session** | ✅ **Member cohort CERTIFIED 2026-07-18: 22/22 exact person-level match** between the derivation (v3 + 2 audited NOEQL overrides) and the owner's Current Members export — zero misses either direction. The non-member cohorts (pack/guest/lead spot-labels from the ~80-person protocol) remain a lighter follow-up for phase-2 KPI certification. | ✅ / 🟨 (non-member spot-labels) |
| P1-2 | **Glofox catalog mapping** | ✅ **Done 2026-07-18**: owner confirmed the six sellable items in chat; director applied + obvious legacy/NOEQL equivalents (Student Membership → recurring and the CCCF/sampler packs are director-mapped — owner may adjust; affects segments, not the member count). | ✅ |
| P1-3b | **ClassPass** (was A4 "may not be in use") | ✅ **ANSWERED BY DATA 2026-07-18: ClassPass IS in use** — 182 bookings carry origin 'classpass'; 45 people derive as aggregator. The aggregator segment is real. | ✅ |
| P2-2 | **Brand-voice card** | 3–5 tone adjectives, we-say/never-say, sign-off, emoji stance, discount philosophy | 🟥 (phase 2–3) |
| P5-1 | **Sales-tax practice** (A6) | Are sessions/retail taxed? Who files? | 🟥 (phase 5) |
| P8-1 | **The Sauna Guys brand assets** | Logo, colors, type for the member-surface skin | 🟧 (phase 8) |

## Owner policy defaults in force (owner-questions §B — using documented defaults until changed)

Briefing 6:00 AM studio time · dunning grace 14d · quiet hours 9 PM–9 AM · marketing cooldown 7d ·
cancel free ≥12h / late-cancel or no-show forfeits 1 credit (no cash fees v1) · refund step-up
$100 · native pack expiry 12 mo · min age 16+ unaccompanied (13–15 w/ guardian) · at-risk 21d ·
hooked 3 visits/30d · stale-credits 30d · credits-expiring 14d · high-value top 10% T12M revenue ·
AI budget $50/tenant/mo · SMS US-only · comms retention 2y / AI artifacts 1y. Studio = Tampa, FL.

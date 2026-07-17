# Critique: Four Independent Kelo Build Plans

## Per-plan assessment

### Plan A

**(1) Strongest ideas worth stealing**
- **`glofox_raw_*` + map tables + native tables as a three-layer import model** — clean separation of capture, mapping, and SoR; re-transformable without re-fetch.
- **Gating AI briefings on import health** — if reconciliation fails, refuse to generate rather than narrate garbage. Explicit disagreement with building intelligence before import trust is the right meta-lesson from §5.
- **`person_relationship_log` as immutable history** with nightly materialization — conversion engine (`pack_holder → recurring_member`) becomes queryable rows, not vibes.
- **Cutover bar with 14-day consecutive green + written rollback plan** — concrete and operator-signable.
- **Server Actions + Supabase RPC for money paths** — keeps atomicity in Postgres; good fit for agent-driven work if the RPC surface stays small.

**(2) Weakest points**
- **No serious treatment of Stripe account ownership / card portability.** Brief notes payments already flow through Stripe under Glofox; if that account is platform-owned, cutover forces re-carding. A and C/B handle this; A barely mentions continuation.
- **Relationship model is oversimplified:** one “current” relationship, no simultaneous subscription + residual pack credits. Recovery studios routinely have both; force-ranking into a single enum loses truth.
- **Credit “remaining” denormalized with nightly checksum** is weaker than append-only ledger-as-SoR (B/C). Mutable remaining is a classic drift surface.
- **Phases assume write-back to Glofox in Phase 2 without partitioning inventory** — dual booking of the same room is the migration landmine; A does not say “do not let both systems sell the same slot.”
- **Effort (~20–26 weeks) is optimistic** for owner+agents given §5 verification gates and broad table-stakes. Compresses non-transactional ops and money into timelines that look like staffed-team estimates.

**(3) Brief contradictions / ignored mandates**
- Soft on §5 “verify payload before mapping” as *infrastructure* — probe script in Phase 0 is good, but no pinned samples in-repo + weekly shape-drift diff (B/C/D are stronger).
- Multi-tenancy is present (RLS + `tenant_id`) but org invites/roles are thin compared to the multi-tenant day-one mandate’s operational needs.
- Does not encode “transactions report returns 0 without namespace” as a **typed request builder requirement** — described in prose, not structural.

---

### Plan B

**(1) Strongest ideas worth stealing**
- **Jobs table as the real scheduler; Netlify tick is dumb** — `FOR UPDATE SKIP LOCKED` makes double-execution *impossible*, not merely unlikely. Best structural answer to §5 #7.
- **Probe-and-pin harness + weekly live-shape diff** — §5 #1 as CI infrastructure; mappers traceable to pinned samples.
- **GIST exclusion constraints for room-slot double-booking** — correctness by schema, not convention; load-testable gate.
- **Freshness in every API response envelope** (`meta.as_of / stale`) — UI cannot omit provenance; designs §5 #4 out at the contract level.
- **Card-vault portability called out early** (studio-owned vs Glofox-platform Stripe) — highest-friction cutover risk most plans underweight.
- **External dead-man’s-switch (Healthchecks.io)** — alerts even if the whole scheduler dies; only plan that treats total silence as a failure mode.
- **Disagreement on email-unique invariant** — walk-ins and shared family emails are real; merge tooling > hard unique constraint.
- **`verify_money` nightly vs Stripe balance transactions** — money bugs caught by system, not angry members.

**(2) Weakest points**
- **Monorepo/Turborepo + packages split** may be more operational surface than owner+agents need; Hono SPA is sound, but package boundary discipline is easy for agents to violate.
- **Waitlist only for class-type; room-slots skip** — reasonable scale bet, but recovery waitlists for popular plunge slots are real; should be tenant-config, not hard omit.
- **Phase order puts billing spine (P4) before native booking (P5)** — good (payments last among *member-facing* paths, staff-mediated first), but coupling of Stripe work before capacity engine needs careful sequencing of “staff POS” vs “public book.”
- **30-day cutover bar** is strong but may be operationally brutal for a single studio owner living in dual systems; no intermediate “soft cutover” for one location/resource.
- **`/ask` free-text Q&A with SQL-tool access** — even read-only, this is a PII and hallucination surface; needs tighter guardrails than stated.

**(3) Brief contradictions / ignored mandates**
- Partial disagreement with broad v1 is healthy and well-argued against §5 #8; does not ignore mandate — resolves it.
- Payroll disagreement (pay reporting not execution) is correct and should have been explicit in the brief’s table-stakes reading.
- Slightly light on **authority matrix per capability** (C/D are clearer) during strangler — `source` column helps but write-back graduation flags are only sketched.

---

### Plan C

**(1) Strongest ideas worth stealing**
- **Authority states per capability** (`GLOFOX_AUTHORITATIVE` → `KELO_AUTHORITATIVE_WITH_WRITEBACK` → `KELO_ONLY` → `RETIRED`) — best formalization of strangler-fig; operators can *see* who owns what.
- **Honest treatment of distributed atomicity** — “atomic” ≠ cross-Stripe ACID; holds + outbox + webhooks + compensating refunds. Only plan that refuses the fantasy of single-transaction money+capacity across providers.
- **Booking holds + signed expiring quotes** before payment — essential for capacity races with card checkout; A/D under-specify holds.
- **Effective-dated `person_relationships`** allowing concurrent types — correct domain modeling for “active sub + residual pack.”
- **Immutable prices / `price_phases` for founding→opening→standard ramps** — recovery studios actually do this; mutating old prices is a landmine.
- **Separate credit vs gift-card ledgers + accountant-approved breakage policy** — liability KPI without pretending legal deferred-revenue certainty.
- **Campaign recipient snapshots at approval** + recheck consent at send — marketing correctness at the level money gets.
- **Pilot inventory partition** (“do not let both systems sell the same inventory”) — migration-critical; nearly unique among the four.
- **OpenAPI + versioned contracts + correlation IDs + If-Match** — enterprise-grade API hygiene that scales to multi-tenant SaaS.

**(2) Weakest points**
- **Massive over-engineering for the stated team.** Full journal (`journal_entries`/`journal_lines`), transactional outbox, authority registry, booking holds state machine, Terminal, multi-role RBAC matrix, XLSX exports — this is a 5–10 engineer product. **77–116 builder-weeks** is honest relative to scope, and therefore **incompatible with owner+agents** without years of calendar time. The plan optimizes for correctness so hard it risks never shipping the morning briefing.
- **Speculative schema risk despite §5 #8 rhetoric.** The data model lists dozens of tables (pay_runs, stock_counts, disputes, financial_accounts…) “incrementally” — in practice this reads as a target architecture dump agents will implement empty.
- **Phase 0 alone is 4–6 weeks** before intelligence — owner value delayed vs B/D’s ~6-week briefing path.
- **Next.js + OpenAPI generated clients + modular monolith modules** — more moving parts than SPA+Hono for this team constraint (§6).
- **Effort inflation may violate “sequence real value early”** even while respecting “never compress verification.”

**(3) Brief contradictions / ignored mandates**
- Does not ignore §5 — it is the most thorough mapping of failure modes to design.
- **Conflicts with team-reality constraint** more than with technical constraints: low operational surface / agent-maintainability is stated, then contradicted by surface area.
- Multi-tenant commercial non-goal respected; Phase 8 “hardening for additional tenants” is appropriately deferred but still large.

---

### Plan D

**(1) Strongest ideas worth stealing**
- **`authority` JSONB on tenant per domain** — practical, shippable version of C’s authority matrix without a full registry product.
- **Vite SPA + Hono + disagreement with Next.js** — best alignment with “agent-maintainability / few footguns” for an auth-gated operator app; same thesis as B, stated more bluntly.
- **Relationship derivation with `relationship_reason` jsonb evidence** + gold-label accuracy gate (≥99%) — verification culture made measurable.
- **`former_member` as explicit type** — missing from A/B’s five-type lists; needed for churn/win-back.
- **Import conflicts table for field-level divergence** when native has touched a row — avoids silent overwrite during dual life.
- **Credit liability snapshot in intelligence phase from *imported* credits** — differentiator ships before native billing; smart sequencing.
- **Agent-maintainability standing rules** at the end — operationalizes §5 #9 and §6 team reality better than most.
- **Shadow dual-run with authority flip back in 15 minutes** — concrete rollback UX.

**(2) Weakest points**
- **Book flow sketch still hand-waves Stripe timing** — “Stripe call outside or after intent row” + compensating cancel is right direction but less rigorous than C’s hold/outbox model; risk of paid-without-booking under race.
- **No GIST exclusion for room ranges** — relies on `FOR UPDATE` on session rows; for pure room-slot appointments without a pre-created session instance, overlapping freeform ranges need exclusion constraints (B/C).
- **Email unique partial index** without merge tooling (B/C’s disagreement applies).
- **Write-back de-emphasized almost to zero for booking/payments** — correct strategically, but schedule write-back / profile write-back under-specified vs brief’s “tested write-back” middle stages.
- **Phases P5 payments before P6 booking** is good, but “still no public booking” staff POS needs clear UI scope or it becomes a half-screen.
- **Observability weaker than B** — no external dead-man heartbeat; Sentry + tables may miss total scheduler death.

**(3) Brief contradictions / ignored mandates**
- Solid on §5 #1–#8; slightly lighter on dual-system inventory partition than C.
- Multi-tenancy present; JWT claim approach is fine if claim refresh on org switch is airtight (service-role defense-in-depth is noted).
- Does not contradict verified Glofox facts; encodes quirks as client policy well.

---

## Comparative judgment

| Section | Strongest | Why |
|---|---|---|
| **Architecture** | **B** (edge **D**) | B’s dumb tick + jobs queue + two-zone raw/native + structural no-fixture path is the best team-constrained architecture. D is simpler SPA stack; A’s Next monolith is fine but less distinctive; C is architecturally richest and least buildable by the real team. |
| **Data model** | **C** (steal B’s exclusion constraints + D’s `former_member`) | C alone models concurrent relationships, immutable prices/phases, holds, separate ledgers, and authority. Too big to implement wholesale — treat as the *reference model*, implement slices like B/D. |
| **API** | **B** | Envelope freshness, person-scoped contracts ready for member app, reports with CSV, health as product surface. C’s OpenAPI is more complete but heavier; A’s Server-Actions-only is weakest for multi-client future. |
| **Import / migration** | **B** | Probe-and-pin, typed namespace requirement, plausible-zero config, recon as cutover meter, external heartbeat. C wins on authority matrix and pilot inventory partition — merge those into B’s pipeline. |
| **Booking / payments** | **C** (with B’s GIST + Stripe Billing split) | Only C fully owns holds, outbox, webhook-as-truth, compensating refunds, and “one billing authority per subscription.” B’s exclusion constraints and `verify_money` are mandatory add-ons. A/D are workable but thinner on distributed failure. |
| **Phasing** | **B** (then **D**) | Value by ~week 6 (briefing), verification gates, 10DLC started early, billing before public booking. D similar and slightly clearer authority flips. A too optimistic; C’s 77–116 weeks fails “real value early” for an owner living on Glofox. |
| **Risks** | **C** for coverage; **B** for actionability | C’s risk table is the checklist to keep. B’s mitigations are the ones an agent team can actually implement first. |
| **Not-build list** | **D** (with **B**’s payroll honesty) | D’s list is ruthless and aligned with §5 #8 / §7. B correctly refuses regulated payroll execution. C’s not-build list is good but the *build* list undermines it. |

**Overall ranking for *this* brief (constraints + §5 + owner+agents):**  
**B > D > A ≫ C** as executable plans; **C** as the domain/correctness encyclopedia to cherry-pick from.

---

## What EVERY plan missed

These are high-value gaps none of the four closed adequately.

### 1. Glofox rate limits, abuse, and multi-tenant import fan-out
All plans assume hourly (or 15-min) pulls. None specify: per-namespace rate budgets, backoff when Glofox throttles, **fair multi-tenant scheduling** when tenant N grows, or what happens when one tenant’s import starves others. Day-one multi-tenancy makes a naive “for each tenant, full entity loop” a production incident.

### 2. Timezone / local “studio day” as a product primitive
C mentions DST tests; others barely. None fully specify that **KPI day boundaries, briefing “today,” dunning schedules, and “under-booked in next 24h”** must use `locations.timezone`, not UTC midnight or the owner’s laptop. Recovery studios care about *local* utilization heatmaps; wrong day boundary silently corrupts the flagship briefing.

### 3. Tax, tips, and what “revenue” means on-screen
Plans treat `amount_cents` as truth. None define whether KPIs are **gross vs net of Stripe fees, tax, refunds, gift-card redemptions, or ClassPass net rates**. Incumbents lose trust on money displays; Kelo’s “trustworthy numbers” criterion needs a **written revenue dictionary** (what Member count, MRR, and daily revenue include/exclude) versioned next to the SQL — not only relationship rules.

### 4. ClassPass / aggregator economics and channel-level P&L
Aggregators are modeled as a relationship type; none design **per-channel contribution margin** (ClassPass payout vs capacity displaced). For a pack-heavy recovery studio, the intelligence layer’s highest-leverage insight may be “this plunge slot is sold to aggregators below credit liability cost” — not only “convert pack-holders.”

### 5. Front-desk offline / flaky-network check-in
Table-stakes include check-in. No plan addresses **degraded mode**: tablet loses Wi‑Fi at peak, double check-in, or queue-and-sync. Even a simple “optimistic local queue with server reconciliation + conflict UI” would beat silent failure during the rush that generates no-shows and angry reviews.

### 6. Waiver legal mechanics beyond storage
All store signatures. None specify: **jurisdiction, minor/guardian, re-sign on template version change, block booking without required waiver, retention period, export for litigation, and what the signature artifact is** (image vs typed name vs provider). Per-session waivers are liability-critical; a blob URL is not a compliance design.

### 7. Cancellation / no-show / late-cancel policy engine
Book/cancel RPCs appear; **policy versions attached to the booking at purchase time** (C sketches, others don’t operationalize) — hours before start, credit burn vs refund, membership-included sessions, pack freezes — are where studios and members fight. Without a versioned policy object, money-correctness tests are incomplete.

### 8. Concierge / corporate / multi-person bookings
Recovery often sells **couple contrast, family packs, corporate blocks, or “booked by person A for person B.”** Models are almost entirely 1 person ↔ 1 booking. Guest-of, household, and invoice-to-company are absent; they will break CRM and credit debit assumptions on day one of real ops.

### 9. Observability of *AI quality*, not just AI cost
Plans cache briefings and version prompts. None define **eval harnesses with owner-labeled “was this action useful?”**, regression sets for segment membership, or alerts when briefing cites metrics that fail reconciliation. The product’s wedge can rot while import health stays green.

### 10. Support / impersonation / audit for “owner + agents” ops
When the owner (or an agent) breaks a membership mid-flight, who can **impersonate a tenant, replay an import page, reverse a ledger entry, and leave a mandatory reason code**? Audit_events appear in C; none make **break-glass support workflows** a phase-0 requirement — yet §5 is a history of needing exactly that forensic trail.

### 11. Secrets and Glofox credential lifecycle per tenant
Multi-tenant day one implies **per-tenant Glofox credentials** in Vault, rotation, and failed-auth alerting (`success: false`). Plans mention Vault vaguely; none design rotation, encryption scope, or “import paused — auth failed” as a first-class tenant health state.

### 12. Concrete load-test definition of “realistic data”
Success criteria demand p95 &lt; 1s and CI load tests. No plan pins **scale assumptions** (sessions/day, history depth, concurrent front-desk + owner, segment size) or a k6 scenario tied to those numbers. Without a workload model, “load-tested in CI” becomes theater — another §5 green-build failure mode.

### 13. Member communication preference and quiet hours as hard constraints
Outreach and dunning will hit SMS. Beyond STOP/10DLC (B partially), **quiet hours in studio timezone, channel preference, and “do not dunning-SMS at 11pm”** are missing. Boring comms correctness is a stated competitive bar.

### 14. The cutover social/process plan
Technical readiness bars abound. Missing: **staff training checklist, member comms calendar, “Glofox is read-only as of date X,” support SLA during first two weeks, and who sits on-call when the owner is also the builder.** Cutover is an operations event, not only a reconciliation metric.

### 15. Explicit “definition of done” for verification culture
All cite §5. None institutionalize a **release rule**: “no claim of fix without: captured evidence, failing test that reproduces, and production-visible health signal.” The meta-lesson was process, not architecture — it needs a CI/human gate, not only better tables.

---

### Bottom line

- **Steal from B:** scheduler-as-queue, probe-and-pin, envelope freshness, dead-man alert, money verify job, early Stripe ownership investigation.  
- **Steal from C:** authority states, holds/outbox, concurrent relationships, pilot inventory partition, honest distributed atomicity — then **ruthlessly cut 60% of C’s schema**.  
- **Steal from D:** SPA simplicity, authority JSONB, gold-label relationship gates, credit liability before native billing, agent rules.  
- **Steal from A:** AI gated on import health, simple cutover narrative, relationship log.  

Ship the hybrid that B would run, with C’s money/migration brain and D’s surface-area discipline — and fill the gaps above before calling cutover “ready.”

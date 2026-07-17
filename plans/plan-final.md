# Kelo — Final Synthesized Build Plan

*Council synthesis, 2026-07-16. Four independent plans were produced from the identical brief
([brief.md](brief.md)) by Claude Fable 5, ChatGPT Sol 5.6, Grok 4.5, and Kimi K2.7, then
blind-critiqued (anonymized, shuffled) by the three external models. This document is the
adjudicated distillation. Fable 5 is the final arbiter; council output was input, not verdict.*

*Sources: [plan-fable.md](plan-fable.md) · [plan-sol.md](plan-sol.md) ·
[plan-grok.md](plan-grok.md) · [plan-kimi.md](plan-kimi.md) · critiques:
[critique-sol.md](critique-sol.md) · [critique-grok.md](critique-grok.md) ·
[critique-kimi.md](critique-kimi.md) · blind key: [critique-key.md](critique-key.md)*

---

## Part I — Council verdict

### Comparison matrix

Blind labels: **A = Kimi, B = Fable, C = Sol, D = Grok.**

| Section | Strongest | Runner-up | Adjudication |
|---|---|---|---|
| Architecture | **Fable** (Grok + Kimi critiques agree) | Grok | Two-zone raw/native model, DB-enforced single scheduler with jobs queue, external dead-man heartbeat, SPA-for-operator / SSR-for-member split. Adopted, minus Turborepo (both critiques flagged the package surface). |
| Data model | **Sol** for depth, **Fable/Grok** for buildability | — | Sol alone models concurrent relationships, immutable prices, holds, and separated ledgers — but lists ~70 tables, which two critiques called a §5-mandate-8 violation. Adopted as *reference model implemented in slices*: Sol's concepts, Fable/Grok's discipline. |
| API surface | **Fable** (2 of 3 critiques) | Sol | Freshness-in-envelope, person-scoped contracts, reports-with-export. Sol's mutation conventions (idempotency, If-Match, operation IDs) merged in. Kimi's Server-Actions-only approach rejected (weakest for the multi-client future). |
| Import / migration | **Fable** (2 of 3) | Sol | Probe-and-pin + watermark rules + reconciliation-as-cutover-meter, upgraded with Sol's candidate/committed watermarks, quarantine queue, deletion detection, and authority states. |
| Booking / payments | **Sol** (2 of 3) | Fable | Sol is the only plan that models cross-provider atomicity honestly (holds, outbox, webhook-as-truth, compensation). Adopted, fused with Fable's exclusion constraints and `verify_money`, and Grok's Stripe-Billing-for-recurrence simplicity. |
| Phasing | **Fable/Grok** shape, **Kimi** speed | — | Trustworthy numbers by ~weeks 7–9, daily briefing by ~weeks 10–13; billing before public booking; member beta strictly before cutover (Sol's critique caught Grok's plan retiring Glofox before members had a Kelo booking path — adopted as an explicit gate). |
| Risks | **Sol** for coverage, **Fable** for actionability | — | Sol's table is the checklist; Fable's mitigations are the implementable set. Merged. |
| Not-build list | **Sol** (2 of 3 critiques) | Grok | The critiques' majority pick is Sol's list; my adjudication takes its boundary-drawing and adds Grok's ruthlessness and Fable's payroll honesty — an explicit override of the vote, same as the data-model row. Sol's "no generic dual-master sync" and "no custom card vault" both survive into §8. |

**Executable ranking (my adjudication, informed by the critiques): Fable ≥ Grok > Kimi > Sol** —
with the explicit caveat that Sol's plan is the domain-correctness encyclopedia this synthesis
cherry-picks from hardest. (The critiques did not agree with each other: Grok's critique explicitly
ranked Sol's plan "last as executable, first as reference"; Kimi's critique gave no overall ranking
but its section wins imply Fable-first; Sol's critique — rating blind — ranked its own plan first
across the board and Grok's weakest. This synthesis treats Sol's plan as Grok's critique framed it.)

### Genuine disagreements, surfaced (with my ruling)

1. **Web framework.** Next.js App Router (Sol, Kimi) vs Vite SPA + Hono (Fable, Grok).
   **Ruling: Vite SPA + Hono.** The operator app is auth-gated and data-dense; SSR buys nothing
   there and App Router server/client boundaries are a documented agent-error surface. Both
   external critiques of the Next.js picks agreed. The member surface (later) gets SSR as its own
   small app, where first-paint genuinely matters.
2. **Relationship modeling.** Single derived enum with history (Fable, Grok, Kimi) vs
   effective-dated concurrent relationship rows (Sol). **Ruling: both, layered.** Sol is right that
   a person can hold a subscription *and* residual pack credits simultaneously — flattening loses
   truth. Fable/Grok are right that KPIs need one unambiguous classification. So: effective-dated
   `person_relationships` facts + one materialized `primary_relationship` by precedence (§ Part II).
3. **Payroll.** The brief lists payroll as v1 table-stakes; **all four plans independently refused
   payroll money-movement**, shipping pay/commission *calculation and export* instead. **Ruling:
   the council is unanimously right and the brief is wrong here** — wage custody and tax filing are
   a regulated domain no incumbent actually owns either; export to Gusto/ADP.
4. **Email dedup.** The brief says "deduplicated by email"; two of four plans (Fable, Sol) replaced
   the hard invariant with a merge process (email nullable, shared family emails real), and two
   critiques endorsed that side. **Ruling: merge process wins.** This is a considered disagreement
   with §4 of the brief, flagged per its own rules.
5. **Effort honesty.** 20–26 wk (Kimi), 22–30 (Grok), 25–36 (Fable), 77–116 (Sol). Critiques
   converged on: the fast plans understate distributed-systems and operations work; Sol's estimate
   is honest *for Sol's scope*, which is too big. **Ruling: ≈29–39 focused weeks to cutover-ready
   (phases 0–7), ≈34–46 to Glofox fully retired (through phase 8)** with the slice discipline
   below — and the brief says timeline is not a constraint, so gates, not dates, govern.
6. **Cutover tolerance.** Percentage bands (Grok, Kimi) vs exact-by-provider-ID (Sol).
   **Ruling: Sol.** Members, credit balances, and subscriptions are discrete entitlements —
   unexplained variance tolerance is zero; money reconciles by Stripe ID with every difference
   explained. Percentages hide exactly the class of bug that killed the prototype.
7. **`past_due` semantics** (Sol's critique of Fable). **Ruling:** `recurring_member` includes
   `past_due` only within a tenant-configured dunning grace window (default 14 days), explicitly
   tested; after that the person declassifies and enters the win-back segment. The rule is written
   in the revenue dictionary (below), not implied.

### The five best ideas nobody's plan had alone (from the blind critiques)

Incorporated throughout Part II:

1. **Stripe as a parallel source of truth *now*** (Kimi's critique): the studio's money already
   flows through Stripe under Glofox — ingest Stripe events read-only from day one to cross-check
   Glofox-derived revenue and surface failed payments in the focus queue *before* Kelo owns billing.
   A free correctness layer every plan left on the table.
2. **The local "studio day" as a product primitive** (Grok's critique): KPI day boundaries,
   briefing "today," dunning schedules, and quiet hours all run on `locations.timezone`, never UTC
   midnight. Wrong day boundaries silently corrupt the flagship briefing.
3. **A versioned revenue dictionary** (Grok's critique): written definitions — what MRR, "member
   count," and daily revenue include/exclude (fees, tax, refunds, gift-card redemptions, aggregator
   net rates) — versioned next to the SQL that computes them, surfaced as UI tooltips.
4. **Write-capability discovery as a gate** (Sol's critique): every plan promised "tested
   write-back" against Glofox write APIs nobody has probed — the exact §5 sin. Write-back is now
   *conditional* on a probe phase; if Glofox writes are unusable, the fallback is inventory
   partitioning, not blind writes.
5. **AI degradation fallback** (Kimi's critique): if Claude is down/slow/malformed, the home screen
   shows yesterday's cached briefing badged as such plus a deterministic metrics-only mode — never
   blank, never fabricated.

---

## Part II — The plan

## 1. Architecture overview

**Design stance:** the team is one owner + AI coding agents, and the prior build died from
unverified assumptions. Therefore: few moving parts, one source of truth per concern, correctness
enforced *structurally* (Postgres constraints, RLS, transactional functions) rather than by
convention, and verification harnesses as first-class deliverables. Where the database can make a
bug impossible, it does.

### Stack (fixed: Supabase, Netlify, Stripe, Claude)

- **One pnpm workspace** (no Turborepo — minimal tooling surface), TypeScript strict everywhere:
  - `packages/db` — SQL migrations (Supabase CLI), generated DB types, and the Postgres functions
    that own every money/booking mutation.
  - `packages/contracts` — Zod schemas for every API request/response, every Glofox payload, every
    Stripe/Resend/Twilio webhook. **The single source of truth for shapes**; nothing declares a
    shape twice. Glofox schemas cite the pinned sample file each was derived from.
  - `apps/api` — one Hono app on Netlify Functions; typed client via `hono/client` (no codegen).
  - `apps/web` — operator app: Vite + React SPA, TanStack Router + Query.
  - `apps/member` — (later phase) member booking surface as a separate small SSR app.
  - `workers/` — import, job processors, AI generation as Netlify Background Functions (15-min cap).
- **Exactly one scheduler, enforced by the database:** a single Netlify Scheduled Function ticks
  every 5 minutes and only enqueues/claims from a Postgres **`jobs`** table
  (`FOR UPDATE SKIP LOCKED`, leases with heartbeats, bounded retries, dead-letter status). All
  recurring work is a `jobs` row. Even if the tick double-fires, the lock makes double-execution
  impossible — §5 mandate 7 as schema, not discipline. Jobs are **chunked and resumable**
  (per-tenant, per-entity, per-window) so serverless duration limits cannot strand work mid-loop.
- **Observability (§4: must be built):**
  - Sentry (web + functions).
  - **Real-user monitoring via Sentry browser tracing** (no new vendor; PII-redacted), by flow
    and device: cold vs warm load, Terminal confirmation time separate from server acceptance,
    tap-to-durable-confirmation per booking step, schedule-view render time. Ships in phase 2
    (operator flows), extends at phases 5–6 (Terminal/booking) and 8 (member funnel). Synthetic
    p95 alone is theater (UX-plan amendment §9.6).
  - In-DB operational truth: `sync_runs`, `sync_state`, `job_runs` — the Health page renders from
    these tables; every screen's freshness chip reads `sync_state`, never a hardcoded string.
  - Alert rules job (import failed, staleness threshold, zero-rows-N-runs, reconciliation drift,
    webhook backlog, **Glofox auth failure**, **business anomalies** — revenue flatline, booking
    drop, no-show spike, credit-liability jump) → Resend email + Twilio SMS to the owner.
  - **External dead-man's switch** (Healthchecks.io/BetterStack heartbeat pinged by the tick) — the
    one piece of observability outside the system it watches; total scheduler death still alerts.
- **Environments:** production + a **persistent staging tenant seeded with sanitized real-shaped
  data** (owner acceptance happens here, not in unit tests) + Supabase preview branches for CI.
  **Backups are a deliverable:** Supabase PITR enabled, documented RPO/RTO, and a *rehearsed*
  restore drill required before any money phase ships and re-run before cutover.

### Coexistence: the two-zone model + authority states

- **Zone 1 — `glofox_raw`:** immutable, append-only raw payload pages exactly as fetched
  (`payload jsonb`, hash, `fetched_at`, request metadata incl. namespace param, import-run id) —
  persisted **on every production run**, not just dev captures. Any mapping bug is fixed by
  re-transforming from raw; no re-fetch, full audit.
- **Zone 2 — Kelo-native tables:** designed for how a recovery studio should work; rows carry
  `source ∈ {native, glofox}` + `external_ref`. Mappers are pure, versioned functions
  contract-tested against pinned samples.
- **Authority registry (Sol's states, Grok's pragmatism):** per capability
  (`people, marketing, scheduling, booking, payments, …`), a tenant-scoped state machine:
  `glofox_authoritative → kelo_with_writeback → kelo_only → retired`. The import writes only
  glofox-authoritative capabilities; flips are reconciliation-gated; the matrix is visible in the
  Health UI. No generic last-write-wins sync, ever; no indefinite dual-master.
- **Demo data structurally unreachable:** seed data exists only in staging/CI; no fixture imports
  in `apps/` (lint-enforced); production loaders have no fallback branch. Honest empty/loading/
  error states are designed components from phase 0.

### Multi-tenancy and security

- Every table: `tenant_id uuid not null`; composite indexes led by `tenant_id`.
- **RLS checks membership, not just a JWT claim** (Sol's critique adopted): policies verify
  `tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid())` via a cached
  helper; the API layer additionally scopes explicitly. Claims can go stale; membership rows don't.
- Service role only in workers/webhooks; every service-role query still filters tenant explicitly;
  each use writes an audit event.
- **Generated RLS test suite:** CI attempts cross-tenant reads/writes on every table; a new table
  without a policy fails the build. A second tenant is seeded from day 0.
- Per-tenant Glofox credentials in **Supabase Vault**, with rotation support and a first-class
  `import_paused_auth_failed` tenant health state (HTTP 200 + `success:false` on auth is a §5 fact).
- Auth: Supabase email+password + magic links; `tenant_users` roles
  (`owner, manager, front_desk, trainer`) + invite tokens. **MFA mandatory for owner/manager**
  (threat-model delta: a compromised inbox must not yield refund authority), optional for
  front_desk/trainer; step-up PINs never resettable via the login email channel.
  **Shared-device step-up auth (UX-plan amendment):** per-user fast PINs (hashed, audited) + a
  re-auth API — actor re-verification before refunds/comps/sensitive deep links on shared
  devices, and manager step-up authorization above the tenant-configured refund threshold
  (a `tenants` setting).
- **Break-glass ops:** admin impersonation, import-page replay, and ledger reversal all exist from
  phase 1, each requiring a reason code and writing to `audit_events` — §5 is a history of needing
  exactly this forensic trail.

---

## 2. Data model

Introduced **slice by slice with the feature that writes it** (§5 mandate 8). The list below is the
target model; the phase table (§6) says when each slice materializes.

### Tenancy & identity

`tenants` (settings JSONB: branding, brand voice, briefing hour, AI/PII toggles, grace windows,
quiet hours, **refund step-up threshold**, cancellation/no-show policy defaults) · `locations` (**IANA timezone — the "studio day" primitive**; all KPI day boundaries,
briefing "today," dunning schedules, and quiet hours compute in location time) · `tenant_users` ·
`tenant_invitations` (per-user **hashed step-up PINs live on `tenant_users`**) · `audit_events`.

**Multi-location semantics decided now** (Sol's gap #9, so the second location isn't a redesign):
memberships and credit packs are **tenant-wide by default** with an optional location restriction;
revenue attributes to the **redemption** location with the sale location retained; every report
takes a location dimension with tenant roll-up; staff can hold roles at multiple locations. The UI
ships single-location; the model and reports don't.

`people` — email `citext`, **nullable**, partial unique per tenant; phone; `source_created_at`
(Glofox `created`, labeled "first seen"), `first_activity_at` (cohort anchor =
least(first booking, first transaction)), `cohort_anchor_basis`, `date_quality`.
`person_merges` + merge-candidate tooling (dedup is a process, not a constraint — council
disagreement #4). **Merge semantics, decided now (ships phase 1 with import review):** the
operator picks the survivor; bookings, ledger entries, consents, comms history, and external refs
reassign to the survivor (ledger union preserves both histories — append-only survives merges);
conflicting contact fields keep the survivor's with the loser's archived on the merge record;
merges are audited and **reversible until either person transacts post-merge** (then
forward-remediation only); Stripe customers merge by attaching the loser's customer id as a
secondary external ref, consolidated when native billing ships (phase 5).
`person_external_refs` (glofox, stripe, aggregators). Leads carry a minimal
**pipeline surface** (`lead_status`, `next_action`, owner) feeding the focus queue — the brief's
"lead pipeline" table-stake as CRM fields, not a separate CRM product.

### Relationship typing — the load-bearing decision (council disagreement #2 resolved)

Two layers, both derived, never hand-entered:

1. **`person_relationships`** — effective-dated facts, concurrency allowed: a person may hold
   `recurring_member` (active/grace subscription) *and* `pack_holder` (positive unexpired credit
   balance) simultaneously. Each row: type, effective range, derivation basis JSONB, rule version.
2. **`people.primary_relationship`** — one materialized enum for KPIs, computed by a single
   deterministic SQL function with strict precedence:
   `recurring_member > pack_holder > aggregator > guest > lead`.
   - `recurring_member` ⇐ subscription in `active`, or `past_due` within the tenant grace window
     (default 14 days) — the **only** cohort feeding member count and MRR. Expected ≈22–24 today:
     the built-in import canary.
   - `pack_holder` ⇐ **positive unexpired credit balance** (not "recent purchase" — Sol's critique).
   - `aggregator` ⇐ most-recent attendance via aggregator channel; `guest` ⇐ any transaction or
     attendance otherwise; `lead` ⇐ none.
   - "Former member" is **not** a sixth primary type (keeps the brief's taxonomy): it's a derived
     win-back segment from `person_relationships` history.
3. **`person_relationship_log`** — append-only transitions with evidence. Pack-holder → member
   conversions (the growth engine) are literally rows here; conversion KPIs are queries.
4. **Gold-label gate (Grok):** a hand-labeled sample of real people; derivation must score ≥99%
   against it before any KPI ships, re-run on every rule change.

Behavioral **segments** sit above: `segment_definitions` (versioned SQL predicates, ~13) +
`segment_assignments` per run_id (append-only per run) so every briefing/outreach cites the exact
segment run it came from.

### Scheduling, booking, credits

`resources` (room/plunge/suite, capacity, open hours, maintenance windows, **readiness state:
ready / turnover / not-ready / out-of-service — distinct from maintenance windows, exposed to the
slot picker, excluded from demand analytics** — UX amendment) ·
`offering_templates` (**room-slot appointment is the primary construct**, group class secondary;
duration + turnover buffer; price or credit cost; min-age policy) ·
`schedule_rules` (recurrence in location timezone; UTC instants stored; **DST transitions tested**) ·
`sessions` (class instances) · `schedule_drafts` + `schedule_publishes` (staged changes, atomic
publish, publish history — UX amendment) · `booking_holds` (short-TTL; used for card-funded checkout **and**
waitlist promotions) ·
`bookings` (session **or** resource+`tstzrange`; **`person_id` (attendee) distinct from
`booked_by_person_id`** — couples, guardians, and front-desk book-for-someone are day-one real
(Grok's gap #8); status machine incl. waitlist; channel; payment kind; idempotency key;
**`policy_version` snapshotted at creation** — cancellation/no-show/late-cancel terms are attached
to the booking, not looked up later) ·
`cancellation_policies` (versioned) · `waitlist_entries` (tenant-configurable for classes **and**
room-slots) · `checkins` · `attendance_events`.

**Double-booking is impossible by schema:** GIST exclusion constraint on
`(resource_id, time_range)`; class capacity enforced inside the booking RPC under a session row
lock, never via an eventually-updated `booked_count`.

`waiver_templates` + versions · `waiver_signatures` (person, booking/session, exact version,
timestamp, typed-name + checkbox artifact — the sole signature modality, deliberately no drawn
canvas — IP) — **waiver acknowledgment precedes payment in every booking path** (UX amendment:
charging before discovering a waiver block manufactures paid-but-unbooked failures); template
change forces re-sign and re-presents mid-booking; a version change or persist-failure after
payment surfaces as a review card, never silently lost; **imported bookings without current
waivers get pre-arrival signing links + a "Waiver needed" desk queue** so members are never
surprised at the counter; no medical questions, no free text. Minor policy: tenant-configured
minimum age per offering + guardian identity & acknowledgment on the waiver (DOB stored; medical
info never); guardian required but absent blocks with **no payment taken**.

**`credit_ledger`** — append-only: `grant` (with expiry), `debit`, `refund_credit`, `expire`,
`adjust` (reason + actor mandatory). **Balance is `sum(delta)` — no mutable remaining column
anywhere** (both Kimi's and Grok's plans were dinged for cached-balance drift; the ledger is the
only truth, with a materialized view for reads). Consumption is earliest-expiring-first.
Credit-liability report = unexpired grants − debits at grant unit price, **labeled operational (not
GAAP) until a tenant breakage policy is configured** (Sol).

### Money

`plans` (recurring/unlimited/pack/drop-in/intro; **immutable prices** — launch-tier ramps
founding→opening→standard are new price rows/phases, never mutations) · `subscriptions` (Kelo
entitlement record mirroring Stripe; pause/freeze/cancel with effective dates; grace policy) ·
`orders` + `order_lines` (every payment ties to an order — the cross-ledger invariant) ·
`payments` (status machine includes a first-class `written_off` state — manager step-up, reason,
consequence model), `refunds` (1:1 with Stripe objects, status machines, provenance) ·
`stripe_events` (raw webhook inbox, unique on event id; processors consume the table, never the
HTTP request) · `stripe_commands` (**durable outbox**: every intended Stripe mutation persisted
with its idempotency key *before* the API call) · `gift_card_ledger` (separate from credits —
different legal treatment) · `idempotency_keys` (tenant-scoped, request-hash-checked; same key +
different payload = rejection).

**Deliberate simplification (flagged):** no general double-entry journal in v1. Sol's
`journal_entries` is the correct end-state for multi-tenant scale, but two critiques judged it
speculative for this team. Instead: append-only ledgers + `verify_money` cross-ledger invariants
(every payment ↔ order; every debit ↔ booking; no negative balances; Stripe balance transactions
fully mapped). The ledger schema is designed so a journal can be derived later without migration.

`comms_log` — every email/SMS ever (transactional + marketing): template, provider message id,
delivery events from webhooks, **consent + suppression checked at send time, quiet hours in
location timezone enforced for outreach and dunning** (never dunning-SMS at 11pm). STOP/unsub
processing, with opt-outs surfaced per person (visible to staff, not overridable). **UX
amendments:** a tone-lint step in the outreach pipeline (pseudo-medical claims,
collections-agency tone) and small-batch pacing defaults for segment sends.
`communication_consents` per channel with evidence.

`automation_flows` + `automation_enrollments` — **lifecycle automation is a v1 table-stake, and it
ships (phase 3):** trigger → pre-approved templated sequence (welcome, lapsed-pack win-back,
post-visit, dunning comms), consent- and quiet-hours-aware, with per-person enrollment state. The
owner approves the *template and trigger* once; individual automated sends within an approved flow
do not re-queue for approval (the no-autonomous-send rule applies to AI-drafted one-off outreach,
where drafts vary per person). No drag-and-drop builder — flows are configured, not designed.

### Intelligence & ops

`ai_artifacts` (briefings, drafts, recommendations: prompt version, model, input window + hash,
cost, TTL) · `outreach_drafts` → approval → send (AI never sends; approval is a human state flip) ·
`briefing_feedback` (**owner thumbs-up/down per briefing item — the AI-quality eval signal**;
regression set for segment membership) · `activity_events` (focus-queue feed, with
**dismissal-with-reason and snooze persistence + a weekly dismissed-items digest job** — UX
amendment against focus-queue decay) ·
**`metric_definitions` — the revenue dictionary:** versioned definitions of every KPI (MRR, member
count, daily revenue gross/net semantics, refund/fee/gift-card/aggregator treatment), rendered as
UI tooltips and cited by briefings.

`sync_state` (per entity: committed watermark, candidate watermark, `consecutive_empty`,
`expected_min_records` rolling baseline) · `sync_runs` · `import_quarantine` (unmapped/unknown
records — unknown transaction types go here, never silently into revenue) · `import_conflicts`
(field-level divergence where Kelo has touched a row) · `write_back_log` ·
`reconciliations` (the cutover meter) · `jobs`/`job_runs` · `alerts` ·
`retention_policies` (**the data-retention matrix:** raw payloads, AI artifacts, comms content,
webhook payloads, waiver evidence, financial records — what's erasable, what's pseudonymized on
person deletion, what's retained for dispute/waiver/financial evidence; person
deletion/pseudonymization workflow + tenant data export ship in **phase 3** alongside consent).

Deliberately absent until their feature ships: payroll runs, stock counts, seat maps, aggregator
API mirrors, automation-step builders, custom report definitions.

---

## 3. API surface

One Hono app, `/api/v1`, Zod-validated at every boundary, typed client for the SPA. Conventions
(Fable's envelope + Sol's mutation hygiene):

- **Every response:** `{ data, meta: { as_of, source, stale, definition_version, correlation_id } }`
  — a screen *cannot* render data without provenance; combined reports inherit the oldest input's
  freshness (stale revenue is labeled stale, never silently mixed with fresh bookings).
- **Every mutation:** `Idempotency-Key` required (client-generated per user action); entity-version
  `If-Match` on updates; long operations return `202` + operation id.
- Errors are structured and never `200`-with-failure (Glofox's own trap, not repeated).

Endpoint families: `/auth`,`/tenant` (settings, invites, roles) · `/people` (search, profile with
relationship history + visits + credits + comms, merge, consents, timeline) · `/segments`
(assignments, per-person basis, run history) · `/briefing` + `/focus-queue` (from `ai_artifacts`;
**404-honest when not generated; degraded mode serves yesterday's cached briefing, badged**) ·
`/schedule` (sessions, room-slot availability — server-computed from open hours − maintenance −
exclusion ranges − **resource readiness state**, returned as labeled slot states so "room not
ready" renders distinctly from booked; demand heatmap; AI recommendations; **authoring mutations:
draft CRUD, conflict validation, atomic publish, publish history** — under the same
Idempotency-Key/If-Match conventions) · `/bookings` (create/cancel/check-in/
no-show/waitlist; create calls the `book()` RPC and returns the definitive result) · `/billing`
(orders, payments, refunds, subscription lifecycle, card-update links, dunning queue) · `/pos`
(checkout: card via Terminal/manual, **cash tender recording, simple discounts with manager role,
receipts** — the front-desk reality Sol's critique demanded) · `/outreach` (drafts, edit,
approve→send, per-person history, measurement) · `/reports` (revenue, attendance, cohort/churn,
LTV, plan-mix, **credit liability, room utilization**, and a **cash-day summary** (sum + count of
cash tenders by day — reconcilable against the drawer without till management); drill-down params;
`format=csv` on every endpoint, large exports as async jobs with progress (XLSX later)) · `/health` (freshness, runs, alerts, authority matrix; unauthenticated `/health/ping`
for the heartbeat) · `/ask` (free-text Q&A over a **catalog of approved, parameterized metric
queries** — not raw SQL, even read-only; Sol's critique adopted) · webhooks (Stripe, Resend,
Twilio: signature-verified, persisted to event tables, 200 fast, processed async).

The member beta app later consumes the same `/schedule`, `/bookings`, `/billing` contracts with a
member-scoped role — person-scoped design now avoids a second API later. **Member account claiming
is designed up front** (Sol's gap): claim-by-verified-email/phone against the imported person,
duplicate-claim and takeover recovery defined, guardian-books-for-dependent supported, email-less
walk-ins claimable by phone. **Verified-contact rule (UX amendment):** every member identity is
contact-verified once (one-time code, per device/session — not per booking); no unverified guest
checkout exists, which is both the dedup guarantee and the claiming flow. **Concurrency surfaces
(UX amendment):** hold-owner visibility on slots, single-flight payment retries, and being-merged
hints are part of the API contract so two staff can't fight over the last slot invisibly.

---

## 4. Import + migration strategy

### Step 0 — probe-and-pin (before any mapper exists)

CLI probe fetches live samples from every Glofox endpoint **across a stratified sample** (single
samples hide optional fields/variants — Sol's critique), redacts PII deterministically, pins
snapshots to `packages/contracts/glofox/samples/` with request metadata. Every Glofox Zod schema
cites its sample file. CI runs all mappers against all samples. A **weekly live-shape diff** alerts
on drift before it corrupts data. The §5 verified facts become executable constraints:

| §5 fact | Structural response |
|---|---|
| `membership` is an object; recurring = type + `subscription_payment` evidence | Mapper joins `user_membership_id` → catalog; derivation requires **both** membership type and subscription-payment evidence (Kimi's critique of looser rules adopted) |
| `created` may be migration date | Stored as `source_created_at` ("first seen"); cohorts anchor on `first_activity_at`; validated against a broad stratified sample in phase 1 |
| Transactions return 0 rows at HTTP 200 without namespace | Namespace is a **non-optional field of the typed request builder** + permanent regression test + zero-row tripwire |
| HTTP 200 + `success:false` | One shared `glofoxFetch()` client throws on `success !== true`, everywhere |
| Transaction type has no clean field | A **versioned classifier** over `metadata.glofox_event` (`subscription_payment` / `invoice_payment`) + description text, contract-tested against pinned transaction samples; unclassifiable rows → `import_quarantine`, never silently into revenue |
| POST-as-read, string unix seconds, inconsistent pagination | One client owns per-endpoint pagination strategy; timestamps parsed once at the Zod boundary |
| Branch == location (single-location studio) | Glofox branch id maps to `locations.external_ref`; single-branch tenants map to the sole location — a per-tenant mapping, not a global assumption |
| Everyone is a "lead" | Relationship derived from behavior only; the Glofox flag is never imported as meaning |

**The two must-answer probe questions — answered by the 2026-07-17 live probe session** (full
findings in [docs/glofox/README.md](../docs/glofox/README.md), the standing Glofox source of
truth; PII-redacted pinned samples in `docs/glofox/samples/`): (a) **per-grant credit expiry
exists** — `Credits.end_date` (unix seconds); packs missing it import as `no_expiry` (degraded
rule retained). (b) **booking channel** — candidate fields `bookings.origin` +
`members.source/origin` exist but were null/unset in samples; phase 1 runs the full-history
distinct-value scan, with the payment-provenance + owner-roster fallback retained. **Additional
live findings folded in:** the `glofox_event` vocabulary has a third value §5 missed —
`book_class` (drop-in payments, the *majority* of rows) — the classifier handles all three;
per-channel marketing consent (`consent.{email,sms,push}`) exists on members and imports as
consent evidence (feeds owner decision D2); **Glofox webhooks exist** (HMAC-SHA256-signed,
at-least-once, 3 retries) — `MEMBER_UPDATED` with `active:false` delivers soft-deletes, so
member deletion detection uses webhooks + daily full sync (Glofox's own recommended pattern),
with snapshot-based detection retained for entities without webhooks; the namespace trap and the
200+`success:false` behavior are now **reproduced/vendor-acknowledged**, not just remembered.

### The pipeline (per tenant × entity × window)

1. **Fetch** → append raw pages to `glofox_raw` (hash-deduped), record `sync_runs`.
2. **Transform** raw → staging → validate (uniqueness, referential joins, timestamps, anomaly
   thresholds vs `expected_min_records`) → **quarantine** unknowns (never silently classify).
3. **Upsert** canonical (keyed `(tenant_id, external_ref)`) and **commit the candidate watermark in
   the same transaction** (Sol's candidate/committed pattern — a crash between upsert and watermark
   can't desync them).
4. **Watermark law (§5 mandate 2):** advance only on schema-valid success; zero rows advance only
   if plausible for that entity/window (per-entity config); `consecutive_empty` crossing threshold
   alarms; suspect-empty runs never advance.
5. **Rate-limit fairness** (Grok's gap): per-tenant Glofox budgets with backoff; one tenant's
   import cannot starve others as tenants multiply.
6. **Deletion detection** (Sol): periodic full-window snapshots per entity; a record absent from
   **two consecutive** full snapshots (never one) becomes a tombstone candidate surfaced in
   `reconciliations` for review — incremental pulls alone cannot see deletions or missed updates.

**The five in-system freshness tripwires, named once** (referenced by the phase-1 gate and risk 2):
(1) the watermark law, (2) per-entity plausible-zero config, (3) the `consecutive_empty` alarm,
(4) the `expected_min_records` rolling baseline, (5) reconciliation drift. The **external dead-man
heartbeat** is the sixth, out-of-system tripwire, verified separately in phase 0.

Cadence: hourly baseline; 15-minute for today's roster during operating hours. Freshness in every
envelope; staleness banner ambers at 2h, reds at 4h with an alert.

**Stripe-as-parallel-truth from day one (Kimi's critique — adopted):** a read-only Stripe ingest
(charges, invoices, `invoice.payment_failed`, subscription objects) runs alongside the Glofox
import. It cross-checks Glofox-derived revenue/MRR *and* feeds real failed-payment items into the
focus queue months before Kelo owns billing. It also settles §8-Q2-adjacent questions (true
subscription states) from the processor itself. **Negative-outcome branch — ACTIVE (owner
confirmed 2026-07-17: the Stripe account is Glofox-gated, accessible only through Glofox):** the
phase-1 gate amends to Glofox-only reconciliation (Stripe reconciliation starts at phase 5, when
Kelo's own Connect account exists); pre-cutover failed-payment detection comes from the Glofox
transactions report (`transaction_status = ERROR` rows — verified live); a restricted Stripe read
key and PAN-portability cooperation are requested from Glofox/ABC as part of the phase-0
discovery conversation, and the **PAN-portability request should be filed as early as Glofox
cooperation allows** since the fallback is a member re-card campaign at cutover.

### Reconciliation — the trust engine and the cutover meter

Daily: Glofox vs Kelo counts/sums per entity/window; derived member count vs owner ground truth
(≈22–24 — the canary); Stripe vs Glofox revenue; results land in `reconciliations`; drift alerts.
Built once in phase 1; later verifies write-back and gates cutover.

### Strangler-fig sequence (brief §4 order, hardened)

1. **Now:** read-only Glofox + Stripe imports; intelligence layer runs on them.
2. **Write-capability discovery gate (new, from Sol's critique)** — in two steps that respect the
   read-only constraint: *(a) non-mutating discovery in phase 0* — documentation, contractual
   permission, endpoint existence, rate limits — no write is sent; *(b) mutation probes only after
   the phase-1 reconciliation gate passes* (matching the brief's "read-only lifts on proof"),
   against sacrificial throwaway records with explicit owner sign-off — idempotency,
   read-after-write delay, side effects (does a write trigger Glofox emails?). **If writes are
   unusable, the strategy is inventory partitioning, not write-back** — the plan does not depend
   on an unverified API a second time.
3. **Non-transactional ownership in order** (data → marketing → scheduling → staff/compliance/
   retail), each capability flipping `glofox_authoritative → kelo_with_writeback` (or `kelo_only`
   with partitioning) only after N clean reconciliation cycles; every write journaled in
   `write_back_log` with a verification re-read.
4. **Booking + payments last.** Native engine for front-desk/owner bookings first (controlled blast
   radius) on **partitioned inventory — a resource/slot set closed in Glofox before Kelo sells it**
   (Sol: never let two systems sell the same slot). New membership sales native next; existing
   subscriptions migrate **in cohorts with exactly one billing authority each — Glofox billing
   disabled before Kelo bills a cohort** (double-billing designed out, not tested out).
5. **Member beta surface** — **strictly before cutover** (members must have a Kelo booking path
   before Glofox is retired; the gate is explicit).
6. **Cutover + retirement**, as an operations event, not a deploy: rehearsed freeze window, final
   import, member comms calendar (what changes, whether cards must be re-entered, URL redirects),
   staff training checklist, first-two-weeks support plan, rollback decision point.
   **Rollback honesty (Sol's critique of authority-flip "rollback"):** once Kelo has charged cards
   and consumed credits, flags don't undo external effects — the rollback plan is
   forward-remediation runbooks (refund/re-book procedures) plus Glofox kept read-accessible 30
   days and cancelled one billing cycle after cutover.

### Cutover-readiness bar (all must hold, 30 consecutive days)

- Reconciliation: **zero unexplained variance** on people, active members, bookings, credit
  balances, subscriptions; revenue reconciled **exactly by Stripe object ID and currency**, every
  difference explained and logged (council disagreement #6 — exactness wins).
- Two clean monthly billing cycles for the pilot cohort; pause/ramp/proration/dunning/cancel paths
  verified with Stripe Test Clocks + controlled live tests.
- Booking concurrency matrix passed (storm test: zero double-bookings); no unresolved P1/P2
  data-correctness defects; import zero-freeze incidents = 0.
- Staff ran all daily ops in Kelo without touching Glofox for the final 14 days; owner signs off on
  member count, MRR, revenue, credits, schedule — against reality, not a green deploy.
- **Member beta proven:** the member surface has been live ≥30 days, ≥50% of member-initiated
  bookings in the final 14 days came through Kelo channels, and no unresolved member-facing P1/P2
  defects exist (members must have a working Kelo booking path *before* Glofox is retired).
- p95 budgets met under the pinned workload model for 7+ days; restore drill passed within 60 days.

### Data reset (§8 Q6)

Full reset. Archive a snapshot of the corrupt DB to cold storage first; preserve only
owner-authored artifacts that can be individually verified (settings, brand voice, any manual
notes); re-import everything from Glofox + Stripe after mapping fixes. Nothing derived survives.

---

## 5. Native booking + payment engine

**Build it (§8 Q1) — unanimous council.** Postgres primitives for availability/bookings/credits/
entitlements/orders; **Stripe owns card vaulting, recurrence, retries, SCA** (Stripe Billing for
subscriptions — hand-rolled recurrence is the incumbents' money-bug surface). Stripe is
infrastructure, not workflow; a licensed booking backend would re-create the rented-workflow
problem Kelo exists to escape.

### Stripe topology — decided now (the gap every plan missed, per Sol's critique)

**Kelo becomes a Stripe Connect platform; each tenant is a Standard connected account; the studio
is merchant of record** (owns disputes, refunds, payouts, tax identity). Tenant #1's existing
account links as the first connected account — which is also the card-continuity path *if* the
studio owns it. **Phase 0 investigates account ownership:** if the current account is
Glofox-platform-owned, file Stripe's PAN data-portability request immediately (weeks of lead time,
needs Glofox cooperation; fallback = self-serve card-update campaign run by the comms engine).
Webhooks and idempotency keys are scoped per connected account from the first line of code —
retrofitting account topology is the single most expensive payments refactor to get wrong.

### Booking core

- **Two paths by funding type:**
  - *Credit / entitlement / comp / front-desk:* one Postgres RPC, single transaction — validate
    (waiver current, age policy, booking window) → capacity/exclusion check → insert booking →
    debit ledger → activity event. Atomic locally, which is honest because no external provider
    participates.
  - *Card-funded (async by nature):* **hold → pay → confirm** (Sol's state machine): short-TTL
    `booking_hold` reserves capacity → durable `stripe_commands` outbox row → PaymentIntent with
    the same idempotency key → member confirms via Payment Element → **signed webhook is the
    authority** → one transaction converts hold to confirmed booking + records payment. Payment
    succeeding after hold expiry auto-refunds and surfaces for review. Members see
    `processing / confirmed / failed / refund pending` — never a success claim before provider
    confirmation. **Hold-extension semantics are part of the `book()` RPC contract (UX
    amendment):** payment initiation freezes hold expiry; one free extension during waiver/OTP
    waits; holds carry owner visibility ("held by Sam, expires 2:40").
- **Cross-provider "atomicity" honestly defined** (Sol, adopted): local ACID + idempotent provider
  commands + durable outbox/inbox + explicit pending states + webhook verification + reconciliation
  + deterministic compensation. Anyone claiming a Postgres RPC makes Stripe atomic is wrong
  (Kimi's plan claimed exactly this; rejected).
- Exclusion constraints for rooms; row-locked capacity for classes; turnover buffers baked into the
  stored range; **waitlist offer engine (UX amendment):** promotion creates a time-limited offer
  hold + notification with visible expiry (never a silent charge on a stale request), sequential
  pass-to-next on decline/expiry, manual promotion with audited manager override;
  tenant-configurable for room-slots too. **No-show consequence engine (UX amendment):** marking
  no-show executes the booking's policy snapshot (credit forfeit / fee) as a money event with
  member notice; reversal restores the credit, sends a corrected notice, and writes audit
  events — same durable-state discipline as refunds. **Party bookings (UX amendment):** one
  checkout may attach multiple attendee bookings (the booked-by/attendee split records who pays
  vs who attends) — couples and parent+teen book in one conversation.
- **Check-in degraded mode** (both critiques' gap, scoped honestly): the check-in screen keeps a
  local retry queue when the network drops — check-ins queue and sync with conflict surfacing;
  **the per-device queue survives reboot, reports to Health, and blocks shift sign-out with
  unsynced items** (UX amendment). Full offline POS is explicitly out of v1.

### Payments & subscriptions

- Stripe Customer per person (lazy), SetupIntents for card-on-file, PaymentIntents for one-offs,
  Stripe Billing subscriptions (pause = `pause_collection`; plan changes via subscription
  schedules; Kelo retains the intended schedule).
- Entitlements grant only on invoice success (subject to the written grace policy); `past_due`
  semantics per council ruling #7.
- **Dunning:** Stripe Smart Retries for cards; Kelo owns comms/workflow — failed payment → focus
  queue → email/SMS sequence (quiet-hours-safe) with a card-update link → owner-visible retry log.
  **Card-entry surfaces (UX amendment):** the member surface (phase 8) uses embedded Stripe
  elements on-domain for card entry and self-serve card update; Stripe-hosted pages remain
  acceptable for operator-initiated dunning links until then, migrating to the member surface at
  phase 8.
- **Refunds** (Sol's orchestration, replacing hand-waved RPC-wrapping): persist refund command →
  Stripe call (idempotent) → status `pending` → webhook confirms → ledger reversal + credit
  restoration if applicable + confirmation message via outbox. Fully journaled; refunds never
  exceed the original.
- **`verify_money` nightly:** Stripe balance transactions ↔ `payments` (missing/orphaned/
  mismatched); payments ↔ orders; debits ↔ bookings; ledger non-negativity; webhook backlog. Any
  unexplained cent alerts and blocks cutover. Plus scheduled Stripe retrieval as webhook backstop
  (webhooks get delayed/dropped).
- **POS v1:** Stripe Terminal (the studio has a front desk; a payment link is not a POS — Sol) +
  cash tender recording + simple discounts (manager step-up, reason required) + **per-product/
  location tax configuration** (receipts must be correct) + receipts (print / SMS / email /
  "offered on screen" for phoneless members; printer failure defers the receipt, never blocks the
  sale — UX amendment). Explicitly deferred: tips, split tender, till open/close, stock counts.
- **Outreach measurement (Sol's gap, scoped):** v1 attribution = conversions (booking/purchase/
  reactivation) within a configurable window post-send, logged per person per campaign, reported
  with its limitations stated in the UI. Holdout groups and incrementality are v2 — claiming causal
  lift without them would violate the trustworthy-numbers objective.

---

## 6. Build phases in order, with rough effort

Focused weeks, owner + AI coding agents. **Every phase ends with a verification gate requiring
live-data evidence — green tests alone never close a phase** (the meta-lesson). The **release rule**
(standing, from Grok's critique): no "fixed/done" claim without (a) captured evidence, (b) a test
that failed before the fix, (c) a production-visible health signal.

| # | Phase | Contents | Effort | Gate (evidence, not vibes) |
|---|---|---|---|---|
| 0 | **Foundations + reality probes** | Workspace, CI, tenancy/RLS core + generated cross-tenant tests, auth/invites, Sentry, jobs queue + tick + dead-man heartbeat, Health v0, **Glofox read probes pinned**, **write-capability discovery (non-mutating: docs, contractual permission, endpoint existence — no write is sent)**, **Stripe account-ownership investigation**, 10DLC registration prepared + filed (inputs enumerated: EIN, use-case + sample messages, opt-in flow description, and a **minimal public page with a skeleton privacy notice** pulled forward from phase 3 — carrier vetting requires it), staging tenant, PITR + restore drill #1 | 3–4 wk | Cross-tenant attack suite passes; forced double-tick executes once; every consumed Glofox endpoint has a pinned contract (incl. the two must-answer signals in §4); Stripe ownership answer documented with the §4 negative branch invoked if needed; heartbeat alert proven by unplugging the tick |
| 1 | **Import, correct & observable** | Two-zone pipeline, mappers + contract tests, watermark law, quarantine + import-review/exception UI, freshness envelopes + UI chips, reconciliation engine + deletion-detection snapshots, alerting, **parallel Stripe read-only ingest**, full data reset + re-import, `created` validation study | 4–5 wk | 13 months of transactions reconcile to Glofox **and** Stripe; derived member count = owner ground truth (~23); gold-label relationships ≥99%; kill-the-import drill fires all five named in-system tripwires |
| 2 | **Intelligence core** | Revenue dictionary, KPI queries, segment engine, daily briefing + focus queue (failed payments arrive via Stripe ingest), demand heatmap, `/ask` (approved-query catalog), AI fallback modes, briefing feedback loop, **workload model pinned (scale assumptions + k6 scenario) + first load test + RUM instrumentation (Sentry browser tracing, operator flows)** | 3–4 wk | Owner validates a week of briefings against reality; every KPI cites its dictionary version; briefing refuses generation on red reconciliation (proven by drill) |
| 3 | **Outreach + comms execution** | Resend + Twilio (10DLC done in background), consent/suppression/quiet hours, comms_log + delivery webhooks, drafts → approve → send, **lifecycle automation flows + enrollments**, lead-pipeline fields on people, attribution v1, **retention matrix + person deletion/pseudonymization + tenant data export** | 3–4 wk | Real campaign end-to-end; ≥99.5% delivery; every send logged per person; a lifecycle flow (welcome or lapsed-pack) runs live; quiet-hours violation impossible by test; a person deletion executes per the matrix |
| 4 | **Ops: staff, compliance, retail-lite, scheduling authoring** | **Scheduling schema (resources + readiness states, offering templates, schedule rules, session authoring + drafts/publish history — DST-tested)**, staff roles/scheduling-lite + step-up PINs, pay & commission *reports*, waiver engine (versions, re-sign, **pre-arrival signing links + "Waiver needed" desk queue** — the queue is *advisory* in phase 4, a Kelo screen staff consult alongside Glofox check-in, since Kelo check-in doesn't exist until phase 6; the enforcing booking-time block ships with the booking engine and **retires the interim mechanism at phase 6**, keeping the desk queue as a monitored backstop until cutover), retail catalog + gift-card catalog/manual grants (sale ships with POS), **write-capability mutation probes (post-phase-1 gate, sacrificial records, owner sign-off)** → write-back or partition decision | 4–5 wk | Owner authors next week's schedule in Kelo; pre-arrival waiver links sent for real imported bookings and the advisory desk queue in daily use; each shipped screen has a native writer + audit trail (no empty shells) |
| 5 | **Billing spine (Connect)** | Connect platform + tenant account, customers/payments/subscriptions/webhooks inbox + outbox, refund orchestration, dunning workflow, plan catalog + immutable price phases, POS (Terminal + cash + tax config + discounts + receipts), **gift-card sales**, `verify_money`, restore drill #2 | 5–7 wk | Live charges + refunds reconcile to the cent; webhook chaos harness (dupes, reorder, replay, delay) passes; dunning fires on a real failed test card; cohort double-billing test proves impossibility |
| 6 | **Native booking engine** | Availability computation, holds + booking RPCs + exclusion constraints, credit debit flow, waitlists, check-in (+ degraded mode), no-show/late-cancel policy engine, **booking-time waiver block** | 4–6 wk | Concurrency storm: zero double-bookings; booking-time waiver block verified live; front desk runs full real days on partitioned inventory in parallel with Glofox |
| 7 | **Write-back/partition ramp + parallel run** | Authority flips per capability, **go-live sequencing per §4 step 4: front-desk bookings → new membership sales → cohort migration (one billing authority each)**, daily reconciliation in anger, readiness dashboard, **assisted-onboarding assets (setup checklist, guided plan/resource config, launch-readiness check)** | 3–4 wk | 30-day cutover clock starts; zero unexplained variances sustained |
| 8 | **Member beta → cutover → retire Glofox** | Member SSR app (on-domain booking, account claiming, cards, credits, waivers, receipts), member comms plan, cutover runbook rehearsal, freeze-window execution, retirement | 5–7 wk | Cutover bar met — including its member-beta criterion (§4); Glofox read-only 30 days, cancelled one cycle later |

**Totals (sums of the table): ≈29–39 focused weeks to cutover-ready (phases 0–7); ≈34–46 to Glofox
fully retired (through phase 8).** The owner gets trustworthy numbers at the end of phase 1
(~weeks 7–9) and the daily briefing at the end of phase 2 (~weeks 10–13) — everything after runs
on a platform already earning trust. Gates govern, not dates (§6: timeline is not a constraint;
verification is).

---

## 7. Key risks and mitigations

1. **Glofox shape drift / silent semantics** (the historical killer) → probe-and-pin + weekly live
   diff + `success!==true` throws in one client + raw-zone re-transformability + quarantine.
2. **Silent import freeze** → the five named in-system tripwires (§4: watermark law,
   plausible-zero config, consecutive-empty alarm, `expected_min_records` baseline, reconciliation
   drift) plus the external dead-man heartbeat. Six independent tripwires; all six failing
   simultaneously is the new bar.
3. **Fabricated/stale data trusted** → no fixture path in app code (lint), freshness in the
   envelope, honest empty states, **AI refuses generation on red reconciliation**, degraded-mode
   badges.
4. **Money bugs in front of members** → outbox/inbox + holds + webhook-as-truth + idempotency
   end-to-end + `verify_money` + webhook chaos harness + Test Clocks. The category's reputation
   killer, treated as the product's own §5.
5. **Wrong Stripe topology discovered late** → Connect decision made now; account ownership
   investigated in phase 0; PAN portability filed early; per-account webhook/idempotency scoping
   from day one.
6. **Double-billing / double-booking during migration** → partitioned inventory; one billing
   authority per subscription cohort; authority registry visible to operators; no dual-master.
7. **Write-back built on unverified APIs (the §5 sin, round two)** → write-capability discovery
   gate; partitioning as the no-write fallback.
8. **RLS/tenancy leak (existential for SaaS)** → membership-based policies, generated cross-tenant
   attack tests, second tenant seeded day 0, service-role audits, per-tenant Vault credentials.
9. **Scheduler/serverless limits** → chunked resumable jobs, leases + heartbeats + dead-letter,
   background functions, queue makes partial progress durable.
10. **Timezone/DST corruption of the flagship briefing** → studio-day primitive, UTC instants +
    local recurrence intent, DST transition tests in CI.
11. **AI quality rot while import health stays green** → briefing feedback loop, prompt versioning
    + eval fixtures, metric citations to dictionary versions, per-tenant budgets, fallback modes.
12. **A2P 10DLC lead time** → filed in phase 0; email-only outreach until approved.
13. **Solo-operator bus factor / docs drift** → docs-as-code (ADRs, generated schema reference,
    runbooks), contracts + tests as enforced documentation, break-glass tooling with reason codes,
    release rule in CI (evidence-linked "done").
14. **Scope creep from broad v1** → phase gates; every table ships with its writer; the not-build
    list below is enforced, not aspirational.
15. **Backup/restore never rehearsed until needed** → restore drills are phase gates (0, 5, and
    pre-cutover), with documented RPO/RTO.

---

## 8. Explicitly NOT in v1 — and why

- **Native mobile apps — and the installable PWA** (amended per the UX plan): responsive web
  only. A cached app shell risks stale-as-fresh, which the freshness contract cannot tolerate;
  app-store surface violates the low-operational-surface constraint. Revisit on SaaS-customer
  demand.
- **Payroll money movement** — pay/commission calculation, approval, and export only. Unanimous
  council disagreement with the brief's table-stakes reading (Part I, #3); wage custody and tax
  filing belong to Gusto/ADP.
- **General double-entry ledger** — append-only sub-ledgers + `verify_money` invariants now;
  journal derivable later (flagged simplification, Part II §2).
- **ClassPass/aggregator API integrations** — channel modeling + imported/manual attendance only;
  per-channel margin analytics on that data (Grok's economics gap) without a partner-API project
  for the least-valuable cohort.
- **Choose-your-spot seat maps** — spin-studio furniture; a sauna room doesn't need it.
- **Custom report builder** — canned drill-down reports + CSV + `/ask` catalog are the report
  builder.
- **Inventory management beyond catalog + sell + refund** — no stock counts, POs, or supplier
  management; no rows would exist at this volume (§5 mandate 8). Till open/close deferred with POS
  v2.
- **Full self-serve SaaS onboarding + Kelo billing** — model supports it; storefront waits for
  tenant #2. But **assisted-onboarding assets ship in v1** (import review + exception resolution in
  phase 1; setup checklist, guided plan/resource config, and launch-readiness check in phase 7)
  because self-onboarding is a competitive bar the council's critiques caught every plan skipping.
- **Corporate / invoice-to-company billing** — the booked-by/attendee split covers couples,
  guardians, and book-for-someone; true corporate blocks invoiced to a company are deferred
  (workaround: front desk books N attendees; the corporate transaction records against one payer).
  A `bill-to` party model ships when a real corporate account demands it.
- **A custom card vault or raw PAN handling** — Stripe owns vaulting, SCA, and card-present rails;
  Kelo owns checkout, records, reconciliation, and support surfaces (Sol's boundary, adopted).
- **SSO/SAML** — email+password + magic links (MFA mandatory only for owner/manager roles per the
  threat model; no enterprise IdP matrix until a tenant demands it).
- **Realtime-everything** — Supabase Realtime only for today's roster/check-in.
- **Forecasting/ML** — heuristics on true current facts; models on ~hundreds of people overfit and
  erode trust. ML when multi-tenant data exists.
- **Autonomous AI actions** — the AI drafts and recommends; a human approves every send, refund,
  and schedule change. No API route can bypass approval.
- **Second AI provider abstraction, GraphQL, message-bus abstractions, microservices, data
  warehouse, Redis** — Postgres + the queue + direct provider SDKs are sufficient and
  agent-legible.
- **Incrementality/holdout experimentation for outreach** — v1 measures windowed conversions with
  stated limitations; causal claims wait for v2 (trustworthy-numbers discipline applied to Kelo's
  own marketing claims).

---

## 9. Consolidated recommendations on the brief's open questions (§8)

1. **Build vs base:** build natively on Postgres + Stripe (Connect platform, Standard accounts,
   studio as merchant of record). Unanimous.
2. **`created` validation:** phase-1 stratified study vs first booking/transaction; store
   `source_created_at` + `first_activity_at` + basis + quality; UI says "first seen," never
   "signup," when provenance is weak. Cohorts anchor on first activity.
3. **Providers:** **Resend** (email — dedicated sending domain, DMARC, delivery webhooks from
   phase 0) + **Twilio** (SMS — 10DLC filed phase 0). Unanimous.
4. **Auth:** Supabase email+password + magic links; membership-based RLS; invites via
   `tenant_users`; SSO deferred.
5. **AI + PII:** stay on Anthropic with zero-data-retention terms; **de-identified outreach
   drafting by default** (behavioral features + first name; PII interpolated locally at send);
   `/ask` restricted to the approved-query catalog; per-tenant policy toggle; disclosed in the
   privacy policy; retention of prompts/outputs governed by the retention matrix.
6. **Data reset:** full reset; archive the corrupt DB cold; preserve only individually-verified
   owner-authored artifacts. Unanimous.
7. **Freshness:** hourly baseline; 15-minute roster during operating hours; freshness chip
   everywhere from `sync_state`; staleness ambers at 2h, alerts at 4h.

---

## 10. Changelog

**2026-07-17 (Glofox API verification session — pre-phase-0 head start):** the OpenAPI 3.1 spec
(63 operations) and all 13 portal guides pulled locally; live read-only probes run against
production with PII-redacted pinned samples — [docs/glofox/README.md](../docs/glofox/README.md)
is now the standing Glofox source of truth. Confirmed live: three-header auth, all §5 traps
(namespace trap **reproduced**), the full recurring-member evidence chain, plan-type vocabulary
(`num_classes`/`time_classes`/`time`), credit `end_date`, third `glofox_event` value
(`book_class`), consent evidence, webhooks (soft-delete semantics), rate limits (10 rps/1000
burst), incremental-sync params (`utc_modified_start_date`, `modified_start_date`), and the
documented write surface. Owner answers folded: **Stripe negative branch ACTIVE**
(Glofox-gated account); studio = Tampa, FL; owner supplies the existing waiver document.
Phase 0's "Glofox read probes pinned" is substantially pre-completed.

**2026-07-16 (final verification round):** interim waiver-block lifecycle defined (advisory desk
queue in phase 4, enforcing block + retirement at phase 6); schedule authoring endpoints added to
§3; availability formula includes readiness states; RUM vendored (Sentry tracing) and phased;
refund threshold + PINs given data-model homes; merge semantics written and phased (1); Stripe
read-access negative branch written; two must-answer Glofox probe signals (credit expiry,
booking channel) added with degraded rules; 10DLC filing inputs enumerated with a phase-0
skeleton privacy notice.

**2026-07-16 (UX-round amendments folded in):** waiver-before-payment everywhere + pre-arrival
waiver queue; typed-name+checkbox confirmed as the sole waiver artifact; hold-extension semantics
in the `book()` contract; room readiness states; cash-day summary; verified-contact member
bookings (no guest checkout); step-up auth PINs + refund threshold; no-show consequence engine;
waitlist offer engine; party-booking checkout grouping; concurrency surfaces; per-device offline
queue reporting; `written_off` payment state; schedule drafts/publish history; async exports;
printer/deferred-receipt states; focus-queue snooze + digest; outreach tone-lint + pacing;
embedded Stripe elements on the member surface; installable PWA dropped; RUM added to
observability. Source: [plan-ux-final.md](plan-ux-final.md) §9.

## What changed because of the council

For the record — ideas in this final plan that no single model produced alone: the layered
relationship model (Sol's concurrency + Fable/Grok's KPI enum); the write-capability discovery
gate; the Stripe Connect topology decision + parallel Stripe ingest during transition; the studio-
day timezone primitive; the revenue dictionary; exact-by-provider-ID cutover reconciliation;
partitioned-inventory migration with one billing authority per cohort; honest rollback-as-
remediation; AI degradation fallbacks + quality evals; the retention matrix and person-deletion
workflow; POS-with-cash reality; member account claiming; assisted-onboarding assets as v1 build
work; and the evidence-linked release rule. The council earned its cost.

# Kelo Build Plan — Claude Fable 5

*Independent council plan. Written against `plans/brief.md` (2026-07). Every recommendation is
grounded in §5 (verified Glofox facts + failure modes) and §6 (constraints). Disagreements with the
brief are flagged inline with **⚠ Disagreement**.*

---

## 1. Architecture overview

### Guiding decisions

The two constraints that shape everything are **(a)** the team is one owner + AI coding agents, and
**(b)** the prior build died from unverified assumptions. So the architecture optimizes for:
*few moving parts, one source of truth per concern, structural (not conventional) correctness
guarantees, and verification harnesses as first-class deliverables.* Where a correctness property
can be enforced by Postgres itself (constraints, exclusion ranges, RLS, transactional functions),
it lives in Postgres — the database is the component least likely to be misused by a future coding
agent that didn't read the docs.

### Stack (within fixed constraints: Supabase + Netlify + Stripe + Claude)

- **Monorepo (pnpm + Turborepo), TypeScript everywhere, strict mode.** Packages:
  - `packages/db` — SQL migrations (Supabase CLI), generated TypeScript types from the live schema
    (`supabase gen types`), and the Postgres functions (RPCs) that own all money/booking mutations.
  - `packages/contracts` — Zod schemas for every API request/response and every Glofox payload
    shape. **This is the single source of truth for shapes.** API handlers parse with these; the
    importer parses with these; tests import these. Nothing declares a shape twice.
  - `apps/api` — Hono app deployed as Netlify Functions (one function, route-mounted). Typed client
    exported via `hono/client` so the web app gets end-to-end types without codegen.
  - `apps/web` — the operator app: **Vite + React SPA** with TanStack Router + TanStack Query.
  - `apps/member` — (later phase) the member-facing booking surface, a separate small
    SSR/edge-rendered app so its performance and branding don't entangle the operator app.
  - `workers/` — the import pipeline, job processors, and AI generation, deployed as **Netlify
    Background Functions** (15-minute limit) triggered by the single scheduler tick.

  **Why a SPA and not Next.js/SSR for the operator app:** the operator app is auth-gated and
  data-dense — SEO is irrelevant, and SSR on Netlify adds a second rendering paradigm and a
  framework adapter layer for zero user benefit. A code-split SPA with edge-cached static assets
  and query caching comfortably meets the p95 < 1.0s budget, and it's the simplest architecture for
  coding agents to modify safely (one rendering model, one data-fetching pattern). The member
  surface — where first-paint speed and link unfurls matter — gets SSR later, as its own app.

- **Exactly one scheduler (per §5 mandate 7), enforced structurally:** a single Netlify Scheduled
  Function fires every 5 minutes and does nothing but enqueue/claim work from a Postgres **`jobs`**
  table using `FOR UPDATE SKIP LOCKED`. All recurring work (import, segment recompute, briefing
  generation, dunning comms, reconciliation, alert evaluation) is a row in `jobs` with a schedule,
  an idempotency key, and a lease. Even if Netlify double-fires the tick or someone later adds a
  second trigger, the DB lock makes double-execution *impossible*, not just unlikely. The tick is
  dumb; the queue is the scheduler.

- **Observability (must be built — §4):**
  - **Sentry** for error tracking (web + functions). One vendor, both surfaces.
  - **In-DB operational truth:** `sync_runs`, `sync_state`, `job_runs` tables record every run with
    status, row counts, duration, error. The app's **Health page renders directly from these
    tables** — the freshness indicator on every screen reads `sync_state.last_verified_at`, never a
    hardcoded string (§5 mandate 4).
  - **Alerting:** an `alerts` job evaluates rules (import failed, watermark stale > threshold,
    zero-rows-N-runs on an always-active entity, reconciliation drift, Stripe webhook backlog) and
    notifies via Resend email + Twilio SMS to the owner. Plus one external dead-man's-switch
    (Healthchecks.io or BetterStack heartbeat) pinged by the scheduler tick — so *even total
    scheduler death* alerts. That external heartbeat is the only piece of observability that must
    live outside the system it watches.

### How Kelo-native data coexists with the Glofox import: the two-zone model

This is the load-bearing architectural idea for the transition:

- **Zone 1 — `glofox_raw` (landing zone).** Raw JSON payloads exactly as fetched, immutable,
  append-only: `glofox_raw.<entity>(id, tenant_id, external_id, payload jsonb, payload_hash,
  fetched_at)`. No interpretation. This makes every downstream mapping *re-runnable and auditable*:
  if a mapping bug is found (the prior build's core failure), fix the mapper and re-transform from
  raw — no re-fetching, no data loss, and the bad mapping is diagnosable because the source payload
  is still there.
- **Zone 2 — Kelo-native tables (the real schema).** Designed for how a recovery studio should work
  (§4 principle: Glofox is a source, not a template). Every row carries
  `source ∈ {native, glofox}` and, for imported rows, `external_ref` (Glofox id). The transform
  step (raw → native) is a set of pure, versioned mapper functions in `packages/contracts` — each
  mapper is **traceable to a pinned, redacted sample payload** checked into the repo (§5 mandate 1)
  and contract-tested against it in CI.

After cutover, the import stops, `source='glofox'` rows remain as history, and nothing about the
native schema changes. The strangler fig is a data-flow direction switch, not a re-architecture.

**Demo/seed data is structurally unreachable from production** (§5 mandate 3): seed data exists
only in a separate Supabase branch/project used by tests and previews. There is no code path in the
app that can substitute fixture data — no fixture imports in `apps/`, enforced by a lint rule.

---

## 2. Data model

All tables: `tenant_id uuid not null references tenants(id)`, RLS policy
`tenant_id = auth.jwt() ->> 'tenant_id'` (via a `current_tenant_id()` helper), composite indexes
led by `tenant_id`. Mutating money/booking paths go through `SECURITY DEFINER` Postgres functions
that re-verify tenancy explicitly — RLS is the fence, functions are the gate.

### Tenancy & identity

- **`tenants`** — studio/org; settings JSONB (branding, timezone, briefing hour, AI/PII toggles).
- **`locations`** — 1..n per tenant (model multi-location now; UI can assume one).
- **`tenant_users`** — links `auth.users` → tenant with role (`owner`, `manager`, `front_desk`,
  `trainer`); invite tokens for org onboarding. This table *is* the multi-tenant auth model —
  Supabase Auth stays vanilla email+password (+ magic links, which Supabase gives nearly free).
- **`people`** — everyone the studio touches. `email citext` with a **partial unique index per
  tenant on normalized email where email is not null** — dedup by email as the brief says, but
  email must be nullable (walk-ins, some aggregator users have none), with a `person_merges` table
  and merge tooling rather than pretending collisions can't happen.
  **⚠ Disagreement (minor):** "deduplicated by email" is the right default but wrong as an
  invariant — shared family emails and email-less walk-ins are real in this niche. Model dedup as a
  *process* (merge tool + match candidates) not a *constraint*.

### Person-relationship typing — the most important modeling decision

The relationship type is **derived, never hand-entered, and stored with provenance**:

- **`people.relationship`** enum: `recurring_member | pack_holder | aggregator | guest | lead` —
  a *materialized* column recomputed by one deterministic SQL function,
  `compute_relationship(person_id)`, from facts already in the ledger:
  1. `recurring_member` ⇐ has an `active`/`past_due` row in `subscriptions`;
  2. `pack_holder` ⇐ credit-ledger balance > 0, or a pack purchase within N days;
  3. `aggregator` ⇐ most-recent attendances sourced from an aggregator booking channel;
  4. `guest` ⇐ has any transaction/attendance but none of the above;
  5. `lead` ⇐ none — signed up, never transacted.
  Precedence is exactly that order.
- **`person_status_history`** — append-only log of every transition (old → new, basis JSONB of the
  evidence, computed_at). This powers the conversion engine the product exists for: *pack_holder →
  recurring_member* transitions are literally rows in this table, so conversion-rate KPIs and
  "trial-graduated" segments are queries, not vibes.
- The **"member" KPI and MRR derive only from `relationship = recurring_member`** — with ~22–24
  expected today, this is also the first reconciliation check against Glofox reality: if the
  derived count isn't ≈23, the derivation is wrong and the import gate fails (see §4).

Behavioral **segments** are one level above relationship: `segment_definitions` (versioned rule
specs — SQL predicates over facts, ~13 to start) and `segment_assignments(person_id, segment,
computed_at, run_id)` — recomputed as a whole per run, kept append-only per run_id so any briefing
or outreach can cite *exactly which segment run* it was drafted from. Segments are derived, never
source data (§4).

### Scheduling, booking, credits

- **`resources`** — physical capacity: sauna room, plunge, contrast suite; capacity, open hours,
  maintenance windows.
- **`offering_templates`** — what's sellable: group class (capacity N, trainer) or **room-slot
  appointment** (resource, duration, buffer/turnover minutes, price or credit cost). Recovery-native
  first: room-slot is the primary construct, group class the secondary — the inverse of gym tools.
- **`sessions`** — scheduled instances (template, location, trainer?, starts_at, capacity) for
  class-type offerings.
- **`bookings`** — one table for both shapes: `person_id`, either `session_id` *or*
  (`resource_id`, `time_range tstzrange`), `status ∈ pending|confirmed|checked_in|no_show|
  cancelled|waitlisted`, `channel ∈ native|front_desk|glofox_import|aggregator`, `payment_kind ∈
  credit|payment|subscription_entitlement|comp`, idempotency key.
  **Double-booking is prevented by a Postgres GIST exclusion constraint** on
  `(resource_id, time_range)` for room-slots and by a capacity check inside the booking RPC for
  classes — the database physically cannot hold two overlapping bookings for one room. This is §5
  mandate 6 made structural.
- **`credit_ledger`** — append-only, the heart of recovery economics: rows for `grant` (pack
  purchase, with expiry), `debit` (booking), `refund_credit`, `expire`, `manual_adjustment`
  (reason + actor required). Balance is `sum(delta)` per person/pack — never a mutable column.
  Liability report = sum of unexpired grants minus debits, valued at grant unit price: this makes
  the **credit-liability differentiator a single query**.
- **`waivers`** + **`waiver_signatures`** (per-session where required), **`checkins`**.

### Money

- **`plans`** — sellable catalog: recurring (monthly/annual/unlimited), credit packs, drop-ins,
  intro offers, with launch-tier ramps (founding → opening → standard) modeled as versioned prices.
- **`subscriptions`** — Kelo's entitlement record, mirroring Stripe subscription state via webhooks;
  freeze/pause/cancel with effective dates.
- **`orders`** + **`order_lines`** — what was sold (pack, retail, gift card, drop-in).
- **`payments`**, **`refunds`** — 1:1 with Stripe PaymentIntents/Refunds, status-machine columns,
  `stripe_event_id` provenance.
- **`stripe_events`** — every webhook, raw, unique on event id; processors are idempotent
  consumers of this table (never of the HTTP request).
- **`gift_cards`** — simple code + balance ledger (same append-only pattern as credits).
- **`comms_log`** — every email/SMS ever sent (transactional + marketing): person, channel,
  template, provider message id, delivery status from provider webhooks. This is both the outreach
  log (§ flows B) and the dunning audit trail.

### Intelligence & ops

- **`ai_artifacts`** — briefings, drafts, recommendations: prompt version, model, input-data
  window, output, cost, TTL. Briefings are *stored*, not regenerated on view.
- **`outreach_drafts`** → approval → `comms_log` (the AI never sends; approval flips state — §3B).
- **`activity_events`** — append-only feed (booking made, payment failed, credit expiring) that
  powers the home-screen focus queue.
- **`sync_state`**, **`sync_runs`**, **`jobs`**, **`job_runs`**, **`alerts`** — as in §1.
- **`reconciliations`** — per entity/window: Glofox count/sum vs Kelo count/sum, drift, status.
  This table *is* the cutover-readiness meter.

Deliberately absent (per §5 mandate 8 — no speculative schema): payroll runs, inventory counts,
seat maps, aggregator API mirrors, custom report definitions. Tables ship in the phase that ships
the feature that writes to them.

---

## 3. API surface

One Hono app (`apps/api`), JSON over HTTPS, Zod-validated at the boundary, typed client consumed by
the web app. Auth via Supabase JWT (tenant claim injected at login via `tenant_users`). Groups:

- **`/auth`, `/tenant`** — session, tenant settings, invites, roles.
- **`/people`** — search, profile (relationship + history + visits + credits + comms),
  merge, notes.
- **`/segments`** — current assignments per segment, per-person basis ("why is this person
  at-risk"), segment run history.
- **`/briefing`** — today's briefing (from `ai_artifacts`), mark-read, feedback; `/focus-queue`.
- **`/schedule`** — sessions & room-slot availability (the availability query is a server
  computation over resources + exclusion ranges, never client-derived), demand heatmap,
  AI schedule recommendations.
- **`/bookings`** — create/cancel/check-in/no-show. Create requires a client-generated
  **idempotency key**; the handler calls the `book()` Postgres RPC and returns the definitive
  result (confirmed / waitlisted / rejected-with-reason).
- **`/billing`** — orders, payments, refunds (RPC-backed), subscription lifecycle
  (create/pause/freeze/cancel), card-update links (Stripe-hosted), dunning queue.
- **`/outreach`** — drafts per segment, edit, approve→send, per-person send history, measurement
  (delivery/open/reply where available).
- **`/reports`** — revenue, attendance, cohort/churn, LTV, plan-mix, **credit liability**, **room
  utilization**; every report endpoint supports drill-down params and `format=csv` export (§2
  criterion 4 — no manual CSV step).
- **`/health`** — per-entity freshness, last runs, alert states; public (unauthenticated,
  minimal) `/health/ping` for the external heartbeat.
- **`/ask`** — free-text Q&A over the tenant's data (server-side Claude with SQL-tool access,
  read-only role, rate-limited, responses cached in `ai_artifacts`).
- **Webhooks:** `/webhooks/stripe`, `/webhooks/resend`, `/webhooks/twilio` — signature-verified,
  write to event tables, return 200 fast; processing is async via the job queue.

Consumption: the operator SPA is the only v1 client. The member beta app later consumes the same
`/schedule` + `/bookings` + `/billing` contracts with a member-scoped auth role — designing those
endpoints person-scoped now costs nothing and avoids a second API later.

**Freshness is in every response envelope:** `{ data, meta: { as_of, source, stale } }` — the UI
renders the staleness chip from `meta`, so a screen *cannot* show data without its provenance
(§5 mandate 4 designed out at the contract level).

---

## 4. Import + migration strategy

### Step 0 — the probe-and-pin harness (before any mapper is written)

A small CLI (`workers/probe`) that: fetches live samples from every Glofox endpoint Kelo consumes;
**redacts PII deterministically**; writes pinned JSON snapshots to `packages/contracts/glofox/
samples/`; and records the request (endpoint, params — including the namespace parameter) alongside.
Every Zod schema for a Glofox payload must reference the sample file it was derived from. CI runs
all mappers against all pinned samples. A weekly scheduled probe re-fetches and **diffs live shape
vs pinned schema — shape drift alerts before it corrupts data.** This is §5 mandate 1 as
infrastructure, not discipline.

The §5 verified facts become executable checks, not documentation:

| Verified fact (§5) | Design response |
|---|---|
| `membership` is an object; recurring = `membership.type` + `subscription_payment` txns | Mapper joins `user_membership_id` → memberships catalog; relationship derivation (§2) uses subscription evidence, never a name string |
| `created` = unix seconds; may be migration date | Import stores it as `source_created_at`; cohort anchor is `first_activity_at = least(first booking, first txn)` — see recommendation below |
| Transactions report returns 0 rows at HTTP 200 without namespace param | The request builder *requires* the namespace param at the type level (non-optional field); plus the zero-row tripwire below |
| HTTP 200 + `success:false` on auth errors | HTTP client treats `success !== true` as a thrown error, everywhere, in one shared client |
| POST-as-read, string unix seconds, inconsistent pagination | One `glofoxFetch()` client owns pagination strategies per endpoint; timestamps parsed once at the boundary by the Zod schema |
| Everyone is a "lead" | Relationship is derived from behavior (§2) — the Glofox flag is never imported as meaning |

### The import pipeline (per entity, per run)

1. **Fetch** into `glofox_raw` (append, hash-deduped). Record `sync_runs` row: requested window,
   HTTP outcomes, rows fetched.
2. **Transform** raw → native via versioned mappers (idempotent upserts keyed on
   `(tenant_id, external_ref)`).
3. **Watermark advance — the §5-mandate-2 rules:**
   - advance **only** on a verified-successful fetch (`success === true`, schema-valid);
   - a zero-row result advances the watermark **only if** zero is plausible for the window
     (per-entity plausibility config: e.g., transactions for a live studio have
     `max_plausible_empty_runs = 3`); otherwise the run is recorded as `suspect_empty` and
     **does not advance**;
   - `consecutive_empty` counter per entity; crossing the threshold fires an alert.
4. **Verify** — post-run invariant checks (row counts vs previous, referential joins resolved,
   e.g. every transaction's person exists) recorded on the run.

Cadence: hourly for all entities; **15-minute for today's bookings/roster** (the one flow where
staleness is operationally painful — recommendation for §8 Q7). Freshness surfaces per §3.

### Reconciliation — the trust engine and the cutover meter

A daily `reconcile` job compares, per entity and rolling window: Glofox count vs Kelo count,
revenue sum vs revenue sum, member count vs derived `recurring_member` count (expected ≈22–24 —
the built-in canary). Results land in `reconciliations`; drift beyond tolerance alerts. This same
machinery later verifies write-back and gates cutover — build it once in phase 1, use it for the
whole strangler fig.

### Strangler-fig sequencing (per §4 order: booking/payments last)

1. **Now:** read-only import + intelligence (phases 0–3 below).
2. **Write-back graduates per entity, gated on reconciliation:** first non-transactional writes
   (person notes/tags, marketing consent), each behind a per-entity `write_back_enabled` flag that
   is flipped only after N clean reconciliation cycles for that entity. Every write-back is
   journaled (`write_back_log`: payload sent, Glofox response, verification re-read).
3. **Scheduling ownership:** Kelo becomes where the schedule is *authored*, pushed to Glofox;
   Glofox remains the member booking surface temporarily.
4. **Booking + payments last:** native engine live for front-desk/owner bookings first (staff-
   mediated = controlled blast radius), Glofox bookings still imported; then new membership sales
   native; then a **parallel-run period** where Kelo is primary and Glofox is reconciled daily.
5. **Member beta surface**, then **cutover**.

### Cutover-readiness bar (concrete, per §2 criterion 8)

Cut over when **all** hold for **30 consecutive days**:
- reconciliation drift = 0 people, 0 bookings, ≤0.5% revenue-sum variance (with every variance
  explained and logged);
- 100% of Stripe charges in the window map to a Kelo order/payment record (billing parity);
- derived member count matches owner's ground truth exactly;
- zero open P1 data-correctness defects; import zero-freeze incidents = 0;
- staff has run all daily ops (check-in, booking, refund, pause) in Kelo without touching Glofox
  for the final 14 days;
- a restore-from-backup drill has passed within the last 60 days.
Then: Glofox export archived (full raw snapshot to cold storage), import jobs disabled, Glofox
subscription cancelled *one billing cycle after* cutover (not same-day — cheap insurance).

---

## 5. Native booking + payment engine

**§8 Q1 recommendation: build it — on Postgres primitives, with Stripe Billing as the recurrence
engine.** Licensing a booking backend re-creates the rented-workflow problem Kelo exists to escape;
but hand-rolling *recurring billing schedules* re-creates the money-bug surface the incumbents are
hated for. The split: **Kelo owns availability, bookings, credits, entitlements, orders; Stripe
owns card vaulting, recurrence, retries, and SCA.** Stripe is infrastructure, not workflow — it
doesn't constrain Kelo's design the way a booking backend would.

### Booking core

- All booking mutations are single Postgres RPCs (`book`, `cancel_booking`, `check_in`,
  `mark_no_show`) — one transaction each: validate → capacity/exclusion check → insert booking →
  debit credit ledger *or* attach payment → write activity event. Atomic by construction.
- **Idempotency:** every RPC takes a caller-supplied idempotency key, stored uniquely; a retry
  returns the original result. The API layer requires it; the web client generates it per user
  action. Double-click, retry-on-timeout, and webhook replay all collapse to one booking.
- **Room-slot correctness:** GIST exclusion constraint (§2) + turnover buffers baked into the
  stored `time_range` (a 60-min sauna with 15-min turnover reserves 75 min). Availability =
  resource open hours − maintenance − existing ranges, computed server-side in one query.
- **Waitlist:** class-type sessions only in v1; auto-promote on cancellation (job-queue task with
  a notification, honoring a claim window). Room-slots don't need waitlists at this scale — skip
  (§5 mandate 8).

### Payments & subscriptions

- **Stripe objects:** one Customer per person (created lazily), SetupIntents for card-on-file,
  PaymentIntents for one-off charges (packs, drop-ins, retail, gift cards), **Stripe Billing
  Subscriptions** for recurring plans (freeze/pause = Stripe pause_collection; plan changes =
  subscription updates with proration policy per plan).
- **Continuity advantage (§5 verified):** the studio's charges already run through Stripe under
  Glofox. Before native billing launches, confirm whether the existing Stripe account is
  studio-owned or Glofox-platform-owned. If studio-owned, cards may be reusable in place; if
  platform-owned, use **Stripe's standard PAN data-portability process** (Glofox/Stripe support
  card-data migration between accounts) — this is the single biggest member-friction risk at
  cutover and the request should be filed *early* (it takes weeks and may need Glofox cooperation;
  fallback is a self-serve card-update campaign, which the comms engine can run).
- **Webhook-driven truth:** Kelo never assumes a charge succeeded from the API response alone;
  `stripe_events` → idempotent processors update `payments`/`subscriptions`. UI shows
  member-visible confirmation only from recorded state.
- **Dunning:** Stripe Smart Retries handles card retries; Kelo owns the *comms and workflow* —
  failed payment → activity event → focus-queue item → automated email/SMS sequence with a
  Stripe-hosted card-update link → owner-visible retry log (§ flow D). Self-serve card update is
  Stripe-hosted in v1 (correct, PCI-light), custom-branded later.
- **Refunds:** RPC wraps Stripe refund + ledger entry + comms log entry + activity event — one
  action, fully journaled, member gets a confirmation email. No "manual refunds done on the side."
- **Money verification (the §5-mandate-6 backstop):** a nightly `verify_money` job reconciles
  Kelo `payments` against Stripe balance transactions (missing, orphaned, amount-mismatched) and
  credit-ledger integrity (no negative balances, debits reference bookings). Drift alerts. Money
  bugs get *caught by the system*, not by an angry member.

### POS / retail

v1: front-desk checkout screen creating PaymentIntents (card-present via manual entry or payment
link/QR); simple product catalog; gift cards as ledgered codes. Stripe Terminal hardware is a
fast-follow *if* the front desk wants tap-to-pay — not v1 (§5 mandate 8: no speculative surface).

---

## 6. Build phases in order, with rough effort

Effort in **focused weeks (owner + AI coding agents)**. Each phase ends with a **verification
gate** — evidence against live data, not green tests alone (the meta-lesson). No phase starts
before the prior phase's gate passes.

| # | Phase | Contents | Effort | Verification gate |
|---|---|---|---|---|
| 0 | **Foundations** | Monorepo, CI, Supabase project + tenancy/RLS core, auth + tenant_users, Sentry, jobs/scheduler skeleton, external heartbeat, Health page v0 | 2–3 wk | RLS proven by cross-tenant access tests; scheduler single-execution proven under forced double-tick |
| 1 | **Import, correct & observable** | Probe-and-pin harness, raw zone, mappers + contract tests, watermark/zero-row rules, freshness envelope + UI chips, reconciliation job, alerting | 3–4 wk | 13 months of transactions imported and **sums match Glofox reports**; derived member count = owner's ground truth (~23); kill-the-import drill fires alerts |
| 2 | **Intelligence core** | KPI queries, segment engine (~13 segments), daily briefing generation + home screen + focus queue, demand heatmap, `/ask` | 3–4 wk | Owner validates a week of briefings against reality; every KPI spot-checked vs Glofox |
| 3 | **Outreach execution** | Resend + Twilio integration (start 10DLC registration in phase 0!), comms_log + delivery webhooks, drafts → approve → send loop, measurement | 2–3 wk | Real segment campaign sent end-to-end, delivery ≥99.5%, every send logged per person |
| 4 | **Billing spine** | Stripe customers/payments/subscriptions/webhooks/refunds, dunning workflow, card-on-file, plan catalog, POS-lite checkout, `verify_money` | 4–6 wk | Live test charges + refunds reconcile to the cent; webhook replay/duplication harness passes; dunning sequence fires on a real failed test card |
| 5 | **Native booking engine** | Resources, templates, sessions, availability, booking RPCs + exclusion constraints, credits debit flow, waivers, check-in, waitlist | 4–6 wk | Load test: concurrent booking storm produces zero double-bookings; front desk runs a full real day in Kelo (parallel with Glofox) |
| 6 | **Write-back & parallel run** | Per-entity write-back gates, write_back_log, schedule authoring in Kelo, membership sales native, daily reconciliation in anger | 3–4 wk | 30-day cutover bar (§4) starts counting |
| 7 | **Member beta + cutover** | Member booking surface (SSR app, on-domain), self-serve card update, cutover runbook execution, Glofox retirement | 4–6 wk | Cutover bar met; members booking natively; Glofox cancelled |

Total ≈ 25–36 focused weeks. Phases 2–3 deliver the owner daily value from week ~6 onward, so the
long tail (4–7) runs on a platform that's already earning trust — which is exactly what the
strangler fig needs.

---

## 7. Key risks and mitigations

1. **Glofox API shape drift / undocumented behavior** (the #1 historical killer). *Mitigation:*
   probe-and-pin harness + weekly live-shape diff + `success!==true`-is-error in one shared client
   + raw zone re-transformability. Shape drift becomes an alert, not silent corruption.
2. **Silent import freeze** (§5 mandate 2). *Mitigation:* watermark rules + per-entity plausible-
   zero config + consecutive-empty alarms + external dead-man's heartbeat + reconciliation drift
   alerts. Four independent tripwires; all four failing simultaneously is the new bar.
3. **Fabricated/stale data trusted as real** (§5 mandates 3–4). *Mitigation:* no fixture path in
   app code (lint-enforced); freshness in the API envelope so UI can't omit it; honest
   empty/error states as designed components from phase 0.
4. **Money bugs in front of members** — the category's reputation killer. *Mitigation:* Stripe
   Billing for recurrence, RPC-only mutations, idempotency keys end-to-end, webhook-event-sourced
   state, nightly `verify_money`, refund/dunning fully journaled. Phase-4 gate includes a
   webhook-chaos test (duplicates, out-of-order, replays).
5. **Double-booking under concurrency.** *Mitigation:* exclusion constraints — correctness by
   schema, load-tested at the phase-5 gate.
6. **Card-vault portability at cutover** (members forced to re-enter cards → churn). *Mitigation:*
   determine Stripe account ownership early (phase 4, not phase 7); file the PAN-portability
   request months ahead; fallback comms campaign ready.
7. **A2P 10DLC registration lead time** blocks SMS. *Mitigation:* start registration in phase 0;
   email-only outreach works meanwhile.
8. **Scheduler/platform limits** (Netlify function duration, cold starts). *Mitigation:* jobs are
   chunked and resumable (per-entity, per-window); background functions for long work; the queue
   makes partial progress durable.
9. **RLS mistakes leaking tenant data** — existential for SaaS. *Mitigation:* RLS test suite that
   attempts cross-tenant reads/writes for every table as a *generated* test (new table without a
   policy fails CI); second tenant seeded from day 0 so single-tenant blindness can't develop.
10. **AI cost/latency/quality drift.** *Mitigation:* briefings generated once daily and stored;
    prompts versioned in-repo with eval fixtures; per-tenant token budgets; cached artifacts with
    TTL; `/ask` rate-limited.
11. **Solo-operator bus factor & docs drift** (§5 mandate 9). *Mitigation:* docs-as-code — ADRs +
    a generated schema reference + runbooks live in the repo; CLAUDE.md points to them; the
    contract tests *are* the API documentation's enforcement arm. One source of truth, verified by
    CI, per §6's agent-maintainability requirement.
12. **Scope creep from the broad v1.** *Mitigation:* the phase gates. **⚠ Disagreement (partial):**
    the brief declares v1 scope broad "by decision," but §5 mandate 8 (no speculative schema/
    screens) pulls the other way. I resolve it as: breadth is the v1 *program*, not the v1
    *moment* — every table-stakes item ships inside a phase that fills it with real data, and
    anything that would ship as an empty screen gets cut from that phase. If forced to choose,
    mandate 8 wins.

---

## 8. What I would explicitly NOT build in v1 — and why

- **Native mobile apps.** Responsive web + PWA (installable, push-capable) covers owner and member
  flows; app-store maintenance is pure operational surface against §6. Revisit when a SaaS
  customer demands it.
- **Payroll money movement.** Staff roles, session pay *reporting*, and commission calculation:
  yes (cheap, table-stakes adjacent). Actually moving payroll dollars: no — that's a regulated
  domain owned by Gusto/ADP; export a report instead. **⚠ Disagreement:** the brief lists
  "payroll" as table-stakes; I'd ship *pay reporting*, not payroll execution — no incumbent
  actually runs payroll either, and the compliance surface is disproportionate.
- **ClassPass/aggregator API integration.** Model aggregator attendance from imported/manual data
  (the `channel` field); a live ClassPass integration is a whole partner-API project serving the
  *least* valuable cohort. The intelligence layer needs the *category*, not the feed.
- **Choose-your-spot seat maps.** Real for spin studios; not for a sauna room. Skip until a
  tenant's floor plan demands it.
- **Custom report builder.** The canned reports + CSV export + `/ask` free-text Q&A cover the need;
  a query-builder UI is a permanent maintenance tax. `/ask` is the report builder.
- **Retail inventory management.** Product catalog + sell + refund: yes. Stock counts, purchase
  orders, supplier management: no rows would ever be written at this studio's retail volume
  (§5 mandate 8).
- **Self-serve multi-org SaaS onboarding + billing** (per brief §7) — the *model* supports it; the
  storefront waits for tenant #2 being real.
- **SSO/SAML.** Email+password + magic links until an enterprise tenant exists.
- **Realtime-everything.** Supabase Realtime only where it earns rent (today's roster/check-in
  screen); everything else is TanStack Query with sane staleness.
- **Forecasting/ML models.** The briefing's value is synthesis of *true current facts*; predictive
  models on ~hundreds of people overfit and erode the trust the product is rebuilding. Heuristics
  (rebooking-rate windows, credit-expiry horizons) first; ML when there's multi-tenant data.
- **A second AI provider abstraction layer.** Claude is assumed persistent (§6); an abstraction
  "just in case" is speculative complexity. Prompts are versioned and provider-portable by being
  plain text — that's abstraction enough.

### Recommendations on the remaining open questions (§8)

- **Q2 (`created` validation):** one-time probe comparing `created` vs first booking/transaction
  across the full person set; if `created` clusters on migration dates, anchor cohorts on
  `first_activity_at`. Store both regardless; never trust either as "signup" in UI copy — label as
  "first seen" / "first activity."
- **Q3 (providers):** **Resend** for email (already scaffolded; add delivery webhooks + a
  dedicated sending domain with DMARC from phase 0). **Twilio** for SMS (10DLC early, per risk 7).
- **Q4 (auth):** Supabase Auth, email+password + magic links now; org invites via `tenant_users`;
  SSO deferred (above).
- **Q5 (AI PII):** stay on Anthropic with a zero-data-retention agreement; **de-identify outreach
  drafting by default** — the model receives behavioral features + first name only; full PII never
  needed for drafting quality. Per-tenant policy toggle stored in tenant settings; disclosed in
  the privacy policy.
- **Q6 (data reset):** full reset. Archive a snapshot of the corrupt DB to cold storage first
  (cheap insurance), preserve nothing into the new schema except any *manually authored* owner
  notes if they exist — verify with a 10-minute query, then drop.
- **Q7 (freshness):** hourly baseline; 15-minute for today's bookings; freshness chip everywhere
  from `sync_state` (never hardcoded — §5 mandate 4).

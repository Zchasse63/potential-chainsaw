# Kelo Build Plan

---

## 1. Architecture overview

### Stack (concrete choices)

| Layer | Choice | Why |
|---|---|---|
| App | **Vite + React 19 + TypeScript** SPA | Lowest cognitive surface for agent-driven work; no SSR/RSC footguns. Operator app is authenticated, not SEO-critical. |
| API | **Hono** on **Netlify Functions** | Typed, tiny, runs where hosting already is. One runtime for HTTP + scheduled jobs. |
| DB / Auth / RLS | **Supabase Postgres + Auth** (fixed) | Tenant isolation via RLS; money ops as Postgres functions. |
| Types | **Zod** schemas as the contract; **supabase gen types** for DB | Single source of truth agents can trust. |
| Payments | **Stripe** (Subscriptions + PaymentIntents + Customer Portal + webhooks) | Already under Glofox; continuation, not a processor migration. |
| Email | **Resend** | Already scaffolded. |
| SMS | **Twilio** | Boring, documented, agent-friendly SDK. |
| AI | **Anthropic Claude** (server-side only) | Briefing, segments, outreach drafts, Q&A. |
| Jobs | **Netlify Scheduled Functions — one scheduler only** | §5 #7. Cross-process lock via `pg_try_advisory_lock` + job-run row. |
| Observability | **Sentry** (errors) + **import_runs / job_runs tables** + **Resend/Twilio/Stripe webhook health** + email/SMS alert on import failure | §5 #4: none exists today; must be ground-floor. |
| Hosting | **Netlify** (fixed) | SPA + functions + schedules. |

**Disagreement with a common default:** I would **not** use Next.js App Router here. The operator surface is an authenticated dashboard; SSR adds framework surface that agents routinely get wrong (cache, server/client boundary, route handlers vs actions), without buying SEO or public-page wins in v1. Vite SPA + Hono functions is simpler to verify and reason about.

### Service boundaries

```
┌─────────────────────────────────────────────────────────────┐
│  Operator SPA (Vite/React)                                   │
│  home · segments · schedule · people · billing · settings    │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS (JWT from Supabase Auth)
┌──────────────────────────▼──────────────────────────────────┐
│  Hono API (Netlify Functions)                                │
│  /api/v1/*  ·  /webhooks/stripe  ·  /webhooks/glofox(none)   │
│  · AI routes (rate-limited)  ·  import admin                 │
└──────┬──────────────────┬──────────────────┬────────────────┘
       │                  │                  │
┌──────▼──────┐  ┌────────▼────────┐  ┌──────▼──────────────┐
│ Supabase    │  │ Stripe          │  │ Anthropic / Resend  │
│ Postgres+RLS│  │ Billing SoR $   │  │ / Twilio            │
│ Auth        │  │                 │  │                     │
└──────▲──────┘  └─────────────────┘  └─────────────────────┘
       │
┌──────┴──────────────────────────────────────────────────────┐
│  Scheduled Functions (ONE mechanism)                         │
│  import:hourly · dunning · lifecycle · briefing:daily        │
│  segment-refresh · credit-liability · health-check           │
│  Each job: acquire advisory lock → run → write job_runs row  │
└──────┬──────────────────────────────────────────────────────┘
       │ read-only until write-back gate lifts
┌──────▼──────┐
│ Glofox REST │  transitional import source only
└─────────────┘
```

### How Kelo-native data coexists with Glofox import

Two explicit layers, never mixed:

1. **`source = 'glofox' | 'kelo'`** on every imported-or-natively-created entity that has a dual life (people, bookings, sessions, transactions, memberships, credits).
2. **`external_ids` table** (or per-entity `glofox_id` + unique partial index) maps Glofox IDs → Kelo UUIDs. Native creates have `glofox_id IS NULL` until write-back.
3. **Authority flag per domain on the tenant:** `authority.people | bookings | payments | marketing | schedule` ∈ `{glofox, kelo}`. Import **writes only domains still under Glofox authority**. When a domain flips to Kelo, import for that domain stops (or becomes reconciliation-only).
4. **No dual-write by default.** Write-back is a separate, gated path (tested, reconciliation-gated) that only activates per domain when the readiness bar for that domain is met. Booking + payments flip last.

During transition the operator UI reads **Kelo tables only**. Freshness of Glofox-sourced domains is shown as a visible watermark banner (`last_successful_import_at`, staleness color). Native-owned domains show live.

### Multi-tenancy shape

- Every business table has `tenant_id uuid not null references tenants(id)`.
- RLS: `tenant_id = (auth.jwt() ->> 'tenant_id')::uuid` (or join through `memberships` for multi-tenant users). Prefer **JWT custom claim** set at login/switch-org for simple, fast policies.
- Service role used only in scheduled jobs and webhooks; every service-role query still filters `tenant_id` explicitly (defense in depth).
- Per-tenant config in `tenant_settings` (timezone, brand voice, Stripe connected account if/when platform charges, Glofox credentials vaulted in Supabase Vault / env-per-tenant secrets store).

---

## 2. Data model

### Tenancy & identity

```
tenants
  id, name, slug, status, created_at
  authority jsonb  -- { people, bookings, payments, marketing, schedule: 'glofox'|'kelo' }

locations
  id, tenant_id, name, timezone, address, is_primary

profiles                  -- login identity (Supabase auth.users 1:1)
  id (= auth.uid), email, full_name

tenant_memberships        -- which people can operate which tenants
  id, tenant_id, profile_id, role  -- owner | admin | front_desk | trainer_readonly
  unique(tenant_id, profile_id)
```

### Person — explicit relationship typing (§4, load-bearing)

This is the most important modeling decision. **Do not store a free-text “status.” Store a typed relationship plus the evidence that derived it.**

```
people
  id, tenant_id
  email, phone, first_name, last_name
  relationship_type   -- enum: recurring_member | pack_holder | aggregator
                      --        | guest | lead | former_member
  relationship_reason jsonb  -- { rule, evidence_ids, computed_at }
  signup_at           -- best-effort original signup (see §8 rec below)
  first_transacted_at, first_booked_at, last_attended_at, last_transacted_at
  source              -- 'glofox' | 'kelo'
  glofox_id           -- nullable, unique per tenant
  tags text[]
  created_at, updated_at
  unique(tenant_id, email) where email is not null
  unique(tenant_id, glofox_id) where glofox_id is not null
```

**Derivation rules (deterministic, re-runnable, versioned):**

| Type | Rule (priority order) |
|---|---|
| `recurring_member` | Active Kelo subscription **or** Glofox `membership.type` ≠ `payg` **and** recent `subscription_payment` / live Stripe sub. **Only this cohort feeds Member count and MRR.** |
| `former_member` | Had recurring membership, now cancelled/expired, no active sub. |
| `pack_holder` | Has remaining or historical credit-pack purchase; not recurring. |
| `aggregator` | Bookings/transactions tagged ClassPass (or similar) only. |
| `guest` | ≥1 paid drop-in / single booking; no pack, no sub. |
| `lead` | Signed up, zero completed transactions and zero attended bookings. |

Recompute on import completion and on every native membership/pack/booking mutation. Store result + reason; never hand-edit the enum without an override flag.

### Programs, rooms, sessions (recovery-native, not gym-class bent)

```
resources                 -- sauna room, plunge, suite
  id, tenant_id, location_id, name, resource_type, capacity, active

programs                  -- templates: "Private Sauna 50min", "Contrast Circuit"
  id, tenant_id, name, duration_min, default_capacity
  booking_mode            -- class | room_slot | open_floor
  resource_requirements   -- which resource types needed

session_instances         -- concrete schedule rows
  id, tenant_id, program_id, location_id, trainer_id null
  starts_at, ends_at
  capacity, booked_count, waitlist_count
  resource_id null        -- for room_slot mode
  status                  -- scheduled | cancelled | completed
  source, glofox_id
```

### Bookings

```
bookings
  id, tenant_id, person_id, session_id
  status  -- pending | confirmed | checked_in | no_show | cancelled | waitlisted
  credit_ledger_entry_id null   -- if paid by credit
  payment_id null               -- if paid by card/POS
  source, glofox_id
  booked_at, cancelled_at, checked_in_at
  unique(tenant_id, person_id, session_id) where status not in cancelled
```

Capacity enforcement is a **DB function** with `SELECT … FOR UPDATE` on the session row (or an advisory lock on `session_id`), never app-only.

### Memberships, credits, money

```
membership_plans
  id, tenant_id, name, plan_kind  -- recurring | unlimited | credit_pack | drop_in | intro
  billing_interval, price_cents, currency
  credit_quantity null, credit_expiry_days null
  stripe_price_id null
  launch_tier  -- founding | opening | standard | null
  active

person_memberships
  id, tenant_id, person_id, plan_id
  status  -- trialing | active | past_due | paused | cancelled | expired
  stripe_subscription_id null
  current_period_start/end, pause_start/end, cancelled_at
  source, glofox_id

credit_packs              -- purchase instances
  id, tenant_id, person_id, plan_id, payment_id
  credits_total, credits_remaining
  purchased_at, expires_at, status  -- active | exhausted | expired | refunded
  source, glofox_id

credit_ledger             -- append-only audit trail
  id, tenant_id, person_id, credit_pack_id null
  entry_type  -- purchase | redeem | expire | adjust | refund | import
  delta       -- signed int
  booking_id null, payment_id null
  reason, created_at, created_by
  -- remaining balance is SUM(delta) or denormalized on pack with ledger as SoR

payments
  id, tenant_id, person_id
  amount_cents, currency, direction  -- charge | refund
  status  -- pending | succeeded | failed | refunded | partially_refunded
  purpose -- membership | credit_pack | drop_in | retail | gift_card | other
  stripe_payment_intent_id, stripe_charge_id, stripe_invoice_id
  idempotency_key unique
  source, glofox_id
  metadata jsonb  -- glofox_event, description, plan_code, etc.
  created_at

payment_events            -- webhook/audit log
  id, payment_id, event_type, payload, created_at
```

**Money-correctness invariant:** every Stripe-affecting mutation goes through a Postgres function that (1) inserts `payments` with a client-supplied `idempotency_key`, (2) only then calls Stripe (or records intent to), (3) updates status from webhook as source of confirmation. No “update balance then charge.”

### Intelligence, marketing, ops

```
segment_definitions       -- code-defined rules, versioned
  id, key, name, priority, rule_version, active

segment_assignments       -- derived, recomputed
  tenant_id, person_id, segment_key, score, assigned_at
  primary key (tenant_id, person_id, segment_key)

outreach_drafts
  id, tenant_id, segment_key, person_id
  channel  -- email | sms
  subject, body, rationale, brand_voice_version
  status  -- draft | approved | sent | failed | discarded
  approved_by, sent_at, provider_message_id

campaigns / campaign_recipients / automation_flows / enrollments
  -- only tables that a shipping feature writes; no speculative empty shells (§5 #8)

ai_briefings
  id, tenant_id, for_date, content jsonb, model, created_at
  unique(tenant_id, for_date)

activity_events           -- append-only feed
  id, tenant_id, person_id null, event_type, payload, occurred_at

waivers
  id, tenant_id, person_id, session_id null, signed_at, document_version, signature_ref

retail_products, gift_cards, gift_card_ledger
  -- ship when retail ships; schema only with the feature

trainers
  id, tenant_id, profile_id null, pay_config jsonb

-- Import / observability (non-negotiable)
import_watermarks
  tenant_id, entity  -- people | sessions | bookings | transactions | memberships | credits
  cursor jsonb       -- page, since, last_id as appropriate
  last_success_at, last_attempt_at, last_status, last_error
  last_record_count, consecutive_zero_count

import_runs
  id, tenant_id, started_at, finished_at, status
  entities jsonb     -- per-entity counts, errors, payload_hash samples
  triggered_by       -- schedule | manual

import_conflicts
  id, tenant_id, entity, external_id, field, incoming, existing, resolution, created_at

job_runs
  id, job_name, tenant_id null, started_at, finished_at, status, detail, lock_key

data_freshness_views     -- SQL view: per tenant/entity age + alarm flags
```

**Explicitly not modeled in v1 schema:** health/medical fields; speculative “future feature” tables; dual member flags that re-create Glofox’s lead-only blur.

### Relationship typing vs. Glofox

Glofox has no member flag. Mapping is **behavioral derivation after import**, not a field copy. Tests assert: given a pinned real payload set, relationship_type distribution matches hand-labeled gold samples for the studio.

---

## 3. API surface

### Principles

- Versioned: `/api/v1/...`
- Auth: Supabase JWT; tenant from claim; RLS as backstop.
- All mutations: **idempotency-key header** where money or booking is involved.
- Errors: structured `{ error: { code, message, details? } }`; never empty 200 on failure (learn from Glofox’s own trap; don’t repeat it).
- List endpoints: cursor pagination, explicit `as_of` freshness header on import-backed reads.

### Main contracts

**Auth / tenancy**
- `POST /auth/login` → Supabase; client sets session
- `GET /me` → profile + tenant memberships
- `POST /tenants/:id/switch` → refresh JWT claim
- `POST /tenants/:id/invites` → email invite (v1 admin-only, not full self-serve SaaS)

**People & CRM**
- `GET/POST /people`, `GET/PATCH /people/:id`
- `GET /people/:id/timeline` (bookings + payments + outreach + activity)
- `POST /people/recompute-relationships` (admin/job)

**Schedule & booking (native — activates when authority.bookings = kelo)**
- `GET /sessions?from&to&location_id`
- `POST /sessions` (create slot/class instance)
- `POST /bookings` `{ person_id, session_id, pay_with: 'card'|'credit'|... , idempotency_key }`
  - Server: capacity lock → credit/payment → booking row → confirmation
- `POST /bookings/:id/check-in|cancel|no-show`
- `POST /bookings/:id/waitlist-promote`

**Memberships & credits**
- `GET /plans`, `POST /plans`
- `POST /people/:id/memberships` (start sub via Stripe)
- `POST /memberships/:id/pause|resume|cancel`
- `POST /people/:id/credit-packs` (purchase)
- `GET /people/:id/credits` (balance + ledger)
- `POST /credits/adjust` (staff adjustment with reason; ledger entry)

**Payments**
- `POST /payments/charge` (POS/drop-in)
- `POST /payments/:id/refund`
- `POST /payments/:id/retry` (dunning)
- `GET /payments?status=failed` (focus queue)
- `POST /webhooks/stripe` (raw body verify; update payment_events → payments)

**Intelligence**
- `GET /briefing/today` (cached daily; 404/empty honest if not ready)
- `GET /segments`, `GET /segments/:key/people`
- `POST /segments/:key/drafts` (generate AI drafts for segment)
- `POST /outreach/:draft_id/approve-send` (owner approval required; never auto-send)
- `GET /analytics/*` (revenue, attendance, credit liability, room utilization, cohorts)

**Marketing**
- `POST /campaigns`, enroll, send
- lifecycle automation CRUD + enrollment state

**Import / health (operator-visible)**
- `GET /health/import` → per-entity watermark, age, last_status, consecutive_zeros
- `POST /import/run` (manual, locked)
- `GET /import/runs`, `GET /import/conflicts`

**Compliance / retail (table-stakes, ship with their phase)**
- waivers sign + verify; retail SKU + gift card redeem

### Client consumption

- SPA uses a thin typed client generated from Zod schemas (or openapi-from-zod).
- React Query (TanStack Query) with:
  - `staleTime` short for money/schedule
  - every list response includes `meta.freshness` → global banner component
- Optimistic UI **only** where rollback is safe (UI filters); **never** for payments/bookings — wait for server confirmation (<1s budget).

---

## 4. Import + migration strategy

### Design against §5 — non-negotiable import rules

1. **Pin real payloads first.** Before any mapper ships, a `fixtures/glofox/captured/` directory holds redacted real responses for people, memberships, transactions report (with namespace), sessions, bookings — each with capture date and endpoint+params. Mappers are unit-tested against these files only. Types are inferred from captures, not guessed. (§5 #1)

2. **Watermark advancement is gated.**
   ```
   on pull:
     if HTTP error OR body.success === false → fail run, DO NOT advance
     if entity is "always-active" (transactions, bookings) AND count==0
        AND window covers > N days of expected activity → ALARM, DO NOT advance
     if count==0 and window is legitimately empty (e.g. new tenant) → advance only with explicit allow_zero reason
     else → write rows in a transaction, then advance watermark
   ```
   `consecutive_zero_count` increments; threshold alerts. (§5 #2)

3. **No fixture fallback in live paths.** Demo data lives in a separate seed command, gated by `APP_ENV=demo`. Production loaders have zero import of demo modules. CI has a lint rule / dependency-cruiser forbid. (§5 #3)

4. **Freshness is a first-class UI + alert signal.** Global header: “Glofox data as of 14:02 (12m ago)” / amber at 2h / red at 4h + Sentry/email alert on failed `import_runs`. (§5 #4)

5. **Tests use seeded real-shaped data.** Integration tests spin Postgres, seed from captured payloads through the real mapper, assert KPI numbers and relationship_type gold labels. A green suite means the data path works. (§5 #5)

6. **One scheduler.** Only Netlify Scheduled Functions. Job entry: `pg_try_advisory_lock(hashtext(job_name))` + insert `job_runs`. If lock fails, exit 0 with `status=skipped_locked`. (§5 #7)

7. **Glofox quirks encoded as client policy, not tribal knowledge:**
   - Transactions report: **namespace required**; missing → treat as hard error even if 200.
   - `success: false` on 200 → failure.
   - Timestamps: string unix seconds.
   - Pagination: per-endpoint strategy table in code (`has_more` vs length).
   - Membership: object; plan name via catalog join on `user_membership_id` / `plan_code`.
   - Transaction type: derive from `metadata.glofox_event` + description.
   - Recurring member: `membership.type` + subscription_payment evidence.

### Import pipeline shape

```
schedule hourly
  → for each tenant where any authority == glofox
    → lock
    → for entity in [people, memberships_catalog, sessions, bookings, transactions, credits]
      → fetch pages since watermark (POST search/report as required)
      → validate against Zod capture-schema
      → upsert via external_id map (source='glofox')
      → derive relationship_type batch
      → write import_runs entity stats
      → advance watermark only per rules above
    → refresh segments, credit liability snapshot
    → emit freshness metrics
```

Idempotent upserts: natural key `(tenant_id, glofox_id)`. Conflicts (field-level divergence on native-touched rows) → `import_conflicts`, never silent overwrite of Kelo-authoritative fields.

### Data reset (§8 recommendation)

**Full wipe of corrupt production data and clean re-import.** Preserve only:
- Tenant settings / brand voice copy the owner wrote by hand
- Any natively created outreach drafts/campaigns worth keeping (export first)
- Captured Glofox fixtures and gold-label relationship samples

Nothing else in the corrupt DB is trustworthy (§5 fabricated data for ~10 weeks). Treat preservation attempts as risk.

### Strangler-fig sequence (matches owner order)

| Stage | Kelo owns | Glofox | Gate to next |
|---|---|---|---|
| **0. Foundation** | Schema, auth, multi-tenant, observability, empty UI shells only for shipping features | untouched | Import health green on captured fixtures in staging |
| **1. Import + intelligence** | Read model, briefing, segments, drafts (send via Resend/Twilio), analytics | SoR for all ops; read-only | Freshness SLO met 14 consecutive days; relationship_type gold accuracy ≥99% on labeled set; no silent zeros |
| **2a. Data ownership** | People edits, notes, tags write to Kelo; optional tested write-back of profile fields | still booking/pay SoR | Reconciliation report: sample of write-backs match |
| **2b. Marketing execution** | Campaigns, SMS/email lifecycle, segment send logging | — | Delivery ≥99.5% email; SMS deliverability monitored |
| **2c. Scheduling (templates/resources)** | Programs, resources, staff schedule tools | sessions still from Glofox until booking cutover | Owner builds next week’s template in Kelo without Glofox |
| **2d. Compliance + retail + staff** | Waivers, retail, gift cards, trainer pay config | — | Feature acceptance per area |
| **3. Booking + payments** | Native room/slot booking, Stripe billing, packs, dunning, memberships | freeze new Glofox-side plan changes; dual-run shadow | See cutover bar below |
| **4. Beta member surface** | Booking widget / light member app on studio domain | retire member traffic gradually | p95 booking <1s; no money defects |
| **5. Cutover** | All authority = kelo | retire | Cutover-readiness bar |

### Cutover-readiness bar (concrete)

Must all be true for 14 consecutive days in production-shadow mode (Kelo computes side-by-side; Glofox still charges until flip):

1. **Counts:** people, active recurring members, open bookings next 7d, credit balances — Kelo vs Glofox within **0.5% or ≤3 absolute**, whichever higher; diffs explained in `import_conflicts` or known timing lag.
2. **Money:** Stripe balance transactions attributed to Kelo test charges succeed end-to-end; refund + dunning retry paths verified on real small amounts; no orphan succeeded-Stripe / missing-Kelo rows (webhook reconcile job clean).
3. **Billing parity:** for the recurring cohort (~22–24), MRR and next invoice dates match Stripe Customer/Subscription objects (source of truth for money), not Glofox labels.
4. **Zero unresolved P0 data-correctness defects**; import success rate ≥99%; no watermark freezes.
5. **Owner sign-off** on a written checklist: morning briefing used ≥5/7 days; trust to stop opening Glofox for daily ops.
6. **Rollback plan:** authority flags can flip back domain-by-domain within 15 minutes; Glofox left read-accessible 30 days post-cutover.

---

## 5. Native booking + payment engine

### Recommendation on build vs. license (§8.1)

**Build natively on Stripe + Postgres.** Do not license a booking backend.

Reasons: (1) owned workflows for room/slot + credit liability are the product; (2) payments already on Stripe — adding another booking SaaS re-creates the rental problem; (3) recovery semantics (fixed-capacity rooms, pack economics) are poorly served by gym-class engines; (4) budget is not the constraint — correctness is. Scope the engine tightly (below); do not build a generic marketplace.

### Booking engine

**Modes:** `room_slot` (primary for sauna/plunge), `class` (group if needed), capacity always on `session_instances`.

**Book flow (atomic):**
```
BEGIN;
  SELECT capacity, booked_count FROM session_instances WHERE id=$1 FOR UPDATE;
  assert booked_count < capacity OR waitlist;
  -- payment or credit:
  if credit: insert credit_ledger delta -1; update pack.remaining;
  if card: insert payments pending + idempotency_key;  -- Stripe call outside or after intent row
  insert booking confirmed|pending;
  update booked_count;
COMMIT;
-- if card: confirm PaymentIntent; webhook → payments.succeeded; if fail, compensating cancel
```

Waitlist: auto-promote on cancel with optional hold timer; notify SMS/email.

Check-in / no-show: status transitions append `activity_events`; no-show can optionally burn credit (tenant setting).

### Payment engine

- **Stripe Customer** per person (per tenant); store `stripe_customer_id` on people.
- **Subscriptions** for recurring plans → `person_memberships.stripe_subscription_id`.
- **PaymentIntents** for packs, drop-ins, retail.
- **Customer Portal / self-serve card update** for dunning recovery.
- **Webhooks** as confirmation authority: `payment_intent.succeeded|failed`, `invoice.paid|payment_failed`, `customer.subscription.*`.
- **Idempotency:** every charge/refund/subscription change requires `Idempotency-Key`; stored unique on `payments`.
- **Dunning job (scheduled):** past_due memberships → retry schedule (e.g. day 0,1,3,5,7) → SMS/email with update-card link → pause/cancel per policy.
- **Refunds:** API creates Stripe refund + ledger compensation (restore credits if pack refund) in one orchestration with status log.

### Money-correctness checklist (tests must enforce)

| Property | Mechanism |
|---|---|
| Atomic | DB transaction + row lock for capacity/credits |
| Idempotent | `idempotency_key` unique; Stripe Idempotency-Key |
| Verifiable | `payment_events` full webhook log; operator can query status |
| Member-visible | confirmation email/SMS + in-UI receipt state |
| No silent drift | nightly reconcile: Stripe list vs `payments` rows for 48h window |

### Credit liability

Daily job snapshots sum of unexpired `credits_remaining` × attributable value → **deferred revenue liability** KPI. Segment `stale-credits` = remaining > 0 AND last_attended older than threshold. This is a recovery-niche differentiator; ship it in intelligence phase using imported credits, before native billing.

---

## 6. Build phases (order + rough effort)

Effort assumes **owner + AI agents**, correctness-first, calendar time not compressed. “Agent-weeks” ≈ focused wall-clock weeks of that working mode.

| Phase | Deliverable | Effort | Exit criteria |
|---|---|---|---|
| **P0 — Foundations** | Monorepo, Supabase multi-tenant schema (only tables needed through P2), RLS, Auth + tenant_memberships, Hono API skeleton, Sentry, job_runs + advisory locks, CI (typecheck, lint, integration test harness with real Postgres), env/secret layout, **captured Glofox fixtures + Zod schemas**, Glofox client with quirk policy | **2–3 weeks** | Deploy empty app; health endpoint; fixtures pinned; one locked scheduled no-op job |
| **P1 — Import v1** | People, memberships catalog, sessions, bookings, transactions (namespace-safe), credits; watermarks; import_runs; relationship_type derivation + gold tests; freshness API + UI banner; alert on failure; **full data reset + re-import** | **3–4 weeks** | 14 days clean imports; zero fabricated paths; Member count = ~22–24 verified; revenue matches Stripe/Glofox sample within tolerance |
| **P2 — Intelligence core** | KPI strip, daily briefing (Claude, cached), ~13 segments recomputed, outreach drafts (email+SMS), approve-and-send via Resend+Twilio, activity log, credit liability + room utilization reports | **3–4 weeks** | Morning flow A usable daily; ≥80% segments have drafts; owner opens briefing ≥5/7 |
| **P3 — Marketing + CRM depth** | Campaigns, lifecycle automations, lead pipeline views, notes/tags, staff roles enforcement | **2–3 weeks** | Segment→send→measure loop live; automations for welcome / lapsed pack |
| **P4 — Ops non-transactional** | Resources & program templates, waiver capture, retail + gift cards (basic), trainer pay config, schedule demand heatmap (read from imported sessions) | **3–4 weeks** | Owner runs non-money ops without Glofox |
| **P5 — Native payments + memberships** | Stripe customers/subs/intents, packs, ledger, dunning, refunds, self-serve card update, webhooks, reconcile job — **still no public booking** (staff-only POS / admin assign) | **4–5 weeks** | Money checklist green; small live charges; MRR from Kelo matches Stripe |
| **P6 — Native booking** | Room/slot booking engine, capacity locks, waitlist, check-in, staff booking UI; authority.bookings → kelo for internal use; shadow metrics vs Glofox | **3–4 weeks** | p95 book <1s; 14-day shadow parity |
| **P7 — Cutover prep + flip** | Dual-run, readiness dashboard, rollback runbook, freeze Glofox writes, flip authority, monitor | **2–3 weeks** | Bar in §4 met; Glofox retired for ops |
| **P8 — Beta member surface** | On-domain booking widget / light member portal (auth, book, packs, card update, waivers) | **3–4 weeks** | Members book without Glofox; polish bar competitive |

**Rough total to Glofox-retired ops:** ~22–30 agent-weeks. Member beta after. Parallelism is limited by verification gates — do not parallelize P5/P6 ahead of P1 trust.

---

## 7. Key risks and mitigations

| Risk | Why it kills | Mitigation |
|---|---|---|
| Wrong Glofox field mapping | §5 meta-lesson; prior death | Fixtures first; gold tests; no mapper without capture |
| Watermark freeze on empty 200 | 10-week revenue blackout | Gated advance; consecutive_zero alarm; namespace required as hard error |
| Fabricated/demo data in prod | Silent false trust | Structural unreachable; CI forbid; honest empty states |
| Invisible staleness | Operators act on lies | Banner everywhere; alerts; criterion 7 |
| Double cron | Double charges / double import | One Netlify scheduler + DB advisory lock |
| Speculative schema/screens | Empty “features,” agent confusion | Table ships with writer; docs generated from schema/tests |
| Money race / double book | Angry members, reviews | `FOR UPDATE` capacity; idempotency keys; webhook SoR |
| Stripe webhook gaps | Paid but unbooked | Outbox/reconcile job; payment_events; alert on orphan intents |
| Relationship_type wrong | Member KPI and growth engine lie | Versioned rules; gold labeled set; only recurring_member → MRR |
| `created` is migration date | Cohorts wrong | §8 rec: validate sample; prefer `least(created, first_transacted_at, first_booked_at)` as `signup_at` with provenance field |
| AI PII leakage / brand damage | Trust, compliance | Server-side only; minimize fields; optional de-identify outreach (§8); never auto-send |
| Agent-driven architecture drift | Docs ≠ code again | OpenAPI/Zod as SoR; ADR folder small; “project knowledge” = schema + tests + this plan in-repo; fail CI on type drift |
| Scope explosion (v1 is broad) | Half-built money paths | Phase gates; booking/payments last; non-goals enforced |
| Glofox API changes mid-transition | Import breaks | Contract tests against live read weekly; schema version on captures |
| Multi-tenant data leak | Existential | RLS forced; integration test attempts cross-tenant read must fail; service-role query linter |

---

## 8. What I would explicitly NOT build in v1 (and why)

1. **Member-facing full app as a launch headline** — per §4/§7; operational trust first. Widget beta only after P7.
2. **Self-serve multi-tenant commercial onboarding / SaaS billing for studio customers** — data model supports tenancy; selling motion is manual/onboarded. Avoids billing-the-biller complexity before one studio is perfect.
3. **Glofox write-back for booking/payments** — high risk, low value if native engine is the destination. Write-back only for low-risk profile fields if needed; prefer flip authority to Kelo.
4. **Second job runner (Inngest/Temporal/etc.)** — violates §5 #7 and operational surface constraint. Netlify schedules + DB locks + Stripe webhooks suffice for v1 volumes.
5. **Real-time websocket roster** — hourly + manual refresh + staleness banner meets §7; live roster only if front-desk check-in on Kelo requires it (then SSE on booking table is enough).
6. **Commodity churn bots / missed-call text-back as a product pillar** — table-stakes automation maybe later; not the moat (§2).
7. **Health/medical data, wearable integrations** — explicit non-goal; liability and scope.
8. **GraphQL layer** — REST + Zod is enough; fewer agent failure modes.
9. **Mobile native apps** — responsive web + later PWA if needed.
10. **Speculative AI features** (autonomous send, auto-reprice, chatbot staff replacement) — owner approves every send; briefing + drafts only.
11. **Licensed booking backend / white-label Mindbody-style core** — conflicts with owned-platform thesis.
12. **Preserving corrupt prod data via clever merge** — full re-import only.
13. **Multiple SMS/email providers or abstract “comms bus”** — Resend + Twilio, direct.
14. **Payroll tax filing / full HR** — trainer pay *config and reports* yes; not a payroll product.

---

## Recommendations on open questions (§8)

1. **Native engine:** **Build** on Stripe + Postgres (see §5 of this plan).  
2. **`created` validation:** Probe 30+ people with known real-world signup dates. Set `signup_at = coalesce(original_if_found, least(created_ts, first_transacted_at, first_booked_at))` and store `signup_at_source`. Cohort reports use `first_transacted_at` as primary growth anchor when provenance is weak.  
3. **SMS:** **Twilio**. Email: **Resend** (confirm production DNS/SPF/DKIM).  
4. **Auth:** Stay on **Supabase email+password + magic link** for v1; `tenant_memberships` + invites. Add Google SSO when second tenant onboards. No full SSO IdP matrix in v1.  
5. **AI + PII:** Keep Anthropic. Policy: **minimize** — briefing uses aggregates + first name + behavioral stats, not full history dumps; outreach drafting may use first name + segment reason; **optionally strip email/phone from model payloads** (providers get content, send happens in our API). Log model inputs retention-limited. No PHI. Document in privacy policy.  
6. **Data reset:** **Full re-import**; preserve hand-written settings and fixtures only.  
7. **Freshness:** **Hourly** default; on-demand “Refresh now” for owner; front-desk check-in phase can add 5–15 min poll for today’s roster only. No sub-minute distributed realtime requirement in transition.

---

## Agent-maintainability rules (standing, not a phase)

- Zod schemas and SQL migrations are the contract; markdown that contradicts them is wrong.
- Every money/booking path has an integration test with real-shaped seed data.
- No demo fixtures on the `import` or `live` module path.
- One watermark policy module; one Glofox client; one scheduler entrypoint.
- Prefer deleting half-built screens over shipping empty ones (§5 #8).

This plan optimizes for the failure modes that already burned real money: **verify against live shapes, make import honesty visible, take money last, and keep the system small enough that an owner-plus-agents team can still see when something is false.**

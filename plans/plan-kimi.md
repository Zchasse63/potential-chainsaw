# Kelo Build Plan

## 1. Architecture overview

### Stack (fixed + chosen)

| Layer | Choice | Rationale |
|---|---|---|
| **App framework** | **Next.js 15 App Router**, TypeScript, on Netlify | Largest agent-training corpus, Server Actions give typed mutations without a separate API layer, and Netlify's Next.js adapter is first-class. We will deliberately avoid App Router complexity we don't need: Node runtime for mutations, no edge-runtime acrobatics, no ISR for live data. |
| **Database / auth** | **Supabase Postgres + Auth + RLS** | Fixed. One shared Postgres cluster, one schema per tenant is *not* used; instead **row-level security on a single schema** with `tenant_id` on every table. |
| **Background jobs** | **Netlify scheduled functions only** | The prior build died on two schedulers double-running the same job. We use exactly one scheduler. Cron jobs call Netlify scheduled functions; each function acquires a Postgres advisory lock / job-lock row before doing work. |
| **Payments** | **Stripe** (direct) | Already the processor under Glofox. Use Stripe Billing for recurring subscriptions, Payment Intents for packs/retail/refunds, and Stripe webhooks for status updates. |
| **Email** | **Resend** | Already scaffolded; excellent deliverability and API. |
| **SMS** | **Twilio** | See recommendation in §8 answers. |
| **AI** | **Anthropic Claude** via server-side calls | Outputs cached in Postgres; no PII sent when a de-identified prompt suffices. |
| **Observability** | **Sentry** + custom `health.alerts` table + Supabase logs | No observability exists today; this is non-optional. |

### Service boundaries

Kelo ships as **one monolithic Next.js app** on Netlify talking to one Supabase database. Boundaries are module-level, not network-level, to keep operational surface tiny:

- **`import-engine/`** — Glofox read, staging tables, mapping, reconciliation, watermarking.
- **`native-ops/`** — people, scheduling, bookings, payments, credits, waivers, retail, staff.
- **`intelligence/`** — segments, briefing, outreach drafts, schedule recommendations.
- **`marketing/`** — campaigns, lifecycle automations, sends, logs.
- **`member-surface/`** — future beta member app/widget; stubbed but not wired until Phase 4.

### Glofox vs. Kelo-native data coexistence

Glofox is a **staging source**, never the schema master. For every entity we maintain:

1. **`glofox_raw_<entity>`** tables that hold captured API payloads exactly as returned.
2. **`glofox_<entity>_map`** tables that record how raw IDs map to Kelo IDs, with the captured payload hash.
3. **Kelo-native tables** (`people`, `sessions`, `bookings`, `transactions`, …) that are the system of record.

During transition, Kelo-native tables are **fed by the import engine** and then **incrementally by native operations** as each domain is cut over. After cutover, the Glofox import is retired for that entity. The schema is designed for Kelo's workflows, not Glofox's; mapping is explicit and versioned.

---

## 2. Data model

### Multi-tenancy ground floor

Every table has `tenant_id uuid NOT NULL`. RLS policies enforce:

```sql
CREATE POLICY tenant_isolation ON people
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
```

All application code sets `app.current_tenant` from the authenticated user's membership. No super-user queries bypass RLS in app code. `tenant_id` is part of every foreign key and every unique index (e.g., `(tenant_id, email)` for people).

### Core entities (simplified)

- **`tenants`** — studio org, timezone, Stripe account ID, Glofox namespace, feature flags.
- **`locations`** — physical sites; every session/booking is location-scoped.
- **`people`** — deduplicated by `(tenant_id, email)`. Columns: `glofox_id`, `first_name`, `last_name`, `phone`, `signup_at`, `first_transaction_at`, `first_booking_at`, `derived_relationship`, `liability_cents` (deferred credit liability), `lifetime_value_cents`.
- **`person_relationship_log`** — immutable history: `person_id`, `from_type`, `to_type`, `reason`, `changed_at`. Relationship types are **first-class and explicit**: `recurring_member`, `pack_holder`, `aggregator`, `guest`, `lead`.
- **`profiles` / `auth.users`** — Supabase Auth users. Staff and owners have `profile` rows linked to `people` or staff records.
- **`staff`** — pay rules, roles, permissions, linked to a profile.
- **`membership_plans`** — `plan_type ∈ {recurring, unlimited, pack, dropin, intro, corporate}`; Stripe price IDs; credit amount; freeze/pause rules.
- **`memberships`** — recurring subscriptions: `person_id`, `plan_id`, `status`, `stripe_subscription_id`, `started_at`, `next_billing_at`, `cancelled_at`.
- **`credit_packs`** — pack purchase header: `person_id`, `plan_id`, `total_credits`, `remaining_credits`, `expires_at`, `status`.
- **`credit_ledger`** — every credit change: `credit_pack_id`, `booking_id`, `change_credits`, `running_balance`, `reason`, `created_at`. This is the money-correctness surface for deferred-revenue liability.
- **`programs`** — template: name, duration, capacity, resource type (sauna room / plunge / contrast room), default trainer.
- **`sessions`** — scheduled instance: `program_id`, `location_id`, `start_time`, `end_time`, `capacity`, `booked_count`, `status`, `trainer_id`.
- **`bookings`** — `person_id`, `session_id` (or `room_slot_id`), `status ∈ {pending, confirmed, cancelled, checked_in, no_show, waitlisted}`, `credits_used`, `amount_cents`, `idempotency_key`, `source`.
- **`transactions`** — single source of truth for money movement: `person_id`, `stripe_payment_intent_id`, `amount_cents`, `currency`, `type`, `status`, `metadata`, `glofox_transaction_id` (transitional), `settled_at`.
- **`waivers`** — `person_id`, `session_id`, `signed_at`, `template_version`, `signature_blob_url`.
- **`retail_products`, `retail_sales`, `gift_cards`** — standard inventory/gift-card ledgers.
- **`segments`** — derived assignments: `person_id`, `segment_key`, `priority_score`, `assigned_at`, `rationale`, `outreach_draft_email`, `outreach_draft_sms`, `outreach_status`.
- **`ai_briefings`** — `tenant_id`, `date`, `content_json`, `model`, `generated_at`, `input_hash`.
- **`import_runs`** — per-entity sync runs with full audit: `entity`, `started_at`, `finished_at`, `status`, `records_fetched`, `records_inserted`, `records_updated`, `watermark_from`, `watermark_to`, `empty_alert_threshold`, `error_message`.
- **`import_watermarks`** — `tenant_id`, `entity`, `last_successful_watermark`, `last_run_at`, `expected_min_records`.
- **`reconciliation_checks`** — daily source-vs-Kelo comparison: `entity`, `source_count`, `kelo_count`, `diff_ids`, `status`.
- **`scheduled_job_locks`** — `job_name`, `locked_at`, `locked_by`, `expires_at`. Prevents double-runs even if Netlify schedules overlap.
- **`health_alerts`** — `tenant_id`, `alert_type`, `severity`, `message`, `acknowledged_at`, `notified_at`.

### Person-relationship derivation rules

Relationship is **derived from behavior**, not a field, and materialized into `person_relationship_log` nightly:

| Type | Rule |
|---|---|
| `recurring_member` | Has an active `membership` in `{recurring, unlimited}` with `status = active` and `next_billing_at` in the future. **Only this cohort counts toward "member count" and MRR.** |
| `pack_holder` | Has `remaining_credits > 0` on at least one active credit pack, no active recurring membership. |
| `aggregator` | Has a booking with `source = 'classpass'` or similar in the last 90 days, no active recurring membership. |
| `guest` | Has at least one paid booking or transaction in the last 12 months, no active recurring membership, no active pack. |
| `lead` | Signed up but no transaction and no booking. |

A person can have **multiple historical** relationship records but exactly one **current** relationship. The daily briefing and KPI strip use the current relationship only.

---

## 3. API surface

### Primary contracts

1. **Supabase client + RLS for reads** — The Next.js app uses the Supabase JS client with RLS for almost all reads. This eliminates a bespoke read API and guarantees tenant isolation at the DB level.

2. **Next.js Server Actions for writes** — Every mutation is a typed Server Action with Zod validation, e.g.:
   - `createBooking(input: BookingInput)`
   - `cancelBooking(input: CancelBookingInput)`
   - `purchaseCreditPack(input: CreditPackInput)`
   - `refundTransaction(input: RefundInput)`
   - `approveAndSendOutreach(input: OutreachSendInput)`

3. **Supabase RPC for atomic operations** — Complex, money-critical operations (book a slot + debit credits + create transaction) are implemented as **database functions** invoked via `supabase.rpc(...)`. This keeps atomicity inside Postgres and makes race conditions impossible at the application layer.

4. **Stripe webhooks** — Netlify Function at `/api/webhooks/stripe` dispatches to handlers that update `transactions`, `memberships`, and `credit_packs`.

5. **AI endpoints** — Server Actions (never client-side):
   - `generateBriefing(tenantId, date)`
   - `draftOutreach(segmentKey, personIds)`
   - `recommendScheduleChanges(locationId, windowDays)`

6. **Import / health endpoints** — Internal scheduled-function routes, not user-facing:
   - `/api/jobs/import-glofox?entity=people`
   - `/api/jobs/reconcile`
   - `/api/jobs/generate-segments`

### Client consumption

- **React Query + Supabase realtime subscriptions** for UI state.
- **Server Components** fetch initial data via Supabase SSR; mutations invalidate caches.
- All UI data displays **freshness indicator** (`data_updated_at`) and stale-state warnings.

---

## 4. Import + migration strategy

This is the highest-leverage correctness work in the rebuild.

### Import pipeline design

```
Glofox API
    ↓
Netlify scheduled function (ONE scheduler)
    ↓
Acquire job lock (skip if locked)
    ↓
Fetch page, verify HTTP 200 + success:true + namespace present
    ↓
Store raw payload in glofox_raw_<entity> with payload_hash
    ↓
Map → Kelo native tables (idempotent: INSERT ... ON CONFLICT UPDATE)
    ↓
Run reconciliation for this entity
    ↓
Advance watermark ONLY if records fetched > 0 OR entity can legitimately be empty today
    ↓
Release lock, record import_run
```

### Watermark rules (directly against §5 failure modes)

- **Never advance on `records_fetched = 0` for a historically active entity.** If the transactions endpoint returns 0 rows, treat it as a failure and alert, because the studio has had ~775 transactions in 13 months.
- **Track `expected_min_records`** per entity from a rolling 7-day minimum. If fetched < expected, fail the run.
- **Capture and pin real payloads before mapping.** The first week of engineering includes a `glofox_probe` script that dumps live response samples into `glofox_raw_samples` and generates Zod schemas from them. Tests assert against these samples, not fixtures.
- **No fixture fallback in production.** Demo data lives in a separate tenant seeded only in preview/CI; production queries can never fall back to synthetic rows.

### Reconciliation (correct and observable)

Every import run performs a lightweight reconciliation; a full reconciliation runs daily:

| Check | Action if failed |
|---|---|
| Count parity: Glofox count vs. Kelo count per entity | Alert + freeze briefing/KPIs + show "data stale" banner |
| Sampled ID parity: random 20 IDs from source exist in Kelo | Same |
| Recency parity: most recent 50 transactions/bookings match timestamps | Same |
| `import_runs` has no failed runs in last 4h | Banner + alert |
| `import_watermarks` age > 2h for active entity | Banner + alert |

The home screen always shows a **data freshness pill**: "Last sync 34 min ago · healthy" or "Sync failed 2h ago · numbers may be stale."

### Strangler-fig cutover order

Per the confirmed order in §4:

1. **Phase 1: Import + intelligence only** — Kelo reads Glofox; owner views briefing and segments. No writes to Glofox.
2. **Phase 2: Non-transactional ownership** — people profiles, marketing lists/campaigns, schedule templates, staff, waivers, retail catalog. Write-back to Glofox is **tested and reconciliation-gated** before enabled.
3. **Phase 3: Native booking + payments** — Kelo owns bookings, credit packs, subscriptions, refunds, dunning. Glofox is read-only backup.
4. **Phase 4: Beta member-facing surface** — booking widget/app.
5. **Phase 5: Cutover** — retire Glofox.

### Cutover-readiness bar

Kelo becomes system of record only when **all** of the following are true for 14 consecutive days:

- Count reconciliation within 0.5% for people, bookings, transactions, active memberships, active credit packs.
- Billing parity: Kelo Stripe ledger matches Glofox-reported revenue within 1% weekly.
- All native booking/payment mutations pass idempotency and refund tests in production shadow mode.
- Zero unresolved P1/P2 data-correctness defects.
- Owner has manually approved and sent outreach from Kelo for at least one week.
- Import health dashboard shows green with no skipped/failed runs.
- A written rollback plan to Glofox is tested (read-only sync remains possible for 30 days).

---

## 5. Native booking + payment engine

### Recommendation: build natively

I recommend **building the booking/payment engine natively** rather than licensing a backend. Recovery economics (room-and-slot, credit packs, deferred liability, contrast add-ons) are different enough from generic class booking that an off-the-shelf backend would force Glofox-shaped workflows back into the product, violating the core thesis.

### Booking engine

- **Resource model:** `resources` (sauna room A, plunge 1, plunge 2) are booked in `slots` or directly via `sessions`. A session has `resource_id`, `start_time`, `end_time`, `capacity`.
- **Race prevention:** bookings are created via a Postgres function:
  ```sql
  create_booking(
    p_tenant_id, p_session_id, p_person_id,
    p_idempotency_key, p_payment_method_id
  )
  ```
  The function locks the session row (`SELECT FOR UPDATE`), verifies `booked_count < capacity`, inserts the booking with a unique `(tenant_id, session_id, person_id, status)` guard for the same person, debits credits or creates a Payment Intent, and updates `sessions.booked_count`.
- **Idempotency:** every mutation carries an `idempotency_key` (client-generated UUID). The DB function returns the existing row if the key is already present.
- **Waitlist:** `waitlist_entries` table; when a cancellation occurs, a function promotes the earliest entry and notifies the person.
- **Capacity types:** per-session capacity (group) and per-slot capacity (private room) both supported via `session_type`.

### Payments and billing

- **Recurring memberships:** Stripe Billing `Subscription` with `stripe_subscription_id` stored in `memberships`. Stripe webhooks update status, `next_billing_at`, and `transactions`.
- **Credit packs / drop-ins / retail:** Stripe Payment Intents created at checkout. On success, insert `transaction` and (for packs) credit-ledger rows in the same DB function.
- **Refunds:** refund via Stripe API inside a Server Action; on webhook confirmation, insert offsetting `transaction` and (if applicable) restore credits via `credit_ledger`.
- **Dunning:** `dunning_attempts` table; scheduled job retries failed invoices with exponential backoff, emails the member, and surfaces failures in the daily briefing.
- **Card updates:** self-serve portal link via Stripe Customer Portal.

### Money-correctness invariants

- Every money movement is recorded in `transactions` before Stripe webhook confirms it; status transitions are `pending → succeeded | failed | refunded`.
- Credit balance is always the sum of `credit_ledger.change_credits` for active packs; no cached "remaining" is trusted without a nightly checksum.
- Refunds never exceed original transaction amount (enforced in DB function).
- All billing mutations are atomic inside Postgres; partial failures are impossible.

---

## 6. Build phases in order, with rough effort

All effort is calendar weeks for an owner-plus-agents team. "Optimize for verification over speed" means phases do not start until the previous phase's exit criteria are met.

### Phase 0 — Foundation and payload verification (3–4 weeks)

- Set up Next.js + Supabase + Netlify + Sentry.
- Implement multi-tenant schema, RLS, auth, org invites, role model.
- **Probe Glofox live API**, capture real payloads for people, transactions, sessions, bookings, memberships, credits. Generate Zod schemas and tests from captured samples.
- Build `glofox_raw_*` staging tables and import-watermark framework.
- Build observability: `import_runs`, `reconciliation_checks`, `health_alerts`, Sentry.
- **Exit:** import of all Glofox entities runs hourly without fixture fallback; reconciliation page shows green.

### Phase 1 — Intelligence layer on imported data (3–4 weeks)

- Map Glofox data to Kelo-native `people`, `sessions`, `bookings`, `transactions`, `memberships`, `credit_packs`.
- Implement relationship derivation and `segments`.
- Build daily briefing generation (Anthropic Claude, cached in `ai_briefings`).
- Build home screen: KPI strip + focus queue + freshness indicator.
- Build segments screen with rationale and drafts.
- **Exit:** owner opens Kelo each morning and trusts the briefing; segments and drafts are reviewed weekly.

### Phase 2 — Own non-transactional operations (4–5 weeks)

- People/CRM management natively.
- Marketing execution: campaigns, lists, email via Resend, SMS via Twilio.
- Schedule templates and staff scheduling.
- Digital waivers.
- Retail catalog and gift cards (non-payment side).
- Tested write-back to Glofox where required, gated by reconciliation.
- **Exit:** owner manages schedules, waivers, retail, and marketing from Kelo; Glofox stays in sync.

### Phase 3 — Native booking + payments (5–6 weeks)

- Native booking engine and room/slot model.
- Stripe subscriptions, credit packs, drop-ins, refunds, dunning.
- Self-serve card update.
- Shadow-run native booking alongside Glofox until parity proven.
- Full money-correctness test suite.
- **Exit:** all new bookings and payments flow through Kelo; Glofox is read-only backup.

### Phase 4 — Beta member-facing surface (3–4 weeks)

- On-brand, on-domain booking widget.
- Member profile, pack balance, upcoming bookings.
- Waitlist and cancellation self-serve.
- **Exit:** beta members book through Kelo without vendor redirects.

### Phase 5 — Cutover and Glofox retirement (2–3 weeks)

- Meet cutover-readiness bar for 14 days.
- Run parallel final reconciliation.
- Retire Glofox import and redirect member traffic.
- Post-cutover monitoring.
- **Exit:** Glofox cancelled; Kelo is system of record.

**Total: ~20–26 weeks to full cutover.** v1 "shippable" intelligence + marketing surface is live after Phase 1 (~6–8 weeks), with continuous value releases thereafter.

---

## 7. Key risks and mitigations

| Risk | Mitigation |
|---|---|
| **Glofox payload keeps changing or undocumented behavior** | Capture-and-pin real samples; make import mapping table-driven (`glofox_field_map`) so API renames are a config change, not a code change. |
| **Import silently freezes again** | Never advance watermark on zero/failure; expected-volume checks; freshness banner + alerts; reconciliation dashboard. |
| **Double scheduler / double runs** | Exactly one scheduler (Netlify scheduled functions) + `scheduled_job_locks` with TTL. |
| **Money mutation is wrong (double charge, lost refund)** | All money operations atomic in Postgres RPC; idempotency keys; Stripe webhooks as confirmation; nightly ledger checksums; shadow mode before cutover. |
| **AI outputs are garbage because import is wrong** | Gate AI features on import health; if reconciliation fails, briefing shows "insights paused — data sync issue" instead of hallucinating. |
| **Agent-generated code drifts into spaghetti** | Strong types (Zod), one source of truth (this plan + schema), tests that assert against live-shaped data, no speculative tables/screens. |
| **PII sent to Anthropic** | De-identify prompts where possible; no health data ever; cache outputs; log AI provider calls; disclose to members in privacy policy; allow opt-out of AI-drafted outreach. |
| **Multi-tenant isolation bug leaks studio data** | RLS on every table; all app queries set `app.current_tenant`; integration tests assert cross-tenant access is blocked. |
| **Scope explosion in v1** | Ruthless "not v1" list (§8); every new screen/table must justify itself against the daily briefing loop or money correctness. |

---

## 8. What you would explicitly NOT build in v1, and why

- **A full native mobile app.** Recovery members book infrequently enough that a responsive PWA/widget is sufficient; native apps add app-store tax and release friction for no proven lift.
- **Full self-serve multi-tenant SaaS signup + billing.** Multi-tenancy is in the data model and auth from day one, but the commercial onboarding surface is manual for the first additional studios. Building automated signup/billing before knowing the second studio's needs is speculative.
- **Real-time (<1 minute) import during transition.** Hourly sync with visible freshness is correct and cheap. Sub-minute sync is only justified after cutover for live roster display.
- **Health/medical data storage.** Product decision already made; no HITRUSH/IPAA scope.
- **Complex payroll/commission automation.** Staff pay rules are modeled and reported, but auto-payroll integrations (e.g. Gusto sync) are deferred. The owner can export a payroll report.
- **Marketplace/aggregator integrations beyond manual tagging.** ClassPass etc. can be tagged as `aggregator` relationship type, but deep API integrations are deferred until recurring-member conversion data proves ROI.
- **Advanced inventory management (purchase orders, vendor management).** Retail sales and simple stock counts are in; full supply-chain inventory is not.
- **Custom email builder with drag-and-drop.** Text + brand template is enough to close the outreach loop; fancy builders are a distraction.
- **A/B testing framework for AI outreach.** Measure open/click/send rates, but full experiment infrastructure is deferred.
- **Open-ended "AI chatbot" that can mutate data.** The AI drafts and recommends; humans approve every send, refund, and booking mutation. Autonomous agentic actions are a v2+ debate.

---

## Explicit disagreements and recommendations on open questions

I disagree with one implicit assumption in the brief: **that the AI intelligence layer can be meaningfully built before the import pipeline is proven.** The prior build's fabricated data rendered any "intelligence" worthless. Therefore, I recommend **gating all AI-generated insights on import health** — if reconciliation fails, the briefing refuses to generate and tells the owner why. The first 3–4 weeks should be payload verification and import trustworthiness before the first Claude call touches member data.

### Recommendations on §8 open questions

1. **Native booking/payment engine:** **Build natively.** Licensing a generic backend would re-introduce Glofox-shaped constraints and undermine the "owned, recovery-native" thesis.
2. **`created`-as-signup-date:** Treat Glofox `created` as a candidate only. Validate by comparing to the earliest `first_transaction_at` and `first_booking_at`. If `created` is later than both, use the earlier of first transaction or first booking as `signup_at`, and store `glofox_created_at` separately with an `signup_date_confidence` flag.
3. **SMS provider:** **Twilio** for reliability and deliverability reporting; Resend confirmed for email. Evaluate MessageBird only if Twilio pricing becomes an issue after scale.
4. **Auth for multi-tenant:** Keep **email + password** for owner and staff in v1. Add **invite-link onboarding** (magic link) for new staff. Defer SSO/passwordless until the second or third studio requires it; the data model supports it later.
5. **AI provider + PII:** Keep **Anthropic**. Policy: no health data; de-identify prompts where possible (replace names/IDs with tokens, map back on output); cache all outputs; maintain an `ai_provider_calls` log; disclose AI use in privacy policy; allow member opt-out of AI-drafted outreach.
6. **Data reset:** **Full reset.** The prior production data is corrupt due to fixture fallback and wrong mappings. Preserve only verified captured Glofox raw samples and the lessons in §5. Re-import from Glofox after mapping fixes.
7. **Freshness expectation:** **Hourly sync with visible staleness** during transition. After cutover, move live roster/check-in to **near-real-time** (webhook or 5-minute poll) because member-facing check-in needs current state.

---

## Summary

Kelo succeeds if the owner trusts the morning briefing enough to act on it, trusts the booking/payment engine enough to run the studio on it, and trusts the import enough to retire Glofox. The plan prioritizes **verification, observability, and money-correctness** over breadth, using a single scheduler, a single monolithic Next.js app on Netlify, Supabase RLS multi-tenancy, and Stripe-native billing. The AI layer is the wedge, but it is built on top of a data pipeline that can prove it is right.

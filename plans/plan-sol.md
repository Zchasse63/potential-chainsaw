## 1. Architecture overview

### Core architecture

Build Kelo as a **TypeScript modular monolith**, not microservices:

- **Web framework:** Next.js with the App Router, deployed on Netlify.
- **Database/Auth:** Supabase Postgres, Supabase Auth, Storage, and generated TypeScript database types.
- **API:** Versioned REST/JSON contracts described by OpenAPI. Browser and future mobile clients use a generated TypeScript client rather than querying application tables directly.
- **Validation:** Zod at every external boundary: Glofox, Stripe, Anthropic, email/SMS webhooks, and public API requests.
- **Background work:** One Netlify Scheduled Function is the **only scheduler**. It enqueues due jobs into a Postgres job table. Netlify Background Functions claim jobs using leases and `FOR UPDATE SKIP LOCKED`.
- **Payments:** Stripe Billing, Payment Element, SetupIntents, and Stripe Terminal. Kelo owns the business state and UI; Stripe supplies payment rails and card vaulting.
- **Email/SMS:** Resend for email and Twilio for SMS. Twilio is the opinionated choice because delivery receipts, STOP handling, number management, and A2P registration matter more than marginally lower cost.
- **AI:** Anthropic Claude behind server-side, structured-output adapters. Claude narrates deterministic metrics; it does not calculate revenue, member count, liability, or utilization.
- **Observability:** Sentry for errors/performance, Better Stack for uptime/heartbeat alerting, and first-class operational tables for imports, jobs, webhooks, message delivery, and reconciliation.

A single repository should contain application code, SQL migrations, OpenAPI, generated types, importer contracts, architecture decision records, runbooks, and tests. This is the **code-verified source of truth** required by §5. Use a simple `pnpm` workspace without a complex monorepo framework.

### Domain boundaries

Keep these as modules within one deployment and one database:

1. Identity, organizations, locations, and permissions
2. CRM and person relationships
3. Catalog, resources, scheduling, and booking
4. Commerce, subscriptions, credits, gift cards, and financial ledger
5. Marketing, consent, campaigns, and communications
6. Waivers, retail inventory, staff, commissions, and pay runs
7. Reporting, segments, briefing, and AI
8. Imports, external integrations, jobs, and reconciliation

Modules may share transactional database procedures, but external clients consume stable API contracts rather than arbitrary tables. This keeps operations small enough for an owner working with coding agents while preserving boundaries that could be split later if scale justifies it.

### Multi-tenancy and security

- Every tenant-owned row contains a non-null `tenant_id`; location-specific rows also contain `location_id`.
- RLS verifies current membership through `tenant_users`, not merely a user-supplied tenant ID or long-lived JWT claim.
- Browser requests carry a Supabase access token and execute under the user’s RLS context.
- Service-role access is restricted to integration and job code, which must explicitly supply a tenant and write an audit event.
- CI includes adversarial cross-tenant tests for every exposed table and API family.
- Tenant files use tenant-prefixed Storage paths and Storage RLS.
- Integration credentials belong in Supabase Vault or an equivalently encrypted server-only store, not browser configuration or ordinary tenant settings.
- Require MFA for owners/admins. Support password login and magic links initially; add passkeys and enterprise SSO later. Staff and member invitations should be passwordless by default.

### Transitional and native data coexistence

Use three layers:

1. **Raw source layer:** Immutable, access-restricted Glofox response pages with request metadata, hashes, mapping version, and import-run ID.
2. **Canonical Kelo layer:** Recovery-native entities used by the application.
3. **Provenance layer:** External references linking canonical entities to Glofox, Stripe, aggregators, and communication providers.

Each capability has an explicit authority state:

- `GLOFOX_AUTHORITATIVE`
- `KELO_AUTHORITATIVE_WITH_WRITEBACK`
- `KELO_ONLY`
- `RETIRED`

Imported fields owned by Glofox can be refreshed without overwriting Kelo-owned annotations, consent records, relationship overrides, or marketing activity. There must be no generic “last write wins” synchronization and no indefinite dual-master period.

### Background execution

The sole Netlify cron tick should run every five minutes and:

- enqueue due import, automation, dunning, reconciliation, expiration, briefing, and maintenance jobs;
- use unique job keys such as `tenant/entity/window` to prevent duplicates;
- let workers claim jobs with leases, heartbeats, bounded retries, and dead-letter status;
- record input, attempt count, duration, output counts, error, and correlation ID.

Hourly import remains the default. A five-minute booking/roster import may be enabled during operating hours only where the live-roster workflow justifies it. The UI must still display the actual `as_of` time.

### AI and PII policy

Keep Anthropic, but do not send names, email addresses, phone numbers, waiver content, or raw customer records by default.

- Segment-level outreach is drafted from aggregate attributes and brand guidance; names and links are interpolated locally.
- Person-level prioritization uses pseudonymous identifiers and structured behavioral features.
- Q&A operates on approved aggregates and query results, not unrestricted database access.
- Require an enterprise provider agreement with no training on submitted data and the shortest practical retention.
- Store prompt version, input snapshot/hash, structured output, citations to deterministic metrics, model, and generation time.
- If inputs are stale or incomplete, do not generate an apparently current briefing.

Waivers must not solicit conditions, symptoms, diagnoses, medications, or free-text medical information.

---

## 2. Data model

Implement the logical model below incrementally with the feature that writes it. Do not create all tables up front; that would repeat the speculative-schema failure in §5.

### Tenancy and identity

- `tenants`
- `locations`
- `tenant_settings`
- `tenant_users`: tenant, Supabase auth user, role, status
- `tenant_invitations`
- `profiles`: tenant-scoped identity record, optionally linked to an auth user
- `roles`, `permissions`, `role_permissions`
- `integration_connections`
- `audit_events`

Initial roles should be owner, admin, front desk, instructor, marketer, accountant, and read-only analyst.

### People and explicit relationship typing

- `persons`: canonical tenant-scoped customer/prospect
- `person_contact_points`: email, phone, verification and deliverability state
- `person_external_refs`
- `person_merges`
- `communication_consents`
- `person_relationships`:
  - `relationship_type`
  - effective start/end
  - current state
  - derivation source
  - rule version
  - confidence/review status
- `person_relationship_snapshots`: reproducible reporting snapshots

Relationship types are explicit:

- `RECURRING_MEMBER`
- `PACK_HOLDER`
- `AGGREGATOR`
- `GUEST`
- `LEAD`

These should not be a single mutable enum on `persons`. A customer can simultaneously have an active subscription, residual pack credits, and historical aggregator activity. Effective-dated relationship rows preserve that reality.

The primary reporting classification is a versioned derived view:

1. An active, qualifying recurring subscription means `RECURRING_MEMBER`.
2. Otherwise, positive unexpired direct-purchase credits mean `PACK_HOLDER`.
3. Otherwise, qualifying partner-funded activity means `AGGREGATOR`.
4. Otherwise, a direct transaction or attended drop-in means `GUEST`.
5. Otherwise, `LEAD`.

Only `RECURRING_MEMBER` contributes to the **member count and MRR**. That definition belongs in a tested data dictionary and database view, not duplicated in UI code.

I explicitly disagree with “deduplicated by email” as a complete identity rule. Email is mutable, may be absent, and may be shared. Use tenant-scoped normalized email as a strong match signal, but combine it with external IDs, phone, and controlled merge review. Never deduplicate people across tenants.

### Catalog, memberships, and entitlements

Separate what is sold from what it grants:

- `products`: memberships, packs, drop-ins, intro offers, retail, gift cards
- `prices`: immutable amount/currency/tax configuration and effective dates
- `offers`: eligibility and promotional rules
- `price_phases`: founding/opening/standard ramps
- `service_offerings`: sauna, plunge, contrast session, class, appointment
- `membership_contracts`
- `subscriptions`
- `subscription_periods`
- `subscription_pauses`
- `entitlements`: unlimited access, visit allowance, service/location restrictions
- `subscription_state_history`

Never mutate an old price to implement a launch-tier increase. Grandfather existing contracts or use an explicit subscription schedule.

### Scheduling and booking

- `resources`: sauna room, plunge station, treatment room, equipment
- `resource_groups`
- `programs`: reusable service/session templates
- `schedule_rules`: recurrence in a location’s IANA timezone
- `session_instances`
- `resource_allocations`: resource and UTC time range
- `booking_holds`
- `bookings`
- `booking_status_history`
- `booking_participants`
- `waitlist_entries`
- `attendance_events`
- `cancellation_policy_versions`

Store instants in UTC and preserve the location timezone and intended local recurrence. Test daylight-saving transitions.

Exclusive rooms should use a Postgres range exclusion constraint. Pooled-capacity sessions should lock the session row and enforce capacity inside a database procedure. Do not rely on an eventually updated `booked_count` field as the correctness boundary.

### Credits and stored value

- `credit_accounts`
- `credit_grants`
- `credit_ledger_entries`: issue, reserve, release, redeem, expire, reverse, adjust
- `credit_reservations`
- `gift_card_accounts`
- `gift_card_ledger_entries`

Credit and gift-card ledgers are separate because gift cards have different legal and accounting treatment. Ledger entries are immutable; corrections use reversal entries. Credits should be consumed using a deterministic policy, normally earliest-expiring first.

Operational credit liability derives from the pack sale allocation, redemptions, expirations, refunds, and the tenant’s accountant-approved breakage policy. Kelo should not present a legally definitive deferred-revenue figure until that policy is configured.

### Commerce and money

- `customers`: Kelo person to Stripe customer mapping
- `orders`
- `order_lines`
- `invoices`
- `payments`
- `payment_attempts`
- `refunds`
- `disputes`
- `provider_events`
- `financial_accounts`
- `journal_entries`
- `journal_lines`
- `idempotency_records`
- `transactional_outbox`
- `reconciliation_runs`
- `reconciliation_differences`

All amounts are integer minor units plus ISO currency. Journal entries must balance before commit. Provider IDs have tenant-scoped uniqueness constraints.

### Marketing and communications

- `segment_definitions`
- `segment_assignments`: derived snapshots with rule version and reason codes
- `campaigns`
- `campaign_recipient_snapshots`
- `message_drafts`
- `messages`
- `message_attempts`
- `message_events`: accepted, delivered, bounced, complained, failed, opted out
- `automation_definitions`
- `automation_enrollments`
- `automation_steps`

A campaign recipient list is snapshotted at approval so reporting can explain exactly who was sent what. Consent and suppression are rechecked immediately before each send.

### Compliance, retail, and workforce

- `waiver_templates`, `waiver_template_versions`
- `waiver_signatures`
- `booking_waiver_acknowledgments`
- `retail_skus`
- `inventory_locations`
- `inventory_movements`
- `stock_counts`
- `staff_profiles`
- `staff_shifts`
- `session_staff_assignments`
- `pay_rules`
- `commission_rules`
- `pay_runs`, `pay_run_lines`

A waiver acknowledgment links a person, booking/session, exact waiver version, timestamp, signature evidence, and audit metadata.

V1 payroll means calculated session pay, commissions, approval, and export—not tax filing or direct deposit.

### Intelligence and operations

- `metric_snapshots`
- `daily_briefings`
- `briefing_items`
- `ai_generations`
- `activity_events`
- `import_runs`
- `import_pages`
- `import_watermarks`
- `import_anomalies`
- `source_records`
- `external_references`
- `authority_registry`
- `conflict_records`
- `job_queue`
- `job_attempts`
- `rate_limit_buckets`

Metrics are calculated by SQL and stored with an `as_of` timestamp and definition version. Claude receives those metrics and produces structured narrative and recommended actions.

---

## 3. API surface

### Contract conventions

Expose `/api/v1` REST endpoints with OpenAPI-generated clients.

Every authenticated route:

- derives the acting user from the Supabase token;
- validates organization membership;
- scopes the request to one tenant;
- returns a correlation ID;
- includes freshness/provenance metadata where imported or derived data is involved.

Every mutation requires an `Idempotency-Key`. Updates use an entity version or `If-Match` to prevent silent overwrites. Long-running actions return `202` with an operation ID.

Representative response metadata:

```json
{
  "data": {},
  "meta": {
    "as_of": "2026-07-10T09:00:00Z",
    "source_status": "fresh",
    "last_successful_import": "2026-07-10T09:02:14Z",
    "definition_version": "member-kpi-v3",
    "correlation_id": "..."
  }
}
```

### Main endpoint families

**Organizations and access**

- `POST /orgs`
- `GET /orgs/{orgId}`
- `POST /orgs/{orgId}/invites`
- `POST /orgs/{orgId}/invites/{token}/accept`
- `GET|PATCH /orgs/{orgId}/settings`
- `GET /orgs/{orgId}/locations`
- `GET|PUT /orgs/{orgId}/roles/...`

**CRM**

- `GET|POST /orgs/{orgId}/people`
- `GET|PATCH /orgs/{orgId}/people/{personId}`
- `POST /people/{personId}/merge`
- `GET /people/{personId}/relationships`
- `POST /people/{personId}/relationship-overrides`
- `GET /people/{personId}/timeline`
- `GET|PATCH /people/{personId}/consents`

**Schedule and resources**

- `GET|POST /locations/{locationId}/resources`
- `GET|POST /locations/{locationId}/programs`
- `GET|POST /locations/{locationId}/schedule-rules`
- `GET /locations/{locationId}/availability`
- `GET|PATCH /sessions/{sessionId}`
- `POST /sessions/{sessionId}/cancel`
- `GET /locations/{locationId}/utilization`

**Booking**

- `POST /booking-holds`
- `POST /bookings`
- `GET /bookings/{bookingId}`
- `POST /bookings/{bookingId}/cancel`
- `POST /bookings/{bookingId}/check-in`
- `POST /sessions/{sessionId}/waitlist`
- `DELETE /waitlist/{entryId}`

Availability responses must include hold expiry, capacity, eligible entitlements, price, required waiver version, and a server-generated quote ID.

**Catalog, subscriptions, and credits**

- `GET|POST /products`
- `GET|POST /offers`
- `POST /subscriptions`
- `POST /subscriptions/{id}/pause`
- `POST /subscriptions/{id}/resume`
- `POST /subscriptions/{id}/cancel`
- `POST /subscriptions/{id}/change`
- `GET /people/{personId}/credits`
- `POST /credit-accounts/{id}/adjustments`
- `GET /credit-accounts/{id}/ledger`

**Payments and POS**

- `POST /checkout-sessions` for Kelo’s on-domain checkout state
- `POST /payment-intents`
- `POST /setup-intents`
- `GET /payments/{paymentId}`
- `POST /payments/{paymentId}/refunds`
- `GET /invoices/{invoiceId}`
- `POST /terminal/connection-tokens`
- `POST /pos/orders`
- `GET /reconciliation-runs/{id}`

Card entry remains embedded through Stripe Elements; Kelo never handles raw card data.

**Marketing**

- `GET /segments`
- `GET /segments/{id}/people`
- `POST /segments/{id}/draft-outreach`
- `POST /campaigns`
- `POST /campaigns/{id}/preview`
- `POST /campaigns/{id}/approve-and-send`
- `GET /campaigns/{id}/results`
- `GET|POST /automations`
- `POST /messages/{id}/retry`

Approval and sending are separate operations. AI has no route that can bypass approval.

**Compliance, retail, and workforce**

- Waiver template/version/signature endpoints
- Booking waiver-status endpoint
- SKU, inventory movement, stock-count, gift-card endpoints
- Staff, shifts, assignments, pay-rule, commission, and pay-run endpoints

**Intelligence and reporting**

- `GET /home/briefing`
- `GET /briefings/{date}`
- `GET /focus-queue`
- `GET /metrics`
- `GET /reports/{reportType}`
- `POST /reports/{reportType}/exports`
- `POST /schedule-recommendations`
- `POST /assistant/questions`

Briefing items link to the exact metrics and affected entities. Reports support cursor pagination, filtering, drill-down, and server-generated CSV/XLSX exports.

**Operational health**

- `GET /data-health`
- `GET /imports`
- `GET /imports/{runId}`
- `POST /imports/{entity}/replay`
- `GET /reconciliations`
- `GET /jobs/{jobId}`

**Webhooks**

- `POST /webhooks/stripe`
- `POST /webhooks/resend`
- `POST /webhooks/twilio`

Webhook signatures are verified before persistence. Each provider event is stored once using its provider event ID, then processed idempotently.

---

## 4. Import + migration strategy

### 4.1 Reset and source verification

Perform a full reset of corrupt imported and derived production data. Preserve only owner-authored records that can be individually verified—tenant configuration, brand guidance, approved consent evidence, and possibly reviewed campaign drafts. Do not preserve old metrics, inferred relationships, transactions, or import watermarks.

Before writing mappings:

1. Run read-only probes against every required Glofox endpoint.
2. Capture request method, required headers, namespace, parameters, pagination behavior, and real response shape.
3. Store restricted raw samples outside the public repository.
4. Commit sanitized but structurally exact samples for contract testing.
5. Produce an endpoint contract file that names each mapped source path and evidence sample.

The adapter must encode the verified facts directly:

- membership comes from the nested `membership` object;
- recurring status requires qualifying membership behavior plus subscription-payment evidence;
- plan name resolves through the catalog;
- transactions require the namespace;
- transaction type is derived from `glofox_event`, catalog references, and description fallback;
- `created` is parsed from Unix seconds represented as a number or string;
- `success: false` at HTTP 200 is an error;
- POST searches are valid reads;
- pagination strategy is endpoint-specific;
- branch-to-location is a tenant mapping, not a global assumption.

Unknown transaction classifications go into a review queue. They do not silently become membership revenue.

### 4.2 Correct incremental import

Each import run has:

- tenant, location, entity, and source window;
- committed and candidate watermark;
- adapter/mapping version;
- expected pagination strategy;
- request and response hashes;
- page counts and record counts;
- inserts, updates, unchanged rows, quarantines;
- control totals where applicable;
- status and error;
- start, heartbeat, and completion timestamps.

Rules:

1. Acquire a tenant/entity lease before fetching.
2. Validate HTTP status, response body, `success`, required fields, and pagination.
3. Save the raw page before transformation.
4. Transform into a staging set.
5. Validate uniqueness, references, timestamps, amounts, and anomaly thresholds.
6. Reconcile the complete staging set.
7. Upsert canonical records and commit the watermark in one database transaction.
8. Emit an import-completed event only after commit.

A failed, partial, malformed, or empty pull never advances the watermark. A legitimate no-change run is recorded, but the last observed source-record watermark remains unchanged. Use overlapping windows and idempotent upserts so replay is safe.

For active transaction and booking streams, unexpected zero counts are alerts. The omitted-namespace transaction response must be represented by a permanent regression test.

Use periodic full snapshots to detect deletions and missed updates. Do not infer deletion from one absence; require two complete snapshots or explicit source evidence.

### 4.3 Reconciliation and observability

Reconciliation should compare:

- source-reference counts;
- people represented versus explained merges;
- bookings by date, status, session, and location;
- active recurring contracts;
- credit balances and expiration dates;
- transaction count and gross/refund/net amounts by currency;
- Stripe charge, invoice, refund, and subscription identifiers;
- unmatched or low-confidence mappings.

Every imported screen displays freshness. Combined reports use the oldest required input as their effective freshness. If transactions are stale but bookings are fresh, revenue is unavailable/stale rather than silently mixed.

Alerts:

- no successful run within the entity SLO;
- transaction or booking count unexpectedly zero;
- watermark unchanged beyond threshold;
- run lease expired;
- source schema changed;
- quarantine or reconciliation difference above threshold;
- HTTP 200 with application failure;
- repeated rate limiting or authentication failure.

Daily briefings should not generate when required input is stale beyond policy.

### 4.4 Signup-date recommendation

Validate `created` across a broad, stratified sample: new records, long-standing customers, known migration-era records, recurring members, guests, and pack holders.

Store separate fields:

- `source_created_at`
- `first_booking_at`
- `first_attendance_at`
- `first_transaction_at`
- `relationship_started_at`
- `cohort_anchor_at`
- `cohort_anchor_basis`
- `date_quality`

If `created` clusters around a migration date, do not call it signup date. Use the earliest verified activity among booking, attendance, and transaction as the cohort anchor, while preserving `created` as source-record creation time. Reports must disclose the anchor definition.

### 4.5 Strangler-fig sequence

1. **Read-only import and intelligence**
   - Glofox remains authoritative.
   - Kelo provides verified reports, relationships, briefing, segments, and data health.

2. **Kelo-owned CRM and marketing**
   - Kelo owns notes, consent captured in Kelo, segments, campaigns, message history, and brand guidance.
   - Glofox people remain imported until the people-creation workflow is proven.
   - Marketing does not require write-back unless Glofox must consume a specific field.

3. **People, staff, compliance, retail, and scheduling**
   - Move one capability at a time through tested write-back.
   - Kelo becomes authoritative for schedules only after read-after-write reconciliation proves Glofox displays the same sessions.
   - Maintain an authority matrix visible to operators.

4. **Native booking and payments**
   - Avoid two booking engines selling the same inventory. Pilot Kelo on designated resources or sessions that are closed to booking in Glofox.
   - Migrate subscriptions in cohorts. A subscription must have exactly one billing authority; disable Glofox billing before Kelo begins billing it.
   - Do not assume existing Stripe customers, payment methods, or subscriptions are controllable by Kelo merely because Glofox uses Stripe. Verify Stripe account ownership, Connect topology, object visibility, and mandate portability in the first phase.

5. **Beta member surface**
   - Launch an on-domain responsive booking widget/PWA against Kelo-authoritative inventory.
   - Move all booking channels only after the pilot passes.

6. **Cutover and retirement**
   - Use a rehearsed freeze window, final import, reconciliation, authority switch, communication plan, and rollback decision point.
   - Keep Glofox read-only for a defined archival period rather than immediately deleting access.

### 4.6 Cutover-readiness bar

Require all of the following:

- 30 consecutive operating days with import freshness SLO met at least 99.5%, and no stale period over two hours without a visible warning and alert.
- 100% of source records have an external reference, quarantine reason, or documented merge.
- Exact trailing-13-month transaction reconciliation by provider ID and currency, with **zero unexplained monetary difference**.
- Exact active-subscription and credit-balance reconciliation.
- Exact trailing-90-day booking totals by date/status/location, apart from documented source defects.
- Two successful monthly billing cycles under Kelo for the pilot cohort; annual, pause, ramp, proration, dunning, and cancellation paths verified using Stripe Test Clocks plus controlled live tests.
- Full booking concurrency, cancellation, waitlist, no-show, refund, card-update, and waiver matrix passed.
- No unresolved severity-1 or severity-2 defects and no unresolved data-correctness defect.
- p95 performance budgets met under realistic load for at least seven days.
- Transactional email/SMS status and retries visible; no unexplained missing confirmations.
- Pilot inventory has operated without double booking.
- Final migration and rollback runbooks rehearsed from a production-like snapshot.
- Owner signs off on member count, MRR, revenue, credits, schedules, bookings, and billing—not merely on a green deployment.

---

## 5. Native booking + payment engine

### Build versus license

Build the booking and entitlement engine natively. Licensing another booking backend would preserve the central strategic dependency Kelo is intended to remove and would constrain recovery-specific resource allocation and credit economics.

Use Stripe rather than building payment rails or card storage. “Owned” should mean Kelo owns the workflow, records, reconciliation, and customer experience—not that it recreates regulated payment infrastructure.

### Booking state machine

Use explicit states:

- Hold: `ACTIVE`, `EXPIRED`, `CONSUMED`, `RELEASED`
- Booking: `PENDING_PAYMENT`, `CONFIRMED`, `WAITLISTED`, `CANCELLED`, `CHECKED_IN`, `NO_SHOW`, `FAILED`
- Attendance is a separate timestamped event rather than an overloaded booking flag.

A database procedure should:

1. Validate offering, location, eligibility, booking window, and waiver requirement.
2. Lock the relevant session/capacity row or acquire a resource-range allocation.
3. Check existing active holds and confirmed bookings.
4. Create a short-lived hold.
5. Calculate a signed, expiring quote.
6. Return the eligible payment or entitlement paths.

For exclusive rooms, enforce overlapping allocation prevention with a database exclusion constraint. For pooled resources, enforce `confirmed + active_holds <= capacity` while holding a row lock.

Waitlist promotion creates a time-limited hold and communication. If the customer does not accept or payment fails, the hold expires and the next entry is considered. This avoids silently charging someone after an old waitlist request.

### Entitlement and credit booking

A credit booking is locally atomic:

- lock the credit account and applicable grants;
- reserve or debit credits;
- consume capacity;
- confirm the booking;
- append credit and domain events;
- commit together.

Cancellation creates reversal/release entries according to the policy version attached to the booking. Never update a balance directly.

Unlimited membership checks an active entitlement and any booking limits inside the same transaction. Payment grace-period behavior is explicit tenant policy, not an accidental interpretation of Stripe status.

### Card-funded booking

A database and Stripe cannot participate in one ACID transaction. I therefore disagree with interpreting “atomic” as literal cross-provider atomicity; that is technically impossible. The correct guarantee is:

- atomic local state;
- idempotent provider commands;
- durable outbox/inbox records;
- explicit pending states;
- webhook verification;
- reconciliation;
- deterministic compensation.

Flow:

1. Create a capacity hold and order under an idempotency key.
2. Persist a command to create a Stripe PaymentIntent.
3. Create it using the same stable Stripe idempotency key.
4. Return the client secret for embedded Payment Element confirmation.
5. Treat the signed Stripe webhook as authoritative for success.
6. In one database transaction, record payment/journal entries and convert the hold to a confirmed booking.
7. If payment succeeds after the hold is no longer usable, automatically attempt a refund and surface the case for review.
8. Send confirmation through the transactional outbox.

The member sees `processing`, `confirmed`, `failed`, or `refund pending`; Kelo must never claim success before provider confirmation.

### Subscriptions and membership lifecycle

Kelo stores the contract and policy; Stripe stores payment method and executes billing.

- Create Stripe Customer and Subscription objects with stable Kelo metadata.
- Grant paid entitlements only after the relevant invoice succeeds, subject to configured grace policy.
- Model pause, resume, cancel-at-period-end, immediate cancellation, plan changes, and price ramps as commands with effective dates.
- Use Stripe Subscription Schedules where appropriate, but retain the intended schedule in Kelo.
- Use SetupIntents and an embedded card-update screen; do not force members into a vendor-branded portal.
- Use Stripe’s retry machinery for payment attempts and Kelo’s workflow for dunning communications, task creation, and escalation.
- Reconcile webhooks with scheduled Stripe retrieval because webhooks can be delayed or missed.

### Financial correctness

- Every command has a tenant-scoped idempotency record and request hash. Reusing a key with different input is rejected.
- Stripe provider events are unique and replayable.
- Payments, refunds, disputes, Stripe fees, pack liabilities, gift-card liabilities, and recognized revenue post balanced journal entries.
- Refunds remain `PENDING` until Stripe confirms them.
- A nightly reconciliation compares local payments and journal entries to Stripe PaymentIntents, Charges, Invoices, Refunds, Disputes, and balance transactions.
- Any unexplained cent difference alerts and blocks cutover.
- Admin adjustments require a reason, permission, and compensating ledger entry.
- Transactional messages are emitted through an outbox after the financial transaction commits.

A payment and an email cannot be externally atomic either. Kelo should guarantee that a committed billing action always creates a durable confirmation-message obligation, then expose delivery and retry state separately.

### POS, retail, and gift cards

Use the same order/payment/journal engine for front-desk retail and drop-ins. Stripe Terminal provides card-present processing. Inventory decrements only after payment succeeds; refunds and voids create reversing stock movements according to policy.

Gift cards use their own stored-value ledger, partial redemption, audit history, and jurisdiction-configurable expiration rules.

### Verification

Required automated testing includes:

- concurrent attempts for the last room/slot;
- duplicated API calls and webhooks;
- webhook reordering;
- payment success after hold expiry;
- worker crash before and after provider calls;
- credit expiration during checkout;
- cancellation and refund races;
- DST schedule generation;
- subscription pause/resume and plan ramp;
- dunning and card replacement;
- cross-tenant access attempts;
- Stripe reconciliation with intentionally introduced differences.

Use captured, sanitized real-shaped provider events and seeded relational scenarios. Demo data must be compiled/deployed separately and structurally unreachable from production routes.

---

## 6. Build phases in order, with rough effort for each

Effort is expressed as focused **builder-weeks for one capable engineer working with coding agents**. It excludes waiting for SMS registration, Stripe/Glofox approvals, and owner acceptance periods. The ranges should not be compressed at the expense of verification.

| Phase | Scope and exit gate | Effort |
|---|---|---:|
| **0. Foundations and live-system verification** | Repository, ADRs, Supabase migrations, tenant/RLS model, auth/invites, OpenAPI conventions, CI, Sentry/Better Stack, job queue, raw Glofox probes, Stripe-account ownership investigation, sanitized source contracts. Exit: cross-tenant tests pass and every required Glofox endpoint has a verified contract. | **4–6 weeks** |
| **1. Correct import and canonical data** | Raw/staging/canonical import pipeline, leases, watermarks, endpoint-specific pagination, provenance, reset/re-import, anomaly detection, freshness UI, reconciliation for people/catalog/sessions/bookings/transactions/credits. Exit: historical controls reconcile and omitted namespace/`success:false` regressions fail tests. | **7–11 weeks** |
| **2. Intelligence read-only vertical slice** | Tested relationship derivation, member/MRR definitions, KPI snapshots, reports, drill-downs, segments, daily briefing, focus queue, AI citations and cache. Exit: owner can complete the morning-review flow without cross-checking Glofox for the agreed sample period. | **7–10 weeks** |
| **3. CRM and marketing execution** | Native CRM annotations, consent/suppression, Resend, Twilio, campaign recipient snapshots, AI drafts, approval/send flow, delivery logs, lifecycle automations, lead pipeline. Exit: segment → draft → approve → send → measure works end to end with no autonomous sends. | **8–12 weeks** |
| **4. Non-transactional operations** | People ownership, staff/roles, staff schedules, pay rules/commission reports, waiver versions and per-session acknowledgment, retail/inventory setup, resource maintenance, gift-card definitions. Build as working vertical slices, not empty screens. Exit: each shipped screen has a native writer, audit trail, and acceptance test. | **10–15 weeks** |
| **5. Native scheduling and controlled write-back** | Programs, recurrence, rooms/resources, appointment slots, capacity, schedule editor, demand heatmap, Glofox write-back adapter, read-after-write reconciliation. Exit: Kelo-authoritative pilot sessions render identically downstream and DST/capacity tests pass. | **8–12 weeks** |
| **6. Commerce, booking, and payments** | Booking holds, waitlist, credits, subscriptions, Stripe Billing, dunning, refunds, card update, ledger, reconciliation, POS/Terminal, inventory sale completion, gift-card ledger. Exit: controlled live money tests and the full failure/concurrency matrix pass. | **16–24 weeks** |
| **7. Beta member surface and cutover** | Responsive on-domain booking PWA/widget, account access, cards, credits, subscriptions, waivers, receipts; pilot inventory migration; performance/load testing; support and rollback runbooks. Exit: every cutover-readiness criterion in §4 is satisfied. | **10–15 weeks** |
| **8. Hardening for additional tenants** | Self-onboarding internals, tenant templates, location roll-ups, data export/deletion, operational support tools, migration tooling, onboarding documentation. This is not commercial self-serve billing. | **7–11 weeks** |

**Total:** approximately **77–116 builder-weeks**, plus the deliberate live proving periods. Correctness gates, not elapsed time, control progression.

---

## 7. Key risks and mitigations

| Risk | Mitigation |
|---|---|
| **Glofox returns plausible HTTP 200 empties or `success:false`.** | Validate body semantics; require namespace in a typed request builder; anomaly-alert on zero active streams; never advance an empty/failed watermark; retain raw request/response evidence. |
| **Source schema or pagination changes.** | Endpoint-specific adapters, Zod contracts, sanitized captured responses, schema-drift alerting, overlapping imports, replayable raw pages, and periodic full snapshots. |
| **Tests pass against unrealistic fixtures.** | Use sanitized real-shaped payloads and production-like seeded relational scenarios. Add deliberate mutation tests: remove namespace, rename `created`, return `success:false`, reorder webhooks, and introduce reconciliation differences. |
| **Fabricated/demo data reaches production.** | Separate demo deployment and database. Production loaders have no fallback branch. Empty, stale, and error states are explicit. CI scans production bundles/config for demo loaders. |
| **Watermark freeze silently makes reports stale.** | Candidate/committed watermarks, transactional commit, health heartbeat, stale banners on every dependent screen, and external alerts. |
| **Recurring members are misclassified as all Glofox leads or PAYG users.** | Versioned relationship rules using nested membership, subscription-payment evidence, catalog joins, and review queues. Member/MRR definitions are centralized and regression-tested. |
| **`created` is a migration date.** | Preserve multiple dates and quality metadata; validate against broad samples; use earliest verified activity as cohort anchor when necessary. |
| **Existing Stripe objects cannot be controlled by Kelo.** | Investigate account/Connect ownership in phase 0. Map object access and mandates. If subscriptions cannot transfer safely, perform cohort reauthorization rather than attempting hidden rebilling. |
| **Double billing during migration.** | One billing authority per subscription, explicit authority registry, cohort migration checklist, Glofox billing disabled before Kelo activation, and post-run invoice reconciliation. |
| **Double booking during the dual-system period.** | Do not let both systems sell the same inventory. Partition pilot resources/sessions and close them in Glofox before Kelo takes authority. |
| **Distributed payment failure creates money-without-booking or booking-without-money.** | Capacity holds, idempotent Stripe commands, webhook inbox, explicit pending states, compensating refunds, dead-letter review, and nightly reconciliation. |
| **Credit balances or liability become mutable/unverifiable.** | Immutable credit grants and ledger entries, deterministic consumption, reversal rather than editing, and accountant-reviewed recognition policy. |
| **Email/SMS is claimed sent when it was not delivered.** | Durable outbox, provider message IDs, webhook delivery state, retries, bounce/complaint suppression, Twilio STOP handling, and a queryable operator log. Measure provider-accepted and delivered rates separately. |
| **Marketing violates consent or carrier rules.** | Consent source/evidence, recipient-time suppression check, quiet hours, unsubscribe links, STOP processing, A2P registration, and immutable campaign recipient snapshots. |
| **AI invents numbers or exposes PII.** | Deterministic SQL metrics, structured outputs, metric citations, freshness gates, de-identified prompts, no unrestricted SQL/database tool, prompt/version audit, and human approval for all outreach. |
| **Tenant data leakage.** | RLS on every tenant table, API membership verification, tenant-scoped storage, restricted service role, security-definer procedure review, and automated two-tenant attack tests. |
| **Broad v1 overwhelms an owner-led build.** | Modular monolith, strict phase gates, vertical slices, no speculative tables/screens, generated contracts/types, and no microservice or bespoke infrastructure burden. |
| **Performance degrades as history grows.** | Cursor pagination, indexed tenant/location/time access paths, precomputed metric snapshots, bounded briefing inputs, query-plan tests, k6 load tests, and CI latency budgets. |
| **Timezone/DST creates wrong schedules.** | IANA location timezone, UTC instances, local recurrence intent, explicit ambiguous/nonexistent-time policy, and transition-date tests. |
| **Waivers accidentally collect health information.** | Fixed acknowledgment fields, no medical questions/free text, template review, versioning, and PII-only data classification. |
| **“Payroll” grows into regulated payroll processing.** | Limit v1 to compensation calculation, approval, reports, and export. Integrate a regulated payroll provider later rather than owning tax filing or custody of wages. |
| **Documentation drifts from implementation.** | Keep ADRs, OpenAPI, SQL migrations, mappings, runbooks, and data definitions in the repository. CI verifies generated types/contracts and rejects undocumented migration or API drift. |

---

## 8. What you would explicitly NOT build in v1

1. **A licensed booking backend.** It conflicts with the owned, recovery-native destination and would move rather than remove the strategic dependency.

2. **Native iOS and Android applications.** Ship a fast, installable responsive PWA/widget after operations are proven. Native apps add release, support, and synchronization burden before product-market evidence warrants it.

3. **A full commercial self-serve SaaS billing/onboarding portal.** Multi-tenant data, invites, roles, configuration, and migration tooling are required now; automated Kelo subscription billing and zero-touch tenant provisioning can follow after several assisted onboardings.

4. **Autonomous AI outreach or autonomous schedule changes.** AI ranks, explains, and drafts. An authorized human approves every send and operational change.

5. **Medical or health records.** No diagnoses, symptoms, contraindication answers, medications, clinical notes, or medical free text. Waivers record legal acknowledgment only.

6. **A general-purpose accounting system.** Build the subledgers and balanced journal necessary to verify Kelo’s money, credits, gift cards, and liabilities. Export to accounting software rather than replacing it.

7. **Tax filing, wage custody, benefits, or direct-deposit payroll.** V1 calculates and approves staff/session compensation and commissions, then exports or integrates with a regulated payroll provider.

8. **A custom card vault or payment processor.** Stripe remains the fixed payment rail. Kelo owns checkout, billing policy, records, reconciliation, and support surfaces.

9. **Real-time replication of all Glofox data.** Hourly freshness is the default; five-minute roster/booking updates are an explicit operating-hours exception. Sub-minute synchronization would add fragility without eliminating Glofox’s consistency limitations.

10. **Generic dual-master synchronization.** Each capability has one authority. Kelo may write back and reconcile during transition, but it will not merge arbitrary edits from both systems using timestamps.

11. **A standalone data warehouse, event-streaming platform, Redis cluster, or microservice fleet.** Postgres snapshots, an outbox, and the leased job queue are sufficient at initial scale and far more maintainable for the actual team.

12. **Complex multi-currency commerce within one tenant.** Support a configured tenant currency and correct ISO currency storage. Add genuine multi-currency accounting only when a tenant requires it.

13. **Deep bidirectional integrations with every aggregator.** Import and classify aggregator attendance/payments where available; add transactional partner integrations individually after Kelo’s own booking engine is stable.

14. **Advanced tax optimization, revenue-recognition automation, or legally opinionated breakage rules.** Provide configurable operational calculations and auditable inputs, then require accountant approval.

15. **Speculative schemas or placeholder screens.** A table or screen ships only with a production writer, reader, audit path, realistic data, and acceptance test.

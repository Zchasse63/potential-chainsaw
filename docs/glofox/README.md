# Glofox API — Source of Truth

*Compiled 2026-07-17 for the Kelo build. Sources: (1) the official OpenAPI 3.1 spec extracted from
the developer portal ([openapi.json](openapi.json), version 2.3.0, 63 operations); (2) the
portal's 13 prose guides ([guides/](guides/)); (3) **live read-only verification probes against
the studio's production account (2026-07-17)** with PII-redacted pinned samples in
[samples/](samples/). Facts are marked **[SPEC]**, **[DOCS]**, or **[LIVE]** — anything marked
[LIVE] was verified against reality, which is this project's standard of truth (build-plan §5).*

*Credentials live in `.env` locally (git-ignored) and move to Supabase Vault in phase 0.
**Never** put keys in this or any doc. Env vars: `GLOFOX_API_KEY`, `GLOFOX_API_TOKEN`,
`GLOFOX_BRANCH_ID`, `GLOFOX_NAMESPACE`, `GLOFOX_BASE_URL`.*

---

## 1. Connection basics

| Fact | Value | Source |
|---|---|---|
| Base URL | `https://gf-api.aws.glofox.com/prod/` | [SPEC]+[LIVE] |
| Auth | Three headers on every request: `x-glofox-branch-id`, `x-api-key`, `x-glofox-api-token` | [SPEC]+[DOCS]+[LIVE] |
| Rate limits | Live: **10 req/s, burst 1000**. Sandbox: 3 req/s, burst 300. 429 on excess | [DOCS] |
| Credential sets | Glofox issues two sets (dev/test + production) pointing at the same environment config | [DOCS] |
| Portal | `api-portal.glofox.com/api-portal/` (ABC Fitness); support: `glofox.apisupport@abcfitness.com`, activation: `apiactivation@abcfitness.com` | [DOCS] |
| Timestamps | Unix epoch seconds — **integers on some endpoints, strings on others** (e.g. members `created` is int; report rows' `created` is string; bookings `created` is string ISO-ish). Parse defensively at the Zod boundary | [LIVE] |

## 2. Response envelopes & pagination — three styles observed [LIVE]

The API is **inconsistent across endpoint generations** (build-plan §5 confirmed). One shared
client must own per-endpoint strategy:

| Style | Envelope | Used by |
|---|---|---|
| **A (2.0 lists)** | `{object, page, limit, has_more, total_count, data: []}` | `/2.0/members`, `/2.0/memberships`, `/2.0/credits`, `/2.0/branches/{id}/events` |
| **B (2.2 lists)** | `{data: [], success: bool, meta: {totalCount, page, limit}}` | `/2.2/branches/{id}/bookings` |
| **C (Analytics)** | `{TransactionsList: {details: [], header: string}}` — **no** `data`, **no** `success`, **no** pagination | `POST /Analytics/report` |

`has_more` exists on style A; style B needs `meta.totalCount` math; style C returns the full
window (keep windows small). Page-based, 1-indexed; `limit` max 100 where declared.

## 3. Errors — including the confirmed traps

- Standard codes: 400/401/403/404/429/500 with `{message, message_code}` bodies. [DOCS]
- **Trap 1 (confirmed by Glofox's own docs):** "Older endpoints sometimes return a 200 status
  code with a `success` field set to `false`… Add a middleware to transform those to 400." This
  is §5's exact failure mode, now vendor-acknowledged. The shared client throws on
  `success === false` anywhere. [DOCS]
- **Trap 2 (reproduced live 2026-07-17):** `POST /Analytics/report` **without** `namespace` in
  the body returns **HTTP 200 with `TransactionsList.details: []`** — silently empty, no error,
  no success flag. With `namespace`, the same request returned 56 real rows for a 30-day window.
  The request builder makes `namespace` non-optional at the type level + permanent regression
  test. [LIVE]

## 4. Endpoint inventory (63 operations, by tag) [SPEC]

**Kelo-critical (import + intelligence):**

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/2.0/members` | All clients+leads | Style A; filters: `active` (true/false/any), `utc_modified_start_date`/`_end_date` (**the incremental-sync watermark params**), `home_only` |
| GET | `/2.0/members/{userId}` | One person | |
| GET | `/2.0/memberships` | The plan catalog | Style A; `private` filter; plan `code` joins to transactions `plan_code` |
| GET | `/2.0/credits?user_id=` | A user's credit packs | **Per-user only** — no branch-wide credits list; import iterates members (rate-budget accordingly) |
| GET | `/2.2/branches/{id}/bookings` | All bookings | Style B; rich filters incl. `modified_start_date` (watermark), `status` (BOOKED/WAITING/CANCELED/RESERVED/FAILED…), `event_type` (events/courses/facilities/users/appointments) |
| GET | `/2.0/branches/{id}/events` | Classes/sessions | Style A; capacity `size`, `booked`, `waiting` |
| POST | `/Analytics/report` | **The transactions report** | Body: `{branch_id, namespace, start, end (unix-second strings), model: "TransactionsList"}`; POST-as-read |
| GET | `/2.0/branches/{id}` | Branch detail | Includes `address.timezone_id/timezone_name`, currency — feeds `locations` |
| POST | `/2.1/branches/{id}/leads/filter` | Lead search | POST-as-read |
| GET | `/2.0/staff` | Staff list | |
| GET | `/2.1/branches/{id}/appointments-availability` | Appointment slots | |
| GET | `/3.0/locations/{id}/facilities` | Facilities/rooms | v3 generation |
| GET | `/2.0/analytics/trainer-performance` | Trainer report | |

**Write surface (exists and is documented — the write-back gate probes its *behavior*, phase 4):**
create/update person (`POST /2.1/branches/{id}/leads`, `PUT /2.0/members/{userId}`), create
booking (`POST /2.3/branches/{id}/bookings`, older `POST /2.0/bookings`), cancel booking
(`DELETE /2.3/...bookings/{bookingId}`, `POST /booking/{id}/user/{uid}/cancel`), mark attendance
(`POST /2.0/attendances`), purchase membership (`POST /2.2/.../plans/{planCode}/purchase`),
cancel membership (`POST /v3.0/memberships/{userMembershipId}/cancel`), carts
(`POST /v3.0/carts` → `.../checkout`), send agreements, register user, lead interactions,
push-device registration.

**Everything else:** Access (barcodes), Price Calculator (event/appointment/course/facility +
`price-breakdown`), Electronic Agreements (waivers: list templates, send for signature, list a
user's agreements), Cart/Products (retail), Courses, Programs, Push Notifications, Linked
accounts (parent/child), Payment methods (`GET /2.1/branches/{id}/payment-methods`), Leads
sources. Full details per operation: [openapi.json](openapi.json).

## 5. Kelo-critical shapes, live-verified

### Person — `GET /2.0/members` [LIVE] ([samples/members.get.limit2.json](samples/members.get.limit2.json))

```
{ _id, branch_id, namespace, first_name, last_name, gender, phone, email,
  active (bool — soft-delete flag, see webhooks), type, 
  membership: { type, status, start_date, user_membership_id },   ← §5 confirmed: object, no name
  origin, source, lead_status, leads: {status, status_modified},
  consent: { email, sms, push },                                  ← marketing consent EXISTS per channel
  created (int unix), modified (int unix),                        ← §5: `created`, no registered_at
  origin_branch_id, name, image_url, account_email, contact_email, role }
```
- `membership.type = "payg"` for non-recurring people (§5 confirmed).
- **`consent.{email,sms,push}`** is a major find: imported marketing-consent evidence exists —
  feeds the D2 owner decision (counsel may accept these as opt-in provenance).
- Plan *name* resolves by joining `membership.user_membership_id` / transaction `plan_code` to
  the catalog (§5 confirmed).
- **`membership.type` + `membership.status` IS THE MEMBER SIGNAL (verified live 2026-07-17, full
  1,366-population scan):** `time`/`time_classes` + status `ACTIVE` = the recurring-member cohort;
  `num_classes` = credit packs (pack-holders); `payg` = drop-in/guest. Distribution:
  **payg/ACTIVE 652 · num_classes/none 693 · time_classes/ACTIVE 13 · time/ACTIVE 6 ·
  time_classes/PAUSED 1 · num_classes/LOCKED 1**. So **recurring members ≈ 19 ACTIVE (+1 PAUSED)** —
  matches the owner's ~22-23 far better than a payment-recency window (which gave only 16, missing
  members who bill on longer cycles / paid differently but hold an ACTIVE recurring membership).
  **DERIVATION FIX REQUIRED:** import `membership.{type,status,user_membership_id,start_date}` onto
  `people` (mapMember + a people migration) and derive `recurring_member` from membership.status
  ACTIVE (+ recurring type), with `subscription_payment` as CORROBORATION, not a hard requirement.
  The remaining ~2-3 gap to ~23 is gold-label territory (comped/edge members the owner adjudicates).
- **GROUND TRUTH PINNED (owner dashboard export "Current Members", 2026-07-17): exactly 22 members
  = 21 ACTIVE + 1 PAUSED.** Breakdown: 6 unlimited (`Monthly Unlimited`/`New Monthly Unlimited`) +
  ~14 class-based (`4/6/8/10-Class`, `Monthly Recurring`) + 2 NOEQL comps ($1 CASH / 100% discount).
  Definition (canonical): a member = an **ACTIVE-or-PAUSED membership on a RECURRING plan** (unlimited
  / N-class / recurring / comp) — NOT drop-in `payg`, NOT a bare `num_classes` credit pack.
  membership.status + the plan's recurring-ness is the signal; subscription_payment recency is
  corroboration only. The API `membership.type` scan gets 19-20; the 2 NOEQL comps read as `payg`
  (100%-comp structure) and are recovered by the owner's A8 catalog mapping marking NOEQL recurring.
  **The member-count canary target is 22 (not 23); the owner's member list is the gold-label positive
  set.** (Member PII stays OUT of the repo — public — used only at validation via service creds.)
- **The NOEQL partner channel (owner-explained 2026-07-17; unique to this studio):** NoEqual (NOEQL)
  is a partner gym on **PushPress**; a custom PushPress→Glofox API integration lets their members buy
  this studio's memberships inside PushPress. **Billing happens on NoEqual's side; the studio invoices
  NoEqual monthly.** Because Glofox refuses true $0 memberships, these run as **$1 / CASH / 100%-discount
  ("NOEQL") memberships** — a deliberate workaround. Of the two NOEQL members: one is **genuinely
  comped** (the partner gym's owner, NOEQL Unlimited) and one is a **real 4-class recurring member
  billed via the partnership** (NOEQL Monthly). Implications: (1) both COUNT as recurring members
  (they're in the owner's Current Members ground truth); (2) their $1 transactions are placeholders —
  **revenue/MRR must NEVER treat NOEQL $1 rows as real revenue** (real revenue arrives as the monthly
  partner invoice, outside Glofox — a phase-2 revenue-dictionary line: partner-invoiced revenue is
  recorded manually or excluded-and-labeled, never inferred from the $1 rows); (3) NOEQL membership
  items may be private/non-sellable in the catalog API — verify the catalog import captures private
  items so the A8 kelo_type mapping can recover these members.

### Plan catalog — `GET /2.0/memberships` [LIVE] ([samples/memberships.get.json](samples/memberships.get.json))

6 catalog items live. Shape: `{_id, name, description, active, buy_just_once, type,
plans: [{code (numeric id), name, price, type, upfront_fee, credits[], starts_on,
auto_renewal, min_price, is_group_membership, free_time_unit_count}]}`.
**Plan `type` vocabulary [LIVE]:** `num_classes` (credit pack), `time_classes` (time-boxed with
class limits), `time` (time-based/unlimited). This + live descriptions seeds the owner's A8
catalog mapping: "2-Week Unlimited Trial" (**the intro offer**), "Monthly Unlimited", "Monthly
Memberships (4-Class …)", "Single Class Drop-in", "Virtual Gift Cards", "Open Sauna + Cold
Plunge", "Guided Sauna + Cold Plunge", "HAPPY HOUR: Open Sauna + Cold Plunge".

### Credit pack — `GET /2.0/credits?user_id=` [LIVE] ([samples/credits.get.nonempty.json](samples/credits.get.nonempty.json))

```
{ _id, user_id, membership_id, membership_name, model, num_sessions (granted),
  available (remaining), active, bookings[] (booking ids consuming it),
  start_date, end_date?, created, modified, type }
```
- **Must-answer #1 ANSWERED: per-pack expiry exists** — schema field `end_date` ("Bookings can
  be made if the class end time is less than this value", unix seconds) [SPEC]. The live sample
  pack omitted it (treat absent/null as `no_expiry` — the degraded rule stays as written).
  `credits-expiring` and liability segments are buildable.
- `model` scopes usage: `programs` = classes, `appointments`/`users` = trainer appts,
  `facilities` = facility bookings [SPEC].
- **No branch-wide credits endpoint** — the import loops members (respect the 10 req/s budget).

### Booking — `GET /2.2/branches/{id}/bookings` [LIVE] ([samples/bookings.get.limit3.json](samples/bookings.get.limit3.json))

```
{ _id, user_id, user_name, type, program_id, event_id, event_name, time_slot_id, model,
  status, attended (bool), paid (bool), payment_method, time_start, time_finish,
  is_first (bool — first-ever visit marker), is_from_waiting_list, is_late_cancellation,
  guest_bookings (int), cancellations[], canceled_at, origin, metadata: {service:{type,id}},
  created, modified (string timestamps) }
```
- Statuses [SPEC]: `BOOKED, WAITING, CANCELED, RESERVED, FAILED, …`; `attended` is the check-in
  fact; `is_late_cancellation` maps straight to Kelo's policy analytics; `is_first` is a free
  new-customer signal.
- **Must-answer #2 (aggregator channel) — partially answered:** candidate fields are
  `origin` (null in samples) and members' `source`/`origin`. No ClassPass markers appeared in the
  30-day transaction window (all rows `StripeCharge`). Phase-1 task: distinct-value scan of
  `origin`/`source` across full history; the studio may simply not use aggregators today (owner
  is checking).

### Transactions — `POST /Analytics/report` [LIVE] ([samples/analytics.report.30d.json](samples/analytics.report.30d.json), 56 rows/30d)

Response: `{TransactionsList: {header, details: [{StripeCharge: {...}}]}}` — each row wrapped in
a **provider key** (§5 confirmed; only `StripeCharge` observed; treat the wrapper key as the
provider dimension and alert on unknown wrappers).

```
StripeCharge: { _id, id, transaction_status (PAID|ERROR|REFUNDED [LIVE]), transaction_provider_id,
  amount (float), currency, customer, paid, invoice_id, event_id, description,
  transaction_group_id, amount_refunded, status, taxes,
  created, modified (branch-LOCAL wall-time strings "YYYY-MM-DD HH:MM:SS", NO zone — convert via
  the branch timezone; corrected 2026-07-17 against the pinned sample, which shows
  "2026-07-17 04:32:52", not string unix),
  metadata: { namespace, branch_id, glofox_event, stripe_subscription_id, user_id, user_name,
              membership_id, plan_code, payment_method, resource_id, environment,
              is_payment_link, balance, user_tax_id } }
```
- **`glofox_event` vocabulary [LIVE, 30d]:** `subscription_payment` (16), `invoice_payment`
  (10), and **`book_class` (30) — a third value §5 didn't document** (drop-in/booking payments).
  The transaction classifier must handle all three + quarantine unknowns.
- **`payment_method` values [LIVE]:** `credit_card`, `card`, `complimentary`, `cash`.
  **Tender normalization (migration 0030):** `credit_card` and `card` are the SAME real-world card
  tender under a Glofox legacy/current label split (owner-confirmed 2026-07-18). `public.tender_aliases`
  maps `credit_card → card` so the revenue-by-tender report collapses them into one row; `cash` and
  `complimentary` are correctly distinct (no alias). Net revenue totals are unaffected — only the
  per-tender grouping consolidates. Add future equivalences by inserting into `tender_aliases`.
- Recurring-member evidence chain confirmed end-to-end: `glofox_event=subscription_payment` +
  `stripe_subscription_id` + `plan_code` → catalog join [LIVE].
- Stripe underneath is confirmed (`StripeCharge`, `stripe_subscription_id`) — but **account
  access is Glofox-gated per the owner**, so the build plan's negative branch applies: no direct
  Stripe API ingest pre-cutover; this report is the payments source until phase 5.
- **Transaction history DEPTH — verified live 2026-07-17 (corrects the plan's "13 months"
  assumption):** the report returns data from **~December 2023 to now ≈ 31 months**, not 13.
  Row counts per 30-day window: now 55 · −6mo 41 · −13mo 67 · −24mo 75 · **−30mo 167 (peak)** ·
  −31mo 51 · **−32mo 0 · −36mo 0** (edge is ~Nov/Dec 2023). The studio was BUSIEST ~2.5 years ago.
  **The full backfill (`glofox.sync.transactions` job payload `backfillStart`) MUST start at
  `2023-11-01`** (a margin before the first observed data), NOT 13 months — a 13-month window drops
  ~18 months incl. the peak. Estimated total ≈ 2,000–2,500 transactions (plan's "775/13mo" was the
  probe window, not the depth).
- **`/2.0/members` `total_count` = 1,366 is PEOPLE, not members** (owner-confirmed 2026-07-17).
  That endpoint returns every contact who ever signed up — guests, single-class drop-ins, expired
  members, leads, dormant credit-holders, plus the real members. **Actual recurring/paying members
  ≈ 22-23** (`primary_relationship = recurring_member`, derived — phase 2). The 1,366 maps to the
  `people` table; the ~23 is the member-count canary + the KPI that matters. NEVER surface the
  `/2.0/members` count as "members" — that is the founding-trauma conflation in one number.

### Branch — `GET /2.0/branches/{id}` [LIVE] ([samples/branch.get.json](samples/branch.get.json))

Includes `address.{timezone_id, timezone_name, currency, lat/long, …}` — seeds Kelo `locations`
(the studio-day timezone primitive) directly. Branch == location for single-location (§5).

### Events — `GET /2.0/branches/{id}/events` [LIVE] ([samples/events.get.limit2.json](samples/events.get.limit2.json))

`{_id, program_id, name, time_start (int), duration, size (capacity), booked, waiting,
trainers[], facility, private, status, close_booking_time, is_online}` — feeds sessions import
and the demand heatmap.

## 6. Webhooks [DOCS+SPEC]

- Configured per webhook to one or more target URLs; **HMAC-SHA256 `signature` header**
  (`Hex(HMAC-SHA256(secret, StringToSign))`); the secret comes **with your API credentials** —
  ask ABC/Glofox support for the studio's webhook secret (action item).
- Delivery: POST, **5-second response deadline**, up to **3 retries, at-least-once** — consumers
  must be idempotent on a stable event id (Kelo's webhook-inbox pattern already assumes this).
- Event schemas in the spec: `MemberEvent` (`MEMBER_CREATED`/`MEMBER_UPDATED`),
  `MembershipEvent`, `InvoiceEvent`, `EventEvent`, `EagreementEvent`, `ServiceEvent`,
  `AccessEvent` (barcodes only), `PushNotificationEvent`.
- **Member deletion is a soft delete** delivered as `MEMBER_UPDATED` with `active:false`; records
  can be reactivated — never purge on `active:false`. **This replaces snapshot-only deletion
  detection for members** (build-plan §4 rule 6 simplifies: webhooks + daily full sync, which is
  exactly the docs' own recommendation).

## 7. Import architecture implications (deltas confirmed for the build plan)

1. **Watermarks:** members support `utc_modified_start_date`; bookings support
   `modified_start_date` — true incremental sync exists for the two biggest entities. The
   transactions report is windowed-only (no cursor): import in small date windows.
2. **Webhooks + daily sync** is Glofox's own recommended pattern — matches Kelo's design;
   webhook secret acquisition is a phase-0/1 action item.
3. **Credits are per-user reads** — the credits import is O(members) requests; at 10 req/s with
   ~1,500 people that's ~3 minutes/full pass; run it as its own chunked job.
4. **Three envelope styles** — the shared `glofoxFetch()` client owns per-endpoint strategy
   (already the plan; now with the concrete style table in §2).
5. **The consent object** (`consent.{email,sms,push}`) imports as consent *evidence* — routes to
   the D2 decision with counsel.
6. **Write-back surface exists and is documented** (§4 list) — phase-4 mutation probes test
   *behavior* (idempotency, read-after-write, side-effect emails), not existence.
7. **Electronic Agreements endpoints** cover waiver templates/send/status — the pre-arrival
   "Waiver needed" queue (phase 4) can likely *send* Glofox agreements during coexistence rather
   than waiting for Kelo-native waivers; the agreements guide notes the flow has partial-support
   caveats ([guides/flow-agreements-waivers.md](guides/flow-agreements-waivers.md)).

## 8. Known traps — the §5 ledger, updated with live confirmations

| Trap | Status |
|---|---|
| `membership` is an object; no `membership_name` on person | **Confirmed [LIVE]** |
| Recurring = membership.type + `subscription_payment` evidence | **Confirmed [LIVE]** (full chain observed) |
| `created` unix seconds; no `registered_at`; may be migration date | **Confirmed [LIVE]** (field present; migration-date validation still phase 1) |
| Transactions report: 0 rows at HTTP 200 without `namespace` | **Reproduced [LIVE] 2026-07-17** |
| No clean transaction `type` field | **Confirmed [LIVE]** — and the vocabulary is bigger than §5 knew: + `book_class` |
| HTTP 200 + `success:false` on older endpoints | **Vendor-acknowledged [DOCS]** |
| POST-as-read endpoints | **Confirmed [SPEC]** (`/Analytics/report`, `/leads/filter`, `/v3.0/locations/retrieve`, `/v3.0/.../search-programs`) |
| String unix seconds | **Confirmed [LIVE]** — mixed int/string by endpoint generation |
| Inconsistent pagination | **Confirmed [LIVE]** — three styles (§2) |
| Everyone is a "lead" | **Confirmed [LIVE]** (`lead_status`/`leads` fields on every member) |

## 9. Remaining open items

1. **Webhook secret** — request from ABC/Glofox support with a Kelo receiving URL (phase 1).
2. **Channel markers** — full-history distinct-value scan of `bookings.origin` and
   `members.source`/`origin` (phase 1); owner is separately confirming whether ClassPass is even
   in use.
3. **`end_date` prevalence** — during the full credits import, measure how many live packs carry
   expiry; absent → `no_expiry` degraded rule.
4. **Write-behavior probes** — phase 4, per the build plan (sacrificial records, owner sign-off).
5. **Sandbox access** — the portal offers sandbox environments (3 req/s); request if useful for
   the write probes instead of sacrificial production records.

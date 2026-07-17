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
  transaction_group_id, amount_refunded, status, taxes, created, modified (string unix),
  metadata: { namespace, branch_id, glofox_event, stripe_subscription_id, user_id, user_name,
              membership_id, plan_code, payment_method, resource_id, environment,
              is_payment_link, balance, user_tax_id } }
```
- **`glofox_event` vocabulary [LIVE, 30d]:** `subscription_payment` (16), `invoice_payment`
  (10), and **`book_class` (30) — a third value §5 didn't document** (drop-in/booking payments).
  The transaction classifier must handle all three + quarantine unknowns.
- **`payment_method` values [LIVE]:** `credit_card`, `card`, `complimentary`, `cash`.
- Recurring-member evidence chain confirmed end-to-end: `glofox_event=subscription_payment` +
  `stripe_subscription_id` + `plan_code` → catalog join [LIVE].
- Stripe underneath is confirmed (`StripeCharge`, `stripe_subscription_id`) — but **account
  access is Glofox-gated per the owner**, so the build plan's negative branch applies: no direct
  Stripe API ingest pre-cutover; this report is the payments source until phase 5.

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

# Critique of the four Kelo build plans

## Per-plan assessment

### Plan A

#### Strongest ideas worth stealing

1. **Clear raw → mapping → canonical separation.** The `glofox_raw_*`, external-ID mapping, and Kelo-native layers make import transformations replayable without allowing Glofox’s schema to become Kelo’s schema.
2. **Import health gates AI output.** Pausing briefings and KPIs when reconciliation fails is exactly the right response to §5’s fabricated/stale-data failure. A stale warning is better than confident fiction.
3. **Concrete observability around imports.** `import_runs`, watermarks, reconciliation checks, health alerts, visible freshness, zero-row alarms, and a single scheduler with locks directly address most of §5.
4. **Opinionated answers to every open question.** Plan A recommends a full reset, validates `created` against first activity, chooses Twilio/Resend, keeps Anthropic with de-identification, and selects hourly transition freshness.
5. **Reasonably legible strangler sequence.** The plan preserves the required order—intelligence, non-transactional operations, booking/payments, member beta, cutover—and gives each phase an exit gate.

#### Weakest points

1. **Its distributed transaction claims are technically false.** A Postgres RPC cannot atomically create a Stripe PaymentIntent, commit a booking, and guarantee that “partial failures are impossible.” Postgres and Stripe do not share an ACID transaction. The design needs durable commands/outbox records, pending states, webhook inbox processing, reconciliation, and compensation—not claims of atomicity across providers.
2. **The RLS design is unsafe or at least incomplete for Supabase.** Using `current_setting('app.current_tenant')` assumes the application can safely set request-local session state through Supabase’s pooled connections. It also does not explain how a browser using Supabase directly is prevented from selecting another tenant. A membership-based `auth.uid()` policy or verified JWT claim lifecycle is required.
3. **The booking engine does not actually prevent overlapping room allocations.** Locking one `session` row prevents over-capacity within that session, but two overlapping session rows can still reserve the same sauna room. Plan A needs a resource-time range exclusion constraint or equivalent allocation lock.
4. **The cutover tolerances are too loose for money and credits.** A 1% weekly billing variance is not a money-correctness bar; it could hide substantial unexplained revenue. Reconciliation should be exact by Stripe/provider ID and currency, with every discrepancy explained.
5. **The rollback promise is not credible.** “Read-only sync remains possible” is not a rollback plan after Kelo has created bookings, charged cards, changed subscriptions, and consumed credits. External effects cannot be reversed by switching an authority flag.

#### Contradictions or ignored mandates

- Plan A calls the product “v1 shippable” after Phase 1, even though the brief explicitly says v1 includes marketing execution, billing actions, inventory/compliance, booking, payments, staff operations, and retail—not merely intelligence.
- Staff pay configuration is modeled, but there is no concrete payroll/commission calculation and approval flow. That is weaker than the brief’s v1 table-stakes requirement.
- Transactional communication is not made durable with a transactional outbox. The brief requires billing actions and transactional emails to be atomic and idempotent in the practical distributed-systems sense.
- The plan mostly respects §5’s verified Glofox facts, but “generate Zod schemas from captured samples” is too casual: a single sample does not reveal optional fields, variants, nullability, or pagination edge cases.

---

### Plan B

#### Strongest ideas worth stealing

1. **Excellent scheduler/job design.** One Netlify scheduler tick plus a Postgres queue, leases, `FOR UPDATE SKIP LOCKED`, idempotency keys, and an external dead-man’s switch is the best operational design in the set.
2. **Freshness is structural, not a UI convention.** Returning `{ as_of, source, stale }` in every response envelope makes it much harder for a future screen to omit provenance—the exact failure in §5.
3. **Probe-and-pin turns verified facts into executable constraints.** Requiring the namespace at the type level, treating `success !== true` as failure, diffing live shapes weekly, and testing mappings against redacted captures are strong measures.
4. **Good identity modeling nuance.** Plan B correctly challenges email as an absolute uniqueness invariant, allows email-less walk-ins and shared addresses, and adds merge tooling while preserving tenant boundaries.
5. **It identifies Stripe/card portability as a cutover risk.** Verifying whether the current Stripe account is studio-owned or Glofox-platform-owned, and starting portability work early, is a major practical improvement over Plans A and D.

#### Weakest points

1. **It quietly omits large pieces of the mandated broad v1.** There is no credible phase for staff scheduling, commission/pay calculations, inventory movement, stock counts, or a complete compliance/retail operational slice. These are not optional according to the brief.
2. **The tenancy policy relies too heavily on JWT claims.** A tenant claim injected at login becomes stale when roles or org membership change and is awkward for users belonging to multiple tenants. The plan needs explicit claim refresh/revocation semantics or RLS membership checks.
3. **Refund orchestration remains hand-wavy.** Saying an RPC “wraps Stripe refund + ledger entry + comms log” obscures the same cross-system atomicity problem Plan A mishandles. The refund should first persist an idempotent command, then call Stripe, await webhook/retrieval confirmation, post reversals, and fulfill the communication obligation.
4. **The proposed `/ask` SQL-tool access is riskier than the rest of the PII policy.** A read-only role prevents mutation, not over-broad access, data exfiltration, expensive queries, or cross-domain disclosure. Plan C’s approved aggregate/query-result approach is safer.
5. **POS is underspecified and partially deferred.** “Manual entry or payment link/QR” is not a satisfactory card-present POS plan, and deferring Stripe Terminal weakens the brief’s native POS requirement.

#### Contradictions or ignored mandates

- Plan B explicitly declines retail inventory management even though §6 says inventory/compliance ship with v1.
- It reframes payroll as reporting, which is defensible, but then does not give that reporting/commission workflow a clear data model or build phase.
- Its relationship rule counts `past_due` subscriptions as recurring members without defining the grace/dunning policy. The brief says only active recurring subscribers count; whether `past_due` qualifies must be explicit and tested.
- The `pack_holder` rule—positive balance **or a pack purchase within N days**—can classify someone with no remaining credits as a current pack-holder. That weakens the brief’s conversion and credit-liability semantics.
- Plan B handles nearly all of §5’s Glofox facts correctly; its main violations are scope rather than source-fact errors.

---

### Plan C

#### Strongest ideas worth stealing

1. **It is the only plan that models payment atomicity honestly.** Plan C explicitly rejects literal cross-provider ACID and substitutes the correct pattern: local atomicity, holds, idempotent Stripe commands, outbox/inbox records, pending states, webhook confirmation, reconciliation, and deterministic compensation.
2. **The data model is substantially more mature.** It separates products, prices, offers, contracts, entitlements, subscriptions, credit grants, gift-card ledgers, payments, refunds, journal entries, communication attempts, consent, waiver versions, and resource allocations instead of collapsing unrelated concepts.
3. **The migration design handles dual-system danger properly.** The authority registry, no indefinite dual-master rule, partitioned booking pilot, one billing authority per subscription, and verified Stripe account/Connect topology directly address the most dangerous cutover failures.
4. **Its cutover bar is the most credible.** Exact provider-ID reconciliation, two billing cycles, controlled live tests, performance requirements, communication verification, owner sign-off, concurrency tests, and rehearsed rollback are materially stronger than percentage-only parity.
5. **It covers neglected domain realities.** DST recurrence, earliest-expiring credit consumption, gift-card legal differences, waiver version evidence, consent rechecking, delivery suppression, campaign recipient snapshots, disputes, and accounting policy are all important.

#### Weakest points

1. **It risks becoming the speculative schema the brief warns against.** Plan C says tables should be introduced incrementally, but then specifies a very large normalized estate—custom RBAC, double-entry journals, authority registries, extensive workforce tables, inventory accounting, operation records, and many history tables. For an owner-plus-agents team, this is a major cognitive burden.
2. **The first differentiated value arrives too late.** Its read-only intelligence slice appears after roughly 18–27 builder-weeks. A narrower verified transaction/person/booking vertical slice could prove the morning briefing much earlier without compromising correctness.
3. **The API surface is too close to an exhaustive product backlog.** Some families are listed only as “waiver endpoints,” “staff endpoints,” etc., while dozens of less important endpoints are named individually. This is broad but not always prioritised enough to guide implementation.
4. **Tenant selection is inconsistent.** Some routes include `/orgs/{orgId}`, others omit the tenant entirely. The plan says every request scopes to one tenant, but it does not define one consistent anti-confused-deputy contract when the path tenant, selected tenant, and JWT memberships differ.
5. **Additional-tenant hardening is placed too late.** Phase 8 includes location roll-ups, onboarding internals, and support tooling after the first cutover. Core tenancy and RLS are present from day one, but multi-location roll-up is itself a v1 table-stakes requirement and should not be deferred that far.

#### Contradictions or ignored mandates

- Plan C does not contradict the verified Glofox facts; it handles them more comprehensively than the other plans.
- It respects Supabase, Netlify, Stripe, multi-tenancy, one scheduler, booking/payments last, and member beta before cutover.
- The main mandate risk is phasing: multi-location roll-up and some additional-tenant operational tooling appear after the nominal cutover despite the broad v1 requirement.
- Its enormous scope is not formally forbidden—timeline is unconstrained—but it conflicts with §6’s low-operational-surface and agent-maintainability goals unless aggressively introduced as small vertical slices.

---

### Plan D

#### Strongest ideas worth stealing

1. **The framework choice is well argued.** Vite + React + Hono is a reasonable low-complexity choice for an authenticated operator app, and the rejection of unnecessary SSR/App Router complexity is specific rather than fashionable.
2. **It directly codifies the known Glofox traps.** Namespace-required transaction requests, `success:false` handling, endpoint-specific pagination, nested memberships, subscription-payment evidence, no fixture fallback, and gold-label relationship tests are all good.
3. **Authority flags make transition state legible.** Explicit domain ownership prevents a generic “last write wins” sync and gives operators a visible model of which system owns people, scheduling, bookings, and payments.
4. **The plan is disciplined about deleting or avoiding speculative features.** Its standing agent-maintainability rules—one client, one watermark policy, one scheduler, real-shaped data, no demo imports—are useful.
5. **The phase gates produce early value.** Relative to Plan C, Plan D gets import, the briefing, segments, outreach, and credit liability in front of the owner quickly.

#### Weakest points

1. **The booking model can double-book a physical room.** Locking `session_instances` only protects capacity inside one session. Nothing prevents two overlapping session instances from assigning the same sauna resource. A resource-range exclusion constraint is mandatory.
2. **The import is not replayable enough.** It pins development captures but does not preserve immutable raw production pages for every import run. Directly validating and upserting into canonical tables makes mapping bugs harder to repair or audit.
3. **The job architecture is fragile under serverless limits.** One scheduled function loops through every tenant and entity with advisory locks, but there is no durable queue, leases, chunking, heartbeat, or dead-letter state. It can time out midway and cannot detect total scheduler death from inside the same scheduler.
4. **Payment orchestration is underdesigned.** The plan lacks a proper durable Stripe command outbox and provider-event uniqueness. `payment_events` tied only to a payment is not enough to handle duplicate, delayed, reordered, or initially unmatched webhooks.
5. **The relationship derivation is too loose.** “Historical credit-pack purchase” can make someone a pack-holder forever, and adding `former_member` changes the brief’s primary taxonomy without explaining how former members participate in guest, lead, or conversion reporting.

#### Contradictions or ignored mandates

- **The phase order directly contradicts the brief.** Plan D retires Glofox operationally in P7 and builds the beta member booking surface in P8. The confirmed sequence requires the member beta **before** cutover; otherwise members have no Kelo booking path when Glofox is retired. Its earlier stage table says the opposite, so the plan is internally inconsistent too.
- Plan D does not actually take ownership of scheduling before booking/payments. It creates templates/resources while sessions remain Glofox-owned, then effectively introduces scheduling with the booking engine. That ignores the owner-confirmed strangler order.
- The proposed “flip authority back within 15 minutes” is not a real payment or booking rollback. Stripe charges, subscription changes, credit consumption, and member confirmations cannot be undone by changing JSON flags.
- Its reconciliation tolerance allows discrepancies in active members and credit balances. Those are discrete liabilities and entitlements; unexplained differences should be zero.
- “Empty UI shells” in Stage 0 conflicts with §5’s explicit prohibition on speculative screens.
- Staff scheduling, commission/pay reporting, consent/suppression, inventory operation, and complete communications delivery handling are materially incomplete relative to the broad v1 mandate.

---

## Comparative judgment

| Section | Strongest plan | Judgment |
|---|---|---|
| **Architecture** | **Plan C**, narrowly over B | C combines a modular monolith, stable API boundary, membership-based RLS, explicit authority states, durable jobs, restricted service-role use, and an unusually strong AI/PII boundary. B’s scheduler and dead-man switch are better individual ideas, but C is more complete. |
| **Data model** | **Plan C** | C best separates products from entitlements, credits from gift cards, orders from payments, and bookings from resource allocations. It also handles effective-dated relationships, consent, communication attempts, waiver versions, workforce, and financial provenance. |
| **API** | **Plan C** | C has the strongest mutation conventions: idempotency keys, optimistic concurrency, operation IDs, quote/hold semantics, webhook persistence, and freshness metadata. Its route scoping needs cleanup, but the contracts are still the most rigorous. |
| **Import/migration** | **Plan C** | C most completely converts §5 into implementation rules and adds deletion detection, quarantine, authority management, partitioned inventory pilots, subscription-by-subscription billing authority, and exact reconciliation. B is a close second because of live shape-drift detection. |
| **Booking/payments** | **Plan C** | C is the only plan that fully acknowledges the impossibility of ACID across Postgres, Stripe, and email, then designs correct sagas around that fact. Its hold expiry, late-payment compensation, journals, webhook replay, and reconciliation are substantially safer. |
| **Phasing** | **Plan C** | C is slow and overbuilt, but it is the only phase plan that credibly includes nearly all of the deliberately broad v1 scope and gives each area a verification gate. A and D are faster largely because they understate distributed-systems and operational work; B omits required operations. |
| **Risks** | **Plan C** | C covers the broadest real failure set: source drift, fixtures, watermarking, Stripe ownership, double billing, dual inventory, comms consent, AI leakage, DST, liability, tenancy, performance, and documentation drift. |
| **Not-build list** | **Plan C** | C draws the cleanest boundary between required table stakes and genuinely unnecessary scope. In particular, it excludes payroll custody, full accounting, native apps, autonomous AI, microservices, and generic dual-master sync without cutting mandated retail/compliance functionality. |

**Overall:** **C is strongest**, B is the best source of operational-simplicity ideas, A is directionally sound but technically overclaims payment atomicity, and D is the weakest because its cutover order is internally contradictory and its booking/payment foundations are not safe enough.

---

## What EVERY plan missed

These are gaps across **A–D**, even where one plan noticed part of the issue.

### 1. No plan chooses the multi-tenant Stripe funds architecture

All four say “Stripe,” but none decides the crucial SaaS question:

- Does each studio use its own Stripe account?
- Is Kelo a Stripe Connect platform using Standard, Express, or Custom accounts?
- Who is merchant of record?
- Who owns refunds, disputes, negative balances, tax reporting, payouts, and chargeback evidence?
- Are customer/payment-method IDs scoped to a connected account?
- How are webhook account context and idempotency keys scoped?

Plan C investigates the existing Glofox Connect topology, and Plan D mentions a future connected account, but neither chooses Kelo’s destination model. This decision affects nearly every payment key and uniqueness constraint and cannot safely be postponed.

### 2. Write-back is planned against another unverified API assumption

Every plan promises tested Glofox write-back, but none makes **write capability discovery** a first-phase gate comparable to the read-payload probe.

Before planning schedule or profile write-back, Kelo needs to verify:

- which write endpoints actually exist;
- whether there is a sandbox/test tenant;
- write idempotency and duplicate behavior;
- read-after-write delay;
- rate limits;
- partial-failure semantics;
- whether writes trigger Glofox emails, billing, or other side effects;
- whether Glofox contractually permits the integration.

Given §5’s meta-lesson, “we will build a write-back adapter later” is not enough.

### 3. Member account claiming and household identity are absent

The beta member surface needs a secure way for an imported `person` to become an authenticated member account. None of A–D specifies:

- claim-by-email/phone verification;
- what happens with shared family emails;
- email-less aggregator or walk-in records;
- duplicate claims and account takeover recovery;
- guardians booking for dependants;
- one login managing multiple participants;
- whether one person can belong to multiple studios.

This is not merely an auth detail; it determines whether the imported CRM identity and the future member login remain the same person.

### 4. “Native POS” is reduced to Stripe card charging

No plan defines a complete front-desk POS operating model. Missing across A–D:

- cash and other non-card tenders;
- split tender;
- tips;
- discounts and manager overrides;
- taxes by product/location;
- receipts and reprints;
- opening/closing a till and end-of-day reconciliation;
- exchanges, voids, and partial retail returns;
- offline or terminal-failure procedures.

Plan C includes Stripe Terminal and tax configuration, but even it does not cover the front-desk cash/till workflow. A payment link is not a complete POS.

### 5. Minor/guardian policy is missing from booking and waivers

Recovery services may prohibit minors or require guardian consent. None of the plans defines:

- tenant-configured minimum ages by offering;
- guardian identity and relationship;
- guardian signature evidence;
- whether the guardian must attend;
- age validation during booking;
- what happens when imported records lack date of birth.

This matters precisely because the product refuses to store medical information: eligibility needs to be policy-driven without drifting into medical intake.

### 6. The outreach loop measures delivery, not business impact

A–D log sends, opens, clicks, or replies, but none gives a credible attribution design for the promised **segment → send → measure** loop:

- conversion windows;
- booking/revenue attribution;
- holdout groups;
- overlapping campaign credit;
- unsubscribes and complaints as negative outcomes;
- pack-holder-to-member conversion;
- incremental revenue versus activity that would have happened anyway.

Without this, the AI can produce attractive messages but cannot demonstrate that its recommendations improved retention or revenue.

### 7. There is no complete data-retention and deletion policy

Plan C discusses provider retention and later export/deletion tooling, but none of A–D defines an end-to-end retention matrix for:

- raw Glofox payloads;
- AI prompts and outputs;
- communication content and events;
- Stripe webhook payloads;
- waiver evidence;
- financial journals;
- deleted/merged people;
- backups and cold archives.

The plan must distinguish data that can be erased, data that must be pseudonymized, and records that must be retained for financial, dispute, consent, or waiver evidence.

### 8. The competitive onboarding/support requirements are not turned into build work

The brief explicitly says productive on day one, self-onboarding, fast human support, and migration help are competitive requirements. None of the plans provides a real acceptance design for:

- tenant setup checklist;
- guided plan/resource/location configuration;
- import review and exception resolution;
- launch readiness checks;
- operator training;
- in-product help and support escalation;
- support audit context that avoids asking the owner to reproduce failures.

Plan C defers some onboarding documentation to a later hardening phase, but documentation alone does not satisfy the requirement.

### 9. Multi-location roll-up semantics remain vague

All plans put `location_id` on records, but none fully defines:

- whether memberships and packs are tenant-wide or location-restricted;
- revenue attribution when a membership is sold at one location and redeemed at another;
- location-local versus tenant-level reporting days and timezones;
- staff working across locations;
- inventory transfers;
- shared customers and duplicate prevention across locations;
- liability and utilization roll-ups.

This is more than adding a foreign key. The brief requires multi-location roll-up as v1 table stakes, and the accounting and entitlement rules need to be explicit before the second location exists.

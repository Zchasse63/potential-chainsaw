## Per-plan assessment (A, B, C, D)

### Plan A

**Strongest ideas**
1. **Raw → map → native table layering.** Keeping `glofox_raw_<entity>`, `glofox_<entity>_map`, and native tables makes every imported field traceable and re-transformable — exactly the antidote to §5’s “guessed payload shape” failure.
2. **Import watermark rules are written as policy, not hope.** “Never advance on zero for an always-active entity” and `expected_min_records` directly encode §5 mandates 2 and 4.
3. **Gating AI on import health.** Refusing to generate a briefing when reconciliation is red is the single most important meta-lesson from §5, and A is the only plan that makes it explicit.
4. **Money mutations via Postgres RPC + idempotency keys.** Putting capacity/credit/debit inside a DB function is the right primitive for atomic booking.
5. **Ruthless not-build list.** A explicitly defers mobile apps, self-serve SaaS billing, real-time transition sync, and autonomous AI sends.

**Weakest points**
1. **Next.js App Router is the wrong default for this team.** A admits the operator surface is auth-gated and data-dense, yet still picks the framework with the most server/client footguns for an owner-plus-agents crew. B and D’s SPA argument is stronger.
2. **No external dead-man heartbeat.** A relies on `scheduled_job_locks` and `import_runs`, but if Netlify’s scheduler itself dies, nothing pages the owner.
3. **`liability_cents` on `people` is a mutable cache, not a ledger-derived value.** This directly contradicts A’s own claim that credit balance is the sum of ledger rows; a cached liability column will drift.
4. **No Stripe account-ownership / PAN-portability investigation.** A treats the Stripe continuation as a simple API switch, ignoring the real risk that Glofox may own the Stripe account or card tokens.
5. **Relationship derivation ignores the §5 membership object nuance.** A defines `recurring_member` as “active membership status,” not the required combination of `membership.type` plus a `subscription_payment` transaction.

**Contradictions / ignored mandates**
- §5 explicitly says recurring members are identified by `membership.type` **and** `subscription_payment` metadata; A’s rule omits the payment evidence.
- §5 mandate 7 is “one scheduler” — A satisfies it structurally, but without an external heartbeat the mandate is only half-addressed.
- The brief’s verified fact that payments already run through Stripe is noted, but A never verifies whether the existing Stripe objects are studio-controllable.

---

### Plan B

**Strongest ideas**
1. **The two-zone raw/native model is the cleanest transition architecture.** Append-only `glofox_raw` plus pure versioned mappers means a mapping bug is fixed by re-transforming, not re-fetching or fabricating.
2. **Probe-and-pin harness with weekly live-shape diff.** Capturing redacted payloads, tying Zod schemas to sample files, and diffing live shape weekly makes §5’s “verify the source payload first” into infrastructure instead of a checklist item.
3. **Scheduler enforced by the database, not by convention.** A single dumb Netlify tick plus a Postgres `jobs` queue using `FOR UPDATE SKIP LOCKED` makes double-runs structurally impossible; the external dead-man heartbeat covers total scheduler death.
4. **Postgres exclusion constraints for room double-booking.** This is §5 mandate 6 made structural, not application-code wishful thinking.
5. **SPA for operators, SSR for the member surface.** This is the only plan that reasons correctly about which surface needs which rendering model.

**Weakest points**
1. **Turborepo + multi-package monorepo is too much surface for an owner-plus-agents team.** The discipline is admirable, but every extra package boundary is a place for agents to generate drift.
2. **No capability-level authority registry.** B uses `source` columns and sync state, but lacks an explicit `authority` flag per domain; during the strangler fig it is harder to see which system owns what.
3. **No financial journal or outbox.** `verify_money` compares Kelo to Stripe, but there is no balanced double-entry ledger to catch internal inconsistencies (e.g., a credit-ledger entry without a corresponding order line).
4. **Relationship history is append-only but not effective-dated concurrent.** A person cannot simultaneously be a recurring member with residual pack credits in B’s model; the precedence rule flattens reality.
5. **No A2P 10DLC lead-time mitigation until Phase 0 is mentioned only in risks.** SMS outreach could be blocked for weeks; B mentions it but buries it.

**Contradictions / ignored mandates**
- B openly disagrees with the brief’s “v1 is broad by decision” framing, resolving it as a phased program. That disagreement is flagged, but the practical effect is that several table-stakes items (e.g., full payroll execution) are deferred despite the brief listing them as v1 requirements.
- §4 says people are “deduplicated by email”; B replaces the constraint with a merge process. B flags this as a disagreement, which is acceptable, but it means the data model no longer enforces the brief’s stated invariant.

---

### Plan C

**Strongest ideas**
1. **Authority registry and explicit authority states.** `GLOFOX_AUTHORITATIVE`, `KELO_AUTHORITATIVE_WITH_WRITEBACK`, `KELO_ONLY`, `RETIRED` is the most precise model for the strangler fig.
2. **Candidate/committed watermarks and transactional outbox.** This is the most rigorous answer to §5’s “never advance on empty/failed pull” and to money-correctness across Stripe/Postgres boundaries.
3. **Effective-dated person relationships.** C is the only plan that lets a person have overlapping relationship realities (e.g., recurring member with residual pack credits) and proves them historically.
4. **Balanced journal + financial reconciliation.** C is the only plan that treats deferred-revenue liability, gift-card liability, and refunds with real accounting structure.
5. **DST/timezone handling and cohort-anchor validation.** C is the only plan that treats `created`-as-signup-date as a real data-quality problem with a validation protocol.

**Weakest points**
1. **It directly repeats the speculative-schema failure mode from §5.** C lists ~70+ tables including `inventory_locations`, `pay_runs`, `commission_rules`, `automation_steps`, `rate_limit_buckets`, etc., long before any feature writes to them. Mandate 8 says “don’t ship speculative schema.”
2. **The timeline is not credible for the stated team.** 77–116 builder-weeks is 1.5–2+ years of owner-plus-agents work, contradicting the brief’s emphasis on early value and agent-maintainability.
3. **MFA for owners/admins is unasked friction.** The brief never requests MFA; adding it to a solo-operator product is operational theater.
4. **OpenAPI-first + generated clients is heavy for an agent team.** The contract discipline is good, but maintaining generated artifacts across many speculative endpoints is exactly the kind of “docs drift” the brief warns about.
5. **No SPA/SSR performance reasoning.** C does not choose a rendering strategy, leaving a default that will likely become Next.js by inertia.

**Contradictions / ignored mandates**
- C explicitly rejects “deduplicated by email” and replaces it with a merge process — flagged, but still a contradiction of §4.
- C redefines “payroll” as calculation/export rather than money movement, directly contradicting the brief’s category table-stakes list, even though it flags the disagreement.
- C requires MFA and enterprise AI provider agreements that the brief does not mandate and that add friction for a single-studio owner.
- Despite the brief’s “no speculative schema/screens” mandate, C’s data model is the most speculative of the four.

---

### Plan D

**Strongest ideas**
1. **Simplest, most agent-maintainable stack.** Vite + React SPA + Hono functions is the lowest-cognitive-load choice and D argues it convincingly against Next.js App Router.
2. **Authority flags per domain on the tenant row.** `authority.people | bookings | payments | marketing | schedule = 'glofox' | 'kelo'` is a clean, visible strangler-fig mechanism.
3. **Captured fixtures + gold-label tests for relationship derivation.** D turns §5’s “test against real-shaped data” into a concrete workflow.
4. **Advisory-lock scheduler and `job_runs`.** Simple, correct, and easy for agents to reason about.
5. **“No Glofox write-back for booking/payments.”** D correctly recognizes that the destination is Kelo ownership, not eternal two-way sync.

**Weakest points**
1. **No immutable raw landing zone in the database.** D relies on captured fixtures in the repo; if the Glofox API changes or a mapping bug is found later, there is no append-only raw record to re-transform.
2. **Denormalized `credits_remaining` on `credit_packs` contradicts the ledger-as-source-of-truth claim.** D says the ledger is the SoR but also stores a mutable remaining column, reintroducing drift risk.
3. **No external dead-man heartbeat for scheduler death.**
4. **Native payments before native booking.** Building subscriptions, packs, and dunning before the booking engine that consumes credits means key integration tests are delayed.
5. **No Stripe account-ownership / PAN-portability investigation, no A2P 10DLC lead-time planning, and no DST/timezone handling.**

**Contradictions / ignored mandates**
- D enforces `unique(tenant_id, email)` without a merge process, following the brief literally but ignoring the real-world case of shared family emails and email-less walk-ins that B and C flag.
- D’s `credit_packs.credits_remaining` column violates its own ledger-SoR invariant and the brief’s money-correctness requirement.
- D says write-back is optional for profile fields; the brief expects tested write-back for non-transactional layers, so D is too cavalier about CRM/schedule write-back.

---

## Comparative judgment

| Section | Strongest plan | Why |
|---|---|---|
| **Architecture** | **B** | B’s two-zone raw/native model, DB-enforced single scheduler, external dead-man heartbeat, and SPA/SSR split operationalize §5 better than the others. |
| **Data model** | **B** | B makes relationships append-only (powering conversion analytics), prevents double-booking with exclusion constraints, and keeps credit/money ledgers append-only without C’s speculative journal bloat. |
| **API surface** | **B** | B’s Hono typed client, freshness envelope in every response, and person-scoped endpoints for the future member app are lean and correct; C is more complete on paper but over-specifies speculative endpoints. |
| **Import / migration** | **B** | B’s probe-and-pin harness, weekly live-shape diff, raw-zone re-transformability, and reconciliation-as-cutover-meter are the most complete answer to §5. |
| **Booking / payments** | **B** | B uses Stripe Billing for recurrence, Postgres RPCs + exclusion constraints for booking, webhook-sourced truth, and a `verify_money` job — the best balance of correctness and buildability. |
| **Phasing** | **A** | A’s 20–26 week timeline and “v1 shippable after Phase 1” sequencing deliver owner value fastest while still putting booking/payments last. |
| **Risks** | **C** | C’s risk list is the most exhaustive and domain-aware, covering shape drift, money bugs, card portability, A2P 10DLC, RLS, AI PII, timezone bugs, and payroll scope creep. |
| **Not-build list** | **C** | C most clearly excludes speculative schema, microservices, data warehouses, native apps, generic dual-master sync, and legally opinionated breakage rules. |

---

## What EVERY plan missed

1. **Backup, point-in-time recovery, and restore validation as a first-class deliverable.**  
   All four talk about rollback, but none specify Supabase PITR, backup frequency, offsite snapshots, or a *tested* restore drill before cutover. For a money system of record, “we have backups” is not a plan; a documented, rehearsed RPO/RTO is.

2. **Using Stripe as a parallel source of truth during the Glofox-sovereign transition.**  
   The brief states the studio’s payments *already* run through Stripe under Glofox. None of the plans propose ingesting Stripe charges, invoices, `subscription` objects, or `invoice.payment_failed` events now to cross-check Glofox-derived MRR and surface failed-card focus-queue items before Kelo owns billing. That is a free correctness layer that all four leave on the table.

3. **Offline resilience for front-desk check-in and POS.**  
   Every plan assumes the studio Wi-Fi is always on. A router outage should not stop check-ins or retail sales. None mention a local queue, offline-capable check-in screen, or retry-sync strategy — a real operational risk in a physical studio.

4. **Business-level anomaly detection beyond import health.**  
   Import health is necessary but not sufficient. None alert on a revenue flatline, a sudden booking drop, a no-show spike, or a credit-liability jump. The product promises “trustworthy numbers” and a daily action list; silent business anomalies undermine both.

5. **AI-provider failure / degradation fallback.**  
   Plans gate AI on import health, but none say what happens if Claude is down, slow, or returns malformed structured output. The home screen cannot go blank. A deterministic fallback — yesterday’s cached briefing plus a manual refresh button, or a “metrics-only” mode — is missing everywhere.

6. **Cutover as a customer-change event, not just a deployment.**  
   None detail how members will be told about the new booking widget, whether they must re-enter cards, how schedule URLs redirect, or how to execute the authority flip without a hard freeze window. Retiring Glofox is a member-facing migration, not an internal release.

7. **Data retention, deletion, and export for PII / GDPR / CCPA.**  
   As multi-tenant SaaS, Kelo needs tenant data export, user deletion workflows, and retention policies. The brief says standard PII handling applies; all four stop at “don’t send health data to Claude” and skip the operational half of PII compliance.

8. **A Glofox-connected staging / acceptance tenant with sanitized production data.**  
   All four rely on captured fixtures and unit tests, but none describe a persistent staging environment where the owner can validate the morning briefing, booking flow, and cutover rehearsal against real-shaped data before touching production. Unit tests are not owner acceptance.

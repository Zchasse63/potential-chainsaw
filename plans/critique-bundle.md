You are reviewing four independent build plans produced by four different frontier AI models from the SAME planning brief (included first below). The plans are anonymized as Plan A, B, C, D in random order. You may have written one of them; you do not know which, so judge purely on merit.

Produce a critique document in markdown with these sections:

## Per-plan assessment (A, B, C, D)
For each plan: (1) its 3-5 strongest ideas — specific design decisions worth stealing; (2) its 3-5 weakest points — errors, hand-waving, violations of the brief's constraints (Supabase/Netlify/Stripe fixed; multi-tenant day one; §5 failure modes), or risky choices; (3) any place it contradicts the brief's verified facts (§5) or ignores a mandate.

## Comparative judgment
Which plan is strongest per section (architecture, data model, API, import/migration, booking/payments, phasing, risks, not-build list) and why — one or two sentences each.

## What EVERY plan missed
The most valuable section: risks, design considerations, domain realities, or verification steps that none of the four plans addressed. Think hard here.

Be blunt and specific. Cite plan letters. Do not rewrite the plans; critique them.

=====================
# THE ORIGINAL BRIEF
=====================

# Planning Brief — Kelo

> **Kelo in one line:** a **full, owned studio-operations platform** for boutique
> recovery/wellness studios (sauna + cold plunge) — booking, payments, memberships, marketing,
> compliance, retail — **with an AI intelligence layer built in**, designed to replace the
> incumbent booking system the studio runs on today.
>
> **This document is self-contained and forward-looking.** It is not a description of a prior
> codebase — there is a discarded prototype, and it is deliberately not described here beyond the
> hard-won domain knowledge in §5, which cost real money to acquire and which any fresh build will
> need. Design the best system for the problem, not a better version of what came before.
>
> **Evidence markers:** **[V]** verified directly against the live systems (production database or
> the live vendor API); **[I]** inferred; **[W]** from market/competitor research (2026-07 — treat
> specific vendor claims as approximate). No secrets, keys, or customer data appear anywhere.

---

## Your task (read this first)

You are one member of an independent planning council. Other frontier models are receiving this
identical brief independently; your plan will be compared against theirs.

**Produce a build plan with exactly these sections:**

1. **Architecture overview** — stack and service boundaries, within the fixed constraints (§6).
   How Kelo-native data coexists with the transitional import from the incumbent system.
2. **Data model** — entities and relationships. Must include (a) **explicit person-relationship
   typing** (recurring member vs. pack-holder vs. aggregator vs. guest vs. lead — §4), and
   (b) **multi-tenancy from day one**.
3. **API surface** — the main contracts and how clients consume them.
4. **Import + migration strategy** — how to make the incumbent-system import **correct and
   observable**, designing directly against the verified facts and failure modes in §5; and how to
   sequence the strangler-fig takeover (§4), including the cutover-readiness bar.
5. **Native booking + payment engine** — room/slot appointment booking, credit packs, recurring
   subscriptions, card billing, and money-correctness (atomic, idempotent, verifiable).
6. **Build phases in order, with rough effort** for each.
7. **Key risks and mitigations** — especially designing against §5.
8. **What you would explicitly NOT build in v1**, and why.

**Rules for your plan:** ground every recommendation in the constraints (§6) and §5 — the domain
facts and prior failure modes are the whole reason this is being rebuilt. Be concrete and
opinionated; prefer specific choices over surveys of options. Where you **disagree with an
assumption in this brief, say so explicitly and explain why** — that disagreement is valuable.
Where the brief leaves something open (§8), make a recommendation rather than deferring.

---

## 1. Product essence

Kelo is a **studio-operations platform that a studio owner owns outright**, purpose-built for the
boutique **recovery/wellness** niche (sauna + cold plunge) that incumbents serve awkwardly. It is a
complete system — class/appointment scheduling and booking, memberships and credit packs, payments
and billing, check-in, staff and payroll, marketing, compliance (waivers), retail — **plus a genuine
AI intelligence layer** (a daily operator briefing, behavioral customer segments with brand-voiced
outreach, and recovery-specific liability/utilization insight) that no incumbent ships. The AI layer
is the wedge and the differentiator; the full platform is the destination.

**The problem has two halves.** *Operational:* a studio owner's data is trapped in a booking tool
built for transactions, not decisions — they can see a schedule and a payment log but can't easily
answer *which class to promote, which failed payment to chase, which lapsing customer to call and
what to say, whether the week is up or down.* Kelo turns that into a daily briefing, ready-to-send
outreach, and legible analytics. *Strategic:* the owner does not want to **rent** their core
operating system from a vendor whose workflows they can't change and whose roadmap they don't
control. Kelo is built to be **owned** — so the studio (and later, the studios that buy Kelo) get
workflows tuned to how recovery studios actually run, not how a general-purpose gym tool was
architected. **[V, per owner]**

**Trajectory.** Today the studio runs on **Glofox** (the incumbent booking platform). Kelo currently
imports Glofox data **read-only** — a deliberate, temporary safety measure while Kelo is proven, not
the end state. The roadmap graduates Kelo from *read-only import* → *tested write-back* → *system of
record* → *Glofox retired*. Kelo ultimately does everything Glofox does, owned by the studio, and is
then sold to **other studios as multi-tenant SaaS.** *A guiding principle from the owner:* **do not
let Glofox's design constrain Kelo's.** Kelo needs Glofox's data; the entire point of building it is
the freedom to design better workflows than Glofox offers. **[V, per owner]**

**Positioning [W]:** *a full studio-operations platform for recovery/wellness studios, with an AI
chief-of-staff built in — owned, not rented, and not limited by a legacy booking tool's workflows.*
Kelo competes head-on with the incumbents (Glofox, PushPress, Bsport, Mindbody, Mariana Tek,
Momence, Walla, and the recovery-aware newcomer Zipper) as a complete platform, and differentiates
on (a) the AI intelligence layer, (b) recovery-niche fit, and (c) the studio owning its own stack.

---

## 2. Objectives & success criteria

**Primary objectives**
1. **Own the system of record.** Kelo becomes the studio's operating system — natively managing
   bookings, memberships, payments, and check-in — and Glofox is retired.
2. **Trustworthy numbers.** Every on-screen figure is correct and current, or explicitly labeled
   stale/unavailable.
3. **A decision, not a dashboard.** The home screen surfaces the 2–3 highest-leverage actions for
   today, each with a one-click path to act.
4. **Outreach that ships.** Behavioral segments produce drafted, on-brand messages the owner
   approves and actually sends (email/SMS), logged per person.
5. **Reliable, observable data.** During transition the import is correct, incremental, and
   self-monitoring — it never silently freezes, and staleness is visible and alertable.
6. **Full-platform table-stakes** (below) — because Kelo replaces the incumbent, these are real v1
   requirements, not add-ons.
7. **Multi-tenant SaaS from day one** — tenant isolation, org onboarding, per-tenant configuration
   are ground-floor, so selling to more studios is a go-to-market step, not a re-architecture.

### Competitive quality bar [W]

*The category pattern: incumbents win on **ease, service, and member-facing polish** and lose on
**analytics depth, performance, and money/comms correctness** — which is precisely Kelo's thesis.
The owner named **PushPress** (excellent operations/tech) and **Bsport** (excellent customer
experience) as reference standards.*

1. **Ease + self-onboarding (match).** PushPress's most-cited strength: owners set it up themselves,
   staff learn it fast — *why it wins despite shallow analytics.* Floor: productive on day one, no
   implementation call. Doubly important for the multi-tenant future.
2. **Fast, human support + migration help (match).** Both references win their best reviews here;
   Bsport's angriest reviewers felt "abandoned after signing."
3. **Member-facing polish, on-brand and on-domain (match/beat).** Bsport's headline differentiator:
   a white-label member app + one-click booking that never redirects the member to a vendor portal,
   plus choose-your-spot and an auto-reallocating waitlist. Kelo eventually owns this surface.
4. **Speed as a correctness feature (beat).** Bsport's polish is undercut by its #1 complaint —
   laggy pages, with studios reporting lost revenue from slow loads. The most winnable
   differentiator: explicit latency budgets, load-tested.
5. **Boring correctness on money + comms (beat).** The most *damaging* complaints for both:
   payments failing in front of members, refunds "done manually," pause/cancel flows breaking,
   invoice emails never arriving. Kelo processes the payments — this is its own responsibility.

### Category table-stakes (v1 requirements) [W]

Class **and** appointment/session booking with room/resource reservation (sauna room, plunge slot);
membership plans with freeze/pause/cancel; flexible monetization where recurring **and** unlimited
**and** credit/session packs **and** drop-ins **and** intro offers coexist cleanly (recovery is
credit-heavy); native payments/POS + retail + gift cards; **automatic dunning / failed-card
recovery** + self-serve card update; CRM with profiles, visit history, lead pipeline; **email + SMS
lifecycle automation**; check-in/attendance; **per-session digital waivers**; staff scheduling +
roles/permissions + payroll/commission; a core-KPI reporting dashboard; **multi-location +
multi-tenant roll-up.**

### Differentiation — the moat [W]

Raw churn scores, missed-call text-back, and lead-reply bots are **commodity** across the category
(Glofox, Walla, Keepme, Momence, Mindbody, PushPress, GymIQ all ship them). Competing there loses.
The defensible ground:

1. **A synthesized daily operator briefing** — a narrative "here's what matters today across
   revenue, attendance, at-risk customers, schedule demand, and cash." **No incumbent ships this**;
   they ship charts and 2am alert lists. The flagship.
2. **Cross-system narrative reasoning** — connecting revenue/attendance/schedule/churn/cash into
   *why* and *what to do*, versus siloed reports.
3. **Behavioral segmentation with brand-voiced, AI-drafted, ready-to-send outreach per segment**,
   closing the loop (segment → draft → send → measure → automate).
4. **Recovery-tuned intelligence — the clearest open gap.** No incumbent AI targets session-pack
   **credit liability**, **unused-credit win-back**, or **no-show/utilization economics on
   fixed-capacity rooms** (not instructor-led classes). The one recovery-aware booking suite found
   (Zipper) ships no intelligence layer.
5. **Owned platform + workflow freedom** — recovery-native workflows (room-and-slot booking,
   credit-pack economics, contrast-therapy add-ons) instead of gym-class constructs bent to fit.

*Architecture validation [W]:* a newer wave (GymIQ, Keepme, PredictStay) proves the AI-layer-on-top
model ("no migration, live in a day") — but all are narrow point solutions. Kelo starts from that
posture and broadens into the full owned platform.

### Measurable success criteria

1. **Trustworthy numbers.** The operator never needs to cross-check the underlying source.
2. **Performance.** p95 page load < 1.0s; booking/mutation confirmation < 1.0s; no schedule-render
   lag under realistic data — budgeted and load-tested in CI.
3. **Money/comms correctness.** 100% of billing actions and transactional emails atomic +
   idempotent, with member-visible confirmation and a queryable status/retry log; ≥99.5% email
   delivery.
4. **Analytics depth.** Every core report (revenue, attendance, cohort/churn, LTV, plan-mix,
   **credit liability, room utilization**) drill-downable and exportable, no manual CSV step.
5. **The outreach loop closes.** ≥80% of segments have a ready-to-send brand-voiced draft on any
   given day; the segment→send→measure loop is live.
6. **Adoption.** Owner-operator productive on day one, self-serve; the daily briefing opened ≥5 of
   7 mornings.
7. **Data freshness (transition).** Imported data never older than ~1–2h without a visible warning;
   a failed import alerts rather than showing stale or fabricated numbers.
8. **Cutover readiness.** A concrete, measurable bar for when Kelo is trusted enough to become the
   system of record and retire Glofox (reconciled counts within tolerance; billing parity verified;
   no unresolved data-correctness defects).

---

## 3. Core user flows (target state)

**A — Morning review (the daily loop, the reason the product exists).** Owner opens the home screen
→ reads 2–3 AI-ranked insights and a KPI strip (revenue, bookings, walk-ins, no-shows, attendance
rate) → scans a focus queue (failed payments, under-booked sessions in the next 24h) → clicks into
the one or two that matter → acts. Must be flawless.

**B — Retention outreach.** Owner opens Segments → sees e.g. "At-risk: 18 people, call this week" →
opens the segment → reviews the ranked list and the AI-drafted message (email + SMS variant +
rationale) → edits and approves → **it sends and is logged per person.** The owner approves every
send; the AI never sends autonomously.

**C — Booking & payment.** A customer (or front desk) books a sauna room / plunge slot → Kelo checks
capacity → takes payment or debits a credit pack → confirms and records it. *(Today this lives in
Glofox; Kelo must own it to replace Glofox.)*

**D — Revenue & billing operations.** Owner reviews revenue → refunds a payment or chases a failed
one → **real money moves**, with member-visible confirmation and a retry log.

**E — Schedule tuning.** Owner reads a demand heatmap (day × daypart, 30-day fill) → reviews AI
recommendations ("add a 6pm Friday plunge; the slot runs 90% full") → adjusts the schedule.

---

## 4. Domain model & integrations

### System-of-record intent
Kelo is the system of record. It must **natively create and manage** people, memberships, bookings,
sessions, payments, credit packs, waivers, and retail — not merely mirror them. During transition it
imports from Glofox; after cutover, Kelo's own data is authoritative. **Design the model for how a
recovery studio should work** — Glofox is an import source, not a schema template. **[V, per owner]**

### Core entities

- **Tenant (studio/organization)** — the top-level boundary. **Every record is tenant-scoped**, and
  the model must support many tenants from day one. A tenant may have multiple locations.
- **Person** — everyone the studio touches, deduplicated by email. The incumbent treats every signup
  as a "lead" with no member flag; Kelo must model an **explicit relationship type** — *this is the
  single most important modeling decision in the product*:
  - **Recurring member** — an active recurring subscriber (Monthly/Annual/Unlimited). **This is the
    only cohort that counts as a "member," and it is small (~22–24 today).** The "member" KPI and
    MRR derive from this cohort **only**.
  - **Pack-holder** — bought class/session credit packs (pay-as-you-go). The **largest** active
    cohort (hundreds), and the source of the stale-credit liability. **Not** a member.
  - **Aggregator (e.g. ClassPass)** — attends via a third-party demand aggregator. **Not** a member.
  - **Guest / drop-in** — one-time or occasional. **Not** a member.
  - **Lead / prospect** — signed up, has not transacted.

  **The core growth engine the intelligence layer targets:** convert pack-holders / aggregator
  users / guests into recurring members, and win back stale credits. For a studio that is mostly
  pack- and drop-in-driven with a small recurring core, *that conversion engine is the product's
  value.* **[V, per owner]**
- **Profile** — identity + roles; shared by people, staff, and login users.
- **Trainer** — pay configuration (base per session, bonus rule), linked to a profile.
- **Program / Session instance** — a template and its scheduled instances (capacity, booked count,
  trainer, start time). Must model **appointment/room-slot** bookings (a private sauna room or
  plunge for a time window), not only group classes.
- **Booking** — a person's booking of a session or room-slot; statuses pending / cancelled /
  checked-in / no-show / waitlisted. Feeds engagement, attendance, retention.
- **Transaction / Payment** — memberships, credit packs, retail, gift cards, walk-ins, corporate.
- **Membership plan** — recurring / unlimited / credit-pack / drop-in / intro types coexisting;
  supports launch-tier ramps (founding → opening → standard rates) common in recovery studios.
- **Credit pack / credit ledger** — session-credit packs (central to recovery economics: unused
  credits are deferred-revenue liability and a prime win-back segment) + an audit trail of
  adjustments.
- **Behavioral segment assignment** — derived mapping of each person to behavioral cohorts
  (~13 today, e.g. active-recurring, hooked, cooling, at-risk, trial-graduated, new, cold-lead,
  stale-credits, win-back, high-value), each with an action priority.
- **AI briefing / caches** — stored daily briefings and time-boxed caches of AI output and KPIs.
- **Activity log** — an event feed (payments, bookings, cancellations).
- **Marketing** — campaigns + recipients; automation flows + enrollments.
- **Compliance & retail** — per-session waivers, retail products, gift cards, facility resources +
  maintenance.
- **Operational** — per-entity import watermark + conflict log, tenant settings, rate-limit buckets.

**Relationships.** A tenant owns all records. A booking links one person to one session/slot; a
transaction links to one person; a session links to a program and a trainer; a credit pack links to
a person. Segments are derived, not stored as source data.

### External services (named; no credentials anywhere in this document)

- **Glofox — the incumbent booking system (transitional).** Current source of truth for people,
  sessions, bookings, payments, credits. REST API, three-header auth. **Currently read-only — a
  safety gate while Kelo is proven.** Roadmap: tested write-back, then retirement. Its real-world
  quirks are documented in §5 and **must be designed against.** **[V]**
- **Application database — Supabase / Postgres. FIXED.** Row-level security scoping every record to
  its tenant; database-side procedures for atomic operations. Must support **true multi-tenancy**.
- **Authentication — Supabase Auth.** Email + password today; must evolve to support multi-tenant
  **org onboarding / invites / roles**, and (recommended) SSO or passwordless for the SaaS phase.
- **AI provider — Anthropic Claude.** Powers the briefing, segment outreach, schedule
  recommendations, and free-text Q&A. Server-side; outputs cached; endpoints rate-limited.
- **Payments — Stripe. Kelo owns billing.** Kelo processes memberships, packs, retail, refunds,
  dunning, and subscription changes through Stripe. *(Note from §5: the studio's payments **already**
  run through Stripe underneath Glofox, so this is a continuation of the existing processor, not a
  migration to a new one.)* **[V]**
- **Email + SMS.** An email provider (Resend is already scaffolded) and an **SMS provider still to be
  chosen** (e.g. Twilio) — required for marketing execution and the SMS outreach Kelo drafts.
- **Background jobs / scheduling.** Hosting-provided scheduled functions run the import and native
  jobs (dunning retries, lifecycle automations). **Choose exactly ONE scheduler** (§5).
- **Hosting — Netlify. FIXED.** Hosts the app and runs scheduled functions; push-to-deploy.
- **Observability — none exists; must be built** (error tracking + import/health alerting). §5.

### Migration strategy (strangler-fig — order confirmed with owner) [V]
Kelo takes over Glofox's responsibilities in a deliberate order — **booking and payments last**
(highest-risk, member-facing money paths), and the **member-facing surface after** the operational
platform is solid:
1. **Import + intelligence (now).** Kelo reads Glofox read-only and runs the intelligence layer.
2. **Own the non-transactional layers, in order:** **data ownership → marketing execution →
   scheduling → everything in between** (people, segments, staff, compliance, retail), writing back
   to Glofox where needed (tested, reconciliation-gated — the read-only rule lifts here, on proof).
3. **Own booking + payments LAST.** Native booking, Stripe payments, membership lifecycle.
4. **Beta member-facing surface.** Once the operational platform is solid, a **beta** member app /
   booking widget — the piece that finally lets Glofox be retired.
5. **Cutover + retire Glofox.** When the readiness bar is met (§2 criterion 8).

---

## 5. Hard-won domain knowledge & failure modes to design against

*This section is the return on a failed prototype. It is not a description of that prototype — it is
the set of **facts about this domain** that a fresh build will hit identically, and the failure modes
that must be designed out. All of it is verified against the live systems. Treat it as
load-bearing: the prior attempt died on exactly these points.*

### Verified facts about the Glofox API [V — probed live, 2026-07]

The prior build **guessed at the payload shape instead of verifying it**, and every guess was wrong.
The real shapes:

- **Membership tier is an object, not a string.** There is **no** top-level `membership_name` field.
  The real shape is `membership: { type, status, start_date, user_membership_id }`. Non-recurring
  people have `membership.type = "payg"`. **Recurring members are identified by `membership.type`
  plus subscription payments** — transaction metadata carries `glofox_event = "subscription_payment"`
  with a `stripe_subscription_id` and a description like *"Monthly Memberships (4-Class
  Membership)"*. The plan **name** resolves by joining `membership.user_membership_id` (or a
  transaction's `membership_id` / `plan_code`) to the memberships catalog.
- **Signup date is `created` (unix seconds), not `registered_at`.** `registered_at` does not exist.
  `created` is populated and varies per person. *(Open caveat: `created` may be the Glofox
  record-creation time, which for migrated people could be a migration date rather than original
  signup — validate across a broad sample; §8.)*
- **The transactions report returns zero rows — silently, at HTTP 200 — if the namespace parameter
  is omitted.** With it, the same query returns real data (775 rows over 13 months in this studio).
  This single omission froze the prior build's revenue for ~10 weeks while reporting "success."
- **Transaction type must be derived**, from metadata `glofox_event` (`subscription_payment` /
  `invoice_payment`) plus the description text — there is no clean `type` field.
- **Payments already flow through Stripe** — report rows are wrapped in a `StripeCharge` provider
  key. Kelo taking over billing via Stripe is a continuation of the existing processor.
- **Other quirks:** several endpoints return **HTTP 200 with `success: false`** on auth/routing
  errors (treat as failure, never as empty); several "read" operations are **POST search/report**
  calls, not GET; timestamps are **string unix seconds**; pagination is page-based and inconsistent
  across endpoints (some return `has_more`, others require length-based detection); for a
  single-location studio, branch == location.
- **Glofox treats every signup as a "lead"** — current members, ex-members, trial buyers and
  one-time drop-ins all appear there, and there is no field that flips a lead into a member. The
  real category must be **derived from behavior** (§4).

### Failure modes to design against [V]

Each of these actively fired in production. They are stated as mandates because each has a war story
behind it:

1. **Verify the source payload before mapping any field.** The prior build's types were fiction; the
   correct values were discoverable in a five-minute read-only probe nobody ran. **Capture and pin
   real payloads first**, and make the mapping traceable to a captured sample.
2. **Never advance an import watermark on an empty or failed pull.** The prior build wrote
   `status: success, records_synced: 0` and moved its watermark forward, so one transient empty
   response **permanently froze** an entity with no error surfaced. Distinguish "legitimately zero"
   from "fetch failed," and treat zero-over-a-month for an always-active entity as an alarm.
3. **Never substitute fabricated data for empty results.** The prior build had a "fixture fallback":
   when a query returned empty, loaders silently swapped in canned demo data. In production this
   rendered **fabricated customers, transactions and revenue as real for ~10 weeks** — and because
   the test suite ran against those same fixtures, **every test stayed green the entire time.** Show
   honest empty / loading / error states. Make demo data structurally unreachable from live paths.
4. **Make data freshness visible on every screen, and alert on failure.** The prior build showed
   10-week-old data with a hardcoded "generated this morning" timestamp and no staleness indicator.
   There was no error tracking of any kind; nothing ever alerted.
5. **Test against seeded, real-shaped data — never fixtures that pass regardless of correctness.**
   A green build meant nothing: it compiled, unit tests passed, and a route smoke test passed, while
   the numbers on screen were wrong. Tests must fail when the real data path breaks.
6. **Every native mutation (booking, payment, membership change) must be atomic, idempotent, and
   verifiable**, with member-visible confirmation. This is also where the incumbents draw their
   angriest reviews (§2).
7. **One scheduler, not two.** The prior build wired two independent cron mechanisms to the same
   hourly job with no cross-process lock — a guaranteed double-run the moment both were enabled.
8. **Don't ship speculative schema or screens ahead of the feature that fills them.** Roughly half
   the prior schema (17 of 35 tables) never held a row, and five screens read tables nothing ever
   wrote — permanent empty states shipped as "features."
9. **Keep one code-verified source of truth for project knowledge.** The prior build's docs drifted
   badly from reality, so each new work session inherited wrong assumptions and compounded them.

### The meta-lesson

The prior attempt failed not from a bad framework choice but from **declaring things done without
verifying them against reality** — commits announced fixes ("fix field-name bugs," "fix tier") that
demonstrably never worked in production, while the real API question went unanswered to the end.
**No timeline pressure exists (§6). Optimize for verification over speed.**

---

## 6. Constraints

- **Fixed platform choices:** **Supabase** (Postgres + Auth + row-level security) and **Netlify**
  (hosting + scheduled functions). The owner prefers both and sees no benefit to switching. **[V]**
- **Kelo owns billing:** real money moves through **Kelo via Stripe**. **[V]**
- **Multi-tenant from v1:** tenant isolation, org onboarding, per-tenant config are ground-floor. **[V]**
- **Glofox is transitional and read-only *for now*** — a safety gate while Kelo is proven, not a
  permanent constraint. Graduation to tested write-back, then cutover, then retirement is the plan
  (§4). **[V]**
- **Do not let Glofox's design constrain Kelo's** — it is a data source, not a schema or workflow
  template. **[V]**
- **v1 scope is broad, by decision:** the intelligence core **plus** marketing execution **plus**
  billing actions **plus** inventory/compliance ship together. **[V]**
- **AI provider:** Anthropic Claude, deeply embedded; assumed to persist. **[I]**
- **Open for reconsideration:** the web framework, UI architecture, native booking/payment engine
  design, and background-job mechanism — everything except the fixed items above. **[V]**
- **Budget: not a constraining factor.** Paid integrations, hosting, and AI/API spend are acceptable
  where they buy real capability. *(Not a license for waste — prefer fewer, well-chosen services.)* **[V]**
- **Timeline: not a constraining factor.** No hard external deadline. **Optimize for correctness and
  durability over speed** — this is a rebuild precisely because shipping fast on unverified
  assumptions produced §5. Sequence real value early, but **never compress a phase at the cost of
  verification.** **[V]**
- **Team reality:** development is driven by **the owner working with AI coding agents**, not a
  staffed engineering team. *[I]* Treat this as a first-class design constraint: optimize for
  **(a) agent-maintainability** — strong types, one source of truth, explicit contracts, tests that
  fail on real bugs rather than passing on fixtures — and **(b) low operational surface**: few
  moving parts, clear observability, no bespoke infrastructure needing a human on call.
- **Compliance:** no medical/health information is stored (product decision); standard customer-PII
  handling applies, including PII currently flowing to the AI provider (§8). **[V]**

---

## 7. Non-goals for v1

- **Storing health/medical information.**
- **Retiring Glofox before Kelo is proven** — cutover is gated on the readiness bar (§2 criterion 8).
- **A full member-facing product at launch** — the member app/widget is a **beta** deliverable after
  the operational platform is solid (§4), not a v1 headline.
- **Full multi-org self-serve SaaS onboarding and billing** — the *data model and auth* must support
  multi-tenancy from day one, but the commercial onboarding surface is not v1.
- **Real-time (sub-minute) data during the import phase** — near-real-time (hourly, with visible
  freshness) unless a specific flow justifies more (§8).

---

## 8. Open questions (make a recommendation rather than deferring)

1. **Native booking/payment engine — build vs. base.** Build it natively (favored, for the
   owned/unconstrained goal) or license a booking/payments backend?
2. **`created`-as-signup-date validation.** Verify whether Glofox `created` is true original signup
   or a migration-into-Glofox date; if the latter, choose the best cohort anchor (first booking?
   first transaction?).
3. **SMS provider** (and confirm the email provider).
4. **Auth for multi-tenant** — org onboarding/invites/roles; keep email+password or move to
   SSO/passwordless for the SaaS phase.
5. **AI provider + PII policy** — keep Anthropic (assumed); what is the acceptable policy for
   customer PII flowing to an AI provider, and should outreach drafting be de-identified?
6. **Data reset** — the existing production data is corrupt (§5); the plan assumes a full re-import
   after the mapping fixes. Anything worth preserving?
7. **Freshness expectation** during transition — hourly-with-staleness, or faster for live rosters?

---

## 9. Product name — Kelo

**Kelo** is the prized silver, weather-hardened dead-standing pine used to build the most coveted
Finnish saunas — connoting craft, patience, and premium materials, squarely in the sauna/recovery
world. Short, warm, pronounceable, clean as a wordmark, and it scales to a multi-studio SaaS brand
without being tied to one location. Working domains: **`getkelo.com` / `kelo.studio`**.

*Collision note [W, search-level only]: no fitness/studio-ops SaaS uses "Kelo"; out-of-space uses
exist (a robotics firm, a broadcast station, one spa), and "kelo" is a semi-generic sauna-wood term,
so it is mildly descriptive inside the wellness vertical — hence a modifier domain. A formal
trademark clearance (Classes 9 and 42) and domain check are still required.*


=====================
# PLAN A
=====================

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

=====================
# PLAN B
=====================

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

=====================
# PLAN C
=====================

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

=====================
# PLAN D
=====================

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
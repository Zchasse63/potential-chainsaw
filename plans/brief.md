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

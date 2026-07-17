# Kelo — Intelligence Content Plan

*2026-07-16. Companion to [plan-final.md](plan-final.md) (which built the plumbing: `ai_artifacts`,
`segment_definitions`, `briefing_feedback`, `metric_definitions`) — this document plans the
**content**: what the segments actually are, what the briefing actually says, how outreach sounds,
how quality is measured, and what every KPI means. Items marked **[OWNER]** are defaults that need
the owner's confirmation — collected in the consolidated question list. Everything else is
decided.*

*Design law inherited from the build plan: **the AI narrates deterministic facts; it never
computes them.** Every number in a briefing or draft is produced by SQL, carried in a structured
payload, and cited by reference. The model's job is synthesis, ranking-articulation, and voice —
never arithmetic, never invention.*

---

## 1. The segment catalog (v1: 13 segments)

Rules are SQL predicates over facts (visits, ledger, subscriptions, relationship history) —
versioned in `segment_definitions`, recomputed per run, assignments append-only per run_id.
A person can match several segments; the **outreach queue shows each person once, in their
highest-priority segment**, and a per-person contact cooldown (**[OWNER]** default 7 days)
prevents pile-ons. **Cooldown scope:** it governs *marketing* touches only — segment outreach and
lifecycle-automation marketing steps share one cooldown clock; **transactional messages and
dunning comms are exempt** (a card-update chase is never blocked by a marketing nudge); steps
*within* one enrolled lifecycle flow follow the flow's own intervals and pause other marketing
touches while active. Also unverified-signal note: two segment inputs (per-grant credit expiry,
aggregator booking channel) are phase-0 probe questions with pre-written degraded rules — see
plan-final §4.

| # | Segment | Rule (defaults; all windows in studio-local days) | Priority | Action intent |
|---|---|---|---|---|
| 1 | `payment-risk` | Active subscription in `past_due` / dunning (from Stripe ingest pre-cutover, native after) | 1 | Card-update chase — the highest-leverage dollar in the building |
| 2 | `at-risk` | `recurring_member` with no attendance in ≥21d **[OWNER: 21]** — paying but not using, the churn precursor | 2 | Personal outreach; the "call this week" list |
| 3 | `credits-expiring` | Credit balance > 0 with any grant expiring within 14d **[OWNER: 14]** | 3 | Use-your-credits nudge (also shrinks liability) |
| 4 | `hooked` | Non-member with ≥3 attendances in trailing 30d **[OWNER: 3/30]** | 4 | **The conversion engine's prime target** — membership offer while the habit is hot |
| 5 | `trial-graduated` | Intro-offer purchase consumed/expired within trailing 30d, no follow-on purchase. **Requires the phase-1 [OWNER] mapping of Glofox catalog items → Kelo plan types** (the import classifier alone can't identify intros); "consumed" = credits exhausted for credit-intros, validity window ended for time-boxed intros | 5 | Convert with a time-boxed founding/standard offer |
| 6 | `stale-credits` | Credit balance > 0, no attendance in ≥30d **[OWNER: 30]** | 6 | Win the visit back before the credits (and the habit) die |
| 7 | `win-back` | Two entry branches: **(a) lapsed member** — subscription cancelled or grace window expired, **no attendance floor** (they enter the day they lapse, per build-plan ruling #7; while still in dunning they stay in `payment-risk`, which takes precedence); **(b) lapsed regular** — exhausted-pack holder with ≥5 lifetime visits, no attendance 60–180d | 7 | Offer campaign; beyond 180d either branch ages into dormant (no active outreach) |
| 8 | `aggregator-regular` | ≥3 aggregator-channel attendances in 60d, zero direct purchases | 8 | Convert to direct — margin capture, gently (they're already loyal to the *studio*) |
| 9 | `cooling` | Previously ≥4 attendances in the prior 60d, none in the last 14d+ — for non-members the window runs **14–59d** (handing off to `win-back` at 60d, no dead zone); members hand off to `at-risk` at 21d | 9 | Light-touch re-engage before they become at-risk/win-back |
| 10 | `new` | `first_activity_at` within 21d and ≥1 attendance | 10 | Welcome + push to the second visit (the retention cliff is between visit 1 and 3) |
| 11 | `cold-lead` | `lead` first seen **in Kelo** ≥14d ago, never transacted, gated on `date_quality` (imported `created` dates are distrusted per §5). **Launch backfill policy:** leads first seen more than 90d before launch are excluded from automatic drip enrollment — a thousand-lead day-one blast is a deliverability and reputation grenade | 11 | Intro-offer drip (lifecycle automation, not manual outreach) |
| 12 | `high-value` | Top decile trailing-12-month collected revenue **[OWNER: or a $ threshold]** | 12 | VIP recognition, referral ask — never discounts (they don't need them) |
| 13 | `active-recurring` | `recurring_member` not matching `payment-risk`, `at-risk`, or `cooling` (defined as the complement — an implementable predicate, not a vibe) | 13 | No outreach; the health baseline every other segment is measured against |

**Segment hygiene rules:** a segment run cites its rule version; assignments under ~3 people
render as a list, not a "campaign"; `at-risk` and `payment-risk` items also feed the focus queue
directly (they're operational, not just marketing). Segment **transitions** (from
`person_relationship_log` + assignment diffs) are first-class events: the **canonical conversion
KPI is the relationship-based definition in §5** (pack_holder/guest/aggregator →
recurring_member); *hooked → recurring_member* is a secondary segment-level lens on the same
engine, and *active-recurring → at-risk* is the alarm.

**Cadence & draft readiness (success criterion 5):** segments recompute daily (after the import
window, before the briefing hour); a draft-generation job follows each run, regenerating drafts
for any segment whose membership changed; drafts carry a 7-day TTL and an on-demand refresh from
the approval screen (counted against the token budget). Criterion 5's denominator = the 12
outreach-bearing segments (`active-recurring` excluded by design); **draft-readiness coverage is
a tracked §4 metric** alongside the briefing-open rate.

## 2. The daily briefing

**Pipeline (deterministic first, model last):**
1. **Candidate-insight generator (SQL, no AI):** a fixed rule set emits scored candidates —
   revenue vs same-day-last-week beyond ±20%; fill-rate anomaly next 24–48h (under-booked
   high-demand slot or fully-booked-with-waitlist); payment failures outstanding; segment-count
   deltas beyond threshold (at-risk grew by ≥3); credit-expiry cluster in 14d; conversion events
   worth celebrating; import/data-health notes. Each candidate carries its metrics, dictionary
   references, affected people/sessions, and a deterministic impact score ($ at stake, people
   affected, time sensitivity).
2. **Selection:** top 2–3 candidates by score, with category diversity (never three revenue
   items); if nothing clears the floor, the briefing honestly says "no urgent actions today."
3. **Synthesis (Claude):** the model receives the selected candidates as structured JSON + the
   revenue dictionary entries they cite + the brand-voice card + the trailing 7 days of
   thumbs-down feedback (so it stops repeating rejected framings). It returns **structured JSON**
   (validated against a Zod schema): per insight — headline (verb-first), 2-line why, evidence
   refs (must match provided candidate ids), one action ref. Free prose outside the schema is
   rejected and retried once, then falls back to the deterministic candidate rendering.
4. **Storage:** `ai_artifacts` with prompt version, model, input hash, cost. Generated once daily
   at the tenant's briefing hour (**[OWNER]** default 6:00 AM studio time); UI only ever reads.

**Honesty rules baked into the system prompt (and enforced by schema/lint, not trust):** cite only
provided numbers; no invented percentages, projections, or confidence scores; no health/medical
framing ever; if an input is flagged stale the briefing was already refused upstream — the model
never sees stale data. **Prompt-injection posture:** person-derived strings (names, notes) enter
prompts as JSON string values only, with the system prompt instructing that data fields are never
instructions; briefing generation has **no tool access**; output schema validation is the second
fence (see [threat-model.md](threat-model.md)).

**Model assignments [recommendation]:** briefing = the most capable available Claude (currently
`claude-fable-5`) — it runs once per tenant per day, so cost is trivial and quality is the
product; outreach drafts + `/ask` synthesis = `claude-sonnet-5`; per-tenant monthly token budget
caps with alerting (**[OWNER]** default $50/tenant/mo, single-tenant reality ≈ a few dollars).

## 3. Outreach voice & drafting

- **The brand-voice card** — a single owner-authored artifact (stored in tenant settings,
  versioned): 3–5 tone adjectives, "we say / we never say" phrase lists, sign-off, emoji stance,
  discount philosophy, one example message the owner loves. **This requires owner input — it
  cannot be derived** (questions in the consolidated list).
- **Drafting inputs are de-identified by policy** (build plan §9 Q5): first name + segment
  rationale + behavioral features (last visit, credits, visit cadence) + voice card. Full contact
  details and merge fields resolve locally at send.
- **Output per segment:** email (subject + body) and SMS variant + a rationale the owner reads in
  the approval ceremony. Length caps: SMS ≤2 segments; email ≤120 words (**[OWNER]** confirm).
- **The tone-lint (deterministic, runs on every draft):** blocks pseudo-medical claims (a banned
  phrase/pattern list: "detox," "boosts immunity," "treats," "heals," …), collections-agency
  register on dunning comms, fake urgency ("last chance" without a real deadline), and any
  discount the voice card's policy doesn't allow. Lint failures return to the model once, then to
  the owner as a manual-edit draft.

## 4. Quality: evals and the feedback loop

- **Segment regression set:** the gold-label protocol (§6) doubles as the permanent segment eval;
  every rule-version change re-runs it (≥99% gate, from the build plan).
- **Briefing evals (fixtures, run in CI on every prompt change):** ~15 synthetic-but-real-shaped
  input days (normal day, anomaly day, nothing-happening day, stale-refused day, all-bad-news
  day). Assertions are deterministic: every number in the output appears in the input payload;
  schema validity; no banned phrases; action refs resolve; "no urgent actions" fires on the quiet
  day (the model must not invent urgency).
- **The live loop:** thumbs per insight + dismissal-with-reason from the focus queue accumulate in
  `briefing_feedback`; a weekly job summarizes (useful-rate per insight category, chronically
  dismissed types) and the summary feeds both the next week's prompts and a monthly human review.
  Success criterion from the brief: briefing opened ≥5 of 7 mornings — tracked from day one.
- **Draft evals:** lint pass-rate, edit-distance between draft and what the owner actually sent
  (high edit distance = the voice card or prompt needs work), and attribution-v1 conversions per
  segment (windowed, limitations stated).

## 5. Revenue dictionary v1 (`metric_definitions`, versioned; the exact copy behind every ⓘ)

| Metric | v1 definition | Notes / **[OWNER]** flags |
|---|---|---|
| **Collected revenue** | Succeeded payments (card + cash) − refunds, in the period, by studio-local day. **Cash basis, labeled "collected."** Gift-card *loads* included but broken out (they're liability until redeemed); gift-card *redemptions* excluded (already counted at load). Stripe fees not deducted (gross), fees shown separately. | Earned/recognized revenue (pack deferral, breakage) is **deliberately v2, with an accountant** — v1 never claims GAAP. |
| **MRR** | Sum of active recurring subscription amounts normalized to monthly (annual ÷ 12), including `past_due` within the grace window (default 14d **[OWNER]**), excluding paused. | The ~22–24-member canary metric. |
| **Member count** | `primary_relationship = recurring_member`. | Only this cohort. Ever. |
| **Attendance rate** | checked_in ÷ (confirmed + checked_in + no_show), per period. | Cancelled excluded from denominator. |
| **No-show rate** | no_show ÷ (confirmed + checked_in + no_show). | |
| **Fill rate** | Booked capacity ÷ available capacity per slot; available excludes not-ready/turnover/maintenance time. | Feeds the heatmap; readiness exclusion prevents cleaning gaps reading as demand failure. |
| **Room utilization** | Booked minutes ÷ open-hours minutes per resource. | |
| **Credit liability (operational)** | Sum over **unexpired grants** of (granted − debits attributed to that grant under earliest-expiring-first lot attribution) × that grant's unit price; expired remainders are closed by `expire` ledger entries and drop out. | Per-grant lot attribution, not a naive balance × price (which mis-handles debits against since-expired grants). Labeled operational, not GAAP, until a breakage policy exists. |
| **LTV (simple)** | Lifetime collected revenue per person. | Labeled "lifetime collected," no projection. |
| **Walk-ins** | Same-day front-desk-channel bookings. | |
| **Aggregator revenue** | Recorded net payout when known; otherwise flagged `estimated` with the assumption shown. | **[OWNER]** what does ClassPass actually pay per visit today? |
| **Conversion rate (the product's KPI — canonical definition)** | Numerator: people whose `primary_relationship` transitioned to `recurring_member` during the month (from `person_relationship_log`). Denominator: people whose `primary_relationship` was `pack_holder`, `guest`, or `aggregator` **on the first day of that month**. | The growth engine, measured honestly. `hooked → member` is a secondary segment-level lens, not this KPI. |

## 6. Gold-label protocol (phase 1, owner task, ~2 hours)

Stratified sample of ~80 real people: all current recurring members (~23), 20 pack-holders (mixed
fresh/stale credits), 10 aggregator users, 10 guests, 10 leads, plus ~7 known tricky cases (shared
family email, the person who switched from packs to membership, a refunded member, an
email-less walk-in). Owner labels each person's true relationship + "would you call them a
member?" in a simple sheet Kelo generates; disagreements between owner label and derivation are
adjudicated one by one (each is either a rule bug or a data lesson — both valuable); the labeled
set becomes the permanent fixture behind the ≥99% gate.

## 7. `/ask` approved-query catalog (v1 seed, ~20 queries)

Revenue by period/tender/product · member count over time · MRR movement (adds, churns, pauses) ·
attendance by person / by period · top N customers by collected revenue · fill rate by daypart ×
weekday · room utilization by resource · credit liability by expiry bucket · credits expiring
within N days (people list) · conversion funnel by month · segment membership + history for a
person · no-show rate by daypart / by person · failed payments outstanding · dunning pipeline
state · campaign results + windowed conversions · lead pipeline by status · gift-card outstanding
balance · cash-day summary · booking channel mix · new people by week. Each is a parameterized,
tested SQL template; Claude's role is picking the query + parameters and narrating the result
with dictionary citations. Questions outside the catalog get an honest "I can't answer that yet —
here's what I can," plus a logged miss (the miss log grows the catalog).

## 8. Workload model (pinned assumptions for the k6 scenario — phase 2 gate input)

Scale reality check from verified data: 775 transactions/13 months (~2/day) and hundreds of
people — **Kelo's performance risk is cold starts and render cost, not data volume.** Pinned
assumptions (**[OWNER]** confirm the starred ones): ~1,500 people; ★ ~30–60 bookable slots/day;
★ ~15–40 attendances/day; 3 years of history retained hot; 5 concurrent operator sessions +
1 Terminal; member surface (phase 8): 50 concurrent browsers, 10 bookings/min peak after an
Instagram post; booking storm test: 20 concurrent attempts on one final slot. k6 scenarios encode
exactly these numbers; RUM validates them against reality after launch.

You are reviewing four independent UX/UI plans produced by four different frontier AI models from the SAME planning brief (included first below). The plans are anonymized as Plan A, B, C, D in random order. You may have written one of them; you do not know which, so judge purely on merit.

Produce a critique document in markdown with these sections:

## Per-plan assessment (A, B, C, D)
For each plan: (1) its 3-5 strongest ideas — specific UX/design decisions worth stealing; (2) its 3-5 weakest points — usability errors, hand-waving, violations of the brief's constraints or locked engineering decisions, or risky choices; (3) any place it contradicts the brief's requirements or skips a required flow/section.

## Comparative judgment
Which plan is strongest per section (design principles, IA, flow specs, UI guidelines, component/theming, accessibility/devices, member surface, not-design list) and why — one or two sentences each.

## What EVERY plan missed
The most valuable section: UX risks, interaction design considerations, operational realities, or user-experience details that none of the four plans addressed. Think hard here — consider the real physical environment (wet hands at a plunge studio? steam? shared devices? members in robes without phones?), the emotional stakes of each flow, and long-term usability decay.

Be blunt and specific. Cite plan letters. Do not rewrite the plans; critique them.

=====================
# THE ORIGINAL BRIEF
=====================

# Planning Brief — Kelo UX/UI (Addendum to the Kelo build plan)

> **Scope of this brief:** the complete UX/UI plan for Kelo — information architecture, user
> flows, interaction patterns, UI guidelines, component-system strategy, accessibility, and device
> strategy. **Explicitly out of scope:** visual identity (color palettes, typography selection,
> logo, illustration) — a design tool and human designer own that later. Your job is everything a
> designer would need *around* that: structure, flows, behavior, states, and the token/theming
> architecture their visual identity will plug into.
>
> **This document is self-contained.** It summarizes the product and the already-locked
> engineering decisions that constrain UX. Do not re-litigate the engineering plan; design the
> best UX within it. Where you believe a locked decision damages UX, say so explicitly — that
> disagreement is valuable.

---

## Your task (read this first)

You are one member of an independent planning council. Other frontier models are receiving this
identical brief independently; your plan will be compared against theirs.

**Produce a UX/UI plan with exactly these sections:**

1. **Design principles** — the 5–8 UX doctrines for this product, each derived from a specific
   product goal or failure mode below (not generic "keep it simple" filler).
2. **Information architecture** — the operator app's full screen inventory and navigation model,
   organized by persona and frequency of use. What is one click away, what is buried, and why.
3. **Core flow specifications** — step-by-step UX for each flow in §3 below, including states,
   edge cases, and what the user sees when things are slow, empty, stale, or failing.
4. **UI guidelines** — the interaction rulebook: data-trust surfaces (freshness, provenance,
   reconciliation warnings), money-action patterns (confirmation, receipts, destructive-action
   protection), forms and validation, tables/reports/drill-downs, notifications and alerts,
   loading/empty/error/degraded states as a designed system.
5. **Component system and theming architecture** — concrete recommendation (library, tokens,
   density, dark mode stance) optimized for AI-coding-agent maintainability; how the future
   visual identity plugs in without rework.
6. **Accessibility and device strategy** — WCAG target, keyboard/screen-reader posture, and which
   personas use which devices (desktop/tablet/phone) for which jobs.
7. **Member-facing surface UX (later beta)** — the booking funnel, account claiming, and the
   polish bar it must hit.
8. **What you would explicitly NOT design in v1**, and why.

**Rules:** be concrete and opinionated; specific choices over surveys. Ground every
recommendation in the product context (§1–§4) and constraints (§5). Where the brief leaves
something open, make a recommendation rather than deferring.

---

## 1. Product context (condensed)

**Kelo** is a studio-operations platform for boutique recovery/wellness studios (sauna + cold
plunge) with an AI intelligence layer built in — a daily operator briefing, behavioral customer
segments with AI-drafted outreach, and recovery-specific insight (credit liability, room
utilization). It replaces the incumbent booking system (Glofox) via a staged strangler-fig
takeover: import + intelligence first, then marketing, scheduling, staff/compliance/retail, then
native booking + payments (Stripe), then a beta member-facing booking surface, then cutover.

**The product's reason to exist:** the owner opens one screen each morning and gets a *decision,
not a dashboard* — 2–3 ranked actions with one-click paths to act. Everything else supports that
loop. A prior prototype died by showing fabricated/stale data as real for ~10 weeks; **trust in
what's on screen is the product's central UX problem.** Every number must be provably current or
visibly labeled stale — freshness metadata arrives in every API response envelope
(`{ data, meta: { as_of, source, stale } }`) and the UI is contractually unable to render data
without provenance.

**Personas, in order of importance:**
1. **Owner-operator** — the daily-loop user; checks the briefing every morning (often on a
   phone), runs billing/outreach/schedule decisions at a desk. Non-technical. Must be productive
   day one, self-serve, no training call.
2. **Front desk** — check-in, walk-in sales (POS), booking on behalf of members, waiver capture.
   Uses a tablet or shared desktop at a counter, often mid-conversation with a customer standing
   there. Speed and error-proofing dominate.
3. **Trainer/staff** — sees their schedule and rosters; minimal surface, likely phone.
4. **Member** (later beta) — books a sauna/plunge slot on their phone from an Instagram link;
   never sees a vendor portal; the entire funnel is on the studio's domain and brand.
5. **Future tenant admins** (SaaS phase) — onboarding/config flows; assisted in v1, not
   self-serve.

## 2. Competitive UX bar

- **PushPress** wins on ease: owners set it up themselves, staff learn it fast. That is the floor.
- **Bsport** wins on member-facing polish (white-label, one-click booking, choose-your-spot,
  auto-reallocating waitlist) but is hated for **lag** — its #1 complaint, with studios reporting
  lost revenue from slow pages. Speed is a UX feature Kelo must weaponize: p95 page load < 1.0s,
  booking/mutation confirmation < 1.0s, budgeted and load-tested.
- Both categories' angriest reviews are **money/comms failures in front of members** (failed
  payments at the desk, refunds "done manually," pause/cancel flows breaking). The UX must make
  money states unambiguous: pending vs confirmed vs failed, member-visible confirmation, and a
  queryable retry log.

## 3. Core flows to specify (from the product plan)

- **A — Morning review (flagship).** Owner opens home → 2–3 AI-ranked insights + KPI strip
  (revenue, bookings, walk-ins, no-shows, attendance) → focus queue (failed payments,
  under-booked sessions next 24h) → clicks into one or two → acts. Must be flawless, fast, and
  work on a phone in a coffee line.
- **B — Retention outreach.** Segments list ("At-risk: 18 people") → ranked people + AI-drafted
  email/SMS with rationale → owner edits/approves → sends and logs per person. The AI never sends
  autonomously; approval UX is the product's trust ceremony.
- **C — Booking & front-desk ops.** Front desk books a room/slot for a person mid-conversation:
  find/create person → pick slot → pay (card via terminal, cash, credits, comp) → waiver check →
  confirmed, receipt sent. Also: check-in (with a degraded/offline retry mode), no-show marking,
  waitlist handling.
- **D — Revenue & billing operations.** Owner reviews revenue → drills into a failed payment →
  retries/chases with one click (dunning sequence w/ card-update link) → or refunds a payment →
  real money moves with visible state transitions and a retry log.
- **E — Schedule tuning.** Demand heatmap (day × daypart, 30-day fill) → AI recommendations
  ("add 6pm Friday plunge; slot runs 90% full") → owner adjusts schedule → publishes.
- **F — Data-trust surfaces.** Health page (per-entity freshness, import runs, alerts, authority
  matrix during transition), staleness banners, reconciliation warnings, degraded-AI modes
  (yesterday's briefing badged as such; metrics-only mode when the AI is down).
- **G — Onboarding (assisted).** Setup checklist, guided plan/resource configuration, import
  review + exception resolution (quarantined records), launch-readiness check.
- **H — Member booking (beta, later).** Phone-first funnel: see availability → pick slot → pay or
  use credits → waiver if needed → confirmation; account claiming for imported people
  (verify by email/phone); self-serve card update, cancellations, pack balance.

## 4. UX-relevant engineering decisions (locked — design within these)

- **Operator app:** Vite + React SPA, TanStack Router + TanStack Query. Auth-gated, data-dense.
  No SSR. **Member surface (later):** separate small SSR app, phone-first, on the studio's domain.
- **Freshness in every response envelope**; staleness thresholds (amber ≥2h, red ≥4h + alert).
  Some data is imported (hourly; roster every 15 min) during transition — screens mix
  live-native and imported data and must label which is which.
- **Mutations:** idempotent, <1s confirmation budget; **no optimistic UI for money or bookings**
  — the UI waits for server confirmation; card-funded booking is hold → pay → webhook-confirmed
  (states: processing / confirmed / failed / refund pending).
- **Honest states:** no fixture/demo data can render in production; empty, loading, error, and
  stale are designed first-class states.
- **AI:** briefing generated once daily and cached; refuses to generate when reconciliation is
  red (UI shows why); per-item owner feedback (useful / not useful) is the eval signal.
  Drafts are always human-approved.
- **Roles:** owner, manager, front_desk, trainer — UI surfaces differ by role.
- **Check-in degraded mode:** local retry queue when the network drops; conflicts surfaced.
- **Waivers:** booking blocks without a current-version signature (interim: check-in-time block);
  minors need guardian acknowledgment.
- **POS v1:** Stripe Terminal + cash recording + discounts (manager role) + tax + receipts. No
  tips/split tender/till management in v1.
- **Multi-location:** model supports it; **UI ships single-location** (no location switcher
  clutter in v1).
- **Team reality:** one owner + AI coding agents build this. Component choices must be
  boring, well-documented, and agent-friendly; custom one-off components are a liability.

## 5. Constraints

- Visual identity (colors, type, logo) is deferred to a design tool + human pass — but the
  **token/theming architecture** that will receive it is yours to specify now.
- Accessibility: no mandated standard in the brief — recommend one and justify the cost/benefit.
- Budget/timeline are not constraints; correctness and durability over speed. But UI surface area
  is a maintenance liability for an agent-built codebase — prefer fewer, denser, better screens.
- No dark patterns; the member funnel must be honest (no fake scarcity, no hidden fees).
- No medical/health information anywhere in any UI.

## 6. Success criteria (UX-relevant, from the product plan)

1. Owner-operator productive on day one, self-serve; daily briefing opened ≥5 of 7 mornings.
2. The operator never needs to cross-check numbers against the underlying source.
3. p95 page load < 1.0s; booking/mutation confirmation < 1.0s; no schedule-render lag.
4. 100% of money actions have member-visible confirmation and a queryable status/retry log.
5. Every core report drill-downable and exportable without a manual CSV step.
6. Front desk can complete a walk-in sale + booking + waiver in under 90 seconds.
7. Member beta: booking funnel completion on par with Bsport's one-click bar, on the studio's
   own domain, p95 < 1.0s.


=====================
# PLAN A
=====================

## 1. Design principles

1. **Lead with a decision, not a dashboard.**  
   Derived from Kelo’s primary reason to exist: the owner should see 2–3 ranked actions each morning, not interpret a wall of charts. “Today” must prioritize recommended action, evidence, and a direct next step. KPIs support the decisions rather than occupy the visual hierarchy.

2. **Provenance is part of the content.**  
   Derived from the failed prototype that presented fabricated or stale information as real. Every data-bearing surface must expose its source and “as of” time through a mandatory UI contract. Stale data may remain visible for context, but it must never look current.

3. **Show durable business state, not transient interface success.**  
   Derived from the industry’s most damaging failures: ambiguous payments, refunds, bookings, and communications. A toast is not proof. Money and booking actions end on a persistent status screen or timeline showing `processing`, `confirmed`, `failed`, or `refund pending`, with receipts and retry history.

4. **Make AI approval a deliberate trust ceremony.**  
   Derived from the requirement that AI never sends autonomously. Kelo must show why a person was selected, what evidence informed a draft, who will receive it, and exactly what will be sent. Approval should be efficient but never accidental.

5. **Optimize front-desk flows for a live conversation.**  
   Derived from the 90-second walk-in target and the social cost of fumbling in front of a member. Front-desk screens should minimize navigation, preserve context, use large targets, prevent duplicates, and clearly distinguish queued, processing, and confirmed actions.

6. **One visible authority for every action.**  
   Derived from the staged Glofox-to-Kelo transition. Mixed-source screens are acceptable; ambiguous write authority is not. Each entity must indicate whether Kelo or the incumbent is authoritative, and the interface must prevent writes through the wrong system.

7. **Degrade honestly and locally.**  
   Derived from intermittent networks, hourly imports, and AI/reconciliation dependencies. If AI is unavailable, metrics still work. If check-in is offline, only check-in enters a local retry queue. If booking or payment cannot be confirmed, Kelo must not imply success.

8. **Spend complexity only on recurrent operational risk.**  
   Derived from the one-owner-plus-agents team constraint. Use a small number of dense, reusable workspaces rather than many narrowly tailored screens. Complexity is justified for payments, reconciliation, waivers, imports, and scheduling conflicts—not for customizable dashboards or decorative interactions.

---

## 2. Information architecture

### Navigation model

The operator app uses a persistent role-specific sidebar on desktop and landscape tablet. Navigation is not user-customizable in v1; predictable placement is more valuable than flexibility.

A global header contains:

- Studio name, without a location switcher in v1
- Global person search
- Persistent data-health indicator
- Actionable-alert count
- Help
- User/role menu

Every substantive view has a URL. Drawers may provide quick inspection, but payment details, person records, campaign reviews, and schedule changes must also have addressable full pages so refresh, sharing, and browser navigation work correctly.

### Owner and manager navigation

One click from anywhere:

1. **Today**
2. **Schedule**
3. **People**
4. **Outreach**
5. **Money**
6. **Reports**

Under **More**:

- Data health
- Setup and launch readiness
- Team and roles
- Plans, packs, pricing, and discounts
- Rooms and resources
- Waivers
- Taxes, receipts, and terminals
- Communication settings
- Audit log
- Studio settings

The owner lands on **Today**. Setup remains prominent only until launch readiness is complete. Data health is one click through the global health indicator even though it is also listed under More.

### Front-desk navigation

One click from anywhere:

1. **Desk**
2. **Schedule**
3. **People**

Under **More**:

- Retry queue
- Today’s receipts
- Limited data-health status
- Help
- Sign out

The front-desk user lands on **Desk**, not the owner briefing. Money reports, outreach, configuration, refunds, and schedule publishing are hidden unless the role grants them.

### Trainer navigation

One click from anywhere:

1. **My day**
2. **Roster**

The trainer sees assigned sessions, room, time, attendance state, and permitted member contact details. Billing, segmentation, business KPIs, and configuration are absent rather than merely disabled.

### Mobile navigation

For owners:

- Bottom navigation: Today, Schedule, People, More
- Outreach, Money, Reports, and Health appear under More
- Deep links from Today bypass navigation and open the relevant action directly

For trainers:

- My day and Roster only

The full schedule editor, import exception resolver, configuration forms, and large reports remain usable but are explicitly desktop-preferred. They should not be forced into a false “mobile dashboard” layout.

### Full screen inventory

| Area | Screens and major subviews | Primary personas | Frequency |
|---|---|---|---|
| Today | Morning briefing, KPI strip, focus queue, insight detail, prior briefing history | Owner, manager | Daily |
| Desk | Member lookup/create, walk-in booking, checkout, waiver capture, check-in roster, waitlist, no-show actions, offline retry queue | Front desk, manager | Continuous |
| My day | Personal schedule, session roster, attendance actions | Trainer | Daily |
| Schedule | Day/week calendar, slot detail, schedule template editor, unpublished changes, publish review, publish history | Owner, manager, front desk read-only | Daily/weekly |
| Demand | 30-day daypart heatmap, recommendation detail, schedule-change draft | Owner, manager | Weekly |
| People | Directory, duplicate suggestions, person profile | All operator roles according to permission | Daily |
| Person profile | Overview, bookings/attendance, plans and credits, payments, messages, waiver status, audit timeline | Owner, manager, front desk | Daily |
| Outreach | Segment list, segment detail, ranked people, draft review, audience exclusions, send progress, campaign history | Owner, manager | Several times weekly |
| Money | Revenue overview, transactions, failed-payment queue, payment detail, refund flow, dunning activity, retry log, receipts | Owner, manager | Daily/weekly |
| POS | Active sale, discounts, tax, tender selection, terminal status, receipt | Front desk, manager | Continuous |
| Reports | Revenue, bookings, walk-ins, attendance, no-shows, room utilization, credit liability; each with drill-down and export | Owner, manager | Weekly/monthly |
| Data health | Entity freshness, authority matrix, import runs, reconciliation results, quarantined records, alerts | Owner, manager | Exception-driven |
| Onboarding | Setup checklist, resource configuration, plan configuration, import review, exception resolution, launch readiness | Owner, assisted admin | Once per launch |
| Settings | Team, roles, resources, plans, discounts, taxes, waivers, receipts, terminals, notifications, audit | Owner, manager selectively | Infrequent |

### Placement rationale

- **Today, Desk, Schedule, People, Outreach, and Money** are top-level because they directly support daily operating loops.
- **Reports** remains top-level for owners because recurrent drill-down is a success criterion, not an administrative afterthought.
- **Health** is visually persistent through the global indicator but its detailed machinery is buried because healthy operations should not require routine attention.
- Configuration is under **More** because it is high-impact but infrequent.
- Role-inapplicable areas are removed from navigation to reduce mistakes on shared devices.

---

## 3. Core flow specifications

### A — Morning review

1. The owner opens **Today**.
2. The cached application shell renders immediately. The page header shows:
   - Business date
   - Briefing generation time
   - Data coverage time
   - Overall freshness state
3. The first content block contains 2–3 ranked insight cards. Each card includes:
   - Recommended action as the title
   - Operational impact, without invented precision
   - Two or three evidence facts
   - Data source and “as of” time
   - Primary action
   - “Why this is recommended”
4. The KPI strip follows: revenue, bookings, walk-ins, no-shows, and attendance. On phones it uses a two-column layout rather than a long hidden carousel.
5. The focus queue shows actionable current items such as failed payments and under-booked sessions in the next 24 hours.
6. Selecting an insight opens the relevant filtered workflow—never a generic report. For example:
   - Failed payments → failed-payment queue
   - At-risk members → prefiltered outreach review
   - Under-booked session → roster plus outreach action
7. After acting, the owner returns to Today and sees the item marked resolved, in progress, or unchanged based on server state.
8. Each AI insight offers “Useful” and “Not useful.” “Not useful” may optionally collect a reason, but feedback never blocks the workflow.

**Exceptional states**

- **No actionable insights:** Show “No urgent actions today,” then KPIs and informational observations. Do not invent low-value recommendations to fill three slots.
- **AI unavailable:** Replace insight cards with a clearly labeled “Metrics-only briefing.” KPIs and focus queue remain available.
- **Reconciliation red:** Do not generate a new briefing. Explain which reconciliation failed, show the last valid briefing with its original date, and link to Data health.
- **Yesterday’s briefing:** Keep it visible only when useful, with a prominent “Generated yesterday” label; never relabel it as today’s.
- **Slow:** Show structural skeletons briefly. If previously fetched data exists, show it with “Updating” and its existing timestamp rather than blanking the page.
- **Partial failure:** Render successful modules independently. A failed KPI request does not remove the briefing.
- **Stale:** At two hours, apply the warning treatment; at four hours, apply the critical treatment and persistent alert. Actions dependent on current availability or money state may be disabled while historical analysis remains viewable.

### B — Retention outreach

1. The owner opens **Outreach** and sees segments with:
   - Plain-language definition
   - Member count
   - Change since the prior calculation
   - Last-calculated time and source
2. Selecting “At-risk: 18 people” opens a ranked list. Each row shows:
   - Person
   - Reasons for inclusion
   - Last visit
   - Remaining credits or plan state where relevant
   - Contactability and consent state
   - Existing outreach or suppression state
3. The owner selects people or accepts the proposed eligible audience. Ineligible, opted-out, recently contacted, missing-contact, and duplicate records are excluded visibly, with reasons.
4. Kelo generates a draft for the chosen channel. The review screen presents:
   - Exact audience count
   - Email subject or SMS body
   - Personalization fields with sample rendering
   - AI rationale and facts used
   - Character/segment count for SMS
   - Any unsupported or unverifiable claim warning
5. The owner edits the message. Changes are autosaved as a draft, but nothing is sent.
6. The approval ceremony has two explicit checkpoints on one review screen:
   - **Audience:** “18 selected, 3 excluded”
   - **Content:** exact final preview
7. The final button says **Send email to 18 people** or **Send SMS to 18 people**, not “Continue.”
8. After server acceptance, the campaign page becomes a durable send monitor with per-person states:
   - Queued
   - Sent
   - Delivered, when available
   - Failed
   - Skipped, with reason
9. Every person profile receives an immutable communication-log entry.

**Exceptional states**

- **Empty segment:** Explain the segment rule and that nobody currently qualifies; do not offer AI copy.
- **Stale segmentation:** Editing is allowed, but sending is blocked if stale data could violate suppression or eligibility rules.
- **AI failure:** Permit a manually written message using the same review and approval flow.
- **Partial send failure:** Do not call the campaign “sent” without qualification. Show counts and offer retry only for retry-safe failures.
- **Page closure during send:** The operation continues server-side; reopening the campaign restores status.
- **Consent changes during review:** Revalidate at send time and exclude newly ineligible recipients.

### C — Booking and front-desk operations

#### Walk-in or staff-assisted booking

1. The front-desk user opens **Desk** and places the cursor in person search automatically.
2. Search accepts name, phone, or email and returns exact and probable matches.
3. If no match exists, **Create person** requests only the minimum required fields. Potential duplicates appear before creation.
4. The person summary shows:
   - Credit or plan eligibility
   - Outstanding balance
   - Current waiver status
   - Minor/guardian status
5. The user chooses service and time from immediately available slots. Each slot shows room/resource, duration, capacity, price or credit cost, and source freshness.
6. Selecting a slot creates a visible temporary hold with an honest expiry timer.
7. Kelo performs waiver preflight before taking money:
   - Current waiver → continue
   - Missing/outdated waiver → sign on the device or send/open a QR link
   - Minor → guardian acknowledgment flow
8. The user chooses tender:
   - Stripe Terminal
   - Cash
   - Credits
   - Comp
9. Discount and comp actions require manager permission. The total, tax, discount, credits, and remaining balance are visible before submission.
10. The primary button states the result: **Charge $42.00 and book** or **Use 1 credit and book**.
11. The interface waits for server confirmation. It does not optimistically show a booking.
12. The result screen shows:
   - Processing, confirmed, or failed
   - Booking reference
   - Payment reference and tender
   - Waiver state
   - Receipt delivery state
   - Check-in action when appropriate

Charging before discovering a waiver block would create paid-but-unbooked failures. The UX should therefore preflight the waiver before payment, even though the condensed flow lists payment first.

The interim policy that defers waiver blocking until check-in damages both member experience and the 90-second front-desk target. Imported bookings without a valid waiver should receive a pre-arrival signing link and appear in a “Waiver needed” queue, rather than surprising the member at the counter.

#### Check-in

1. Desk defaults to the current roster with large **Check in** controls.
2. Selecting a member validates booking, waiver, and duplicate check-in state.
3. Online success changes the row to **Checked in** with server time and actor.
4. If the network drops:
   - A persistent offline bar appears
   - Check-ins can be queued locally
   - Rows say **Queued on this device**, not checked in
   - A visible queued count remains until synchronization
5. On reconnection, Kelo replays idempotently. Conflicts enter a resolver with the server state and proposed local action.

Offline mode applies only to check-in. New bookings, card payments, refunds, and other money actions remain unavailable offline.

#### No-show and waitlist

- No-show is available only after the session’s configured threshold. Confirmation names the person and session.
- Reversing a no-show writes an audit event.
- Cancellation opens the waitlist. Staff can send an expiring offer to the next eligible person.
- An offer is not displayed as a booking until accepted and confirmed.
- Staff see offered, expired, accepted, and skipped states, with reasons.

### D — Revenue and billing operations

1. **Money** opens on revenue summary plus operational queues, not charts alone:
   - Failed payments
   - Payments processing unusually long
   - Refunds pending
   - Dunning requiring attention
2. Every summary number drills into the underlying transaction list with its filter preserved in the URL.
3. Selecting a failed payment opens a detail page showing:
   - Member and amount
   - What the payment was for
   - Failure reason in plain language
   - Processor status and reference
   - Attempts and timestamps
   - Communication and card-update activity
4. Available actions depend on processor state:
   - Retry when permitted
   - Send secure card-update link
   - Start or resume dunning
   - Record resolution
5. Retry requires an explicit confirmation naming the amount and payment method. The screen then shows processing and awaits the real result.
6. A card-update link action shows the exact channel and recipient, then logs delivery and completion.
7. Refund starts from a confirmed payment. The user chooses full or partial amount and a required reason.
8. The review step shows:
   - Original payment
   - Refund amount
   - Expected resulting balance
   - Effect on credits or booking, if any
   - Receipt recipient
9. After submission, the transaction remains visibly **Refund pending** until processor confirmation. It is never labeled refunded merely because a request was accepted.
10. The payment timeline records requests, retries, webhook results, communications, actors, and receipts.

**Exceptional states**

- Duplicate requests are absorbed idempotently and linked to the existing operation.
- An unknown processor result stays **Processing—verification required** and is polled/reconciled.
- Failed refund requests retain the original confirmed payment state and expose retry-safe options.
- If data is stale or reconciliation is critical, initiating a refund or retry is blocked while read-only history remains available.
- A receipt failure does not reverse a successful payment; it appears as a separately retryable receipt-delivery failure.

A webhook-confirmed result cannot always be guaranteed within one second because the processor is external. The UI should acknowledge server acceptance within the budget but retain an honest **Processing** state until the webhook arrives. Pretending finality to meet a timing metric would be worse UX than a short, durable processing state.

### E — Schedule tuning

1. The owner opens **Schedule → Demand**.
2. A 30-day heatmap shows day × daypart fill rate. Controls expose:
   - Service/resource
   - Date window
   - Capacity basis
   - Excluded closures or abnormal days
3. Selecting a cell opens the sessions behind the aggregate.
4. AI recommendations appear beside the heatmap, each with:
   - Proposed change
   - Evidence period and sample size
   - Current fill rate
   - Expected operational effect
   - Known constraints
5. Selecting a recommendation creates an unpublished schedule draft.
6. The editor shows the current schedule and proposed changes. Existing bookings are never silently displaced.
7. Validation checks:
   - Room/resource conflicts
   - Staff conflicts
   - Capacity and duration
   - Existing bookings
   - Plan or service availability
8. The publish review summarizes added, changed, and removed slots; effective date; affected bookings; and member communications.
9. Publishing awaits server confirmation and creates a publish-history entry.

**Exceptional states**

- **Insufficient data:** Show the heatmap with sample counts and suppress AI recommendations rather than extrapolating.
- **Stale imports:** Historical demand may remain viewable, but availability-dependent editing is disabled if Kelo is not authoritative.
- **Conflicts:** Publish is blocked with direct links to each conflict.
- **Partial publish failure:** Retain the draft and show exactly which server validation prevented publication.
- **No demand data:** Explain the required observation period and link to the standard schedule editor.

### F — Data-trust surfaces

#### Global treatment

- Every screen has a page-level freshness indicator.
- Data from different envelopes carries local source/freshness labels.
- Hover, tap, or keyboard focus reveals an absolute timestamp, relative age, source, and import run.
- Warning begins at two hours; critical begins at four hours and creates an alert.
- Imported data says **Imported from Glofox**. Native data says **Live in Kelo** where that distinction matters.
- Staleness never relies on color alone.

#### Data health page

The page is organized into:

1. **Current issues:** reconciliation failures, late imports, webhook delays
2. **Entity freshness:** people, bookings, rosters, payments, credits, waivers
3. **Authority matrix:** read source, write source, last synchronization, expected cadence
4. **Import runs:** running, completed, partially completed, failed
5. **Quarantine:** records requiring human resolution
6. **Reconciliation history:** counts and differences by entity

Each issue names its operational consequence and affected actions. “Bookings are four hours stale; do not use imported availability for new bookings” is preferable to “Sync failed.”

The hourly import cadence materially conflicts with the goal that the operator never cross-checks volatile operational numbers. Labels mitigate this but cannot make hourly data equivalent to live data. During transition, Kelo should prevent availability or money actions based on stale imported state and make the authoritative system explicit.

### G — Assisted onboarding

1. On first access, the owner sees a setup checklist with five stages:
   - Studio and team
   - Rooms/resources and services
   - Plans, packs, prices, tax, and discounts
   - Import and reconciliation
   - Payments, waivers, and launch readiness
2. Each stage states who is responsible: owner or Kelo-assisted.
3. Configuration uses guided forms with a summary preview rather than exposing raw system settings.
4. Import review first shows totals:
   - Imported
   - Merged
   - Quarantined
   - Rejected
5. Exceptions are grouped by resolvable cause, such as duplicate identity, missing price, invalid phone, or orphaned credit.
6. The resolver supports safe batch decisions only when every affected record shares the same cause.
7. Every decision shows a before/after preview and is reversible until the import is committed.
8. Launch readiness checks:
   - No critical reconciliation errors
   - Terminal and test payment verified
   - Waiver version active
   - Booking resources configured
   - Staff roles assigned
   - Receipt and message delivery tested
9. Launch cannot be declared ready while critical checks fail. Noncritical warnings may be acknowledged with an audit note.
10. After launch, the checklist moves under More and Today becomes the default home.

**Exceptional states**

- A failed step retains prior inputs.
- Long imports show counts and current phase, and continue server-side if the browser closes.
- Empty imports are treated as errors unless explicitly expected.
- Import exceptions never silently disappear because a later run completed.

### H — Member booking beta

1. The member follows a studio-domain link, optionally with service or campaign context preselected.
2. The first screen shows real availability, duration, total price or credit cost, and relevant cancellation terms.
3. The member selects a slot, which creates a short server-side hold with an honest timer.
4. Kelo identifies the member:
   - Returning claimed account → fast sign-in
   - Imported unclaimed account → email/SMS verification
   - New member → minimal contact creation
5. The member chooses credits or card. Available credits are shown before payment; unavailable or expired credits explain why.
6. Missing or outdated waiver appears inline before final booking. Guardian acknowledgment is used for minors.
7. The final review shows service, time, price, taxes, credits, cancellation terms, and waiver state.
8. The button says **Pay $42 and book** or **Use 1 credit and book**.
9. Confirmation waits for server truth and shows booking reference, receipt, calendar action, directions, and cancellation policy.
10. If payment remains processing, the page retains the booking reference and updates automatically. Refreshing or reopening the link restores status rather than creating a duplicate.

---

## 4. UI guidelines

### Data-trust surfaces

Use a mandatory `DataBoundary` component for all API-backed content. It accepts `{ data, meta }`; missing provenance is a render-time development error and a monitored production error.

Freshness presentation has three levels:

- **Page level:** “Current as of 8:14 AM”
- **Module level:** only when a module differs from the page
- **Row/field level:** when a mixed-source record materially affects interpretation

Source and freshness labels use plain language, not internal service names. The detail disclosure includes:

- Absolute and relative time
- Native or imported source
- Import/run identifier when relevant
- Reconciliation state
- Link to Data health

Do not stamp every cell with a timestamp. Consolidate identical provenance while preserving access to detail.

### Money and booking actions

- Never use optimistic success for payments, refunds, bookings, cancellations, or schedule publication.
- Primary buttons name the action and amount.
- Disable duplicate submission after activation, while preserving visible processing state.
- Confirmation is proportional:
  - Ordinary booking: final review in context
  - Retry charge/refund: explicit confirmation
  - Bulk or unusually high-risk action: step-up authentication
- Do not use typed phrases for routine refunds; they slow legitimate work without adding meaningful safety.
- Every action produces a persistent result page or timeline.
- Toasts may supplement but never replace durable state.
- Receipts show delivery status and can be resent without repeating the money action.
- Destructive actions describe operational consequences, not merely “Are you sure?”

### Forms and validation

- Labels remain visible; placeholders are examples, not labels.
- Validate formatting as the field loses focus and validate business rules on submission.
- On submission failure, show an error summary and move focus to it while preserving every input.
- Required fields are identified in text.
- Disabled buttons must have an adjacent reason. Prefer an enabled submit that reveals validation over unexplained disabling.
- Autosave only low-risk drafts such as outreach copy and schedule drafts. Never autosave published schedule, refund, payment, or send approval.
- Warn before leaving unsaved high-impact changes.
- Search-before-create is mandatory for people to reduce duplicates.
- Dates and currency use the studio’s configured locale and timezone; transaction logs also preserve precise timestamps.

### Tables, reports, and drill-downs

- Use one reusable table system with sorting, filtering, column visibility, pagination or virtualization, and keyboard navigation.
- Filters and selected time range are encoded in the URL.
- Summary metrics always drill into their supporting rows.
- Sticky headers and the first identifying column are permitted on desktop.
- Mobile renders priority fields as record cards; it does not compress a ten-column table into illegibility.
- Charts have an adjacent data-table view and textual summary.
- Exports operate on the current filtered view and are available directly as CSV and XLSX. Large exports become server jobs with visible progress and a download notification.
- Exported files include timezone, filters, generated time, source, and data-as-of time.
- Reports never silently omit incomplete or stale records; exclusions are stated.

### Notifications and alerts

Use four distinct mechanisms:

1. **Inline validation:** local and immediately resolvable
2. **Toast:** transient confirmation for reversible, noncritical actions
3. **Banner:** current page is degraded, stale, offline, or blocked
4. **Alert center:** persistent operational issues requiring later action

Alert counts include only actionable unread items, not general activity. Critical money, reconciliation, import, or terminal issues remain until resolved or acknowledged. Alerts deep-link to the affected object.

Do not send redundant owner notifications for every normal event. Daily briefing readiness, critical sync failures, terminal failures, and prolonged payment/refund processing are appropriate notification candidates.

### Loading, empty, error, and degraded states

Every reusable data component must ship with all of these states:

- **Initial loading:** stable skeleton matching final geometry
- **Background refresh:** existing data remains with “Updating”
- **Empty:** explains what the absence means and offers a relevant action
- **Filtered empty:** says no results match and offers “Clear filters”
- **Error:** plain-language consequence, retry, and reference ID
- **Partial error:** successful modules remain usable
- **Stale:** data remains visible with age and source
- **Offline:** only supported local actions remain enabled
- **Permission denied:** explain required role without implying missing data
- **Processing:** persistent operation state, safe to leave and return
- **Conflict:** compare local intent with server truth and provide resolution

After roughly one second, slow mutations must add explanatory text such as “Waiting for terminal” or “Confirming with payment provider.” After prolonged delay, offer safe navigation away and a link to the operation status. Never reset a processing action merely because the browser timed out.

---

## 5. Component system and theming architecture

### Recommended stack

Use:

- **Tailwind CSS** for constrained styling
- **Radix UI primitives through a pinned shadcn/ui component layer**
- **TanStack Table** for tables and reports
- **React Hook Form + Zod** for forms and shared validation schemas
- **Lucide** for icons
- **Storybook** for component states and documentation
- **axe-core** and automated interaction tests for accessibility
- A small approved chart wrapper rather than allowing feature code to instantiate chart-library components directly

This combination is widely documented and familiar to coding agents. The risk with shadcn is uncontrolled local modification, so generated components must live in one owned package and feature code must not fork them.

### Required product components

Build and document these before feature proliferation:

- `AppShell`
- `RoleNavigation`
- `PageHeader`
- `DataBoundary`
- `FreshnessBadge`
- `SourceLabel`
- `ReconciliationBanner`
- `StateBadge`
- `MetricTile`
- `InsightCard`
- `AsyncButton`
- `ConfirmAction`
- `MoneySummary`
- `ReceiptPanel`
- `AuditTimeline`
- `QueryTable`
- `FilterBar`
- `ChartWithTable`
- `PersonSearch`
- `SlotPicker`
- `WaiverStatus`
- `OfflineQueueBar`
- `ErrorPanel`
- `EmptyState`
- `StepWizard`

Payment, booking, send, and import states should be modeled as typed discriminated unions. Components must exhaustively render every server state; unknown states fail visibly rather than falling through to “success.”

### Token architecture

Use three token layers expressed as CSS custom properties:

1. **Foundation tokens**  
   Raw spacing scale, radii, elevation, motion duration, breakpoints, type scale, and eventual palette values.

2. **Semantic tokens**  
   Examples:
   - `surface-canvas`, `surface-panel`, `surface-raised`
   - `text-primary`, `text-secondary`, `text-inverse`
   - `border-default`, `border-strong`
   - `action-primary`, `action-secondary`
   - `status-success`, `status-warning`, `status-critical`, `status-processing`
   - `data-native`, `data-imported`, `data-stale`
   - `focus-ring`

3. **Component tokens**  
   Examples:
   - `button-primary-background`
   - `table-row-selected`
   - `freshness-critical-border`
   - `insight-card-emphasis`

Feature code may use semantic or component tokens only—never raw color values or arbitrary spacing. Lint against raw hex values and uncontrolled Tailwind arbitrary values.

The future designer supplies foundation values and may adjust semantic mappings. Layout, states, and component behavior remain unchanged. Tenant branding for the member app should be a validated subset of tokens—logo, action color, surfaces, and type choices—not arbitrary tenant CSS.

### Density

- Default operator density: comfortable but data-efficient
- Front-desk controls: minimum 44px targets, preferably 48px for primary actions
- Reports: optional compact table density saved per user
- Member surface: spacious, single-column, touch-first

Do not provide a global density customizer in v1.

### Dark mode

Do not ship dark mode in v1. It doubles visual QA for status-heavy, data-trust, terminal, chart, and tenant-branding surfaces without supporting a core operating job. The token system should permit it later, but v1 should deliver one rigorously accessible theme.

### Maintenance controls

- Storybook stories must cover loading, empty, stale, critical, offline, processing, failed, and permission-denied states.
- Visual regression tests cover all shared components and core flows.
- Feature code cannot import Radix primitives directly; it imports Kelo components.
- New one-off components require evidence that an existing pattern cannot express the need.
- Component examples include correct TanStack Query integration so agents do not bypass provenance handling.

---

## 6. Accessibility and device strategy

### Accessibility target

Target **WCAG 2.2 AA** for both operator and member surfaces.

This is the appropriate durability target: it is achievable without enterprise-level compliance overhead, improves keyboard and low-vision use on shared workstations, and prevents the future member surface from requiring an accessibility retrofit.

### Keyboard and screen-reader posture

- All workflows must be keyboard-complete, including tables, dialogs, date/slot pickers, menus, and payment status inspection.
- Focus order follows visual order.
- Dialogs trap focus and return it to the initiating control.
- Route changes move focus to the page heading.
- Processing, queued, confirmed, failed, and offline changes use appropriately restrained live regions.
- Status is conveyed through text and iconography, never color alone.
- Charts provide summaries and tabular alternatives.
- Table rows must not be clickable without an actual focusable link.
- Error summaries identify and link to invalid fields.
- Touch targets meet at least 44×44 CSS pixels.
- Support 200% zoom without lost functionality; narrow data tables may scroll horizontally with a clear affordance.
- Respect reduced-motion preferences.
- Session and hold timers provide textual warnings and do not unexpectedly discard completed form work.
- OTP fields support paste, autofill, and assistive technology rather than using isolated inaccessible digit boxes.

### Device strategy by persona

| Persona | Primary device | Best-suited jobs | Explicit limits |
|---|---|---|---|
| Owner | Phone in morning; desktop for operations | Briefing, focus queue, quick outreach approval, alert review; desktop for money, reports, schedule tuning | Do not expect complex import or schedule configuration on phone |
| Front desk | Landscape tablet or shared desktop | Search, booking, POS, waiver, check-in, waitlist | Card payment and booking require network; only check-in degrades offline |
| Trainer | Phone | My day, rosters, attendance permitted by role | No dense business reporting |
| Member | Phone browser | Booking, claiming account, card update, cancellations, balance | No operator-app reuse or vendor portal redirect |
| Assisted admin | Desktop | Onboarding, import exceptions, launch readiness | Not optimized as a self-serve tenant console in v1 |

The SPA decision creates a real first-load risk for the owner’s coffee-line phone use. Mitigate it with route-level code splitting, a very small Today bundle, cached shell assets, prefetch after authentication, and strict performance budgets. Do not load reporting, schedule-editor, terminal, or import code on the Today route.

Shared front-desk sessions should support fast role-aware lock and re-entry, prominently show the signed-in actor, and avoid exposing owner-only information in browser history or cached screens.

---

## 7. Member-facing surface UX (later beta)

The member surface is a separate product experience, not a responsive skin over the operator app. It uses the studio’s domain, branding tokens, policies, and support contact, with no Kelo vendor chrome in the booking funnel.

### Booking funnel

The default funnel should be four conceptual stages:

1. **Choose**
   - Service or offer may be preselected from the incoming link
   - Show earliest real availability first
   - Show total price or credit requirement immediately
   - Provide lightweight date/service filtering
   - Represent waitlist truthfully when full

2. **Identify**
   - Returning members use a low-friction email/SMS code
   - Imported people claim their existing account rather than creating another
   - New members provide only required contact information
   - The response must not reveal whether arbitrary contact details belong to an account

3. **Review and pay**
   - Credits are offered first when eligible
   - Stripe wallet/card options are presented without redirecting to a generic portal
   - Taxes, fees, cancellation terms, and remaining balance are visible before action
   - Missing waiver is completed inline

4. **Confirmed**
   - Durable booking and payment state
   - Receipt
   - Add-to-calendar
   - Directions and arrival guidance
   - Cancel/reschedule action according to policy
   - Pack or credit balance

No forced account-profile completion, marketing opt-in, app download, or password creation may interrupt booking.

### Account claiming

- Ask for email or phone and send a single-use verification code.
- Use neutral responses to prevent account enumeration.
- If both imported phone and email exist, show masked options after the first verification step.
- Resolve duplicate imported profiles through a support-assisted path without losing the held slot.
- On successful claim, merge the verified login identity with the imported person; do not create a parallel account.
- If verification fails, preserve the selected slot while the hold remains valid and offer correction or support.

### Self-service account area

Keep it small:

- Upcoming bookings
- Cancel/reschedule where permitted
- Payment method update
- Pack and credit balance, including expiry
- Receipts
- Waiver status
- Contact details
- Sign out

Do not expose internal segment labels, staff notes, reconciliation data, or operational payment-retry terminology.

### Polish and performance bar

- SSR the initial availability and booking context.
- Keep member JavaScript separate from the operator bundle.
- Avoid full-page reloads between steps.
- Preserve progress after authentication and payment challenges.
- Support browser back without losing the held selection.
- Provide clear recovery for expired holds, failed payment, duplicate submission, and lost connectivity.
- Use real availability only; never show fake scarcity or “someone else is viewing this.”
- Show one final total before payment, with no late fees.
- Meet p95 under one second for initial route and normal step transitions under target load.
- Test on current and one prior major iOS Safari and Android Chrome versions, on mid-range hardware and constrained mobile networks.

The quality threshold is not merely that booking works. A member arriving from Instagram should understand availability, price, identity, and confirmation without learning Kelo’s terminology or encountering a vendor portal.

---

## 8. What you would explicitly NOT design in v1

- **Multi-location switching or portfolio dashboards.** The data model may support them, but visible location controls would add clutter and tenant-boundary risk before the workflow is needed.
- **Self-serve SaaS tenant administration.** Onboarding is assisted; designing generalized provisioning, billing, domain verification, and tenant lifecycle management would distract from studio operations.
- **Custom dashboards, draggable widgets, or user-built reports.** They undermine the decision-first home and create substantial maintenance and accessibility cost. Ship fixed, drillable operational reports.
- **A full CRM journey builder.** Retention outreach should remain segment → review → approve → send. Branching automations and autonomous AI violate the trust model.
- **Autonomous AI sending or schedule publication.** AI proposes; an authorized human approves.
- **Full offline operation.** Only check-in receives a local retry queue. Offline booking, card payment, refund, and schedule mutation would create unacceptable conflict and money risk.
- **Tips, split tender, till management, or advanced cash reconciliation.** These are outside POS v1 and would complicate the 90-second front-desk flow.
- **Arbitrary drag-and-drop scheduling.** Use structured draft changes and publish review. Dragging is imprecise on tablets, difficult to make accessible, and dangerous around existing bookings.
- **Complex waitlist optimization rules.** Support a clear sequential offer flow with expiry and status. Defer configurable ranking, overbooking, and multi-session substitution.
- **Native mobile apps.** Responsive web surfaces and the separate SSR member app cover the defined jobs without adding release and synchronization burdens.
- **Dark mode.** Preserve token support but defer the duplicate QA burden.
- **Medical profiles, health questionnaires, recovery prescriptions, or health recommendations.** Kelo is an operations product and must not collect or present medical information.
- **Social feeds, gamification, leaderboards, or community features.** They do not support the daily decision loop or reliable studio operations.
- **A broad member marketplace.** The member experience remains studio-specific and on the studio’s domain.
- **Final visual identity.** Color palette, typography choice, logo, and illustration remain for the human design pass; v1 engineering should implement only the semantic token and theming architecture they will populate.

=====================
# PLAN B
=====================

---

## 1. Design principles

Each principle is derived from a concrete product goal or known failure mode — not generic craft advice.

**1. Decision, not dashboard.**  
The morning briefing exists because the owner is drowning in data and starving for action. Every primary surface must end in a ranked, one-click path to do something. KPI strips without an “act” affordance are a failure of this principle. The product’s reason to exist is the daily decision loop; everything else is support.

**2. Provenance is a first-class UI element.**  
A prior prototype died by presenting fabricated/stale data as real for ~10 weeks. Trust is the central UX problem. No number, list, or chart may render without an adjacent, scannable freshness/source label. The UI is contractually unable to paint data that lacks `{ as_of, source, stale }` in the envelope. Ambiguous numbers are worse than missing numbers.

**3. Money never lies, never optimizes, never guesses.**  
Failed payments at the desk and opaque refunds are the angriest category of competitor reviews. No optimistic UI for money or bookings. States are explicit: `processing → confirmed | failed | refund_pending`. Every money action produces a member-visible receipt and a queryable retry log. The operator always knows which side of the ledger a dollar is on.

**4. Speed is a feature, lag is lost revenue.**  
Bsport’s #1 complaint is lag. Budget: p95 page load < 1.0s, mutation confirmation < 1.0s. Prefer fewer, denser screens over multi-step wizards. Front desk must complete walk-in + booking + waiver in < 90 seconds while a customer is standing there. Loading states must never feel like waiting — skeleton or inline spinner with known upper bound, not indefinite progress bars.

**5. AI proposes; humans dispose.**  
The AI never sends outreach, never moves money, never publishes schedule changes. Approval is a deliberate ceremony with rationale visible, edit capability, and a clear “you are about to…” confirmation. Per-item useful/not-useful feedback is always one tap away. When AI is unavailable or reconciliation is red, degrade honestly (metrics-only mode, “yesterday’s briefing” badge) — never fabricate.

**6. Role-shaped surfaces, not permission-gated menus.**  
Owner, manager, front_desk, trainer see different homes and different default densities. A front-desk tablet is not an owner laptop with items grayed out. Hide what a role cannot use; don’t disable it. This cuts cognitive load and prevents the “why can’t I click this?” support loop.

**7. Honest empty, honest fail, honest stale.**  
No fixture data in production. Empty, loading, error, stale, and degraded-AI are designed first-class states with copy, recovery actions, and visual treatment — not afterthoughts. A blank screen or a spinner that never resolves is a bug in the design system, not just engineering.

**8. Dense where experts work; sparse where members book.**  
Operator app: information-dense, keyboard-friendly, multi-panel where it helps. Member funnel (later): single-column, thumb-zone, one decision per screen. Do not apply member-app sparseness to the operator tool or operator density to the booking funnel.

---

## 2. Information architecture

### Navigation model

**Primary chrome:** left sidebar (desktop ≥1024px) / bottom tab bar (tablet & phone). No hamburger-primary navigation — frequency of use is too high for buried nav.

**Sidebar sections (owner/manager):**

| Section | Items | Default landing |
|---|---|---|
| **Home** | Morning briefing (single screen) | Yes — for owner |
| **People** | Members, Segments, Outreach history | — |
| **Schedule** | Calendar, Resources/rooms, Waitlist | — |
| **Front desk** | Check-in, Walk-in sale, Today’s roster | Default for front_desk role |
| **Money** | Revenue, Payments, Refunds, Failed/dunning queue | — |
| **Insights** | Utilization heatmap, Credit liability, Reports | — |
| **Health** | Data freshness, Import runs, Alerts, Authority matrix | — |
| **Settings** | Plans, Resources, Staff/roles, Waivers, Studio profile, Integrations | Buried; low frequency |

**Trainer surface:** Schedule (own) + today’s roster only. No Money, no Insights, no Health, no Settings.

**Front desk surface:** Front desk (home) + People (find/create) + Schedule (read + book-on-behalf). No full Money (can take payment and see receipt for the transaction they just ran; cannot refund or run reports). No Health. No Insights. Settings: none.

**Phone (owner, coffee-line mode):** Bottom tabs — Home | People | Schedule | Money (failed-payments badge) | More. Health and Settings live under More. Morning briefing is the entire Home tab; KPI strip collapses to a horizontal scroller; focus queue is full-width cards.

### Screen inventory by persona & frequency

**Owner — daily (one click from Home or tab):**
1. Morning briefing (flagship)
2. Focus queue item detail (failed payment, under-booked session)
3. Segments list + segment people + draft outreach
4. Revenue overview + payment detail
5. Today’s schedule (read)

**Owner — weekly (sidebar, 1–2 clicks):**
6. Utilization heatmap / schedule tuning
7. Credit liability report
8. Outreach history / send log
9. People directory + person profile
10. Refund flow
11. Dunning / card-update chase

**Owner — episodic (Settings / Health, intentionally buried):**
12. Health / data-trust page
13. Import review + quarantine resolution
14. Plan & resource configuration
15. Staff/roles
16. Waiver version management
17. Onboarding checklist (post-launch, archived)

**Front desk — continuous shift:**
18. Check-in board (today’s bookings, search, status)
19. Walk-in / POS sale flow
20. Book-on-behalf flow
21. Person find/create (lightweight)
22. Waiver capture (inline or modal)

**Trainer:**
23. My schedule + roster (read-only attendance mark if permitted)

**Why buried:** Settings, multi-step config, historical import logs, and authority matrix are high-consequence / low-frequency. Burying them prevents accidental edits and keeps the daily surface clean. Health is one click for owners (sidebar) because trust events are time-sensitive, but not on the phone tab bar.

**What is never more than one click for the owner:** briefing → act; failed payment → retry/chase; segment → draft; any number on a report → drill-down.

---

## 3. Core flow specifications

### A — Morning review (flagship)

**Entry:** Open app (auth session present) → `/` resolves to briefing for owner/manager. If session expired, login then land on briefing (not last deep link — the daily loop wins).

**Layout (desktop):**
- Top: greeting + date + global freshness chip (`as_of` of the briefing itself, source: `ai_daily` or `metrics_only`).
- KPI strip (5 metrics: revenue MTD/today toggle, bookings today, walk-ins today, no-shows 7d, attendance rate 7d). Each KPI is a button → drill report. Each shows its own `as_of` / stale badge.
- Main: 2–3 ranked insight cards. Each card: title, one-sentence rationale, primary CTA (“Retry 3 failed payments”, “Review At-risk segment (18)”, “Add Friday 6pm plunge”), secondary “Why this?” expand, useful/not-useful thumbs.
- Right or below: Focus queue — operational items not fully covered by AI cards (failed payments count, under-booked sessions next 24h, waivers expiring, import exceptions). Badge counts. Tap → filtered list.

**Phone:** Stacked — freshness chip → KPI horizontal scroll → insight cards full width → focus queue. CTAs are large, thumb-reachable.

**States:**
| State | What user sees |
|---|---|
| Loading | Skeleton KPI strip + 3 card skeletons; no fake numbers. Hard timeout 3s → error with retry. |
| Empty (day-one, no data) | “Import still running / no activity yet” with link to Health and Onboarding checklist. No fabricated insights. |
| Stale briefing (generated yesterday or data red) | Banner: “Briefing from yesterday · data was stale at generation” + metrics-only KPI strip if live metrics available. |
| AI refused (reconciliation red) | Metrics-only mode. Banner explains why AI withheld insights; link to Health. Focus queue still live from operational queries. |
| AI down | Same as refused; copy differs (“AI temporarily unavailable”). |
| Partial KPI stale | Individual amber/red chips on those KPIs only; others render normally. |
| Act path | CTA navigates to the real operational screen with filters pre-applied (e.g. Money → failed payments last 48h). No separate “AI action” sandbox. |

**Edge cases:** Owner opens at 11pm — still “today’s” briefing until next generation window; label the generation time. Multiple locations later: v1 is single-location, no switcher.

**Feedback loop:** Thumbs on each card write eval signal immediately (toast: “Thanks — this trains tomorrow’s briefing”). Not a modal.

---

### B — Retention outreach

**Entry:** Briefing CTA, or People → Segments.

**Steps:**
1. **Segments list** — name, size, last-touched, trend chip. Sorted by AI priority when arrived from briefing; alphabetical/filterable otherwise. Each row shows segment freshness.
2. **Segment detail** — ranked people table: name, risk rationale (one line), last visit, credits remaining, preferred channel. Multi-select (default: all recommended). Sort by rank (default), last visit, name.
3. **Draft panel** (split view desktop; full-screen step on phone) — for the selection: channel tabs (Email / SMS), AI-drafted body + subject, **rationale sidebar** (“why these people, why this tone”). Owner edits freely. Merge fields preview per selected person (sample of 1, cycle through).
4. **Approval ceremony** — summary: N people, channel, cost estimate if SMS, “AI will not send — you are sending.” Primary button: “Send to N people.” Secondary: save draft / cancel. No “send later” automation in v1 beyond explicit schedule-at (optional, owner-picked time).
5. **Sending** — progress list per person: queued → sent | failed. Failures stay visible with retry. No silent partial success.
6. **Log** — immutable per-person send record: timestamp, channel, body snapshot, operator id. Reachable from person profile and Outreach history.

**States / edges:**
- Empty segment: “No one currently matches. Conditions: …” — not an error.
- Draft generation slow: panel shows “Drafting…” with cancel; on fail, blank editor with “AI draft unavailable — write your own” (never block send on AI).
- Stale segment membership: banner if segment computed `as_of` older than threshold; “Refresh segment” button.
- SMS length / email validation: inline, block send only on hard errors.
- Person missing email/phone for chosen channel: excluded with count explained before send (“3 people skipped — no mobile”).
- **Trust ceremony is non-skippable** — no “don’t show again,” no bulk-send keyboard shortcut that bypasses the summary step.

---

### C — Booking & front-desk ops

**Design north star:** customer is standing there; under 90 seconds for walk-in sale + booking + waiver.

**C1 — Book on behalf / walk-in**

1. **Find or create person** — search by name/phone/email (typeahead, 200ms debounce). If none: “Create person” inline (name + phone or email minimum). Duplicate warning if soft match.
2. **Pick resource + slot** — today’s timeline default; room tabs or list; available slots only (unavailable grayed with reason: booked / blocked / outside hours). Waitlist affordance if full.
3. **Pay** — tender chooser: Terminal (card), Cash, Credits (show balance), Comp (manager PIN/role). Amount from plan/slot price; discount field (manager). Tax line visible. **No optimistic confirm** — button shows spinner until server confirms.
4. **Waiver gate** — if no current-version signature: capture flow (sign on tablet, or send link). Minors: guardian name + acknowledgment. Booking blocks without signature (or interim: allow book but block check-in — product allows interim; UI must show “waiver due at check-in” badge loudly).
5. **Confirmed** — large success state, receipt options (SMS/email/print), “Book another” / “Done.” Member-visible confirmation always fired when contact exists.

**C2 — Check-in**

- Board: today’s bookings, filterable by session/resource, search. Status chips: expected, checked-in, no-show, cancelled.
- Tap → Check in (immediate mutation, wait for server). Mark no-show (with undo window 10s toast).
- **Degraded / offline mode:** when network drops, banner “Offline — check-ins queued.” Actions enqueue locally with local timestamp; UI shows pending-sync icon per row. On reconnect: flush; conflicts (e.g. already cancelled server-side) surface a resolve list — never silent drop.
- Waiver block at check-in if still missing (interim policy).

**C3 — Waitlist**

- Full session: “Add to waitlist” from book flow. Ordered list on session detail. Auto-offer later (product phase); v1: staff notifies / books manually from waitlist with one tap “Book next.”

**States:** payment `processing` (Terminal present), `confirmed`, `failed` (retry or change tender), cash `recorded` (no processor). Double-submit prevented by idempotency key + disabled button after first click.

---

### D — Revenue & billing operations

**Entry:** Money → Revenue overview, or briefing focus queue.

**Revenue overview:** period selector, totals (gross, refunds, net, by tender), failed-payment count CTA, export. Every figure has provenance chip. Drill any total → transaction table.

**Failed payment drill:**
1. List: person, amount, plan/booking, failure reason, age, attempts.
2. Detail: full attempt log, card brand/last4 if any, linked booking.
3. Actions: **Retry now** | **Send card-update link** (starts dunning sequence) | **Write off / cancel entitlement** (destructive, role-gated, typed confirm).
4. State machine visible as timeline: failed → retrying → confirmed | failed again → chase sent → …

**Refund:**
1. From payment detail: Refund → amount (full default; partial allowed) → reason code + note → **typed confirm** (amount + “REFUND”) for full refunds over threshold (recommend > $0 — all refunds confirm; >$100 require typing).
2. Wait for server: `refund_pending` → `refunded` | `refund_failed`.
3. Receipt to member; log entry immutable.

**Rules:** no optimistic money UI; every action has member-visible confirmation when contact on file; retry log always queryable and exportable.

---

### E — Schedule tuning

1. **Heatmap** — day × daypart grid, 30-day fill rate, resource filter. Cell color = fill band; cell click → sessions list.
2. **AI recommendations** panel — e.g. “Add 6pm Friday plunge — 90% fill on adjacent slots.” Each: rationale, accept → opens schedule editor with draft change, dismiss with feedback.
3. **Editor** — adjust recurring or single sessions; conflict detection (overlaps, staff double-book). Changes are **draft** until Publish.
4. **Publish ceremony** — diff summary (added/removed/moved), affected future bookings count, notify-members toggle (default on for cancellations/moves). Confirm publish.
5. **Post-publish** — success + link to affected bookings; failures partial-listed.

**States:** stale utilization data → banner + “figures as of …”. AI down → heatmap only, no recommendations. Empty history (new studio) → “Need 14 days of data for recommendations.”

---

### F — Data-trust surfaces

**Health page (owner):**
- Per-entity freshness table: entity, `as_of`, source (`native` | `import:glofox`), lag, status (green/amber/red).
- Import runs: last N runs, counts, exceptions link.
- Alerts feed: red freshness, reconciliation mismatch, AI refusal events.
- Authority matrix (transition): which system is source-of-truth per entity type — read-only explanation during strangler phase.

**Global patterns (all screens):**
- **Staleness banners:** amber ≥2h, red ≥4h — page-level when primary dataset stale; field-level chips otherwise.
- **Mixed source labeling:** when a screen mixes live-native and imported rows, column or row badges (`Live` / `Imported`).
- **Reconciliation warning:** blocking or strong banner when totals disagree across sources; AI briefing refuses with pointer here.
- **Degraded-AI:** briefing badges “Yesterday” or “Metrics only”; drafts show “AI unavailable.”

---

### G — Onboarding (assisted)

Not self-serve SaaS polish in v1 — assisted, but the UI must let the operator and implementer share a checklist.

1. **Setup checklist** — ordered: studio profile → resources/rooms → plans/products → staff roles → waiver PDF/version → Stripe / Terminal → import → launch-readiness.
2. **Guided config** — one concern per step; save & exit anytime; progress persisted.
3. **Import review** — run summary; **quarantine queue** for exception records (duplicate phones, missing required fields). Resolve: merge / edit / drop. Cannot mark launch-ready with critical quarantine open.
4. **Launch-readiness** — green checks: payments test charge, waiver current, at least one resource + plan, freshness green on core entities, Terminal paired if using card-present.
5. Post-launch: checklist moves to Settings → archived; Health remains the ongoing trust surface.

---

### H — Member booking (beta, later) — see §7 for full treatment

Summarized here for flow completeness: phone-first; availability → slot → pay/credits → waiver → confirmation; claim account for imported members; self-serve card update, cancel, pack balance. Separate SSR app on studio domain. Honest inventory, no fake scarcity.

---

## 4. UI guidelines

### 4.1 Data-trust surfaces

- **Envelope contract in UI:** presentational components that bind money or metrics accept `meta: { as_of, source, stale }` or refuse to render (dev-time assert; prod fallback: “Data unavailable”).
- **Freshness chip:** compact `Live · 12:04` / `Imported · 11:40` / amber `Stale · 2h` / red `Stale · 4h+`. Tooltip with exact timestamp and source.
- **Page banner hierarchy:** red reconciliation > red stale > amber stale > AI degraded. One banner max; highest severity wins; others in Health.
- **Provenance in exports:** CSV/PDF include `as_of` and source columns or footer.
- **Never** use demo/fixture data in production builds — environment hard-split.

### 4.2 Money-action patterns

- **Confirmation:** every money mutation has a review step (amount, person, method, consequences). Destructive (refund, void, comp over threshold): typed confirm.
- **In-flight:** button → spinner, label “Processing…”; disable duplicates; idempotency key client-generated UUID.
- **Terminal states:** badge colors consistent app-wide — processing (neutral pulse), confirmed (success), failed (danger), refund_pending (warning).
- **Receipts:** after success, “Receipt sent to … / Send receipt / Resend.” Member-visible confirmation is mandatory when contact exists; if no contact, force capture or explicit “No receipt” reason.
- **Retry log:** always linked from payment detail; filterable; exportable. Front desk sees the single transaction they ran; owner sees full history.
- **No silent retries** in UI — operator-initiated or clearly labeled system dunning with log entries.

### 4.3 Forms & validation

- Inline validation on blur; re-validate on change after first error.
- Hard block on submit only for hard errors; warnings are non-blocking with explicit “Continue anyway.”
- Prefer single-column forms for entry speed; multi-column only for paired fields (city/state).
- Search-as-select for people and slots — never force IDs.
- Destructive form actions: red button + confirm; never on the primary Enter path without confirm.

### 4.4 Tables, reports, drill-downs

- Default page size ~25–50; virtualize long lists.
- Every primary report metric is clickable → filtered transaction/person list.
- Column picker persisted per role/user; sensible defaults by role.
- Export always available on report tables (CSV); no “request from support.”
- Empty table: illustrated empty + why + CTA (not a blank grid).
- Sticky header + first identity column on desktop.

### 4.5 Notifications & alerts

- **In-app:** focus queue + Health alerts are source of truth. Toast only for direct consequences of the user’s action (sent, refunded, error).
- **No toast spam** for background AI or import completion — badge the relevant nav item instead.
- **Email/SMS to operators** out of band for red freshness / payment processor down (product decision); UI deep-links those to Health or Money.
- Alerts are dismissible only if not currently true; recurring conditions reappear.

### 4.6 Loading / empty / error / degraded (system)

| State | Pattern |
|---|---|
| Loading (initial) | Skeleton mirroring final layout; no layout jump. |
| Loading (mutation) | Button/row-level spinner; section not blanked. |
| Empty | Title + one-line reason + primary CTA. |
| Error (recoverable) | Inline panel: what failed, Retry, link to Health if data-related. |
| Error (page) | Full-page with Retry + Home; preserve route for retry. |
| Stale | Render data + amber/red treatment; do not hide numbers solely for staleness unless reconciliation red and numbers are known-wrong. |
| Degraded AI | Explicit badge; residual non-AI functionality intact. |
| Offline (check-in) | Persistent top banner; queued action icons; conflict resolution on reconnect. |

Copy tone: plain language, no blame, next step always present. No humor on money or waiver failures.

### 4.7 Interaction density & speed

- Prefer split-view master–detail on desktop for People, Money, Segments.
- Keyboard: `/` focuses global search; `j/k` list navigation where tables are primary; `Esc` closes drawers.
- Touch targets ≥44px on front-desk flows.
- Confirmations <1s: if server may exceed, show processing state by 300ms — never leave the old state clickable.

---

## 5. Component system and theming architecture

### Recommendation

**Library:** [shadcn/ui](https://ui.shadcn.com) + **Radix primitives** + **Tailwind CSS**, with **TanStack Table** for data grids and **Recharts** (or Visx if agents cope) for heatmap/ sparklines.

**Why this stack for an AI-agent-built codebase:**
- shadcn is copy-in source, not a black-box dependency — agents can read and edit components locally.
- Radix handles a11y behaviors (focus trap, keyboard) that agents routinely get wrong if hand-rolled.
- Tailwind utility classes are greppable and mechanically refactorable.
- Huge training-data footprint → fewer hallucinated APIs than obscure libraries.
- Avoid: MUI (theme runtime complexity, dense override tax), custom design-system from scratch, Chakra (less agent-idiomatic in 2024–26), heavy Ant Design (opinionated visual debt).

**Do not** introduce a second component library for the member app — share the token package; member app may use a thinner subset of components.

### Tokens / theming architecture

```
tokens/
  color.semantic.json   // --color-bg, --color-surface, --color-danger, --color-warning,
                        // --color-success, --color-info, --color-stale-amber, --color-stale-red,
                        // --color-money, --color-ai-accent
  color.primitive.json  // raw scales — filled later by designer
  space.json            // 4px base scale
  typography.json       // size/weight/line-height tokens; font-family placeholders
  radius.json
  shadow.json
  motion.json           // durations, easings — keep subtle
```

- Semantic tokens only in components (`bg-surface`, `text-danger`) — **never** primitive palettes in app code.
- Visual identity pass later = rewrite primitive → semantic mapping + font-family; **zero component rewrites** if this discipline holds.
- CSS variables generated from tokens; Tailwind maps to those variables.
- **Density:** default `comfortable` for owner; `compact` density token set for front-desk tables (tighter row height). Toggle is product-level per route/role, not a user theme switcher in v1.
- **Dark mode stance:** **ship light-only in v1.** Define semantic tokens so dark can be added by pairing values later; do not implement dark dual-styling now (maintenance cost for agents, front-desk glare environments prefer light anyway). A `prefers-color-scheme` hook is not wired until identity pass.
- **AI-accent** and **stale-amber/red** are semantic from day one — they are product language, not brand decoration.
- **Chart tokens:** sequential and categorical palettes as semantic chart tokens; colorblind-safe defaults (do not rely on red/green alone — pair with pattern or label).

### Component inventory (v1, keep tight)

Layout: AppShell, Sidebar, TabBar, PageHeader, SplitView.  
Data: DataTable, KPIChip, FreshnessChip, ProvenanceLabel, StatusBadge, Heatmap.  
Feedback: Banner, Toast, EmptyState, ErrorState, Skeleton, OfflineBanner.  
Overlays: Modal, Drawer, ConfirmDialog (with typed-confirm variant).  
Forms: TextField, Select, Combobox (people search), DateTime, Toggle, MoneyInput.  
Money: TenderChooser, PaymentStateTimeline, ReceiptPanel.  
AI: InsightCard, DraftEditor, FeedbackThumbs, DegradedAIBadge.  
Front desk: CheckInBoard, SlotPicker, WaiverCapture.

Anything not on this list needs a written reason before creation — custom one-offs are a liability.

---

## 6. Accessibility and device strategy

### WCAG target

**WCAG 2.2 Level AA** for the operator app and member funnel.

**Justification:** boutique studios serve diverse staff and members; keyboard and screen-reader support is table stakes for forms, money, and booking. AAA is not cost-effective for a dense operator tool (contrast on data-heavy tables and charts fights density). AA is the best cost/benefit line: enforceable with linting (eslint-plugin-jsx-a11y), Radix primitives, and axe CI — agent-maintainable.

**Non-negotiables:**
- All money and booking flows fully keyboard-operable.
- Focus order matches visual order; focus visible.
- Status and errors announced via live regions (especially Terminal payment results and check-in offline sync).
- Color never sole channel for stale/failed/success — icon + text.
- Touch targets ≥44px on front-desk and member flows.
- Reduced-motion respected for non-essential animation.

**Screen-reader posture:** operator app is “usable,” not “optimized for daily SR-only power use.” Member funnel should be cleaner SR UX (simpler DOM, linear flow).

### Device strategy by persona

| Persona | Primary device | Jobs | Secondary |
|---|---|---|---|
| Owner-operator | Phone (morning briefing, triage); Desktop (deep work: billing, outreach edit, schedule publish) | A, B, D, E, F | Tablet optional |
| Front desk | Tablet (counter) or shared desktop | C (check-in, walk-in, book, waiver) | Phone not primary |
| Trainer | Phone | Own schedule/roster | — |
| Member (beta) | Phone | H entire funnel | Desktop acceptable but not designed-first |
| Future tenant admin | Desktop | Config | — |

**Responsive breakpoints:**  
- Phone: <768px — owner morning loop + trainer + member funnel.  
- Tablet: 768–1023 — front desk primary; owner usable.  
- Desktop: ≥1024 — owner deep work; sidebar chrome.

**Front-desk specifics:** assume shared device, possibly kiosk-like. Large type option for check-in board; avoid hover-only actions; Terminal flow must work full-screen without needing a second window. Session timeout generous during open hours but re-auth for refunds/comp.

**No native apps in v1.** PWA install optional later; do not depend on it. Member surface is mobile web on studio domain.

---

## 7. Member-facing surface UX (later beta)

### Polish bar

Must match or beat Bsport on: one-thumb booking, clear slot availability, waitlist, instant confirmation. Must beat Bsport on: **speed** (p95 < 1.0s), honesty (no fake scarcity), and brand (studio domain, studio identity — not a vendor portal).

### Funnel (phone-first, SSR app)

1. **Land** — studio-branded availability for sauna/plunge; date scroller; resource filter. Show real remaining capacity; if low, say the real number — never “Only 1 left!” marketing fake.
2. **Slot detail** — time, duration, price / credit cost, what’s included. CTA: Book.
3. **Auth / claim** — if unknown: email/phone + OTP or magic link. If imported unclaimed: “We found a membership for this email/phone — claim” → verify OTP → link history, credits, waivers.
4. **Pay or credits** — saved card, new card (Stripe), or credit pack balance. Show tax and total before confirm. No hidden fees.
5. **Waiver** — if needed, sign in-flow (canvas or typed consent) before confirm. Guardian path for minors.
6. **Confirm** — wait for server (hold → pay → webhook-confirmed states mirrored in simple language: “Processing payment…”, “You’re booked”, “Payment failed — try another card”). 
7. **Confirmation screen** — time, location/room, add-to-calendar, cancel policy summary, pack balance remaining. SMS/email receipt.

**Self-serve post-book (account):** upcoming bookings, cancel (policy-enforced windows, honest copy), pack/credit balance, card update (for dunning links — same UI), waiver status.

### Account claiming

Critical for strangler import: match on verified email or phone; show what will be linked (credits, past visits count — not medical anything); explicit Confirm claim. Ambiguous matches → support contact, not auto-merge.

### What “vendor portal” smells like (avoid)

- Kelo branding in the primary chrome (footer “Powered by Kelo” discreet OK).
- Account screens that expose multi-tenant or operator concepts.
- Lag, multi-step registration before seeing availability.
- Fake timers or misleading urgency.

### States

Same honest-state system: empty days (“No openings Saturday — join waitlist or try Sunday”), payment failed, waiver required, session full. Degraded: if booking service slow, explain; never double-charge (idempotent submit).

---

## 8. What you would explicitly NOT design in v1

| Deferred | Why |
|---|---|
| **Visual identity** (palette, type, logo, illustration) | Owned by design tool + human; we only ship token architecture. |
| **Dark mode** | Token-ready only; implementation cost without brand system is thrash. |
| **Multi-location switcher / cross-location UX** | Model supports it; UI single-location to avoid clutter and agent surface area. |
| **Native mobile apps / offline-first full app** | Check-in degraded queue only; full offline is a product unto itself. |
| **Member social, community feeds, challenges, leaderboards** | Off-mission; recovery studio ops first. |
| **In-app live chat / operator messaging inbox** | Outreach is email/SMS with logs; a full inbox is a support product. |
| **Custom report builder** | Fixed drill-downable reports + export; builders are maintenance black holes. |
| **Tips, split tender, till sessions, cash drawers** | Explicitly out of POS v1. |
| **Self-serve tenant admin / SaaS onboarding polish** | Assisted onboarding only; future phase. |
| **Choose-your-spot maps / seat maps** | Sauna/plunge is resource/time capacity, not seat maps; complexity without demand. |
| **AI autonomous send, auto-refund, auto-publish schedule** | Violates “AI proposes; humans dispose.” |
| **Medical/health data, biometrics, wearable integrations in UI** | Hard product ban. |
| **Complex role editor / per-field ACL UI** | Fixed roles: owner, manager, front_desk, trainer. |
| **In-app help center / tour tooltips everywhere** | Day-one productivity via clear IA and empty states; a tour paper-cuts the dense UI. One optional first-run for briefing only. |
| **Notification preference centers with 20 toggles** | Sensible defaults; expand later when channels multiply. |
| **Animation-heavy / marketing-site motion in operator app** | Speed and clarity; motion tokens exist but stay minimal. |
| **White-label theme editor for studios in operator app** | Member surface inherits studio brand via config, not a full theme IDE in v1. |

---

### Explicit tension with locked engineering (for the record)

1. **No SSR on operator app** — fine for auth-gated SPA, but phone morning briefing will depend entirely on client fetch + cache. UX mitigation: aggressive TanStack Query hydration from a warm cache, skeleton that matches final layout, and service-worker **only** if it does not risk stale-as-fresh (prefer no SW caching of API data; freshness > offline shell). If briefing open rate suffers on cold cellular, revisit edge-cached read models later — do not violate the freshness contract with a stale shell that looks live.

2. **No optimistic UI for bookings** — correct for trust; front-desk 90s budget still achievable if p95 mutation <1s. UX must invest in perceived speed (instant field feedback, prefetched slot grids) so the wait is only on the final confirm.

3. **Interim waiver-at-check-in vs block-at-book** — dual policy is a UX footgun. Recommend: one studio-level policy flag, surfaced clearly in Settings and as badges on bookings; do not mix behaviors silently per flow.

---

This plan is intentionally dense and opinionated so a designer can own visuals later without reopening structure, and so AI coding agents inherit a small, greppable component and state vocabulary rather than an unbounded UI surface.

=====================
# PLAN C
=====================

1. Design principles
---------------------

Each principle is derived from a specific product goal, failure mode, or competitive bar in the brief.

### 1. Decision-first, not dashboard-first
The owner’s morning loop is the product’s reason to exist. Home is not a dashboard; it is a ranked queue of *actions* with one-tap paths to resolution. Every insight must answer “What do I do now?” If a metric does not have an associated action, it is hidden or reachable only by drill-down.

### 2. Provable truth over presentation
The prior prototype died because fabricated/stale data looked real for 10 weeks. Every data surface must carry provenance and freshness metadata; the UI is contractually unable to render a number without its envelope. Trust is not a tooltip; it is visible, scannable, and non-dismissible.

### 3. Honest state machines for money and capacity
Money and booking states must be shown as explicit states, not optimistic assumptions. Pending, processing, confirmed, failed, refund-pending, and retry-scheduled are first-class visual states with member-visible receipts and queryable logs. This prevents the “failed payment at the desk” humiliation that dominates incumbent reviews.

### 4. Speed is a trust signal
Bsport’s studios lose revenue to lag. Kelo weaponizes speed: p95 page load <1s, mutation confirmation <1s. Loading states are content-aware skeletons, not spinners; front-desk flows are default-heavy so the 90-second walk-in target is met by design.

### 5. One conversation, one surface
Front-desk work happens while a customer is standing at a counter. Booking, payment, waiver, and receipt must live in a single modal/pane with a clear stepper, large touch targets, and no navigational dead ends.

### 6. AI drafts; humans decide
The AI never sends, books, refunds, or schedules autonomously. Approval is a deliberate “trust ceremony”: the owner sees the AI’s rationale, edits the draft, and confirms. Feedback (useful / not useful) is captured per item to feed the eval loop.

### 7. Progressive disclosure, not shallow dashboards
Density is a feature for the owner. The morning view shows 2–3 ranked cards; everything else is one tap away. Tables support sorting, filtering, inline drill-down, and one-click export. The UI is deep, not wide.

### 8. Fail visible, fail safe
Loading, empty, stale, error, and degraded/offline states are designed first-class, not afterthoughts. When the network drops at check-in, the app queues locally and surfaces conflicts. When AI is down, the UI explains why and falls back to metrics-only mode with manual actions.

---

2. Information architecture
---------------------------

### Navigation model

| Layer | Contents | Rationale |
|---|---|---|
| **Global header** | Studio name, universal search (Cmd/Ctrl+K), data freshness indicator, notification bell, user menu | Available on every screen; search lets front desk jump straight to a person/booking |
| **Primary nav** (desktop left rail / mobile bottom bar) | **Home**, **Book**, **Schedule**, **People**, **Money**, **Outreach**, **Insights**, **Admin** | Ordered by frequency for the owner-operator; front desk sees Book/Check-in first via role-based nav |
| **Contextual action bar** | Screen-level primary action (e.g., “New booking”, “Retry failed payments”, “Publish schedule”) | Keeps the one-conversation flow intact |
| **Home cards** | Each briefing card links directly to its action screen | Decision-first: one tap from insight to action |

**Mobile:** bottom tab bar with Home, Book, Schedule, People, More.  
**Desktop:** collapsible left rail with icon + text labels and tooltips.

### Screen inventory by persona and frequency

| Screen | Primary persona | Frequency | Depth | Notes |
|---|---|---|---|---|
| **Home / Morning Briefing** | Owner | Daily | 0 | KPI strip + 2–3 AI cards + focus queue |
| **Failed Payments queue** | Owner | Daily | 1 click from Home | Actionable list with one-click retry / card-update link |
| **Outreach / Segments** | Owner | 2–3×/week | 1 | Segment cards → ranked people → approval pane |
| **Revenue dashboard** | Owner | 2–3×/week | 1 | KPIs + transaction list + drill-down |
| **Transaction detail** | Owner / Manager | As needed | 2 | State timeline, refund, retry log |
| **Schedule / Day view** | Front desk, Trainer | Daily | 0–1 | Bookings grid, check-in, no-show |
| **Schedule Tuning / Heatmap** | Owner | Weekly | 2 | Demand heatmap + AI recommendations |
| **Quick Book modal** | Front desk | Many ×/day | 0 (global button) | Find person → slot → pay → waiver → confirm |
| **Check-in** | Front desk / Trainer | Many ×/day | 1 | Search/scan + offline queue |
| **People / Member lookup** | Front desk | Many ×/day | 0–1 | Search, profile, credits, waivers, history |
| **Waiver capture** | Front desk | As needed | Inline | Signature or guardian acknowledgment |
| **POS / Walk-in sale** | Front desk | Many ×/day | Inline within Quick Book | Card terminal, cash, credits, comp |
| **Insights / Reports** | Owner | Weekly | 2 | Core reports, export, drill-down |
| **Data Health** | Owner | Daily early on, then weekly | 1 (under Admin or global freshness badge) | Per-entity freshness, reconciliation, quarantine |
| **Settings / Integrations** | Owner / Manager | Setup + monthly | 2 | Glofox/Stripe connect, team roles, waivers, rooms |
| **Onboarding checklist** | Owner (assisted) | Once | 0 until complete | Guided setup + import review |
| **My Schedule / Roster** | Trainer | Daily | 0–1 | Minimal read-only-ish surface |

### What is one click away vs. buried

- **One click from Home:** failed payments, outreach segments, under-booked sessions, revenue KPI drill-downs, schedule recommendations, data-health alerts.
- **One click from global search:** any member, booking, or transaction.
- **Buried two clicks or more:** team role configuration, import quarantine resolution, report export settings, plan/resource defaults. These are setup or exception surfaces, not daily-loop surfaces.
- **Not shown to Front desk/Trainer:** Outreach, Schedule Tuning, Revenue refund authority (unless manager role), Data Health, Admin settings.

---

3. Core flow specifications
---------------------------

Each flow includes: (a) happy path, (b) key states, (c) edge cases, (d) slow / empty / stale / failing behavior.

### A — Morning review (flagship)

**Entry:** owner opens app. App checks `/briefing` cache and freshness.

1. **Header strip** loads KPIs (revenue, bookings, walk-ins, no-shows, attendance). Each metric has a provenance chip.
2. **AI briefing cards** appear as 2–3 ranked cards. Each card shows: title, delta, one-line rationale, primary action, secondary “useful / not useful” feedback.
3. **Focus queue** lists: failed payments count, sessions under-booked in next 24h, expiring credit packs, overdue waivers.
4. Owner taps a card → routed to the action screen.
5. Owner rates a card with thumbs up/down → captured as eval signal.

**States:**
- **Loading:** content-aware skeleton for KPIs and briefing cards; focus queue shows placeholder rows.
- **Empty (first run):** replace briefing with onboarding checklist; no fabricated demo data.
- **Stale:** global amber/red banner; each stale metric chip turns amber/red; briefing card shows “As of yesterday.”
- **AI down / reconciliation red:** briefing refuses to generate; UI shows metrics-only mode with a prominent explanation and a manual action queue.
- **Error:** retry button; if KPI endpoint still works, fall back to KPI-only view.

**Edge cases / slow/failing:**
- If briefing generation is still running when owner opens app, show “Generating today’s briefing…” progress state and the previous day’s metrics below.
- If reconciliation is red, block AI card generation but surface the conflict as the top actionable item.
- If KPI data is mixed live + imported, label each metric individually.

### B — Retention outreach

1. Owner navigates to **Outreach**. Sees segment cards: “At-risk: 18 people,” “Win-back: 7,” etc. Each shows size, expected revenue at risk, last refreshed, AI confidence.
2. Taps a segment → **ranked people table**. Columns: name, last visit, reason, channel, draft preview.
3. Taps a person (or multi-selects) → **approval pane** opens. Shows AI rationale, editable message, channel toggle (email/SMS), send-now/schedule, personalization tokens.
4. Owner edits or approves → taps **Send**.
5. Mutation is idempotent; per-person status updates to “sending → sent/delivered/failed.”
6. A log entry is written to the member’s comms timeline.

**States:**
- **Loading:** skeleton segment cards and table rows.
- **Empty segment:** message “No one matches this segment right now. Kelo will check again tomorrow.”
- **Stale segment data:** amber badge on segment card; owner can refresh.
- **AI draft poor:** owner edits inline or clicks “Regenerate draft.”
- **Send failure:** row turns red with retry button and error reason; log shows failure.
- **Unsubscribed member:** channel disabled with note “Unsubscribed; cannot send.”

### C — Booking & front-desk ops

> **UX disagreement:** The locked “no optimistic UI for money or bookings” decision directly taxes the front-desk 90-second target and the Bsport speed bar. Perceived speed will be lower than actual speed. The design mitigates this with server-side tentative holds, a progress stepper, large default selections, and terminal-state clarity — but the policy remains a measurable conversion risk.

**Entry:** front desk taps global **Book** button or selects a slot on the schedule.

1. **Find / create person**  
   - Search by name, phone, email.  
   - Create new contact inline with phone mask and duplicate warning.  
   - Show credits/packs, waiver status, membership holds.
2. **Pick slot**  
   - Default to today, next available. Filter by sauna / cold plunge.  
   - Selecting a slot calls the server for a tentative hold; UI shows “Held for 5:00” countdown.  
   - Display price, credits required, remaining capacity.
3. **Pay**  
   - Tabs: Card terminal, Cash, Credits, Comp.  
   - **Card terminal:** initiate Stripe Terminal; show reader status (ready / processing / tap card).  
   - **Cash:** large number pad, amount tendered, change due. Manager PIN for over/under.  
   - **Credits:** deduct from pack/balance, show remaining.  
   - **Comp:** reason required; manager PIN required.  
4. **Waiver**  
   - If waiver is missing or expired, present e-signature pad or guardian checkbox for minors.  
   - Booking cannot be confirmed without current waiver.
5. **Confirm**  
   - Summary, receipt options (email/SMS/print), booking ID.  
   - One-tap “Start next booking” resets the modal.

**Check-in sub-flow:**
- Search/scan → show today’s booking → tap check-in.
- Degraded/offline: store in local retry queue, show “Will sync” badge; on reconnect, surface conflicts if already checked in elsewhere.

**No-show / waitlist:**
- No-show: from schedule, tap no-show → confirmation dialog → updates attendance.
- Waitlist: if slot full, offer “Add to waitlist”; when slot opens, notify front desk and member; v1 does not auto-reallocate without owner opt-in.

**States:**
- **Processing:** lock submit button, show stepper with active step “Processing payment…”.
- **Payment failed:** return to pay step with error reason, preserve slot hold if still valid, suggest alternative payment.
- **Stale schedule data:** banner “Schedule last updated 20 min ago”; refresh before booking.
- **Offline:** local queue mode with clear sync status.
- **Empty search:** “No member found. Create new contact?” with one-tap create.

### D — Revenue & billing operations

1. **Revenue dashboard** loads KPI strip (today, this week, month) and a transaction list.
2. Owner filters by status, date range, source (POS, member booking, import).
3. Taps a **failed payment** row → detail view.
4. Detail shows state timeline: initiated → failed at timestamp → reason → retry count.
5. Actions: **Retry now**, **Send card-update link**, **Write off / escalate**, **View retry log**.
6. Refund: from any confirmed transaction, tap **Refund** → amount (full/partial) → reason/category → manager PIN if required → mutation → status moves to refund-pending → confirmed via webhook.

**States:**
- **Processing:** primary action disabled, inline spinner, “Do not close this screen.”
- **Failed retry:** timeline updated with new failure reason and next scheduled retry.
- **Refund pending:** row locked from further refund until webhook confirms.
- **Reconciliation warning:** inline banner if imported payment totals disagree with native records; link to Data Health.
- **Empty:** “No transactions in this period” with presets to common ranges.

### E — Schedule tuning

1. **Schedule heatmap** shows day × daypart grid, 30-day fill %, revenue per slot. Provenance chips distinguish imported attendance from live bookings.
2. **AI recommendations panel** lists ranked cards: e.g., “Add 6pm Friday plunge; projected +$420/wk; confidence 78%.”
3. Owner taps a recommendation → preview shows new slot, projected impact, conflicts.
4. Owner adjusts: add/edit slot, duration, capacity, recurrence, pricing.
5. Taps **Publish** → server validates → schedule updates → live on booking surfaces.

**States:**
- **Loading:** skeleton grid and placeholder recommendations.
- **Empty / new studio:** “Not enough attendance data yet. Start with your default schedule.”
- **Stale imported data:** grid cells show amber badge; hover shows last import time.
- **AI unavailable:** show manual schedule editor with a note; recommendations hidden, not broken.
- **Conflict:** if editing a slot with existing bookings, modal offers reschedule or cancel-with-notify.

### F — Data-trust surfaces

1. **Data Health page** (owner-only, reachable from freshness indicator or Admin) shows per-entity table:
   - Entity (members, bookings, payments, schedule, roster)
   - Source (Glofox import, native, Stripe)
   - Last successful run / next scheduled
   - Record counts
   - Reconciliation status
   - Action (re-run import, view quarantine)
2. **Quarantine list** shows exception records with reason, source row preview, actions: create as new, merge, ignore.
3. **Staleness banners** appear globally when any critical data crosses ≥2h (amber) or ≥4h (red).
4. **Degraded-AI modes:**
   - Briefing stale → card badged “Yesterday’s briefing.”
   - Reconciliation red → metrics-only mode with explanation and manual action queue.

**States:**
- **Import running:** progress bar, entity-level status, estimated records.
- **Import failed:** red row, error message, one-click retry.
- **Empty quarantine:** “No exceptions — all records reconciled.”
- **Authority transition:** each entity row labels the current source of truth (Glofox vs Kelo native); writes disabled for import-only entities.

### G — Onboarding (assisted)

1. **Setup checklist** persists progress: connect Glofox, connect Stripe, configure rooms/services, import data, review exceptions, set waivers, invite team, launch readiness.
2. **Guided plan/resource config:** wizard for sauna/cold plunge rooms, capacities, default durations, pricing, operating hours.
3. **Import review:** side-by-side source vs imported counts; quarantined records grid.
4. **Launch readiness check:** data freshness green, reconciliation green, test payment succeeded, waiver configured, at least one schedule published.

**States:**
- **Incomplete:** next step highlighted, disabled launch button.
- **Validation error:** inline error on the offending field, checklist item turns red.
- **Import exception:** checklist item badge with count; link to quarantine.
- **Assisted context:** in-app guidance + help panel; CS can share screen.

### H — Member booking (beta, later)

1. **Landing** on studio domain from Instagram link: studio branding, service selector (sauna / cold plunge / combo).
2. **Availability:** phone-first calendar + time slots; <1s load; real-time capacity; no fake scarcity.
3. **Pick slot:** show price, tax, cancellation policy before payment.
4. **Authentication / account claiming:**
   - Returning member: sign in or use magic link.
   - Imported member: enter email/phone → OTP/code → set password → claim imported credits/packs.
   - Guest checkout: optional, with email for receipt.
5. **Payment:** Apple Pay / Google Pay / saved card / new card; credits/packs if signed in.
6. **Waiver:** if needed, e-signature with guardian flow for minors.
7. **Confirmation:** booking ID, add to calendar, share, self-serve link.

**Self-serve account:**
- Update card, view bookings, cancel with policy (refund/credit), pack balance.

**States:**
- **Slot taken during browse:** live refresh + toast “This slot just sold out.”
- **Payment processing:** clear progress indicator, no duplicate submit.
- **Payment failed:** inline error + retry without re-entering slot.
- **Empty availability:** suggest nearest alternative times.

---

4. UI guidelines
----------------

### Data-trust surfaces

- **Every data component receives `meta: { as_of, source, stale }` and renders a provenance chip.** No exceptions. In development, missing meta throws a console error.
- **Provenance chip placement:** top-right of KPI cards, inline before metric value in tables, in list row metadata. Tooltip on hover shows exact timestamp and source system.
- **Freshness thresholds:** amber ≥2h, red ≥4h. Red triggers a persistent global banner with a link to Data Health.
- **Reconciliation warnings:** inline banner at the top of the affected screen, not a modal. Color-coded by severity; action button leads to quarantine.
- **Authority matrix:** during transition, labels like “Source of truth: Glofox (read-only)” or “Source of truth: Kelo” appear on edit screens so users know why a field is locked.

### Money-action patterns

- **State timeline:** every money mutation displays a vertical timeline: initiated → processing → confirmed/failed/refund-pending. Each node has timestamp and source.
- **No double-submit:** primary action disabled and shows processing state until server confirmation; unlock only after terminal state.
- **Destructive protection:** refunds, comps, and voids require a two-step confirmation and, for refunds/comps, a manager PIN. Show the amount and reason before final confirm.
- **Receipts:** every transaction produces a receipt screen with booking details, payment method, amount, tax, and a “Send again” action. Receipts are queryable from the member profile and transaction detail.
- **Retry log:** failed payments and refund retries have a queryable, exportable log with timestamps, outcomes, and next scheduled retry.

### Forms and validation

- **Inline validation on blur** for format errors; **submit-time validation** for business rules.
- **Top-of-form error summary** for server errors, with field-level anchors.
- **Input masks:** phone, currency, date.
- **Smart defaults:** front-desk forms default to today, next available slot, last-used payment method.
- **Disable submit** until required fields are valid, except front-desk flows where “Save draft” is offered to avoid losing mid-conversation progress.
- **Duplicate detection:** creating a member triggers fuzzy-match warnings before creation.

### Tables, reports, and drill-downs

- **Base component:** TanStack Table with consistent sorting, filtering, pagination, and row selection.
- **Density:** compact on desktop, comfortable on tablet, card-based on mobile.
- **Drill-down:** row click opens detail; right-click or “…” menu for common actions.
- **Export:** one-click CSV/PDF export on every report; no manual CSV assembly.
- **Empty states:** explain why empty and provide the logical next action.
- **Sparklines/KPIs:** use simple HTML/CSS bars, not heavy charting libraries, to preserve the <1s load budget.

### Notifications and alerts

- **Toast:** only for non-blocking success/confirmation (e.g., “Receipt sent”).
- **Persistent notification center:** for money failures, AI issues, import failures, waitlist openings.
- **Inline banners:** for stale data, reconciliation warnings, offline mode.
- **Modal alerts:** reserved for destructive actions, legal/irreversible confirmations, and offline-conflict resolution.
- **Batch routine successes:** do not toast every successful import; only surface failures and completion summaries.

### Loading / empty / error / degraded states (designed system)

Define four reusable templates used on every screen:

1. **Loading skeleton** — content-aware shapes that mirror the final layout. Never a generic spinner over a blank screen.
2. **Empty state** — headline, one-sentence explanation, primary action. No decorative placeholder data.
3. **Error state** — clear message, error code (for support), Retry button, and a safe fallback when possible.
4. **Degraded state** — persistent banner explaining what is limited, plus the subset of data/actions that still work.

**Offline / degraded check-in:** local retry queue is visible in a bottom sheet; conflicts surfaced as cards with resolution actions.

---

5. Component system and theming architecture
--------------------------------------------

### Recommended library: shadcn/ui

**Rationale:** shadcn/ui is a set of copy-paste Radix primitives wrapped in Tailwind. It is boring, well-documented, widely used, and ideal for an AI-coding-agent team: components live in the repo, are version-pinned, and can be regenerated or extended without fighting a black-box design system.

**Supporting stack:**
- **Primitives:** Radix UI (via shadcn)
- **Styling:** Tailwind CSS
- **Forms:** react-hook-form + zod
- **Tables:** TanStack Table
- **Icons:** Lucide React
- **Date/calendar:** native date components built on top of shadcn Calendar; avoid heavy third-party date libraries.

**Do not build custom one-off components.** If a component cannot be composed from shadcn + Tailwind, it needs a written justification and a plan for reuse.

### Component inventory tied to flows

| Component | Used in |
|---|---|
| `BriefingCard` | Morning review |
| `FocusQueueItem` | Morning review |
| `FreshnessChip` / `ProvenanceBadge` | Every data surface |
| `MoneyTimeline` | Transaction detail, refunds, retry log |
| `ApprovalPane` | Outreach |
| `QuickBookModal` / `BookingStepper` | Front-desk booking |
| `TerminalStatus` | POS card payment |
| `WaiverSignature` | Front desk, member beta |
| `HeatmapGrid` | Schedule tuning |
| `RecommendationCard` | Schedule tuning, outreach |
| `DataHealthTable` | Data trust |
| `QuarantineRow` | Onboarding, data health |
| `NotificationCenter` | Global |
| `CommandMenu` | Global search |
| `EmptyState` / `Skeleton` / `ErrorFallback` | System-wide |

### Token architecture

Use **CSS custom properties** (HSL values) so theming is runtime-swappable and future-brand-ready.

**Primitive tokens** (replaceable by visual identity later):

```css
--color-neutral-50...950
--color-brand-50...950
--color-success-50...950
--color-warning-50...950
--color-danger-50...950
--color-info-50...950
```

**Semantic tokens** (components consume these, not primitives):

```css
--background-default
--surface-elevated
--surface-overlay
--text-primary
--text-secondary
--text-disabled
--border-subtle
--border-strong
--focus-ring
--state-success-bg
--state-warning-bg
--state-danger-bg
--state-info-bg
--data-live
--data-imported
--data-stale
```

**Typography tokens:**

```css
--font-sans
--font-mono  /* for timestamps, IDs, retry logs */
--text-xs...text-4xl
--font-regular
--font-medium
--font-semibold
--line-height-tight
--line-height-normal
```

**Spacing, radius, elevation, motion:**

```css
--space-1...space-16
--radius-sm...radius-xl
--shadow-sm...shadow-xl
--duration-fast
--duration-normal
--ease-in-out
```

### Density

- **Desktop operator app:** `density="compact"` — smaller padding, tighter row height, more rows visible.
- **Tablet front desk:** `density="comfortable"` — larger tap targets, bigger buttons.
- **Mobile:** `density="comfortable"` with card-based layouts.

Density is toggled via a data attribute or class that adjusts tokenized spacing/typography.

### Dark mode stance

**Support dark mode from day one via the `dark` class strategy.** All semantic tokens have dark variants. Default to light mode, but the architecture makes switching a single class/config change. This prevents rework when visual identity is applied and meets staff preferences.

### How visual identity plugs in later

1. Designer replaces primitive color values in one theme file.
2. Semantic tokens automatically propagate through components.
3. Typography tokens map to the chosen typeface.
4. Border radius and shadow tokens apply the brand’s elevation language.
5. No component rewrites are required unless new patterns are introduced.

---

6. Accessibility and device strategy
------------------------------------

### WCAG target

**Adopt WCAG 2.2 Level AA as the baseline, with AAA contrast for money amounts, status badges (success/warning/danger), and data-trust indicators.** AA is the defensible minimum for a B2B SaaS with employee users; AAA for money/status reduces error risk and legal exposure. The incremental cost is low because the component library and token system are built with contrast in mind from the start.

### Keyboard posture

- All interactive elements reachable via Tab in logical order.
- Global **Cmd/Ctrl+K** command palette for search and navigation.
- Modal dialogs trap focus and restore focus on close.
- Skip-to-content link on every screen.
- Front-desk flows support Enter to advance step when safe.

### Screen-reader posture

- Semantic headings (`h1`–`h3`) define page structure.
- ARIA live regions announce staleness changes, money state transitions, and check-in sync status.
- Every icon button has an `aria-label`.
- Form inputs use persistent visible labels; placeholders are supplementary only.
- Error messages are associated with fields via `aria-describedby`.
- Respect `prefers-reduced-motion`.

### Device mapping

| Persona | Primary device | Jobs | UX implication |
|---|---|---|---|
| **Owner-operator** | Phone (morning); desktop/tablet (deep work) | Morning briefing, quick actions, billing, outreach, schedule tuning | Thumb-friendly cards on phone; dense tables on desktop |
| **Front desk** | Tablet at counter (landscape); shared desktop | Check-in, walk-in booking, POS, waiver capture | Large touch targets, split-pane modals, always-visible search |
| **Trainer/staff** | Phone | View schedule/roster, check-in | Minimal, read-focused surface |
| **Member (beta)** | Phone | Book, pay, cancel, update card | Phone-first funnel; desktop fallback only |
| **Future tenant admin** | Desktop | Assisted onboarding, multi-tenant config | Not self-serve in v1 |

---

7. Member-facing surface UX (later beta)
----------------------------------------

### Booking funnel

The entire funnel lives on the studio’s own domain; no vendor portal is visible.

1. **Landing** — studio hero, service selector, location. Loads <1s.
2. **Availability** — calendar + time slots; real-time capacity; filter by service; clear pricing including tax.
3. **Slot selection** — show duration, room, price, cancellation policy, any pack/credit balance.
4. **Identity** — sign in, magic link, account claim, or guest checkout.
5. **Payment** — Apple Pay / Google Pay / saved card / new card / credits.
6. **Waiver** — e-signature, guardian flow for minors.
7. **Confirmation** — booking ID, add to calendar, share link, “Book another.”

### Account claiming for imported people

- Member enters email or phone from studio records.
- System sends OTP/code.
- Member verifies, sets password, sees imported profile including active packs/credits and upcoming bookings.
- If no match, route to guest checkout or prompt to contact studio.

### Self-serve account

- View upcoming/past bookings.
- Cancel with policy clearly shown before confirmation; refund or credit automatically applied per studio rules.
- Update saved card.
- View pack/credit balance.

### Polish bar

- **One-click booking** for returning members with saved payment and waiver: service → slot → confirm.
- **Honest UX:** no fake scarcity timers, no hidden fees, full price shown before payment.
- **Speed:** p95 <1s for availability and confirmation.
- **White-label:** brand colors, logo, and tone from studio; Kelo branding invisible.

---

8. What you would explicitly NOT design in v1, and why
------------------------------------------------------

| Item | Why it is out of v1 |
|---|---|
| **Multi-location switcher UI** | The data model supports multi-location, but v1 ships single-location to avoid navigation clutter. The location context is baked into APIs/DB so adding a switcher later is a UI-only change. |
| **Self-serve tenant onboarding** | Studio setup involves Glofox/Stripe credentials, import reconciliation, and waiver config. An assisted flow reduces failed activations and trust failures. |
| **Advanced POS features: tips, split tender, till management** | Locked engineering decision. Tips/split tender add UI complexity and reconciliation risk that the v1 team cannot safely support. |
| **Native iOS/Android apps** | Web app covers all personas; app store review, updates, and maintenance are a liability for a small team. PWA is sufficient if needed. |
| **Complex staff scheduling / shift management** | Trainers only need roster/schedule visibility in v1. Full shift management is a separate product surface. |
| **Loyalty / rewards program beyond retention outreach** | Out of scope; the AI-assisted retention flow is the v1 retention surface. |
| **In-app chat / AI assistant outside the briefing** | Adds surface area and ambiguous trust boundaries. The briefing + approval pattern is the only AI surface in v1. |
| **Advanced analytics / custom report builder** | Core reports with export satisfy success criteria. Custom builders are a maintenance liability. |
| **Health, medical, or biometric data** | Explicitly prohibited. No HRV, BMI, diagnosis, or recovery-score UI anywhere. |
| **Automated AI send/auto-book/auto-refund** | Product principle: AI drafts, humans decide. Autonomy is out forever, not just v1. |
| **Social / community features** | Not part of the daily operations loop; defers platform risk. |
| **Full white-label email/SMS template designer** | Outreach messages are editable per draft; a full template designer is not needed to prove retention value. |

---

This plan gives the future visual designer a complete behavioral, structural, and tokenized foundation. The architecture is opinionated, agent-maintainable, and built so that colors, type, and brand identity can be dropped in later without restructuring screens or components.

=====================
# PLAN D
=====================

by the brief; everything structural, behavioral, and systemic is in scope.*

---

## 1. Design principles

Each is derived from a named failure mode or product goal — these are the doctrines an AI coding
agent should be able to apply mechanically when the plan is silent:

1. **Provenance or nothing.** Every displayed number wears its freshness and source; "stale" is a
   designed visual state, not an apology. A screen that cannot show provenance does not render the
   number. *(From the 10-week fabricated-data failure — the product's founding trauma.)*
2. **A decision, not a dashboard.** The home screen ranks 2–3 actions with verbs attached; charts
   live one level down as *evidence* for decisions, never as the destination. If an insight has no
   one-click action, it doesn't belong on Today. *(Objective 3.)*
3. **Money states are unambiguous.** `processing / confirmed / failed / refund pending` are
   visually distinct by shape + icon + color (never color alone), rendered only from server truth.
   No optimistic UI for money or bookings — the sub-1s confirmation budget is met by being fast,
   not by lying first. *(Competitive bar §2; incumbent horror stories.)*
4. **The counter test.** Every front-desk flow must pass: completable in ≤90 seconds, one-handed
   on a tablet, while talking to a customer, resumable after interruption, with targets ≥44px.
   *(Success criterion 6.)*
5. **Empty states teach; error states point home.** Every empty state names what will fill it and
   offers the action that does; every error state says what failed, what's preserved, and the one
   next step. Neither ever shows placeholder data. *(Honest-states mandate.)*
6. **Speed is a feature with a budget.** Skeletons over spinners, cached-then-revalidate reads,
   route-level code splitting, no layout shift on load. Any interaction >200ms shows progress;
   >1s is a design defect to fix, not a spinner to prettify. *(Bsport's #1 complaint is the
   winnable gap.)*
7. **One pattern per job.** A small, closed vocabulary of interaction patterns (defined in §4)
   applied uniformly. A new screen composes existing patterns; inventing a new pattern is an
   explicit design decision, not a Tuesday. *(Agent-built codebase: novelty is a defect vector.)*
8. **Approval is a ceremony.** AI output is visibly draft-shaped (distinct surface treatment)
   until a human approves it; the approve moment shows exactly what will happen ("Send SMS to 18
   people, ~$0.14, within quiet hours ✓") and is logged. *(The AI-never-sends rule made visible.)*

---

## 2. Information architecture

### Navigation model

**Operator app (owner/manager), desktop:** persistent left rail, 5 primary + overflow.
**Phone:** bottom tab bar with the same 5. **Role-based landing:** owner/manager → Today;
front_desk → Desk; trainer → My Schedule.

| Primary nav | Contents | Why this altitude |
|---|---|---|
| **Today** | Briefing, KPI strip, focus queue, setup checklist (until complete) | The daily loop is the product; it owns position 1 and the app icon's landing |
| **People** | Search, segments, person profiles, merge review, leads | Second-most-frequent owner destination; outreach entry point |
| **Schedule** | Week/day calendar, demand heatmap, AI recommendations, publish | The tuning loop (flow E) |
| **Money** | Revenue overview, payments (w/ failed-first filter), dunning queue, refunds, payouts | Flow D; "failed payments" is one click from anywhere via focus queue |
| **Marketing** | Outreach drafts/approvals, campaigns, automations, send log | Flow B's home |
| *Overflow ("More")* | Reports, Retail & gift cards, Staff, Waivers, Health, Settings | Weekly-or-rarer jobs; deliberately buried to keep the rail honest |

**Desk (front-desk surface):** a separate route group, tablet-first, reachable from the rail but
designed to live full-screen at the counter: **Check-in · Book · Sell · Find person**. Four fat
tabs, no rail, no reports. It is the same app (same session, role-gated), not a second codebase.

**Global chrome:** freshness chip (top right; per-screen worst-of-sources, tap → Health);
alert bell (import/money alerts, badge count); ⌘K command palette (person search, "new booking,"
"refund payment…" — power-path for everything, and the agent-friendliest way to add actions
without new chrome); quick-add button (+): booking / person / sale.

**Click-depth rules:** anything in the focus queue resolves in ≤2 clicks from Today. Any person
reachable in ≤2 interactions from anywhere (palette → name → profile). Reports are ≤3 clicks and
never dead-end — every aggregate drills to the row level.

### Screen inventory (operator, v1 — 24 screens, each named with its writer feature)

Today · Briefing archive · People index · Person profile (tabs: overview, visits, credits,
payments, comms, waivers) · Segments index · Segment detail · Merge review · Schedule calendar ·
Heatmap · Recommendation review · Session/slot detail (roster) · Money overview · Payments index ·
Payment detail (timeline) · Dunning queue · Refund flow (modal) · POS/Sell · Retail catalog ·
Gift cards · Outreach approvals · Campaign/automation list + detail · Send log · Staff & roles ·
Waivers admin · Health · Settings (tenant, billing, comms, AI/PII toggles) — plus Desk's four.

No screen ships before the feature that writes its data (§5-mandate-8 discipline applies to UI
exactly as to schema).

---

## 3. Core flow specifications

**A — Morning review.** Phone-first layout, in scroll order: (1) briefing — max 3 insight cards,
each = *headline verb → 2-line why with metric citations (tap a number → its report, pre-filtered)
→ one primary action button*; (2) KPI strip — 5 tiles with deltas vs same-day-last-week +
7-day sparkline, each tile tap-through to its report; (3) focus queue — grouped `Money / Today's
schedule / People`, each row = situation + one-tap action + dismiss-with-reason (dismissals feed
the eval loop). Per-item 👍/👎 on insights. **States:** briefing not yet generated (before the
tenant's briefing hour) → yesterday's, badged "Yesterday"; reconciliation red → "Briefing paused —
data sync issue" card linking to Health + metrics-only mode (KPI strip still renders, from labeled
data); AI provider down → cached briefing + "regenerate" retry. Whole screen server-cached;
p95 < 1s including briefing (it's a read, never a generation).

**B — Retention outreach.** Segments index: cards ranked by action priority, each = segment name,
count, trend, "review outreach" CTA, and *evidence line* ("no visit in 30d, credits expiring").
Segment detail: left = ranked person list (evidence chips per person: last visit, credits,
LTV); right = draft panel — Email/SMS tabs, expandable *rationale* ("why this message"), inline
edit with tracked changes vs the AI draft, per-person preview with merge fields resolved.
Approve = ceremony (§1.8): summary sheet (recipients, channel, cost estimate, quiet-hours check,
consent exclusions listed by name) → confirm → progress bar with per-person send states →
done state links to send log. **Edge cases:** person with no consent → excluded with visible
reason, one-tap "request consent" flow; draft stale (segment recomputed since draft) → banner +
regenerate; partial send failure → failed rows surfaced with retry, never silent.

**C — Front desk.** *Check-in:* today's roster, search-as-you-type, one tap = checked in
(row turns, undo toast 10s). Waiver missing → row badge, tap opens sign-on-tablet flow (flip to
customer, signature, flip back — 20s). Offline → amber "offline — check-ins queued (3)" banner,
queue drains on reconnect, conflicts (double check-in) surface as a review card, never silently
merged. *Book:* person picker (recents + search + "new walk-in": name + phone only) → availability
grid (next 4h default, resource × time; full slots greyed with waitlist affordance) → payment
selector as tabs [Credits n · Card · Cash · Comp(manager)] with policy preview ("late cancel
after 6pm forfeits credit") → confirm → printed/SMS receipt option. Sub-flows preserve state if
interrupted (a half-finished booking parks as a resumable card on Desk home). *Sell (POS):*
product grid (top-sellers first), cart drawer, discounts behind manager PIN, tender: Terminal /
cash / gift card → receipt. All Desk mutations show the money-state pill until server-confirmed.

**D — Billing operations.** Payments index defaults to *Needs attention* filter (failed,
disputed, refund-pending). Payment detail = vertical timeline (attempt → retry → webhook →
comms sent), each event timestamped and sourced. Actions rail: Retry now · Send card-update link ·
Refund · Write off (manager) — each with consequence preview. Refund modal: amount (≤ original,
pre-filled), reason (required), credit-restoration checkbox when applicable, then **state
walk-through in the UI**: `refund pending` pill until Stripe webhook confirms → `refunded` +
"member notified ✓". Dunning queue: kanban-ish list by attempt stage with per-person pause.

**E — Schedule tuning.** Calendar (week default) with utilization tint per slot; toggle to
heatmap (day × daypart, 30-day fill %, tap cell → the sessions behind it). AI recommendation
cards ("Add Friday 6pm plunge — the 5–7pm band runs 92%, waitlist depth 3.2") with evidence
tap-through and one-click *stage* → staged changes preview (diff view of the week) → **Publish**
with impact summary ("2 slots added, 1 capacity change; no existing bookings affected").
Guardrail: edits touching sessions with bookings require explicit per-booking resolution
(move/notify/refund) before publish activates.

**F — Trust surfaces.** Freshness chip states: `Live` (native data) · `Synced 12m ago` ·
amber `Stale 2h+` · red `Stale 4h+ — numbers may be wrong` (red also fires the banner across
affected screens and disables briefing generation). Mixed screens label sections independently
("Bookings: live · Revenue: synced 41m ago"). Health page: per-entity cards (last success, rows,
consecutive-empty counter, 7-day run sparkline), alert feed with acknowledge, authority matrix
(which system owns what — during transition this is the owner's mental model of the migration),
manual "sync now". Reconciliation warnings render *inline on the affected report*, not only in
Health ("Member count differs from source by 1 — view detail").

**G — Assisted onboarding.** Setup checklist card pinned atop Today until done (progress ring;
items: connect import, review quarantined records, confirm plans/prices, add staff, send test
outreach, connect Stripe). Each item deep-links into the real screen in a guided mode (spotlight +
"done" detection from actual data, not self-report). Import review queue: quarantined records as
cards (raw payload summary → suggested resolution → approve/edit/skip), batch actions, count
drains visibly. No video tours, no fake sample data.

**H — Member booking (beta).** Three phone screens, no app install, on studio domain:
(1) **Availability** — public, no login wall; date strip + slot grid; slot → (2) **Identify &
pay** — email/phone → known person gets a 6-digit code (account claiming *is* the booking flow,
not a separate registration); pay via Apple/Google Pay or saved card or credits (balance shown);
waiver inline if required (scroll-to-sign); (3) **Confirmed** — add-to-calendar, cancel/reschedule
link honoring the policy shown at booking, pack balance after debit. Member area (post-claim):
upcoming bookings, credits, card update (Stripe-hosted, on-brand wrapper), history. Polish bar:
p95 <1s per step, zero redirects off-domain, booking completable in <30s for a returning member.
No dark patterns: full price + policy before payment, no countdown timers, no pre-checked boxes.

---

## 4. UI guidelines — the interaction rulebook

**The state system (one wrapper, used everywhere).** Every data region implements exactly five
states: `loading` (skeleton matching final layout — no spinners for primary content, no layout
shift), `empty` (icon + one sentence naming what fills it + primary CTA), `error` (what failed,
what's safe, retry), `stale` (content renders + provenance badge per §3F), `ready`. Implemented
as one `<DataRegion>` component consuming the response envelope's `meta` — screens *cannot*
render data without passing through it. This is the §5-mandate-3/4 pair enforced in the component
tree.

**Money & destructive actions.** Status pills: shape+icon+color (`● confirmed` green solid,
`◐ processing` blue pulse, `▲ failed` red outline, `↺ refund pending` amber). Irreversible
actions use consequence-preview dialogs (what happens, to whom, revocable-until-when); refunds and
write-offs additionally require a reason. Undo-toast (10s) for reversible actions (check-in,
dismiss, stage); no undo theater for money — if it can't be undone, the dialog says so before,
not after. Every money action's confirmation names the member-visible effect ("Maria gets a
refund receipt by email").

**Forms.** Validate on blur, re-validate on submit; server field errors map to fields, never to a
toast; sticky footer action bar with dirty-state guard ("Discard changes?"); single-column
layouts; autosave only for drafts (outreach edits), explicit save for config. Date/time inputs
always show the studio timezone label.

**Tables & reports.** Server-side pagination + sort; filter chips (removable, URL-persisted so
views are shareable/bookmarkable); row click → side drawer (preserves table context), full-page
only for person/payment detail; every report header: definition tooltip from the revenue
dictionary (`ⓘ MRR — active recurring subscriptions, past_due ≤14d included`), `as_of` stamp, and
an Export CSV button (criterion 5 — export is a button, never a support ticket). Drill-down =
filter push-down: clicking a bar/cell applies its filter to the row view below.

**Notifications.** Toasts: confirmation only, auto-dismiss, never for errors that need action.
Alert center (bell): import/money/reconciliation alerts with acknowledge + deep link. Off-app
escalation (email/SMS to owner) reserved for red-state alerts per the alerting rules — the UI
never assumes the owner is looking at it. Badge counts are real counts, not decoration.

**Copy tone.** Plain, specific, numerate: "3 failed payments — $214" not "Some payments need
attention." Timestamps relative under 24h ("41m ago"), absolute after, always tz-labeled.
Sentence case everywhere. No blame in errors ("Couldn't reach Stripe" not "You did X wrong").

---

## 5. Component system & theming architecture

**Recommendation: shadcn/ui (Radix primitives) + Tailwind CSS v4 + TanStack Table + Recharts +
Lucide icons.** Rationale against the agent-maintainability constraint: components are *vendored
source* (agents read and modify them directly — no opaque dependency), the pattern corpus is the
largest in the ecosystem (agents have deep training coverage), Radix supplies accessibility
semantics by default, and Tailwind keeps styling co-located and grep-able. Charts limited to a
thin wrapper kit (`<KpiTile>`, `<TrendSpark>`, `<Heatmap>`, `<FillBar>`) so no screen imports a
chart library directly — one place to restyle when the visual identity lands.

**Token architecture (the design-tool socket).** Three layers of CSS variables:
1. *Primitives* — raw scales (`--blue-600`, `--space-4`, `--radius-2`) — the only layer a design
   tool touches;
2. *Semantic* — meaning-bearing aliases (`--surface`, `--surface-raised`, `--text-muted`,
   `--accent`, `--positive/negative/warning`, and the domain set: `--status-confirmed`,
   `--status-processing`, `--status-failed`, `--freshness-live/aged/stale`);
3. *Component* — per-pattern overrides only where needed.
Components reference semantic tokens exclusively. When the designer delivers identity, they remap
layer 1→2 (a few dozen lines) and zero components change — the rework-free plug-in point the brief
asks for. Same mechanism carries per-tenant white-labeling later (member surface loads tenant
tokens) and dark mode (a parallel semantic map — architecture ships day one, visual pass deferred).

**Density & platform:** comfortable spacing default; `dense` variant for tables and Desk roster.
Operator app and member app share the token package and primitive components; member app gets its
own composition layer (bigger type, thumb-reach layouts). PWA-installable both.

---

## 6. Accessibility & device strategy

**Target: WCAG 2.2 AA on the member surface (hard requirement — public, legal exposure, and
Radix + tokens make it cheap); AA-pragmatic on the operator app** — full keyboard operability
(palette-first design helps), visible focus, contrast-checked semantic tokens (automate with a
token contrast test in CI), screen-reader-correct on the five core flows, `prefers-reduced-motion`
respected (motion is minimal anyway: state transitions only). Status never encoded by color alone
(§4 pills). Touch targets ≥44px on Desk and member surfaces. Skipped consciously in v1: full AAA,
screen-reader optimization of dense internal reports (documented, revisited with SaaS tenants).

**Devices by persona/job:** Owner — phone for Today/approvals (bottom tabs, thumb-reach actions),
desktop for money/schedule/reports (rail + drawers). Front desk — landscape tablet, full-screen
Desk, hardware: Stripe Terminal + optional receipt printer; works degraded offline (check-in
queue). Trainer — phone, My Schedule only. Member — phone-first SSR pages, desktop works but is
not optimized. Responsive rule: Today/People/Outreach/Desk fully adaptive; Schedule editing and
dense reports are desktop-optimized with a functional simplified phone rendering (view + one-tap
actions, no drag operations).

---

## 7. Member-facing surface UX (beta) — the polish bar

Covered as flow H (§3); the bar it must hit, stated as testable requirements: on-domain end to
end (no vendor redirect at any step, including card update — Stripe-hosted pages wrapped on-brand);
returning-member booking in ≤3 taps + Face ID payment; first-time booking incl. waiver in <90s;
p95 <1s per step on 4G; waitlist join is one tap with honest position shown; cancellation honors
and *displays* the policy accepted at booking; every confirmation arrives by email/SMS within 60s
(and the UI says it did). Account claiming never creates a duplicate person — unrecognized
email/phone falls back to guest checkout + later merge tooling, invisible to the member.

---

## 8. What I would explicitly NOT design in v1

- **A bespoke design system** — shadcn is the system; we own tokens and four chart wrappers, not
  a component library.
- **Dashboard customization** (rearrangeable widgets, saved layouts) — the product's thesis is
  that *it* ranks what matters; customization dilutes the briefing's authority and doubles UI
  state surface.
- **Dark-mode visual pass** — token architecture supports it day one; shipping it before the
  visual identity exists means doing it twice.
- **Tenant theming UI** — tokens make it possible; a settings surface for it waits for tenant #2.
- **Choose-your-spot floor maps** — sauna rooms don't have seats (already cut from the build plan).
- **Drag-and-drop automation/campaign builders** — flows are configured forms (already cut).
- **Native-app UX** (push notification center, offline-first everything) — PWA + email/SMS covers
  v1; the check-in retry queue is the only offline surface, deliberately.
- **i18n** — externalize strings from day one (cheap discipline), translate nothing yet.
- **Animated product tours / walkthrough overlays** — the setup checklist with real-data "done"
  detection replaces them; tours rot and patronize.
- **Custom report layout builder** — canned reports + drill-down + CSV + `/ask` already won this
  argument in the build plan; same verdict for its UI.
- **Per-member marketing preference center page** (beyond unsubscribe/STOP + channel toggles on
  the profile) — full preference management waits for real volume.
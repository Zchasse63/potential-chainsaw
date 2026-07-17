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

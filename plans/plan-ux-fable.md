# Kelo UX/UI Plan — Claude Fable 5

*Independent council plan against `plans/brief-ux.md` (2026-07). Visual identity is out of scope
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

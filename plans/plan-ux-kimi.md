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

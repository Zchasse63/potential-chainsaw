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

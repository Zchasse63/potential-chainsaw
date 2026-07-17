# Kelo UX/UI Plan

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

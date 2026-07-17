# Critique: Four Kelo UX/UI Plans

## Per-plan assessment

### Plan A

**(1) Strongest ideas worth stealing**
- **`DataBoundary` as a hard render contract** — missing `{ data, meta }` is a dev-time and monitored production error, not a soft guideline. This is the only plan that treats provenance as an unbypassable component-tree law rather than a chip pattern.
- **Waiver preflight before money** — reorders the brief’s condensed walk-in sequence so you never create paid-but-unbookable failures. Explicitly calls the interim “block at check-in” policy a damage to the 90s target and proposes a pre-arrival “Waiver needed” queue for imports. Correct product judgment.
- **Honest webhook vs. 1s tension** — refuses to fake finality to hit the mutation budget; server acceptance within 1s, durable `Processing` until webhook. Most plans dance around this; A names the trap.
- **Role-shaped navigation that removes surfaces** (not grays them out) plus a front-desk home that is **Desk**, not the owner briefing — critical for shared counter devices.
- **Two-checkpoint outreach approval on one screen** (Audience + Content) with a button that says `Send email to 18 people` — the trust ceremony is concrete, not aspirational.
- **Partial-module independence on Today** — failed KPI fetch doesn’t blank the briefing. Rarely specified elsewhere with this clarity.

**(2) Weakest points**
- **Surface area bloat risk.** The inventory is excellent but large (Demand as its own area, full POS as separate, extensive Settings). For a one-owner + agents team, density of *screens* competes with density of *information*. A’s own principle 8 fights its inventory slightly.
- **“Step-up authentication” for high-risk bulk actions** is hand-waved — no definition of when, how, or what second factor on a shared desk tablet.
- **Trainer surface is thin by design but underspecified** on attendance write permissions and conflict with front-desk check-in (who marks attendance when both can?).
- **Mobile “More” dump** for Outreach/Money/Reports/Health is correct for chrome but under-designed for the coffee-line path when the briefing CTA deep-links fail or the owner wants to chase a payment without full desktop density.
- **No explicit treatment of interrupted mid-sale recovery** (customer steps away, another walks up). Queue/retry is only for offline check-in.

**(3) Contradictions / skips**
- No hard contradiction with locked engineering. Correctly designs *within* no-optimistic-money and single-location.
- **Flow H** is solid but lighter on guest-vs-claim edge cases than on operator flows.
- **Retail/gift cards** correctly absent (matches POS v1). Good restraint.
- Does not skip required sections; all eight are present and thick.

---

### Plan B

**(1) Strongest ideas worth stealing**
- **“Role-shaped surfaces, not permission-gated menus”** as a named principle — cleanest statement of the shared-device problem.
- **Explicit “tension with locked engineering” coda** (no SSR cold-start risk for coffee-line Today; no-optimistic vs 90s; dual waiver policy as footgun). This is what the brief asked for when locked decisions hurt UX — and B does it without re-litigating the whole plan.
- **Trust ceremony is non-skippable** — no “don’t show again,” no bulk-send shortcut past summary. Product-defining constraint.
- **Typed confirm for refunds** (amount + “REFUND”) — opinionated safety; debatable cost, but clear.
- **Front desk as a first-class nav home** with explicit “can take payment / cannot refund or report” money boundary — sharper than burying desk under Schedule.
- **Tight component allowlist** with “written reason before creation” — best agent-maintainability posture after A’s DataBoundary.

**(2) Weakest points**
- **Waitlist is a stub** (“staff notifies / books manually”) — meets v1 minimalism but under-serves flow C relative to Bsport bar and the brief’s waitlist handling ask.
- **Onboarding (G)** is checklist-shaped but thinner on exception grouping, reversible batch decisions, and launch-readiness hard gates than A/C.
- **“Write off / cancel entitlement”** on failed payments appears without a full consequence model (does the booking remain? credits? member messaging?).
- **Phone Home collapses KPI to horizontal scroller** — A’s warning against long hidden carousels is better; B reintroduces the pattern it should fear.
- **Health top-level for owners** is good for trust events but competes with “decision not dashboard”; no clear rule for when Health badge should interrupt Today vs. sit quietly.

**(3) Contradictions / skips**
- Aligns with locked decisions; the tension section is additive, not rebellious.
- **Flow H** deferred largely to §7 — acceptable, but core-flow section is thinner than A/C for member edge cases.
- Does not invent till/tips/split tender. Clean.
- All required sections present; slightly more outline-y on E/G exceptional states.

---

### Plan C

**(1) Strongest ideas worth stealing**
- **Single “Quick Book” modal/stepper** as the front-desk atomic unit — “one conversation, one surface” is the right counter metaphor; global Book button + start-next-booking reset is operationally sharp.
- **Tentative server hold with visible countdown** on slot pick — good perceived-speed mitigation under no-optimistic-UI.
- **Cmd/Ctrl+K command palette** as universal jump (shared with D) — high leverage for dense operator app and agent-added actions.
- **AAA contrast only for money/status/trust indicators** — pragmatic split that other plans don’t make; good cost/benefit argument if scoped tightly.
- **Content-aware skeletons + “Generating today’s briefing…” with previous metrics below** — practical morning-open state.
- **Authority labels on edit screens** (“Source of truth: Glofox (read-only)”) — clearest write-authority UX during strangler transition.

**(2) Weakest points / risky choices**
- **Dark mode from day one** — doubles visual QA on status-heavy, chart, terminal, and tenant-brand surfaces for no core job. A/B/D correctly defer implementation. C’s “prevents rework” claim is weak; token readiness without shipping dual themes is enough.
- **Cash “amount tendered / change due” + manager PIN for over/under** slides toward till management, which is **explicitly out of POS v1**. Recording cash ≠ cash-drawer UX.
- **AI “confidence 78%” on schedule recommendations** invents precision that fights the trust doctrine. Prefer sample size / evidence period (A/D) over fake calibration.
- **Guest checkout on member funnel** without a clear merge/claim later path risks duplicate people — the strangler’s worst long-term UX debt.
- **“Sparklines via HTML/CSS, not heavy charts”** is speed-smart but undercuts demand heatmap and utilization work; E needs a real grid, not bars.
- **Weaker money timeline rigor** than A/B/D on refund_pending vs. processor truth and receipt-failure-as-separate-from-payment.

**(3) Contradictions / skips**
- Soft conflict with POS v1 scope (change/over-under).
- Claims disagreement with no-optimistic-UI but still designs within it — fine, but the “measurable conversion risk” claim is underspecified (no mitigation metrics).
- **Reports/export** mentioned but thinner than success criterion 5 requires (drill-downable + exportable as a system).
- All eight sections exist; B and E edge cases are thinner; “Retail” absent (good).

---

### Plan D

**(1) Strongest ideas worth stealing**
- **Interrupted booking as a resumable card on Desk home** — unique among the four; this is real counter life (phone rings, other customer, Terminal glitch). Highest operational IQ moment in any plan.
- **Desk as a separate full-screen route group** (Check-in · Book · Sell · Find person), same app/session, no rail — best separation of counter UX from owner chrome without a second codebase.
- **Setup checklist pinned on Today with “done” detection from real data**, not self-report — kills rotting tours and fake completion.
- **Dismiss-with-reason on focus queue** feeding the eval loop — better learning signal than thumbs alone on AI cards.
- **Consequence-preview dialogs that name member-visible effects** (“Maria gets a refund receipt by email”) — money UX with social accountability.
- **Strict screen budget mindset** (“24 screens, no screen before the feature that writes its data”) — best alignment with agent-maintenance liability.
- **Flip-to-customer waiver on tablet** (sign, flip back) — concrete 20s interaction other plans leave abstract.

**(2) Weakest points**
- **Scope creep in overflow inventory:** Retail catalog, gift cards, payouts, “automations” under Marketing. Gift cards/retail/payouts are not POS v1; automations flirt with the “AI never sends / no journey builder” rule even if human-approved.
- **Kanban-ish dunning** is clever and probably premature — a failed-payment queue with stages is enough; kanban is a new pattern without evidence of need.
- **WCAG split** (“hard AA on member, AA-pragmatic on operator”) is honest but dangerous: money and booking live on the *operator* app at the counter. Softening operator a11y where Terminal results and errors fire is the wrong place to save cost.
- **Flow specs are denser in prose but thinner on systematic exceptional-state tables** than A/B — more manifesto, less state machine in places (especially offline conflict resolution detail, partial publish failure).
- **“PWA-installable both”** without a freshness policy for installed shells risks stale-as-fresh (B’s tension note is wiser).
- **Marketing as primary nav label** vs. “Outreach” — fine naming, but “campaigns/automations” implies more product than v1 should surface.

**(3) Contradictions / skips**
- Inventory items (gift cards, retail, payouts, automations) **exceed** locked POS/v1 product surface — not locked-engineering violations, but brief-scope violations.
- Does not re-litigate no-optimistic-UI; stays inside it.
- Member H is strong and testable (≤3 taps returning, <90s first-time) — good polish bar.
- All required sections present; F’s Health is good; G is clever but light on quarantine batch safety vs. A.

---

## Comparative judgment

**Design principles** — **A slightly over B/D.**  
A’s eight doctrines are the most tightly bound to failure modes (provenance-as-content, durable business state vs. toasts, one visible authority, spend complexity only on operational risk). B is nearly as good and more quotable; D’s “counter test” and “one pattern per job” are excellent. C’s set is solid but more generic in places (“progressive disclosure”).

**Information architecture** — **D for counter structure; A for full role model; B as best balance.**  
D’s full-screen Desk route group is the best front-desk IA idea. A has the clearest owner/front_desk/trainer matrix and bury-vs-promote rationale. B’s “Front desk” top-level + role-shaped homes is the most implementable middle path. C’s primary nav is slightly overstuffed (Home/Book/Schedule/People/Money/Outreach/Insights/Admin).

**Flow specifications** — **A wins overall; D wins C (front desk); B wins the engineering-tension honesty.**  
A’s A–G exceptional states are the most complete (reconciliation red, partial send, consent change mid-review, waiver preflight, refund_pending honesty). D’s resumable half-booking and tablet flip-waiver are the best single flow-C inventions. B is the only plan that systematically flags locked-decision UX debt. C’s Quick Book stepper is strong but cash/till drift and thinner D/E hurt it.

**UI guidelines** — **A, then B.**  
A’s four-mechanism alert model, export provenance, disabled-button-needs-reason, and processing-after-1s copy rules form a real rulebook. B’s envelope-refuse-to-render and banner severity stack are sharp. D’s five-state `DataRegion` is elegant but less complete on notifications/export. C is competent, weaker on money state discipline.

**Component / theming** — **A ≈ B > D > C.**  
A/B/D all pick shadcn + Radix + Tailwind + TanStack Table (correct for agents). A’s three-layer tokens + exhaustive product component list + Storybook state mandate is the most durable. B’s “anything not on this list needs a written reason” is the best anti-proliferation rule. D’s chart wrapper kit is smart. **C loses for shipping dark mode day one** and a looser “do not build one-offs” without enforcement mechanics.

**Accessibility / devices** — **A, then B.**  
A: WCAG 2.2 AA everywhere, keyboard-complete core flows, SPA cold-start mitigation for Today, shared-session lock/re-entry. B: clear breakpoints and “usable not SR-optimized” operator honesty. D under-protects operator a11y where money lives. C’s AAA-for-money is interesting but dark-mode QA tax and weaker shared-device session story.

**Member surface** — **A ≈ D > B > C.**  
A: four-stage funnel, anti-enumeration claim, hold preservation on failed verify, no vendor chrome. D: sharp testable bars (≤3 taps, <90s, on-domain card update wrapper) and claim-as-booking-flow. B: solid polish bar, thinner claim edge cases. C: guest checkout without strong anti-duplicate story is a long-term liability.

**Not-design list** — **B ≈ A > D > C.**  
B’s table is ruthless and well-justified (no seat maps, no help-center tours, no 20-toggle notification center). A is comprehensive and principle-aligned. D’s list is good but undermined by *including* retail/gift/automations earlier in the IA. C is fine; dark-mode-in-v1 elsewhere contradicts the spirit of “don’t design what you can’t maintain.”

**Overall strongest plan:** **A**, with **D’s Desk/resume ideas and B’s engineering-tension + non-skippable ceremony** mandatory steals. C is the weakest of a strong set — not bad, but most scope drift and least trust-rigor on money/AI precision.

---

## What EVERY plan missed

None of the four adequately designs for the **physical and social reality of a sauna/cold-plunge studio**, the **emotional stakes at the counter**, or **long-term UX decay**. The highest-value gaps:

### 1. Counter privacy and “customer is reading the screen”
Front desk is mid-conversation with a body in a robe two feet away. Every plan designs large targets and speed; **none designs privacy modes**: hide “At-risk,” failed-payment amounts, staff notes, LTV, or segment labels when the Desk UI is in “customer-facing” orientation (waiver flip is the only gesture that implies this, and only in D). A shoulder-surfing mode / privacy dim on person panels is missing entirely.

### 2. Wet hands, steam, shared glass, gloves
Tablets at plunge studios get wet and smudged; staff may have damp hands; owners may open Today on a phone outdoors in winter. Plans specify ≥44px targets but not **glove-tolerant hit areas, high-contrast under bright lobby light, accidental-touch guards during Terminal presentment, or stylus/clean-mode**. No plan mentions anti-palm-rejection during waiver signature with wet fingers.

### 3. Shift handoff and device ownership of the offline queue
Check-in degraded mode is specified as local retry on “the device.” **Who owns the queue when the morning desk person leaves?** If the tablet reboots, is the queue on disk encrypted? Can two tablets offline-check-in the same person? Conflict UX assumes reconnect on the *same* device. Multi-device offline divergence is unaddressed by all four.

### 4. Peak-hour queue psychology (the silent 3 seconds)
No optimistic UI means the customer watches a spinner while card-present payment confirms. Plans lock the button; **none design the human beat**: what the staff says, what the screen shows the *customer* (not the operator), whether a second staffer can start the next walk-in on another device against the same slot hold, and how to avoid double-conversation dead air. Perceived speed is a script + UI problem, not only a skeleton problem.

### 5. Members without phones / without pockets
Robes, lockers, Instagram-to-book later — but **at the door**, many members have no phone on them. Account claiming, SMS receipts, card-update links, and OTP flows assume a phone in hand. Missing: **name/birthday lookup only, verbal confirmation codes, paper receipt as first-class (not afterthought), and “send receipt when you get your phone” deferred delivery** that doesn’t look like failure.

### 6. Room turnaround, buffers, and physical capacity ≠ booking count
Sauna/plunge ops need **clean/turnover buffers**, soft caps when people linger, and mid-session walk-in pressure. Heatmaps and slot pickers treat capacity as a number. No plan designs **turnover constraints in the slot picker**, “room not ready” desk state, or overstay handling — all of which drive the under-booked / over-full recommendations the AI is supposed to make.

### 7. Family / minor / multi-body bookings
Guardian waiver is mentioned; **booking two people into one slot, parent+minor packs, and who holds the credit** are not. Front desk reality is couples and parent+teen walking in together. The person model in all plans is single-primary-person flows.

### 8. Cash end-of-day without “till management”
POS v1 records cash but forbids till features. Owners still need **“cash recorded today: $X”** reconcilable against the drawer. No plan designs a minimal cash-summary that isn’t till management — so studios will spreadsheet it, breaking “never cross-check” for the one tender that isn’t Stripe-backed.

### 9. Alert and focus-queue decay
Thumbs up/down and dismiss exist (especially D), but nothing addresses **chronic amber staleness during Glofox transition**, badge blindness, or a focus queue that refills faster than the owner can clear it. Long-term, Today becomes another dashboard. Missing: **queue SLAs, auto-aging, “snooze until tomorrow,” and a weekly “you dismissed 40 things” hygiene insight** — without turning into nagware.

### 10. Strangler dual-authority as a months-long mental model
Authority matrix appears on Health pages. **Daily flows don’t teach “you cannot fix this in Kelo — do it in Glofox”** at the moment of intent. Operators will hammer disabled buttons. Missing: intent-time redirect copy, deep links or checklists into the incumbent, and a **countdown-to-cutover** narrative so the dual system feels temporary, not broken.

### 11. Concurrent staff on the same session
Two front-desk users booking the last plunge slot; trainer marking attendance while desk checks in; owner refunding while desk rebooks. Idempotency is an eng property; **UX for “someone else just took this”** (presence, hold contention, roster live-updates) is absent beyond generic conflicts.

### 12. Emotional load of waiver and first cold plunge
Waiver is treated as a gate. For recovery studios it’s also **anxiety and consent theater in a vulnerable moment**. No plan designs microcopy, time-to-sign, or “first visit” desk scripts that keep the 90s target without making the member feel processed. Minors+guardian at a wet counter is especially underspecified.

### 13. Owner emotional stakes on money and AI
Failed payments and “at-risk” outreach are shame-adjacent (chasing friends/clients in a boutique community). Plans optimize efficiency of dunning and send. Missing: **tone controls, “not tonight” pacing, community-small-batch defaults, and copy that doesn’t sound like a collections agency** — retention UX for a 200-member studio is not SaaS lifecycle email.

### 14. Performance budgets as UX contracts, not slogans
All cite p95 <1s. None specify **what the UI does at p50 vs p95 vs p99**, budget ownership per route (Today bundle weight — only A sketches code-splitting), or a **user-visible “degraded performance” mode** when the Terminal or network is slow but not offline. Bsport’s lag complaint will recur as “spinner limbo” without an upper-bound UX.

### 15. Auditability for the owner who doesn’t trust yet
After the fabricated-data trauma, trust needs a **“prove this number” gesture** on every KPI (one tap → constituent rows + envelope meta + export), not only drill-downs on reports. Several plans imply this; none make **“challenge this figure”** a universal pattern with a 2-second path from briefing card metric to raw lines.

### 16. Accessibility of older owner-operators and shared kiosks
WCAG AA is chosen; **dynamic type / larger-text mode for 50+ owners**, kiosk timeout vs. mid-waiver, and screen-reader announcements that don’t leak PII via speakers at the counter are unmentioned.

---

### Bottom line

**Steal from A** the DataBoundary contract, waiver-before-money, and exceptional-state completeness.  
**Steal from D** resumable Desk bookings, full-screen counter mode, real-data onboarding completion, and flip-to-customer waiver.  
**Steal from B** non-skippable send ceremony and the explicit locked-decision tension register.  
**Steal from C** Quick Book as one surface and authority-on-edit-screens — then drop dark-mode-now and cash-drawer UX.

**Then design what none of them did:** privacy at the counter, wet/shared hardware, shift-owned offline queues, phone-less members, room turnaround physics, cash summary without till bloat, focus-queue hygiene over months, and dual-system intent-time guidance during the strangler — because Kelo’s real UX failure modes will be social and environmental long before they are component-library failures.

# Kelo — Final Synthesized UX/UI Plan

*Council synthesis, 2026-07-16. Four independent UX plans from the identical brief
([brief-ux.md](brief-ux.md)), blind-critiqued (anonymized, shuffled) by the three external models,
adjudicated and distilled by Fable 5. Companion to the build plan
([plan-final.md](plan-final.md)) — where the two documents touch (waivers, POS scope,
authority states), this plan defers to the build plan and flags recommended amendments in §9.*

*Sources: [plan-ux-fable.md](plan-ux-fable.md) · [plan-ux-sol.md](plan-ux-sol.md) ·
[plan-ux-grok.md](plan-ux-grok.md) · [plan-ux-kimi.md](plan-ux-kimi.md) · critiques:
[critique-ux-sol.md](critique-ux-sol.md) · [critique-ux-grok.md](critique-ux-grok.md) ·
[critique-ux-kimi.md](critique-ux-kimi.md) · blind key: [critique-ux-key.md](critique-ux-key.md)*

---

## Part I — Council verdict

### Comparison matrix

Blind labels this round: **A = Sol, B = Grok, C = Kimi, D = Fable.**

| Section | Strongest | Adjudication |
|---|---|---|
| Design principles | **Fable** (Kimi's critique) / **Sol** (Grok's) | Merged: Sol's failure-mode-bound doctrines ("a toast is not proof," "one visible authority") + Fable's operational tests ("the counter test," "one pattern per job"). |
| Information architecture | **Fable** (Kimi's) / **Sol** (Sol's) | Fable's full-screen **Desk** route group + Sol's six-item owner nav and role matrix. All three critiques flagged Fable's overflow inventory as scope creep — resolved as a phase-labeling issue, not a cut (see disagreement 9). |
| Core flow specs | **Sol** (all three critics) | The most complete exceptional-state coverage of any plan in either council round. Adopted as the flow backbone, with Fable's resumable bookings + flip-waiver, Kimi's Quick Book + hold countdown, Grok's tension register grafted in. |
| UI guidelines | **Sol** (all three) | Sol's state taxonomy and notification model replace Fable's five-state `DataRegion` (correctly criticized as too reductive). |
| Component / theming | **Sol** for controls, **Fable** for the design-tool socket, **Grok** for anti-proliferation | Unanimous stack (all four independently chose shadcn/Radix/Tailwind/TanStack Table). Sol's enforcement mechanics + Fable's domain-semantic tokens + Grok's "written reason before creation" rule. |
| Accessibility / devices | **Sol** | WCAG 2.2 AA on *both* surfaces; Fable's "AA-pragmatic" split was rightly rejected — money lives on the operator app. |
| Member surface | **Sol ≈ Fable** | Sol's claiming/anti-enumeration + Fable's testable polish bars. |
| Not-design list | **Sol** (2 of 3) | Strictest brief alignment; Grok's ruthless cuts folded in. |

**Overall this round: Sol's plan strongest** (Grok's and Sol's critiques rank it first outright;
Kimi's splits, giving Fable principles + IA and Sol the other six sections) — the inverse of the
build-plan round, and instructive: Sol's exhaustiveness was a liability in a scope-constrained
build plan and an asset in an interaction rulebook. Placing Fable's plan second is *my
adjudication* from the per-section wins, disclosed accordingly: the one critique that named a
runner-up (Sol's) ranked Grok's plan second and called Fable's the least scope-disciplined.
(Sol's critique again blind-ranked its own plan first — but Grok's independent critique agreed,
so the top verdict stands on convergence, not self-preference.)

### Disagreements adjudicated

1. **Dark mode.** Kimi: ship day one. Sol/Grok/Fable: token-ready, defer the visual pass.
   **Ruling: defer.** Dual-theme QA on status-heavy trust surfaces before a visual identity exists
   is double work; the semantic-token architecture makes it a later remap, not a retrofit.
2. **Accessibility target.** **WCAG 2.2 AA on operator *and* member surfaces** (Sol). Fable's
   operator-app carve-out and Kimi's selective AAA both rejected: the highest-stakes flows (money,
   Terminal results, check-in) happen on the operator app, and AA is enforceable mechanically
   (Radix + axe CI + token contrast tests).
3. **Waiver vs payment order.** Sol's preflight-before-money is unanimously endorsed by the
   critiques: charging before discovering a waiver block manufactures paid-but-unbooked failures.
   **Ruling: waiver preflight precedes tender selection in every booking flow.** This also produces
   a build-plan amendment recommendation (§9.1).
4. **Refund confirmation friction.** Grok: typed confirm. Sol: proportional confirmation, no typed
   phrases for routine work. **Ruling: Sol** — consequence-preview + required reason for every
   refund; step-up re-auth (manager PIN) above a tenant-configured threshold; typed phrases never.
5. **Phone KPI presentation.** Horizontal carousel (Grok) vs wrapped grid (Sol).
   **Ruling: two-column grid** — carousels hide metrics from a coffee-line scan.
6. **Owner phone tabs.** **Today · Payments · People · Schedule · More.** Payments earns a phone
   tab (failed-payment work is explicitly daily — Sol's own critique of its More-menu placement).
   *(Label "Payments" per the 2026-07-17 design amendment; this ruling originally said "Money".)*
7. **Member guest checkout.** Kimi proposed it; Fable allowed a fallback version; Sol and two
   critiques flagged the duplicate-identity liability. **Ruling: no unverified guest checkout.**
   Every member *identity* is contact-verified once (one-time code) — which *is* the
   account-claiming flow for imported people and the dedup guarantee for new ones. Verification is
   **per device/session, not per booking**: a verified session persists (with a re-verification
   policy on new devices and sensitive changes), so the returning-member ≤3-tap bar in §7 holds;
   the code step applies to first bookings and new devices only.
8. **Briefing regeneration.** Fable's "regenerate" button contradicted the locked once-daily-cached
   model (Sol's catch). **Ruling:** the UI retries the *fetch*, never triggers regeneration;
   degraded modes serve yesterday's briefing badged, or metrics-only.
9. **"Scope creep" (retail, gift cards, lifecycle automations in the IA).** All three critics
   flagged these against the self-contained UX brief — but they are **v1 build-plan items**
   (retail catalog + gift cards: phases 4–5; lifecycle automation flows: phase 3).
   **Ruling: they stay, phase-labeled in the screen inventory** — a screen ships only with its
   build phase (the UI mirror of §5 mandate 8). The critics' underlying point stands as a rule:
   *the IA must never display a nav item whose feature hasn't shipped.* Nav items appear when
   their phase lands.
10. **AI numeric confidence.** Kimi's "confidence 78%" / "projected +$420/wk" style is **banned**
    (Sol + Grok critiques): fabricated precision is the founding trauma. Recommendations cite
    *evidence* — fill rates, sample sizes, observation windows — never invented probabilities or
    revenue projections without a defined, labeled model.

### The gaps no plan caught alone (from the blind critiques — all incorporated in Part II)

The critiques' "what every plan missed" sections were the strongest of the entire council exercise.
The synthesis adopts: **counter privacy** (customer-readable screens); **the wet-hands
environment**; **the hold-expiry race** (hold vs waiver vs OTP vs Terminal vs webhook — "the single
most dangerous booking-state gap"); **Terminal two-device failure choreography**; **the phoneless
member path**; **no-show as a money event**; **room readiness ≠ booking capacity**; **a cash-day
summary that isn't till management**; **alert-fatigue decay controls**; **the "prove this number"
gesture**; **intent-time authority guidance** ("Open in Glofox"); **declined-card dignity**;
**shift handoff & session hygiene**; **member-side waitlist honesty**; **concurrent-staff conflict
UX** (two operators, one last slot); **multi-person/party bookings** (couples and parent+teen at
the counter); **unsubscribe/opt-out as designed UX**; **real-user performance monitoring**.

---

## Part II — The plan

## 1. Design principles

*(Eight doctrines, per the brief's 5–8 spec — each derived from a named failure mode or goal.)*

1. **Provenance or nothing — and degrade honestly.** Every number wears its source and age; a
   component lacking envelope metadata refuses to render (a monitored error, not a guideline).
   Stale is a designed state, never a secret. When a dependency fails, degradation is local and
   labeled: AI down → metrics-only; import stale → labeled data, blocked *only* for actions that
   depend on it; network down → check-in queues locally, money actions refuse; a failed module
   never blanks its neighbors. *(The 10-week fabricated-data failure.)*
2. **A decision, not a dashboard.** Today ranks 2–3 actions with verbs; charts are evidence one
   level down. An insight with no one-click action doesn't ship. When there's nothing urgent, say
   "no urgent actions today" — never invent filler recommendations.
3. **A toast is not proof.** Money and booking actions end on durable state — a persistent
   timeline or result page showing `processing / confirmed / failed / refund pending` from server
   truth, with receipts and retry history. No optimistic UI for money or bookings, ever.
4. **The counter test — weather and dignity included.** Every Desk flow: ≤90 seconds for a
   walk-in **sale + booking + waiver**, one-handed on a tablet, resumable after interruption,
   ≥48px primary targets, operable with damp fingers — and safe to show the customer standing two
   feet away: staff-facing detail stays staff-facing; the customer-visible surface shows only what
   preserves the relationship ("Let's try another card" — never the decline code, a segment label,
   or an LTV figure).
5. **Role-shaped surfaces, not permission-gated menus.** Front desk gets Desk, trainers get My
   Day — surfaces are removed for roles that can't use them, never grayed out. *(Shared devices.)*
6. **One visible authority, taught at the moment of intent.** During the strangler transition,
   a field Kelo can't edit says *why* and offers the path ("Schedules are managed in Glofox until
   cutover — open Glofox"), plus a visible migration timeline so dual-authority feels temporary,
   not broken.
7. **Approval is a non-skippable ceremony.** AI output is visibly draft-shaped until a human
   approves; the approve screen shows audience, content, cost, and exclusions; the button names
   the act ("Send SMS to 18 people"); no "don't show again," no bypass shortcut.
8. **One pattern per job.** A closed vocabulary of interaction patterns applied uniformly; a new
   pattern is a written design decision. *(Agent-built codebase: novelty is a defect vector.)*

## 2. Information architecture

**Owner/manager, desktop:** persistent left rail — **Today · Schedule · People · Payments ·
Marketing · Reports · Health** *(labels amended 2026-07-17 to match the accepted design; Health
promoted to the rail with a quiet status dot — fitting for a trust-first product)* — plus the
**Desk-mode launcher card** (below) and **More** (Retail & gift cards *(phase 4–5)*, Staff,
Waivers, Setup, Settings, Audit log). Not user-customizable. Owner lands on Today.
**Phone:** bottom tabs **Today · Payments · People · Schedule · More**; KPI strip renders as a
two-column grid; deep links from Today bypass navigation.

**Desk** — a separate full-screen route group (same app, same session, role-gated), tablet-first:
**Check-in · Book · Find person**, plus **Sell** when POS ships *(phase 5)* — Desk launches with
three fat tabs and gains the fourth with its feature (ruling 9 applied to Desk itself). No rail,
no reports. Front-desk role lands here; owner reaches it from the rail. Interrupted work parks as
**resumable cards on Desk home** (half-finished booking, pending Terminal result, unsynced
check-ins).

**Trainer:** My Day + Roster only. Attendance-marking permission is explicit per tenant config;
when both desk and trainer can mark, last-write shows actor + time (no silent overwrite).

**Global chrome:** person search; freshness indicator (worst-of-sources for the current screen,
tap → Health); alert bell (actionable unread only); **⌘K command palette** — navigation and
search always; money verbs (refund, retry) *navigate to* their confirm surfaces, never execute
directly.

**Click-depth rules:** focus-queue items resolve in ≤2 clicks from Today; any person in ≤2
interactions from anywhere; every report ≤3 clicks and drill-down-terminal at row level; every
substantive view has a URL (drawers for inspection, addressable pages for payments, people,
campaigns, publishes — with re-auth required to reopen sensitive payment/refund deep links on
shared devices).

**Screen inventory** (phase-labeled; a screen ships only with the build phase that writes its
data): Today · Briefing archive · People index · Person profile (overview / visits / credits /
payments / **subscription management** / comms / waivers / **lead status & next action** / audit) ·
Merge review · Segments + segment detail · Schedule calendar (with publish-history panel) ·
Demand heatmap + recommendations · Session/slot roster (with waitlist panel) · Money overview
(incl. cash-day summary) · Payments (needs-attention default) · Payment detail (timeline) ·
Dunning queue (staged list — not kanban) · Refund flow · **Reports** *(2+)*: revenue, attendance,
cohort/churn, LTV, plan-mix, credit liability, room utilization — one report shell, seven canned
reports, each drill-down + export · **Ask** (free-text metric Q&A *(2)*, entered from Reports or
the palette; answers render under the provenance contract with dictionary citations and
drill-to-rows) · Health (freshness / runs / alerts / authority matrix / quarantine / per-device
offline queues) · Setup checklist + import review · Outreach approvals + send log · Campaign
detail (with **attribution panel**, limitations stated) · Lifecycle automations *(3)* · Staff &
roles · Waivers admin · Retail catalog + gift cards *(4–5)* · Settings (incl. **privacy tools**:
person deletion/pseudonymization, tenant data export *(3)*) · Audit log · Desk's surfaces (Sell
at *(5)*) · Member app *(8)*.

## 3. Core flow specifications

*(Sol's exceptional-state backbone; deltas and grafts noted. Every flow implements the full state
taxonomy of §4.)*

**A — Morning review.** Header: business date, briefing generation time, data-coverage time,
overall freshness. Then 2–3 ranked insight cards (action-as-title, evidence facts with tap-through
to their reports, "why this," 👍/👎 that never blocks), KPI grid (each tile: delta vs
same-day-last-week, sparkline, own freshness chip, tap → report), focus queue (Money / Today's
schedule / People; each row = situation + one-tap act + **dismiss-with-reason** feeding the eval
loop). States: not-yet-generated → yesterday's badged; reconciliation red → briefing refuses, card
explains *which* reconciliation failed, links Health, metrics-only mode; AI down → same, different
copy; partial KPI failure → only that tile degrades; slow → skeleton ≤1s, then existing data with
"Updating"; no urgent actions → says so. **Focus-queue hygiene** (new): items auto-age, "snooze
until tomorrow" exists, and a weekly digest surfaces chronically dismissed item types — the queue
must not decay into a dashboard.

**B — Retention outreach.** Segments (plain-language definition, count, trend, last-computed) →
ranked people (evidence chips, consent/contactability state, existing-outreach state) → draft
panel (Email/SMS tabs, rationale, **tracked changes vs the AI draft**, per-person merge-field
preview, SMS segment count, unverifiable-claim warnings) → **two-checkpoint ceremony on one
screen** (Audience: "18 selected, 3 excluded — reasons shown by name" / Content: exact final
preview) → buttons: **"Send email to 18 people"** plus **"Send test to me"** (a real send to the
owner's own contact — the cheapest trust builder in the ceremony, adopted from the design round)
→ durable per-person send monitor (queued / sent /
delivered / failed / skipped-with-reason; failures retry-able, never silent) → immutable per-person
comms log. Consent re-validated at send; quiet hours enforced in the **studio location's timezone**
(aligned with the build plan — members of a physical studio are local; revisit only if a tenant
ever spans timezones); stale segment blocks send (not editing). AI draft failure → owner writes
manually through the same ceremony. **Unsubscribe/opt-out is designed UX, not plumbing**: every
email carries an unsubscribe link and every SMS honors STOP; opting out flips suppression
immediately, shows as `skipped — opted out` in the send monitor, and surfaces on the person
profile with date and channel — staff can see it but cannot override it. **Tone guardrails**
(new): drafts run a lint for pseudo-medical claims and collections-agency tone; segment sends
default to small batches with pacing — a 200-member community is not a SaaS funnel.

**C — Booking & front desk.** *Book (Quick Book, one surface):* person search-or-create (minimum
fields, duplicate warning) → person summary (eligibility, balance, waiver status, minor status) →
slot picker (next 4h default; full slots show waitlist affordance; **room-readiness aware** — a
slot in turnover/maintenance shows "room not ready," not bookable-empty) → selecting creates a
visible server hold with honest countdown → **waiver preflight** (per the build plan's evidence
model: the member reads the current waiver version and acknowledges by **typed name + checkbox**
— flip-to-customer on the tablet, or QR/send link; guardian identity + acknowledgment for minors;
inherently accessible, no drawn-signature canvas — see §9.9) → tender tabs (Terminal / cash /
credits / comp-with-manager-PIN; gift cards from phase 5; **no last-used default** — explicit
selection every time) → button names the act ("Charge $42.00 and book") → server-confirmed result
page (booking ref, payment ref, waiver state, receipt delivery state, check-in action).
**Waiver legal edge cases** (from Sol's gap #8): a waiver version change mid-booking re-presents
before confirm; a guardian required but absent blocks with empathetic copy and **no payment
taken**; a signed acknowledgment that fails to persist after payment surfaces as a review card
(never silently lost); members can request their signed acknowledgment (delivered from the
person profile).
**Party bookings** (Grok's gap #7): the confirm screen offers "add another person to this slot" —
repeat person-pick + waiver for the companion, one shared tender step at the end (the build plan's
booked-by/attendee split records who pays vs who attends). Couples and parent+teen book in one
conversation; invoice-to-company stays deferred per the build plan.
**Hold choreography** (the critiques' top gap): payment initiation freezes hold expiry; waiver/OTP
waits show the timer with a non-pressuring warning and one free extension; payment success after
hold release auto-refunds with a staff review card; abandoning parks a resumable card.
**Concurrent staff** (new): a hold taken by another operator renders as "held by Sam — expires in
2:40" (not bookable-empty); losing the last slot mid-flow shows "someone else just took this slot"
with waitlist + nearest-alternative one-taps; payment retry is single-flight (a second operator
opening the same failed payment sees "retry in progress — started by Sam"); person records being
merged show a being-edited hint.
*Sell (POS, ships phase 5):* product/plan grid (top sellers first) → cart → **discount** (manager
step-up, reason required) → tax shown per product/location config → same tender tabs as booking →
server-confirmed → receipt (print / SMS / email / "offered on screen" for the phoneless — printer
out-of-paper defers the receipt, never blocks the sale). Sale-only visits skip the slot steps
entirely — the 90-second criterion's sale leg is this flow.
*Check-in:* roster with large targets, one-tap check-in (undo 10s), waiver badge blocks per
policy; offline → "Queued on this device (3)" rows, idempotent replay on reconnect, conflict
resolver — **queue survives reboot, is per-device-visible in Health, and blocks shift sign-out
with unsynced items** (shift-handoff gap). *Waitlist (staff side)* (new): joining from a full slot
takes one tap and shows the person their position; the session roster carries a waitlist panel
(ordered, with offer states: offered / expires-in / declined / expired-passed-to-next); a
cancellation triggers the sequential offer flow, and staff can manually promote — if the
waitlisted person is *standing at the desk* during someone else's active offer window, staff sees
the window countdown and can book them into a different slot or queue-jump with a manager
override (audited). *No-show* (consequence model): available after the session's threshold;
confirm dialog previews the financial consequence per the booking's policy snapshot ("forfeits 1
credit — Maria will be notified"); reversal restores the credit, sends a corrected notice, and
writes audit events. *Declined card:* staff screen shows plain reason + next actions (retry /
other tender / hold slot briefly); customer-facing surface shows nothing but the retry invitation.
*Terminal failure choreography:* explicit "verifying result — do not retry" state when app and
reader disagree; safe tender-switch only after a definitive reader outcome or a timeout with
automatic later reconciliation; reader-disconnect/battery states named, with cash fallback one
tap away.

**D — Billing operations.** Money opens on queues, not charts: failed payments, long-processing,
refunds pending, dunning attention — plus revenue summary where every figure drills with its
filter in the URL. Payment detail = timeline (attempts, webhooks, comms, actors, receipts).
Actions gated by processor state: retry (explicit confirm naming amount + method), card-update
link (shows channel + recipient, logs delivery + completion), dunning start/pause, record
resolution, write-off (manager step-up; consequence model: booking/credit effects stated — a
first-class payment state, §9.9). Refund: amount (≤ original) + required reason → review (original
payment, resulting balance, credit/booking effect, receipt recipient) → `refund pending` until
webhook → `refunded` + "member notified ✓."
**Subscription management** (new — the incumbents' named failure mode, previously undesigned):
from the person profile's subscription tab: **Pause** (effective date + auto-resume date, preview:
"billing stops Mar 1, resumes Apr 1 — Maria keeps booking until Feb 28"), **Cancel** (at period
end by default; immediate requires manager step-up; consequence preview shows entitlement end and
any credit implications), **Change plan** (effective next period via schedule; proration policy
stated before confirm). All three use the durable-state pattern: `change pending` until Stripe
confirms, member notified, timeline entry written. Freeze/pause state renders on the person
header and the roster.
Stale-data blocking is **dependency-scoped** (Sol's self-correction): a stale roster import never
blocks a Stripe-native refund. **Cash day summary**: "cash recorded today: $X, N transactions" on
Money overview — reconcilable against the drawer without till management.

**E — Schedule tuning.** Heatmap (day × daypart, 30-day fill, resource filter, closures excluded;
cells → underlying sessions; **turnover/maintenance time excluded from demand math** so the AI
never reads cleaning gaps as demand failure). Recommendations cite evidence period, sample size,
current fill — never invented confidence or revenue projections. Accept → unpublished draft →
editor with conflict validation (rooms, staff, capacity, existing bookings — never silently
displaced; per-booking resolution required) → publish review (diff, effective date, affected
bookings, member comms toggle) → **atomic publish** (all-or-nothing; a failed validation retains
the draft and names the blocker) → publish history (a panel of Schedule, in the inventory).
**Render performance is designed, not hoped** (success criterion 3): the calendar and heatmap
virtualize by visible window, heatmap cells defer interactivity until hover/focus, and RUM carries
a dedicated schedule-view render metric — "no schedule-render lag" is measured, not asserted.

**F — Data-trust surfaces.** Three-level provenance (page / module-when-different / row-when-
material); labels in plain language ("Imported from Glofox," "Live in Kelo"); detail disclosure on
tap (absolute + relative time, source, run id, reconciliation state, Health link). Health page:
current issues (each naming its *operational consequence* — "Bookings are 4h stale; don't trust
imported availability"), entity freshness, authority matrix (read source / write source / cadence /
**countdown-to-cutover narrative**), import runs, quarantine, reconciliation history, a
**verification ledger** (append-only, exportable feed of every automated check with pass/fail
and counts), and the trust-streak headline **"days since an unchecked or unmarked figure"** —
marked-imported figures don't break it, failed-check ones do (both
adopted from the design round — the founding trauma turned into a number). **The
"prove this number" gesture** (new, universal): every KPI and briefing-cited metric offers a
two-tap path → constituent rows + envelope metadata + export. Trust is a gesture, not a promise.
**Anti-habituation controls** (new): alerts dedupe into incidents; banners are relevance-scoped
(not worst-source-anywhere); acknowledge ≠ resolve; the system tracks proceed-despite-red rates
and chronically-dismissed alerts for periodic review; migration/source labels retire at cutover.

**G — Assisted onboarding.** Five-stage checklist (studio & team / rooms & services / plans,
prices, tax / import & reconciliation / payments, waivers, launch readiness), each stage marked
owner vs Kelo-assisted, **completion detected from real data, not self-report**. Import review:
totals (imported / merged / quarantined / rejected), exceptions grouped by cause, batch decisions
only within a same-cause group, before/after previews, reversible until commit. Launch readiness
hard-gates: no critical reconciliation errors, test payment + Terminal verified, active waiver
version, resources + plans configured, roles assigned, receipt/message delivery tested. Noncritical
warnings acknowledgeable with an audit note. Post-launch the checklist archives under More.

**H — Member booking (beta).** Five stages on the studio's domain, SSR, phone-first:
**Choose** (real availability first — earliest slots, total price/credit cost upfront, honest
waitlist with position and offer-window expectations) → **Identify** (returning verified device:
already signed in, zero friction; imported: claim-in-flow with masked-contact verification and
anti-enumeration neutral responses; new or new device: minimal contact + one-time code — *no
unverified guest checkout*, ruling 7) → **Waiver** (if missing or outdated — read + typed-name
acknowledgment before any tender is shown, honoring ruling 3; guardian path for minors) →
**Review & pay** (credits offered first; wallet/card via embedded Stripe elements — no hosted-page
redirect, resolving the on-domain promise; taxes, terms, remaining balance visible) →
**Confirmed** (durable state that survives refresh/reopen; receipt; add-to-calendar; directions;
cancel/reschedule per the policy shown at booking; balance).
**Account area** adds **self-serve card update** (entry points: the dunning email/SMS link — which
deep-links here after verification — and the account view; embedded elements; success updates the
dunning queue and shows "card updated ✓, next retry Mar 3"; failure states honest), upcoming
bookings, balances with expiry, receipts, waiver status, and unsubscribe preferences.
Hold preserved through verification hiccups; browser back never loses the slot; no forced profile
completion, marketing opt-in, or app download. **Claiming as identity resolution** (new): recycled
phones, shared family emails, and split-balance duplicates route to a support-assisted, audited
resolution workspace that preserves the held slot and never exposes balances pre-verification.
**The phoneless member** (new, end-to-end): staff-assisted identity at the desk (name + DOB or
booking ref), waiver on the studio device, verbal/printed booking reference, receipt state
"offered on screen / printed / deferred until contact available" — deferred delivery is a designed
state, not a failure.

## 4. UI guidelines

**The provenance contract.** One `DataBoundary` component wraps every API-backed region; it
requires `{ data, meta }` — missing metadata is a dev-time error and a monitored, visibly-refused
render in production (never a silent fallback). Full state taxonomy every data region implements:
initial-loading (geometry-stable skeleton) · background-refresh (existing data + "Updating") ·
empty (what fills it + CTA) · filtered-empty ("clear filters") · error (consequence, retry,
reference id) · partial-error (siblings survive) · stale (visible + labeled) · offline (only
supported local actions enabled) · permission-denied (names the role, doesn't imply missing data) ·
processing (durable, safe to leave and return) · conflict (local intent vs server truth +
resolution).

**Money patterns.** Status pills by shape+icon+color, never color alone. Proportional
confirmation (ruling 4), with **two distinct auth mechanisms** that must not be conflated:
*actor re-authentication* (shared-device identity — fast PIN re-entry before any refund, comp, or
sensitive deep link, always, per §6) and *manager step-up authorization* (a second, manager-role
approval required above the tenant's refund threshold and for discounts/comps/immediate
cancellations). Ordinary bookings get in-context review; retry/refund get explicit confirms;
typed phrases never. Consequence previews name the
member-visible effect. Buttons name the act and amount. Duplicate submission disabled at
activation; idempotency keys client-generated. Receipts: delivery state shown, resend without
re-charging, "no receipt" requires a reason. Slow mutations grow explanatory text after 1s
("Waiting for terminal…"), offer safe navigation with a durable operation link after prolonged
delay, and never reset because a browser timed out.

**Forms.** Visible labels (placeholders are examples); format-validate on blur, business-validate
on submit; error summary with focus moved to it, inputs preserved; disabled buttons carry adjacent
reasons; autosave for low-risk drafts only (outreach copy, schedule drafts) — never for approvals,
sends, refunds, publishes; search-before-create mandatory for people; timezone labeling: one
persistent page-level studio-timezone label, per-value labels only where zones differ (relaxed
2026-07-17 — labeling every value was audit-flagged as unimplementably strict).

**Tables & reports.** One table system (sort, filter chips, column visibility, pagination/
virtualization, keyboard nav); filters + ranges in the URL; summaries always drill to rows; mobile
renders priority-field cards, not crushed columns; charts ship with a table view + text summary;
exports operate on the current filtered view (CSV/XLSX; large exports become server jobs with
progress) and embed timezone, filters, generated-at, and data-as-of; report headers carry revenue-
dictionary tooltips (`ⓘ MRR — …`) and the as-of stamp; exclusions are stated, never silent.

**Notifications.** Four mechanisms with strict lanes: inline validation (local) · toast
(transient confirmation of the user's own reversible action — never errors needing action) ·
banner (this page is degraded/stale/offline/blocked; severity-stacked compactly when concurrent,
never hiding a payment outage behind a staleness banner) · alert center (persistent, actionable-
unread counts only, deep-linking, dedup-grouped). Off-app escalation (email/SMS) reserved for
red-state rules. Anti-fatigue controls per §3F.

**Copy.** Plain, specific, numerate ("3 failed payments — $214"); relative times under 24h,
absolute after, tz-labeled; sentence case; no blame; no humor on money or waivers; customer-facing
copy never exposes segment labels, LTV, decline codes, or staff notes.

## 5. Component system & theming architecture

**Stack (unanimous across all four plans):** shadcn/ui (Radix primitives) + Tailwind CSS +
TanStack Table + React Hook Form + Zod + Lucide + **Storybook** (every shared component's stories
must cover the §4 state taxonomy) + **axe-core in CI**. Charts only through a thin wrapper kit
(`KpiTile`, `TrendSpark`, `Heatmap`, `FillBar`) — feature code never imports a chart library.
shadcn components live in one owned package; feature code imports Kelo components, never Radix
directly; **anything not on the component list needs a written reason before creation.** Payment,
booking, send, and import states are typed discriminated unions rendered exhaustively — unknown
states fail visibly, never fall through to success.

**Core component list** (merged, ~36 — this list is the allowlist, and it includes everything the
plan's own flows and guidelines require): AppShell, RoleNavigation, PageHeader, DataBoundary,
FreshnessChip, SourceLabel, ReconciliationBanner, Banner, Toast, AlertCenter, StatusPill, KpiTile,
InsightCard, FocusQueueItem, ResumableWorkCard, AsyncButton, ConfirmAction (with step-up variant),
MoneyTimeline, ReceiptPanel, AuditTimeline, QueryTable, FilterBar, ChartWithTable + the chart
wrapper kit (KpiTile/TrendSpark/Heatmap/FillBar — part of this list), PersonSearch, SlotPicker,
HoldTimer, WaitlistPanel, TenderChooser, TerminalStatus, WaiverCapture (typed-name + checkbox),
CheckInBoard, OfflineQueueBar, DraftEditor (tracked changes), ApprovalCeremony,
ScheduleDraftEditor, EmptyState / ErrorPanel / Skeleton, StepWizard, CommandMenu.

**Tokens — the design-tool socket.** Three CSS-variable layers: primitives (raw scales — the only
layer the future designer touches) → semantic (surface/text/border/action/focus + the domain set:
`--status-confirmed/processing/failed/refund-pending`, `--freshness-live/aged/stale`,
`--data-native/imported`, `--ai-accent`) → component tokens where needed. Feature code uses
semantic tokens only; raw hex and arbitrary Tailwind values are lint-blocked. Visual identity
lands by remapping layer 1→2 with zero component rewrites; tenant branding for the member surface
is a validated token subset (logo, action color, surfaces, type), never arbitrary tenant CSS;
dark mode is a future parallel semantic map (deferred, ruling 1). Density: comfortable default;
`dense` for tables; `desk` sizing (≥48px primaries) for counter surfaces. Motion minimal,
reduced-motion respected.

## 6. Accessibility & device strategy

**WCAG 2.2 AA, both surfaces** (ruling 2), enforced mechanically: Radix semantics, axe CI, token
contrast tests, keyboard-complete workflows (tables, dialogs, pickers, payment inspection), focus
management (route change → heading; dialogs trap and restore), restrained live regions for
processing/queued/confirmed/failed/offline transitions — **tuned so speakers at the counter never
announce PII**, status never color-alone, real links in table rows (no click-only rows, no
right-click dependencies), error summaries linking to fields, 200% zoom without loss, accessible
OTP fields (paste/autofill), waiver acknowledgment fully keyboard/screen-reader operable (typed
name + checkbox — no canvas anywhere), larger-text mode for 50+ owners.

**The physical environment is a design target** (the critiques' flagship gap): ≥48px primary
targets on Desk; spacing tuned for damp-finger mis-taps; destructive/money actions away from
screen edges; waiver acknowledgment is typed-name + checkbox (no signature canvas — wet fingers
and drawn signatures don't mix, and typed acknowledgment is inherently accessible); high-contrast
tested under lobby glare; device acceptance testing includes wet-hands operation and a
waterproof-case reality check.
**Shared-device hygiene:** auto-lock after inactivity with fast role-aware re-entry; signed-in
actor always visible; person-search and half-completed sales clear on safe timeout; re-auth before
refunds/comps and before reopening sensitive deep links; browser autofill disabled on person
fields; receipt-destination masked and confirmed before sending to imported contacts.

**Devices:** Owner — phone (Today, approvals, payment chase) + desktop (money, schedule, reports;
schedule editing and dense reports are desktop-preferred with a stated simplified phone fallback:
view + one-tap actions, no drag). Front desk — landscape tablet, full-screen Desk, Terminal +
optional printer (printer failure states designed: out-of-paper → receipt state "deferred," never
blocking the sale). Trainer — phone. Member — phone-first SSR. **No PWA installation in v1**
(rulings from B/A critiques): a cached shell risks stale-as-fresh; the check-in retry queue is the
only offline surface, deliberately. SPA cold-load mitigation for the coffee-line phone: tiny Today
bundle, route-level code splitting, prefetch-after-auth, no reporting/editor/terminal code on the
Today route. **Real-user monitoring by flow and device** (new): cold vs warm load, studio Wi-Fi vs
4G, Terminal confirmation time separately from server acceptance, tap-to-durable-confirmation per
booking step, abandonment by funnel step — PII-redacted; synthetic p95 alone is theater.

## 7. Member surface (beta) — the polish bar, testable

On-domain end to end (embedded payment elements, no hosted redirects); returning member **on a
verified device/session** books in ≤3 taps + wallet auth (the one-time-code step applies to first
bookings and new devices only — ruling 7); first-time incl. code + waiver <90s; p95 <1s per step on 4G mid-range hardware
(tested on current + prior iOS Safari / Android Chrome); waitlist join is one tap with honest
position and offer-window; offers expire visibly and pass to the next member; cancellation shows
the policy accepted at booking; confirmations arrive within 60s and the UI states delivery;
no dark patterns (no fake scarcity, no countdown pressure, no pre-checked boxes, no late fees);
account claiming per §3H with the identity-resolution workspace behind it. Full §3H flow governs.

## 8. What we will NOT design in v1

Dark-mode visual pass (token-ready only — dual-theme QA before an identity exists is double
work) · dashboard customization / draggable widgets / saved layouts (they dilute the briefing's
authority and double UI state surface) · CRM journey builders and drag-drop automation designers
(lifecycle flows are configured forms) · autonomous AI send/publish/refund (forever, not just
v1) · native mobile apps + PWA install (app-store surface; cached shells risk stale-as-fresh) ·
full offline operation (check-in queue only — offline money is unacceptable conflict risk) ·
tips, split tender, till management, cash-drawer reconciliation (the §3D cash summary is
deliberately not this) · drag-and-drop schedule manipulation (structured drafts + publish review;
drag is imprecise on tablets and dangerous around bookings) · choose-your-spot seat maps (a sauna
or plunge room is one resource booked whole for a time window — there are no seats to choose, so
parity with Bsport's booking bar holds without them) · custom report builders (seven canned
drill-down reports + export + `/ask` cover the need; builders are permanent maintenance tax) ·
complex waitlist optimization (sequential offer with expiry only; configurable ranking waits for
evidence) · marketplace/social/gamification (off the daily-operations mission) · in-app chat or
an operator messaging inbox (outreach is logged email/SMS; an inbox is a support product) ·
notification preference centers (sensible defaults; toggles multiply QA surface) · per-user
density customization (premium before the core loop is proven) · i18n translation (strings
externalized as cheap discipline, English only until a non-English tenant exists) · animated
product tours (the checklist with real-data detection replaces them; tours rot) · staff
practice/sandbox mode (mitigation: new staff train on the staging tenant with real-shaped seed
data — a build-plan asset, not a product surface) · medical/health/biometric anything (hard
product ban) · final visual identity (the design tool's job — this plan ships its socket).

## 9. Recommended amendments back to the build plan

UX findings that should modify [plan-final.md](plan-final.md):

1. **Waiver preflight before payment** in every booking path — and retire the "interim check-in-
   time block" earlier than planned: imported bookings without current waivers get a pre-arrival
   signing link + a "Waiver needed" desk queue, so members are never surprised at the counter.
2. **Hold-extension semantics** in the booking engine: payment initiation freezes hold expiry;
   one free extension during waiver/OTP; payment-after-release auto-refund already exists — add
   the extension rules to the `book()` RPC contract.
3. **Room readiness states** on resources (ready / turnover / not-ready / out-of-service) distinct
   from maintenance windows, exposed to the slot picker and excluded from demand analytics.
4. **Cash-day summary** as a first-class Money query (sum + count of cash tenders by day).
5. **Verified-contact rule** for all member bookings (kills unverified guest checkout; simplifies
   dedup and claiming).
6. **RUM telemetry** (PII-redacted) added to the observability stack alongside Sentry.
7. **No-show consequence engine**: no-show marking executes the booking's policy snapshot
   (credit forfeit / fee) as a money event with notice + reversal — same durable-state discipline
   as refunds.
8. **Embedded Stripe elements** (not hosted pages) for member card entry and card update, to honor
   the on-domain promise — Stripe-hosted remains acceptable for operator-initiated dunning links.
9. **Supporting machinery this UX plan requires that the build plan doesn't yet contain**
   (each small, none architectural):
   - **Step-up auth**: per-user fast PINs (hashed, audited) + a re-auth API for shared-device
     actor verification and manager authorization; tenant-configured refund threshold setting.
   - **Waiver evidence**: confirm typed-name + checkbox as the sole signature artifact (this plan
     designs no drawn-signature canvas — simpler *and* more accessible than the critiques' palm-
     rejection concerns assumed); add re-present-on-version-change and persist-failure review
     states to the waiver flow.
   - **Focus-queue state**: dismissal-with-reason and snooze persistence + the weekly
     dismissed-items digest job.
   - **Outreach pipeline**: tone-lint step, batch pacing, and unsubscribe/STOP suppression
     surfaced per person (suppression itself already exists).
   - **Party bookings**: allow one checkout to attach multiple attendee bookings (booked-by /
     attendee split already exists; this is a checkout-grouping concern).
   - **Waitlist offers**: sequential offer engine with expiry windows + manual promotion override
     (audited) — the build plan's waitlist covers class auto-promote; room-slot offers need the
     same machinery per tenant config.
   - **Concurrency surfaces**: hold-owner visibility, single-flight payment retries, and
     being-merged hints exposed via the API.
   - **Health additions**: per-device offline check-in queue reporting; payment `written_off`
     state; schedule draft/publish/history tables + endpoints; async export jobs (CSV now, XLSX
     later); receipt printer support at the Desk (deferred receipt state).
   - **Drop the installable PWA** from plan-final §8's mobile stance: responsive web only —
     a cached app shell risks stale-as-fresh, which the freshness contract cannot tolerate.
   - **Quiet hours**: confirmed studio-location timezone (aligned; no per-person timezone data
     needed).

---

## Part III — Design-round amendments (2026-07-17, accepted by owner)

The visual design guide is delivered and accepted: **[docs/design/](../docs/design/)** —
`DESIGN-GUIDE.md` (Route 01 "The Quiet Instrument" + accepted amendments), `tokens.json` /
`tokens.css` (the machine-readable contract, AA- and CVD-validated), the stylescape, all P0+P1
screen mockups, and the Today phone variant. Changes absorbed into this plan: rail/phone nav
labels (§2), "Send test to me" in the approval ceremony (§3B), the verification ledger + trust
streak on Health (§3F). Standing rules from the design review now bind the build: `neutral-400`
is never a text color (floor = `neutral-600`); form controls use the dedicated ≥3:1 input-border
token; charts use max 3 categorical hues (slate/amber/birch — green/red stay status-reserved)
with patterns beyond; tenant text tokens are AA-validated mechanically at intake. The circled-k monogram is the **final mark** (owner-confirmed 2026-07-17). Open, non-gating:
The Sauna Guys' brand assets for the member-surface skin (owner: not needed right now).
**The design gate is closed.**

### Part III addendum — external design audit (2026-07-17)

The finalized design system was audited by the three external council models (45+ findings,
verified before adoption; full record: plans/audit-design-{grok,sol,kimi}.md). Fixes live in
docs/design/ (tokens v1.1 semantic layer, guide Amendments round 2, mockup copy corrections).
Deltas absorbed into this plan: timezone-labeling rule relaxed (§4); the component allowlist's
written-reason rule guards novel domain components only — base shadcn/Radix primitives are
pre-approved (§5); DataBoundary's taxonomy is compositional (primary render state + independent
freshness/connectivity/mutation flags), not mutually exclusive (§4); the heatmap's tint is
30-day fill with any demand overlay as a separately named, later layer (§3E). The audit's most
important confirmations: no send action may exist outside the ApprovalCeremony, and the
verification-state trio (verified / imported-unverified-marked / failed-check-suppressed) now
has one canonical definition shared by the guide, the trust streak, and the intelligence plan.

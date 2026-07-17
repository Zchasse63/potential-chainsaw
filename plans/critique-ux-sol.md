# UX/UI plan critique

## Per-plan assessment

### Plan A

#### Strongest ideas worth stealing

1. **Best treatment of durable business state.** The principle that “a toast is not proof” is exactly right. Persistent payment/booking timelines, receipt-delivery status, webhook-aware processing, and retry history directly address Kelo’s highest-risk trust failures.
2. **Excellent provenance hierarchy.** Page-, module-, and row-level freshness avoids both extremes: hiding provenance in tooltips or stamping every cell. The `DataBoundary` contract, mixed-source labeling, and explicit authority matrix are unusually concrete.
3. **Strongest end-to-end flow detail.** The morning briefing, outreach approval, refund, schedule-publish, onboarding, and degraded check-in flows all specify slow, stale, partial, empty, and conflict states rather than only happy paths.
4. **Good waiver sequencing judgment.** Moving waiver preflight before payment avoids a paid-but-unbooked disaster. The plan also correctly calls out check-in-time waiver surprise as harmful and proposes a pre-arrival queue/link.
5. **Best agent-maintainability guardrails.** Typed state unions, a controlled shadcn/Radix wrapper layer, token linting, Storybook state coverage, and prohibiting direct primitive imports give coding agents a bounded vocabulary.

#### Weakest points

1. **Stale-data blocking is too broad.** “If data is stale or reconciliation is critical, initiating a refund or retry is blocked” needs dependency-level scoping. A stale roster import should not block a Stripe-native refund; otherwise the trust system becomes an availability problem.
2. **The owner’s mobile IA underrates Money.** `People` gets a bottom-nav position while Money, Outreach, and Health are under More. Deep links from Today help, but failed-payment work is explicitly daily and should remain directly discoverable.
3. **The waitlist design is only partially operationalized.** It defines expiring offers and statuses, but not simultaneous acceptance, unreachable members, fallback to the next person, staff override, or how the member receives and accepts the offer.
4. **The component program risks becoming a project of its own.** Requiring roughly two dozen product components, exhaustive Storybook states, visual regression, XLSX export, and multiple maintenance gates “before feature proliferation” is durable but potentially too front-loaded for one owner plus agents.
5. **Addressable sensitive pages create a shared-device tension.** Making person and payment pages shareable/bookmarkable is good, but the later warning about browser history does not specify URL redaction, recent-history cleanup, or reauthentication for reopening sensitive links.

#### Contradictions or required omissions

- **No material locked-decision contradiction.** Plan A explicitly identifies UX damage from hourly imports and interim waiver-at-check-in behavior without pretending those constraints do not exist.
- All required flows and sections are present.
- The member waitlist experience is noticeably thinner than the rest of the member funnel, despite waitlist polish being part of the competitive context.

---

### Plan B

#### Strongest ideas worth stealing

1. **Role-shaped surfaces are well articulated.** “Not an owner laptop with items grayed out” is a strong rule for front-desk and trainer usability and reduces accidental access on shared devices.
2. **Good outreach approval ceremony.** Exact audience count, cost estimate, resolved merge-field previews, exclusions, and an explicit “Send to N people” action make human approval meaningful rather than ceremonial theater.
3. **Strong money receipt policy.** Requiring contact capture or an explicit “No receipt” reason is a useful operational control, and separating receipt resend from the money action prevents duplicate charges.
4. **Useful engineering-tension section.** It correctly calls out the SPA cold-start risk, the waiver-policy ambiguity, and the perceived-speed cost of waiting for server truth without trying to overturn locked decisions.
5. **Good desktop interaction model.** Split-view People, Money, and Segments surfaces preserve context and reduce navigation churn during repetitive owner work.

#### Weakest points

1. **The phone KPI carousel is a usability mistake.** Horizontal scrolling hides metrics, creates weak discoverability, and is awkward in a coffee-line scan. A wrapped grid or prioritized summary is safer.
2. **The booking sequence creates a paid-but-blocked risk.** It specifies Pay before Waiver, then says booking blocks without a current signature. If payment can complete before waiver failure, this recreates exactly the public-facing ambiguity Kelo must avoid.
3. **“Hard timeout 3s” is not a good slow-state design.** A performance budget should trigger telemetry and degraded messaging, not convert a potentially recoverable request into an error at an arbitrary boundary.
4. **Always returning an authenticated owner to Home breaks task continuity.** Expired sessions should preserve safe deep links, especially when the user came from a card-update link, alert, or payment detail.
5. **The single-banner rule hides concurrent hazards.** Showing only the highest-severity banner and relegating everything else to Health could conceal a simultaneous payment outage and stale roster problem. Multiple relevant issues need a compact stack or issue summary.

#### Contradictions or required omissions

- “This trains tomorrow’s briefing” overstates the feedback contract. The brief says thumbs are an evaluation signal, not that a single response directly trains or changes the next briefing.
- Waitlist handling is under-specified: “staff notifies / books manually” does not cover offer acceptance, expiry, races, or member confirmation.
- “Failures partial-listed” after schedule publication is ambiguous and potentially unsafe. The plan should state whether publication is atomic rather than implying partial schedule mutation.
- The screen inventory is not truly full: audit history, receipt history, offline retry resolution, publish history, and several settings/exception subviews remain implicit.

---

### Plan C

#### Strongest ideas worth stealing

1. **“One conversation, one surface” is a strong front-desk doctrine.** Keeping person selection, slot, payment, waiver, and confirmation in one pane is appropriate for a customer waiting at the counter.
2. **Good terminal-level detail.** Reader states, alternative tender recovery, cash change calculation, and preservation of the slot after a failed card attempt are more concrete than most plans.
3. **Useful global search model.** Search across people, bookings, and transactions is well matched to front-desk interruption and owner investigation work.
4. **Money timelines are consistently applied.** Retry, refund, and webhook states are made inspectable instead of being reduced to a status badge.
5. **The source-of-truth labels on edit screens are valuable.** Explaining why an imported field is locked is much better than merely disabling it.

#### Weakest points

1. **It invents high-confidence business claims without a data contract.** “Expected revenue at risk,” “projected +$420/wk,” and “confidence 78%” are dangerous in a product whose founding failure was fabricated certainty. These values need defined models, sample-size warnings, and provenance—or should not appear.
2. **Defaulting to the last-used payment method is unsafe.** In a shared front-desk context, this can encourage an accidental card/cash/credit selection for the next member. Default the safest eligible tender or require explicit selection.
3. **Dark mode from day one is unjustified scope.** It doubles status, chart, contrast, and tenant-brand QA before the visual identity exists. Token readiness is enough.
4. **Row-click and right-click interactions conflict with its accessibility posture.** A row must contain a real focusable link, and common actions cannot depend on right-click, especially on tablets.
5. **The member funnel adds friction before availability.** A “studio hero,” password creation, and optional guest checkout weaken the Instagram-to-booking speed goal and increase duplicate-account risk.

#### Contradictions or required omissions

- The provenance contract is weaker than required: missing metadata only produces a console error. The brief says production UI must be unable to render data without provenance; the fallback must visibly refuse rendering.
- As in Plan B, payment precedes waiver despite booking being blocked without the current waiver. That sequence can leave money and booking state inconsistent.
- Guest checkout conflicts with reliable imported-account claiming unless identity is still verified and deduplicated before person creation.
- The schedule flow lacks a strong publish diff, effective date, and atomic failure contract. “Reschedule or cancel-with-notify” is not enough for existing bookings.
- Waitlist handling remains mostly a notification concept rather than a fully specified operational flow.
- The proposed AAA treatment is hand-wavy. “AAA contrast for money amounts and status badges” is not a complete accessibility strategy and its claimed incremental cost is understated.

---

### Plan D

#### Strongest ideas worth stealing

1. **The “counter test” is memorable and operational.** One-handed tablet use, interruption recovery, 90-second completion, and large targets are better acceptance criteria than vague “front-desk friendly” language.
2. **Excellent copy guidance.** “3 failed payments — $214” and explicit time-zone-aware timestamps are practical rules that improve actionability and reduce interpretation.
3. **Strong outreach review details.** Quiet-hours checks, named consent exclusions, cost estimates, resolved merge-field previews, and tracked changes make approval unusually trustworthy.
4. **Real-data onboarding completion is smart.** Detecting checklist completion from actual configuration instead of self-reported checkboxes prevents false launch readiness.
5. **The member funnel correctly exposes availability before login.** Treating account claiming as part of booking rather than a separate registration project is the right conversion choice.

#### Weakest points

1. **The IA is bloated with unbriefed features.** Leads, retail catalog, gift cards, payouts, campaign automations, tenant billing, and AI/PII toggles undermine the stated “small, closed vocabulary” and add surface area unrelated to the required flows.
2. **The five-state `DataRegion` is too reductive.** It omits background refresh, partial error, permission denied, processing, offline queue, and conflict states—the exact states this product repeatedly needs.
3. **The screen inventory is internally inconsistent.** It claims 24 screens but lists more, while assisted onboarding, import exception resolution, trainer screens, and several Desk subflows are not cleanly represented.
4. **“AA-pragmatic” is not a conformance target.** Limiting screen-reader correctness to five core flows is weaker than WCAG 2.2 AA and risks inaccessible reports, settings, and exception resolution.
5. **PWA-installable operator and member apps are unnecessary and risky.** Without a precise cache policy, installability can encourage stale shells or API data in a product where stale-as-current is existentially dangerous.

#### Contradictions or required omissions

- **AI regeneration contradicts the locked daily-cached briefing model.** On provider failure, Plan D offers “regenerate”; the brief says the briefing is generated once daily and cached.
- **Gift-card tender exceeds the locked POS v1 scope.** The specified tenders are Terminal, cash, credits, and comp.
- **The front-desk booking flow omits waiver preflight and minors’ guardian acknowledgment.** Waiver appears only in check-in handling, despite booking generally blocking without the current version.
- **No-show marking is not actually specified as an operator flow.**
- **Waitlist handling is only an affordance.** There is no offer, acceptance, expiry, skip, or conflict model.
- **Onboarding lacks a proper launch-readiness gate.** It does not clearly require reconciliation health, terminal/test payment, current waiver, configured resources, and assigned roles.
- “Zero redirects off-domain” conflicts with a “Stripe-hosted” card-update page unless the implementation is embedded rather than hosted navigation; “wrapped on-brand” does not resolve that.
- “Account claiming never creates a duplicate” conflicts with guest checkout followed by later merge tooling.
- The `/ask` reference in the not-design section is unsupported by this self-contained brief and suggests reliance on an external plan.

---

## Comparative judgment

| Section | Strongest plan | Why |
|---|---|---|
| **Design principles** | **A** | Its doctrines connect directly to Kelo’s distinctive risks: provenance, durable server state, authority during migration, local degradation, and front-desk social pressure. |
| **Information architecture** | **A** | It provides the clearest role-specific navigation, mobile adaptation, frequency rationale, screen inventory, and treatment of addressable detail pages. |
| **Core flow specifications** | **A** | It is the only plan that is consistently detailed across all eight flows, including partial failure, stale dependencies, webhook uncertainty, import quarantine, and publish validation. |
| **UI guidelines** | **A** | Its state taxonomy, provenance hierarchy, durable money confirmation, export metadata, and processing/conflict patterns form the most complete interaction rulebook. |
| **Component/theming architecture** | **A** | The controlled wrapper layer, typed state unions, three-tier tokens, lint rules, and agent-facing examples offer the strongest protection against component drift. |
| **Accessibility and devices** | **A** | It sets an unambiguous WCAG 2.2 AA target, covers route focus and live regions, and uniquely addresses SPA bundle risk and sensitive shared-device sessions. |
| **Member-facing surface** | **A** | It best handles neutral account enumeration, duplicate imported profiles, hold recovery, back-button behavior, payment processing restoration, and no forced account completion. |
| **Not-design list** | **A** | It is the most tightly tied to locked scope and maintenance economics, while explicitly excluding autonomous AI, full offline operation, advanced POS, dark mode, medical data, and generalized SaaS administration. |

**Overall:** Plan A is materially strongest. Plan B is a credible second; Plan C contains several unsafe certainty and interaction choices; Plan D is sharp in places but the least disciplined about scope and locked behavior.

---

## What EVERY plan missed

### 1. The physical environment is not an ordinary SaaS office

Plans A–D design for “tablet at a counter,” but none designs for **wet fingers, condensation, glare, steam, towels, cleaning chemicals, or a tablet being handed between staff and members**.

Practical consequences:

- Wet touch input can fail or produce repeated taps; primary payment and check-in actions need stronger duplicate protection and large spacing.
- Signature canvases are especially unreliable with wet hands and are often inaccessible.
- Devices need a staff-facing mode, customer-facing handoff mode, and obvious “ready to hand back” state.
- Tablet placement, waterproof cases, washable styluses, glare, and keeping electronics outside wet zones should be part of device acceptance testing.
- Destructive and money actions should not sit near screen edges where a wet palm can trigger them.

A–D all treat touch targets as a pixel measurement, not as a physical-operating-environment problem.

### 2. There is no complete “member has no phone” path

A member may be in a robe with their phone in a locker—or may not have brought one. Yet A–D repeatedly rely on QR links, SMS receipts, OTPs, card-update links, or mobile waiver completion.

Kelo needs an explicit on-site fallback:

- Staff-assisted identity confirmation without account claiming.
- Waiver completion on a studio device, with an accessible non-drawn-signature option.
- Printed or verbally confirmed booking reference when no phone/email is available.
- A receipt status of “offered on screen/printed,” not only “sent.”
- A clear block when a guardian is required but unavailable, with empathetic copy and no payment taken.

Individual plans mention printing or sign-on-tablet, but none carries a no-phone member through the entire booking, waiver, payment, and receipt journey.

### 3. Room availability is not the same as bookable capacity

None of A–D models the recovery-specific operational state of a sauna/plunge room:

- Cleaning or turnover buffer.
- Preheat/cool-down time.
- Maintenance or out-of-service state.
- Temperature/readiness failure.
- Temporary closure after a spill or equipment fault.
- Moving affected bookings and triggering refunds/credits.

Without this, a slot can be technically empty but physically unusable. Schedule tuning and room-utilization reporting will also produce bad recommendations if maintenance and turnover time are treated as demand failure.

### 4. Hold expiry is not coordinated with waiver, OTP, Terminal, and webhook timing

All four plans use or imply temporary slot holds, but none fully specifies the hardest race:

1. Slot is held.
2. Member searches for a guardian, completes OTP, reads a waiver, or waits on Terminal.
3. Hold expires.
4. Payment succeeds or webhook arrives afterward.

The UX must define:

- When and why a hold extends.
- Visible warnings that do not pressure members deceptively.
- Whether payment initiation freezes expiry.
- What happens if payment succeeds after capacity was released.
- How the user recovers without being charged twice.
- Whether a staff user can safely restart after leaving the screen.

This is the single most dangerous booking-state gap across A–D.

### 5. Terminal failure recovery is not detailed enough

A–D name Terminal states, but none fully designs the two-device choreography when the operator app and reader disagree:

- Reader says approved; app still says processing.
- App times out; reader is waiting for a card.
- Member removes the card early.
- Reader disconnects or loses battery.
- Staff switches to cash while a card result is unknown.
- A late webhook confirms after the staff has retried.

The UI needs a **“do not retry yet—verifying result”** state, reader-specific instructions, a safe tender-switch rule, and a reconciliation path that prevents duplicate payment while keeping the customer-facing message discreet.

### 6. No-show marking ignores its emotional and financial consequences

All plans treat no-show largely as an attendance status. None adequately specifies:

- Whether marking no-show forfeits a credit or charges a fee.
- The consequence preview before staff confirms.
- Whether the member is notified.
- How a mistaken no-show is reversed.
- Whether reversal restores a credit and sends a corrected receipt.
- How disputes appear in the audit timeline.

At a wellness studio, a mistaken no-show can become a money dispute immediately. This should follow the same durable-state discipline as refunds.

### 7. Shared-counter privacy is under-designed

A and B acknowledge shared devices, but A–D all miss the actual shoulder-surfing and abandonment risks:

- Mask phone/email and card details until needed.
- Never expose “At-risk,” lifetime value, failed-payment reason, or private staff notes on a member-facing handoff screen.
- Clear abandoned person searches and half-completed sales after a short safe timeout.
- Prevent browser autofill from exposing another member’s information.
- Reauthenticate before reopening sensitive payment/refund deep links.
- Define what appears on a receipt printer and how unclaimed printouts are handled.
- Confirm a masked receipt destination with the member before sending to an imported address or household phone.

“Role-based navigation” is not enough when the customer can see the screen.

### 8. Waiver capture is treated as a signature widget, not a legal interaction

None of A–D specifies an accessible alternative to drawing on a canvas, or handles:

- Screen-reader-compatible consent.
- Keyboard/typed acknowledgment where legally valid.
- Failed signature upload after payment.
- A waiver version changing during an active booking.
- Guardian identity and authority—not merely a guardian checkbox.
- A member declining the waiver after a slot has been held.
- Providing the signed document afterward.

A signature pad alone is both physically fragile in this environment and an accessibility risk.

### 9. Imported-account claiming needs a real identity-resolution operation

A–D mention OTP and support paths, but none fully handles stale or ambiguous imported identity data:

- Recycled phone numbers.
- Shared family email addresses.
- A member who no longer controls the imported contact method.
- Minor accounts using a guardian’s contact details.
- Duplicate profiles with balances split across them.
- A malicious claimant who knows someone else’s phone number.
- Preserving a held slot while support resolves the account.

“Contact support” is not a flow. Operators need a safe, audited resolution workspace that does not expose pack balances before identity is established.

### 10. Concurrent staff actions are barely considered

Offline check-in conflicts are covered, but A–D do not adequately design for normal online concurrency:

- Two staff members selecting the final slot.
- Two operators retrying the same payment.
- One manager refunding while another starts dunning.
- Schedule publication racing with a booking.
- One staff member editing a person while another merges the record.
- A member cancelling while the front desk checks them in.

Kelo needs object-version conflict messaging, read-only “being edited by” hints where useful, and recovery that preserves the operator’s intent without pretending a stale action succeeded.

### 11. Alert fatigue and provenance habituation will erode trust

Every plan adds freshness chips, banners, badges, Health alerts, and notification counts. None defines how those signals avoid becoming wallpaper after months of routine import lag.

Needed controls include:

- Alert deduplication and incident grouping.
- Ownership and escalation for unresolved alerts.
- Measuring alert age and acknowledgment without treating acknowledgment as resolution.
- Relevance-scoped banners rather than “worst source anywhere.”
- Retirement of migration/source labels after Kelo becomes authoritative.
- Monitoring how often users proceed despite red warnings.
- Periodic review of alerts that are frequently dismissed or never acted upon.

Trust UI that is constantly visible but rarely actionable eventually communicates nothing.

### 12. Performance is specified as a number, not an observed user experience

A–D repeat the `<1s` budget, but none defines real-user monitoring by flow and device:

- Cold phone load versus warm SPA navigation.
- Studio Wi-Fi versus 4G.
- Terminal confirmation time separately from server acceptance.
- Availability render time separately from full page load.
- Time from tapping “Book” to durable confirmation.
- Interaction latency on low-end shared tablets.
- Error and abandonment rates by booking step.

Synthetic p95 tests can pass while a wet, aging counter tablet on poor Wi-Fi still loses sales. Performance needs user-visible diagnostics and field telemetry, with strict PII redaction.

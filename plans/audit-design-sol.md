1. **Critical — The trust contract contradicts itself on whether unverified numeric values may render at all.**
   - **Evidence:** `plans/plan-ux-final.md §3F` defines the headline as “**days since an unverified figure shown**”; `docs/design/DESIGN-GUIDE.md §4` instead says “a trailing `*` on any **unverified figure**”; `docs/design/p0-screens.html §04` visibly renders `"$480*"` while the Health mockup simultaneously reports `41` days since an unverified figure was shown, and its footer says unverifiable numbers are merely “grey[ed] out.”
   - **Suggested fix:** Define separate machine states for `metadata_missing`, `unreconciled`, and `verified`; specify for each whether the value is hidden or shown, and make the trust-streak calculation consistent with that rule.

2. **Critical — The schedule heatmap’s governing metric and observation window differ between the UX contract and the accepted mockup.**
   - **Evidence:** `plans/plan-ux-final.md §3E` specifies “**30-day fill**” with closures and turnover/maintenance excluded, while `docs/design/p0-screens.html §07` defines tint as “booking demand (**searches + waitlists, last 8 weeks**)” and its footer additionally includes “sellout speed.”
   - **Suggested fix:** Canonically define the heatmap metric, numerator, denominator, exclusions, window, and source fields; if both fill and inferred demand are needed, make them separately named overlays rather than one ambiguous tint.

3. **Critical — The required three-layer semantic-token architecture does not exist in the machine-readable contract, making the “semantic tokens only” rule impossible to implement.**
   - **Evidence:** `plans/plan-ux-final.md §5` requires “primitives → semantic (`surface/text/border/action/focus`) → component tokens” and bans feature use of primitives, but `docs/design/tokens.css` exposes mostly raw variables such as `--kelo-brand-600` and `--kelo-neutral-600`, with shadcn mappings only in a comment and no canonical `action`, `text`, `focus`, or component-state variables.
   - **Suggested fix:** Add generated semantic variables such as `--action-primary-*`, `--text-*`, `--focus-ring`, and `--control-*`, map shadcn/Tailwind to them in executable configuration, and enforce primitive access only inside the token package.

4. **Critical — Today provides direct send actions that bypass the mandatory outreach approval ceremony.**
   - **Evidence:** `plans/plan-ux-final.md §§1.7, 3B` requires a non-skippable audience/content ceremony with named exclusions, exact final preview, cost, and “Send test to me”; `docs/design/p0-screens.html §01` says “**SENDS IMMEDIATELY ON APPROVAL**” beside `Approve & send to 18`, and `docs/design/p0-today-phone.html` exposes the same direct action without those checkpoints.
   - **Suggested fix:** Replace Today’s send button with a `Review to send` navigation action, require `ApprovalCeremony` immediately before every send API call, and add a test proving cards, command-menu actions, and deep links cannot bypass it.

5. **Critical — The refund surface omits the two distinct authorization ceremonies and the required consequence-review step.**
   - **Evidence:** `plans/plan-ux-final.md §4 Money patterns` requires actor re-authentication “before **any refund**” and separate manager step-up above the threshold; `§3D` requires review of resulting balance and booking/credit effects, but `docs/design/p0-screens.html §05` presents a reason selector followed directly by `Refund $35.00`, with no PIN, second actor, threshold state, or consequence review.
   - **Suggested fix:** Specify and mock the exact state machine `edit → consequence review → actor re-auth → optional manager authorization → processing`, including focus restoration, cancellation, expired PIN, denied authorization, and durable return states.

6. **Critical — The toast examples directly violate both the durable-result rule and the notification-lane contract for booking and payment failures.**
   - **Evidence:** `plans/plan-ux-final.md §§1.3, 4 Notifications` says “A toast is not proof” and toasts are “never errors needing action”; `docs/design/p0-screens.html §04` nevertheless defines toasts for `Booked — confirmation sent to Dan` and `Charge failed — card declined` with a `Try another` action.
   - **Suggested fix:** Remove these as Toast variants; route booking success to the durable result page and payment failure to persistent inline/banner state, leaving Toast only for reversible, noncritical confirmations.

7. **Critical — The member white-label surface has no machine-readable tenant token schema, so its accepted structure cannot be styled without inventing a theming API.**
   - **Evidence:** `plans/plan-ux-final.md §5` permits a validated subset of “logo, action color, surfaces, type,” while `docs/design/DESIGN-GUIDE.md §§2, 8` says “logo, palette, display face”; neither `tokens.json` nor `tokens.css` defines any tenant/member namespace, allowed keys, derived hover/focus/disabled states, logo constraints, or Stripe Elements mapping.
   - **Suggested fix:** Add a versioned `member-theme` schema defining every overridable token, immutable functional/status tokens, derivation rules, font/logo constraints, validation and fallback behavior, and the mapping into embedded Stripe Elements.

8. **Major — The machine token files are not equivalent and contain stale shadcn mappings that contradict accepted amendments.**
   - **Evidence:** `docs/design/tokens.json` defines typography scales, sizing, `surface.inverseBrand`, and the dedicated input boundary, but much of this is absent from `tokens.css`; the CSS mapping still says `muted-foreground <- neutral-500` despite the documented text floor of `neutral-600`, and maps `--input` to `--kelo-border-strong` rather than `--kelo-border-input`.
   - **Suggested fix:** Declare one source of truth, generate JSON, CSS, Tailwind, and shadcn mappings from it, and add CI parity tests that reject missing or stale mappings.

9. **Major — The member funnel’s most sensitive stages and account flows are missing entirely from the mockups and component contract.**
   - **Evidence:** `plans/plan-ux-final.md §3H` requires Identify/claiming, anti-enumeration OTP, waiver and guardian paths, account card update, cancellation/rescheduling, preferences, and support-assisted identity resolution; `docs/design/p0-screens.html §03` shows only Choose, Review & pay, and Confirmed, while the `§5` component allowlist contains no OTP, identity-resolution, account-booking, or cancellation component.
   - **Suggested fix:** Add structural specs and stories for every missing stage and exceptional state, including resend/expiry/cooldown, neutral identity errors, guardian handling, held-slot preservation, card-update outcomes, and cancellation consequences.

10. **Major — The component allowlist claims completeness while omitting primitives explicitly required by the UX plan.**
    - **Evidence:** `plans/plan-ux-final.md §5` says the list “includes everything the plan’s own flows and guidelines require” and feature code never imports Radix directly, yet it omits Dialog/Drawer/Sheet, Tooltip, Tabs, Input/Select/Checkbox/Radio, OTP, date/time picker, pagination, and mobile bottom navigation despite requirements for addressable drawers, report tooltips, tabs, forms, OTP, dialogs, and pagination elsewhere in the plan.
    - **Suggested fix:** Separate a complete base-primitives allowlist from domain components, state which Radix/shadcn primitive implements each required interaction, and remove the written-reason tax for already-approved primitives.

11. **Major — Core interactive components lack canonical hover, pressed, active, selected, loading, and disabled state tokens.**
    - **Evidence:** `tokens.json` supplies colors and a selected-row usage note but no component-state map; `docs/design/p0-screens.html` relies on prototype-only `style-hover` attributes and one-off inline colors, while `plans/plan-ux-final.md §4` requires disabled reasons and `AsyncButton` behavior.
    - **Suggested fix:** Define state matrices and component tokens for buttons, links, tabs, nav items, table rows, selectable cards, inputs, icon buttons, and destructive actions, including state-combination precedence.

12. **Major — The system provides no spacing, layout, or responsive token contract beyond a 4px base and three reference widths.**
    - **Evidence:** `tokens.json` contains only `"spacingBase": 4`, while mockups hard-code many arbitrary paddings and gaps; `DESIGN-GUIDE.md §8` names 1440 desktop and landscape tablet, and the UX plan also requires phone cards, simplified schedule/report fallbacks, and responsive drawers without defining breakpoints or transitions.
    - **Suggested fix:** Define spacing/container scales, breakpoints, rail-collapse behavior, card/table transformations, modal-to-sheet rules, calendar fallback structure, and supported portrait/intermediate-width layouts.

13. **Major — The phone prototypes structurally prevent scrolling and therefore cannot satisfy the 200% zoom/no-loss requirement.**
    - **Evidence:** `plans/plan-ux-final.md §6` requires “200% zoom without loss”; `docs/design/p0-today-phone.html` fixes the viewport to `height:826px` and uses `overflow:hidden`, while each member screen in `p0-screens.html §03` fixes `height:792px` with `overflow:hidden`.
    - **Suggested fix:** Specify document or region scrolling, sticky-header/footer behavior, safe-area insets, virtual-keyboard resizing, and reflow at 200% zoom; remove fixed-height clipping from the structural examples.

14. **Major — The system has no overlay, scrim, or z-index contract for the many nested portal surfaces it requires.**
    - **Evidence:** `tokens.json` defines only elevation shadows, while `plans/plan-ux-final.md` requires command menus, dropdowns, popovers, tooltips, drawers, sheets, dialogs, toasts, approval modals, and nested re-auth/manager authorization.
    - **Suggested fix:** Add named z-index layers, scrim tokens, portal ownership rules, nested-overlay policy, scroll locking, escape behavior, and focus-return rules.

15. **Major — Reduced-motion behavior is contradictory and cannot be derived from the current CSS.**
    - **Evidence:** `DESIGN-GUIDE.md §7` says reduced motion is “opacity-only”; `tokens.json` says “opacity-only, 0ms movement,” but `tokens.css` sets every duration variable to `0ms` without providing separate opacity and transform channels or preventing components from using movement.
    - **Suggested fix:** Define component-level reduced-motion variants, retain an optional opacity duration, disable transform/position animation explicitly, and add tests for sheets, dialogs, skeletons, confirmation ticks, and chart transitions.

16. **Major — The status vocabulary is far smaller than the actual typed state space the product must render exhaustively.**
    - **Evidence:** `tokens.json` defines only confirmed, processing, failed, and refund-pending; the UX plan additionally requires refunded, long-processing, written-off, retry-in-progress, auto-refund review, booking conflicts, receipt delivery states, subscription change-pending, waitlist offer states, room readiness, and terminal disagreement states.
    - **Suggested fix:** Create a canonical state registry mapping every discriminated-union value to label, icon, shape, tone, allowed actions, and unknown-state fallback; do not force unrelated states into the four money pills.

17. **Major — Money-status radius descriptions are ambiguous against the radius token names.**
    - **Evidence:** `tokens.json` describes processing as `"radius 4-5"` and failed as `"radius 3"`, while the actual radius tokens are `r1=4`, `r2=6`, and `r3=10`; an agent could reasonably interpret “radius 3” as either 3px or token `r3`.
    - **Suggested fix:** Replace prose dimensions with exact token references, adding dedicated status radii if 3px or 5px values are intentional.

18. **Major — `DataBoundary` states are listed as if mutually exclusive even though required screens need several simultaneously.**
    - **Evidence:** `plans/plan-ux-final.md §4` lists background-refresh, stale, offline, partial-error, processing, and conflict in one “full state taxonomy,” while §3 requires combinations such as stale existing data updating in the background, partial KPI failures during refresh, and offline queues with conflicts.
    - **Suggested fix:** Define a compositional state model with primary render state, independent freshness/connectivity/mutation flags, banner precedence, allowed combinations, and announcement priority.

19. **Major — The heatmap lacks the required accessible table/text alternative and a defined keyboard interaction model.**
    - **Evidence:** `plans/plan-ux-final.md §4 Tables & reports` says charts ship with “a table view + text summary,” and §3E says heatmap cells become interactive on hover/focus; `docs/design/p0-screens.html §07` shows only the visual grid, with no table toggle, summary, tooltip behavior, grid semantics, or focus-order strategy.
    - **Suggested fix:** Add the alternate table and text summary, define roving-grid keyboard behavior or a simpler focus model, and specify the same tooltip content for hover, focus, and touch.

20. **Major — Touch-target sizing is internally inconsistent, especially on phone surfaces.**
    - **Evidence:** `tokens.json` defines `target-min: 44`, but `docs/design/p0-screens.html §03` member time pills are approximately 36px high, the refund option controls are 40px high, and the component sheet defines default buttons at 36px; only Desk’s 48/56px targets are consistently specified.
    - **Suggested fix:** State whether 44px is a universal interactive hit-box minimum or only a visual size, then tokenise compact/default/Desk hit areas and update phone controls to meet the declared rule.

21. **Major — The accepted member Choose screen suppresses full slots instead of providing the required waitlist action and expectations.**
    - **Evidence:** `plans/plan-ux-final.md §§3H, 7` requires honest waitlist position and offer-window expectations with one-tap join; `docs/design/p0-screens.html §03` renders `11:00a` only as struck-through and provides no waitlist affordance or explanatory state.
    - **Suggested fix:** Define full-slot, joinable-waitlist, joined, offer-active, expired, and unavailable variants for member slot controls, including position and offer-window copy.

22. **Major — The Quick Book mockup omits the visible server hold and its countdown after a slot has been selected.**
    - **Evidence:** `plans/plan-ux-final.md §3C` requires selection to create “a visible server hold with honest countdown”; `docs/design/p0-screens.html §02` shows a selected `4:00p` slot, waiver state, tender, and final booking button without any hold or expiry indicator.
    - **Suggested fix:** Place `HoldTimer` persistently on every post-selection Quick Book state and specify extension, frozen-during-payment, expired, and resumed-card presentations.

23. **Major — AI recommendation copy violates the ban on unlabeled predictive and revenue precision.**
    - **Evidence:** `plans/plan-ux-final.md Ruling 10` bans revenue projections without a defined, labeled model; `docs/design/p0-screens.html §01` says a session “**will sell out by ~2:30p**” and an overflow is “**worth about $170**” without identifying a model or derivation.
    - **Suggested fix:** Replace these with historical evidence statements, or add an explicitly defined model label, inputs, observation window, limitations, and drill-through supporting the projection.

24. **Major — Outreach reply handling contradicts the explicit v1 exclusion of an operator messaging inbox.**
    - **Evidence:** `plans/plan-ux-final.md §8` excludes “an operator messaging inbox,” but `docs/design/p0-screens.html §06` states `REPLIES ROUTE TO DESK INBOX`; the drafted SMS also promises “Reply YES and we'll hold one,” with no approved reply-processing workflow.
    - **Suggested fix:** Route replies to a named external channel or remove reply-dependent copy; otherwise formally add and design the narrowly scoped reply workflow and amend the v1 exclusion.

25. **Major — The approval action label has three conflicting canonical forms.**
    - **Evidence:** `plans/plan-ux-final.md §1.7` uses `Send SMS to 18 people`, §3B uses `Send email to 18 people`, and `DESIGN-GUIDE.md §4` plus the mockups use `Approve & send to 18`.
    - **Suggested fix:** Define channel-specific labels in `ApprovalCeremony`, including whether “approve” is a separate state or the send itself, and use the same copy everywhere.

26. **Major — Shared-device timeout and re-entry behavior is security-critical but lacks implementable timing and focus rules.**
    - **Evidence:** `plans/plan-ux-final.md §6` requires auto-lock, fast role-aware re-entry, safe clearing of person search and half-completed sales, and blocking sign-out for unsynced queues, but defines no inactivity duration, warning period, extension behavior, focus destination, resumable-work handling, or actor-switch semantics.
    - **Suggested fix:** Specify the timeout state machine, warning dialog and keyboard behavior, what is cleared versus parked, offline-queue handling, actor attribution, and re-entry destinations.

27. **Major — Print is an actual POS requirement but has no design or token contract.**
    - **Evidence:** `plans/plan-ux-final.md §3C` requires receipt `print / SMS / email`, and §6 names an optional printer with deferred/out-of-paper behavior; no file defines receipt dimensions, print-only content, browser chrome suppression, typography fallback, PII rules, or printer retry states.
    - **Suggested fix:** Add receipt print templates and `@media print` rules, supported paper sizes, printer-state UI, redaction rules, and tests ensuring app navigation and staff-only data never print.

28. **Minor — The final brand mark has no canonical asset and conflicts with obsolete artwork still present in the accepted design directory.**
    - **Evidence:** `DESIGN-GUIDE.md §§2 and Amendments 5` declares a circled lowercase-k monogram final but describes it approximately; `stylescape-route-01.html` still uses the earlier concentric growth-ring mark, while P0 files embed a different circled-k SVG inline.
    - **Suggested fix:** Commit canonical SVG/favicon/app-icon assets with fixed viewBox and clear-space rules, identify them as authoritative, and remove or visibly deprecate the obsolete ring artwork.

29. **Minor — Timezone labeling is phrased more strictly than the mockups implement, leaving agents to choose between per-value and page-level labels.**
    - **Evidence:** `plans/plan-ux-final.md §4 Forms` says the studio timezone is labeled “on **every date/time**,” while mockups commonly provide one page/footer `EDT` label and leave individual slots, timeline rows, and booking dates unlabeled.
    - **Suggested fix:** Define a consistent rule such as one persistent page-level timezone label plus explicit labels only where zones differ, and provide formatting tokens/utilities for absolute and relative time.

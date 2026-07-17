# Kelo Design System — Pre-Implementation Audit Findings

## Critical

### 1. shadcn `--input` mapping contradicts the input-boundary amendment
**Defect:** Coding agents wiring shadcn will put decorative hairlines on form controls, undoing the glare-legibility rule the amendment exists for.  
**Evidence:** `tokens.css` maps `--border / --input <- --kelo-hairline / --kelo-border-strong`; amendment + `DESIGN-GUIDE.md` §Amendments.2 and `tokens.css` amendment block require `--kelo-border-input: #8A9296` for form controls only. Component sheet form fields still use `rgba(16,22,27,.16)`.  
**Fix:** Map shadcn `--input` (and any Kelo `Input`/`Select`/`Textarea`) to `--kelo-border-input`; keep hairline/strong decorative-only; document the split in the mapping comment.

### 2. Text-ink floor has no legal recipe for muted or disabled text
**Defect:** Agents must either violate the floor or invent illegal colors for disabled/placeholder/muted chrome.  
**Evidence:** Amendment: “`neutral-400` is never a text color… lightest text ink is `neutral-600`.” `tokens.css` maps `--muted-foreground <- --kelo-neutral-500` (`#6F7A80`, lighter than the floor). Component sheet disabled button uses `color:#97A0A4` (neutral-400); disabled field label uses `#97A0A4`; placeholder/disabled field text uses `#BEC4C6` / `#97A0A4`.  
**Fix:** Publish explicit semantic text roles: `--text-primary` (ink), `--text-secondary` (neutral-600), `--text-disabled` (define one AA-or-exempt pattern, e.g. neutral-600 @ reduced opacity on a named disabled surface, or a dedicated token that still meets AA if it conveys meaning), `--text-placeholder`; ban raw neutral-400/500 as `color` in lint; remake disabled button/field stories to the recipe.

### 3. No hover / active / pressed / disabled / selected control tokens
**Defect:** Every interactive control will be guessed (opacity, brand-700, darken filters) with no single source of truth.  
**Evidence:** `tokens.json` / `tokens.css` define brand/functional scales and domain statuses but no `--action-primary-hover|active|disabled`, secondary/ghost/destructive variants, selected-slot, or selected-nav beyond brand `$usage` prose (“050 = selected-row/active-nav bg”). Component sheet shows Primary/Secondary/Ghost/Disabled/Focus as static snapshots only.  
**Fix:** Tokenize full action matrix (bg/fg/border × default/hover/active/focus-visible/disabled) for primary, secondary, ghost, destructive, and desk-primary; add selected states for nav, slots, tender chips, table rows; put them in Storybook as the contract.

### 4. Overlay scrim and z-index scale are undefined
**Defect:** Modals, approval ceremony, command palette, popovers, toasts, banners, and Terminal “verifying” layers will stack incorrectly.  
**Evidence:** Elevation `e0–e3` shadows exist; UX plan requires dialogs, ⌘K, alert center, ConfirmAction, approval ceremony, Terminal conflict UI. No scrim color/opacity token; no z-index scale in tokens or guide.  
**Fix:** Add `--kelo-overlay-scrim` (e.g. ink @ fixed alpha) and a closed z-index scale (dropdown < popover < sticky chrome < banner < modal < toast < command palette < critical system).

### 5. White-label override boundary is contradictory and incomplete
**Defect:** Member-surface theming will either leak status/AI semantics or block legitimate studio branding; AA intake has no named token list.  
**Evidence:** UX plan §5: “validated token subset (logo, action color, surfaces, type)”; `DESIGN-GUIDE.md` §8: “logo, palette, display face”; stylescape §08 shows four dashed swatches with no names; member mockup uses non-token warm hex (`#FAF7F1`, `#23201B`, `#C9A227`, etc.) labeled throwaway. No list of CSS variables tenants may set, nor which pairs are AA-checked at intake.  
**Fix:** Publish an explicit allowlist (e.g. `--tenant-logo`, `--tenant-display-font`, `--tenant-action`, `--tenant-action-fg`, `--tenant-surface-app|card`, `--tenant-text-primary|secondary`) and a denylist (status, freshness, AI, money pills, focus ring width/offset policy); define intake validation pairs; keep structure/components non-overridable.

### 6. Spacing scale missing (only `spacingBase: 4`)
**Defect:** Agents will free-form Tailwind gaps/padding from mockup pixels; density modes cannot be implemented consistently.  
**Evidence:** `tokens.json` `$meta.spacingBase: 4`; no space steps. Mockups use 6/8/10/12/14/16/18/20/24/26/32 ad hoc. UX plan density: comfortable / `dense` / `desk`.  
**Fix:** Ship a 4px-grid scale (at least 1–24) plus density maps (control height, cell padding, section gap) for comfortable/dense/desk.

### 7. Money / booking status taxonomy incomplete vs UX contract
**Defect:** Flows that must render durable server states have no pill/shape language; agents will invent colors or overload “Processing.”  
**Evidence:** Domain statuses: confirmed / processing / failed / refund-pending only (`tokens.json` domain, `DESIGN-GUIDE.md` §4). UX plan requires `processing / confirmed / failed / refund pending`, plus `change pending` (subscriptions), `written_off`, hold states, Terminal “verifying result — do not retry,” receipt deferred, waiver persist-failure review, queued check-ins.  
**Fix:** Extend StatusPill vocabulary (shape+icon+color) for every discriminated union the build will ship in v1; map each to tokens before implementation.

### 8. AI insight copy in mockups violates the numeric-projection ban
**Defect:** Governing UX plan bans invented revenue projections; mockups teach the opposite pattern agents will copy into InsightCard.  
**Evidence:** UX plan ruling 10 / §3E: cite evidence, never invented revenue projections. `p0-screens.html` Today briefing suggestion: “worth about $170”; schedule AI chip implies open slot without evidence envelope on the chip itself.  
**Fix:** Rewrite insight/schedule AI examples to evidence-only (fill rate, sample window, waitlist count); add InsightCard content rules to the design guide so copy is part of the component contract.

---

## Major

### 9. Semantic text / border / focus layer is incomplete relative to the stated 3-layer architecture
**Defect:** Feature code is told to use semantic tokens only, but most semantics are still raw neutrals.  
**Evidence:** UX plan §5: primitives → semantic (surface/text/border/action/focus + domain) → component; lint-block raw hex. `tokens.json` has surfaces + domain + partial borders; no `--text-*`, no `--focus-ring-width|offset|color` tokens (focus described only in prose: “2px brand-600, 2px offset”).  
**Fix:** Materialize the semantic layer in `tokens.json`/`tokens.css` and map shadcn to it exclusively.

### 10. Desk route chrome does not match the UX IA
**Defect:** Agents building Desk from the mockup will ship a two-pane Check-in+Book screen without the required full-screen tab group and resumable home.  
**Evidence:** UX plan §2: Desk = full-screen route group with fat tabs **Check-in · Book · Find person** (+ Sell later); interrupted work = resumable cards on Desk home. `p0-screens.html` §02 is a single composite with session chips + roster + Quick book; no tab bar, no Find person, no ResumableWorkCard.  
**Fix:** Add Desk shell mock/spec: tab bar ≥48px, home with resumable cards, per-tab layouts; keep Quick Book as Book tab content.

### 11. Owner chrome missing global elements the UX plan requires
**Defect:** Alert center entry and More overflow are unspecified in the visual system agents will clone.  
**Evidence:** UX plan §2: rail + **More**; global chrome = search, freshness, **alert bell**, ⌘K. Mockup rails show Today…Health + Desk launcher + tenant/user, no More, no alert bell; search is present.  
**Fix:** Specify rail order including More; place alert bell + badge; define AlertCenter panel anatomy against notification lanes (§4).

### 12. Critical flow components named in the allowlist have no visual contract
**Defect:** HoldTimer, TerminalStatus, WaiverCapture, WaitlistPanel, ResumableWorkCard, ConfirmAction (step-up/PIN), OfflineQueueBar (desk), TenderChooser edge cases, CommandMenu will be improvised.  
**Evidence:** UX plan §5 core list includes these; component sheet covers buttons, fields, freshness, money pills, banners, toasts, skeleton, AI draft, empty, dense table — not the above. Hold countdown and Terminal “do not retry” are called out as the most dangerous booking gaps in the UX plan.  
**Fix:** Add P0 component frames + state tables for each allowlist item used in Desk/booking/money before coding those flows.

### 13. Responsive breakpoints and phone fallbacks are undefined
**Defect:** Agents cannot know when AppShell switches rail → tabs, or how Schedule/Reports “simplified phone fallback” behaves.  
**Evidence:** Tokens list sidebar 232 and phone mock at 390; no breakpoint tokens or rules. UX plan §6: schedule editing desktop-preferred; phone = view + one-tap. Only Today phone is mocked.  
**Fix:** Define breakpoints (e.g. desk tablet landscape, owner phone) and per-route fallback rules tied to AppShell variants.

### 14. Density modes are named but not tokenized
**Defect:** “Dense tables at 13px” and desk 48/56 targets exist as sizing notes, not as a switchable density contract.  
**Evidence:** `tokens.json` sizing + type rule “Dense tables: 13px…”; UX plan density comfortable/dense/desk; no `data-density` token set for padding/height/gap.  
**Fix:** Density token packs (control height, table row min-height, font step, gap) and how Desk forces `desk`.

### 15. Table / list interaction states incomplete
**Defect:** QueryTable needs row hover, selected, focus-within, disabled, and imported-row affordances beyond a static hatch example.  
**Evidence:** Brand `$usage` mentions selected-row bg; component sheet shows native vs imported rows only; no hover/selected/keyboard focus row specs; UX plan requires keyboard-complete tables and real links in rows.  
**Fix:** Specify row states + focus visibility + link-in-cell pattern in the component sheet.

### 16. Approval ceremony incomplete vs UX plan on primary surfaces
**Defect:** “Send test to me” and two-checkpoint audience/content ceremony are inconsistent across mockups.  
**Evidence:** UX plan §3B + Part III: ceremony includes **Send test to me** and audience exclusion list. Segments mock has Send test; Today briefing and component-sheet draft do not; neither shows named exclusions (“3 excluded — reasons by name”) as a checkpoint UI.  
**Fix:** One ApprovalCeremony spec with required slots (audience, content preview, cost, exclusions, Send test, verb-with-count); all AI send entry points use it.

### 17. Focus-queue hygiene UI missing
**Defect:** Dismiss-with-reason, snooze, and empty “no urgent actions” are required interaction, not drawn.  
**Evidence:** UX plan §3A focus-queue hygiene; mockup rows only have Fix/Send/Review (desktop) or chevrons (phone).  
**Fix:** Define FocusQueueItem menu (act / snooze / dismiss+reason) and empty ranked state.

### 18. `prefers-reduced-motion` implementation contradicts the written rule
**Defect:** Zeroing all durations removes even opacity confirmation; agents may also ship skeleton shimmer that ignores the pledge.  
**Evidence:** Guide: “opacity-only”; `tokens.json` motion: “opacity-only, 0ms movement”; `tokens.css` sets all `--kelo-duration-*` to `0ms` with no opacity exception or “no transform/shimmer” rule. Skeletons shown with static blocks only (good) but no anti-shimmer rule.  
**Fix:** Keep short opacity durations under reduced motion; ban transform/translate/shimmer in CI for `prefers-reduced-motion`.

### 19. Processing status radius is ambiguous
**Defect:** “radius 4–5” forces a guess (r1 vs between tokens).  
**Evidence:** `DESIGN-GUIDE.md` §4 and `tokens.json` `status-processing.shape`: “radius 4-5”.  
**Fix:** Pin to `r1` (4) or a single px value.

### 20. Chart secondary UI (tooltip, legend, table toggle, empty) not specified
**Defect:** Reports/KPI drill use ChartWithTable; only categorical hues and demand ramp are tokenized.  
**Evidence:** `tokens.json` chart + UX plan tables/reports guidelines; no tooltip surface, focus order, or pattern-for-series-4+ examples in the component sheet.  
**Fix:** Spec ChartWithTable chrome: tooltip, direct labels, pattern samples, table toggle, loading/error.

### 21. Monogram asset disagreement across design artifacts
**Defect:** Agents may implement the wrong mark.  
**Evidence:** Amendment 5 / guide: circled-k monogram final. `p0-screens.html` / phone use circled **k** text. `stylescape-route-01.html` uses concentric growth-ring mark without “k”.  
**Fix:** Deprecate rings in stylescape; single SVG source for the circled-k at 16/32/64.

### 22. Concurrent-staff, room-readiness, and customer-safe desk surfaces have no visual language
**Defect:** Highest-risk Desk edge cases will be ad hoc.  
**Evidence:** UX plan §3C: “held by Sam — expires in 2:40”, room not ready, declined-card customer copy, staff-only detail. Mockups show happy-path roster/book only.  
**Fix:** Spec SlotPicker/CheckInBoard variants for held-by-other, room-readiness, waiver-block (done), unpaid, and a privacy rule for what may appear customer-readable (type size/placement alone is not enough).

### 23. `tokens.json` vs `tokens.css` drift
**Defect:** Dual contracts will diverge in implementation.  
**Evidence:** `surface.inverseBrand` / several domain object structures in JSON; CSS lacks `--kelo-surface-inverseBrand` and encodes domain mostly as flat color aliases without shape metadata; freshness text colors live only in JSON domain objects.  
**Fix:** Generate CSS from JSON (or vice versa) in CI; include inverseBrand and any semantic aliases agents need.

### 24. Member funnel structure incomplete for the governing flow
**Defect:** Identify (OTP/claim), Waiver, hold-through-back, and account/card-update states are unscoped visually for a white-label surface.  
**Evidence:** UX plan §3H five stages; `p0-screens.html` shows Choose, Review & pay, Confirmed only.  
**Fix:** Add member frames for Identify, Waiver (typed-name), hold-expiry, payment failure dignity, and confirmed delivery states using tenant tokens only.

---

## Minor

### 25. Icon / avatar / badge size scales not defined
**Defect:** Nav icons, status icons, avatars (26–40px in mockups), and count badges will drift.  
**Evidence:** Mockups vary icon 9–18px and avatar sizes; no sizing tokens beyond hit targets.  
**Fix:** Small closed scales (icon 12/16/20/24; avatar 24/32/40; badge min sizes).

### 26. Toast lifetime, stacking, and focus behavior unspecified
**Defect:** UX lanes say toasts are transient confirmations only; component sheet shows a failure toast with action (overlaps banner/alert responsibilities).  
**Evidence:** UX plan §4 Notifications; component sheet error toast with “Try another.”  
**Fix:** Align toast content rules; define duration, max stack, and that action-needed errors use banner/inline/result page.

### 27. Link color / hover only in HTML chrome, not tokens
**Defect:** In-app links may not match.  
**Evidence:** Mock `<style>a{color:#3E5A74}a:hover{color:#324A60}</style>` only.  
**Fix:** `--kelo-link` / `--kelo-link-hover` semantic tokens.

### 28. Micro size 10.5px invites subpixel inconsistency
**Defect:** Half-pixel type renders differently across platforms; still allowed only for uppercase labels.  
**Evidence:** `tokens.json` micro 10.5; many mock labels at 9–10px mono below the “micro mono 10.5” / “12px desktop chrome” floor language.  
**Fix:** Snap micro to 11px or 10px with a single token; lint mock/build minimums.

### 29. Command palette and person-search results UI not designed
**Defect:** ⌘K is global chrome but only a search field shell appears.  
**Evidence:** UX plan global chrome; mockup search input with ⌘K hint only.  
**Fix:** CommandMenu result groups (nav, people, money verbs → confirm routes).

### 30. Print / receipt printer deferred state is copy-only
**Defect:** “Deferred receipt” is a designed money state in UX; no ReceiptPanel variant.  
**Evidence:** UX plan §3C printer out-of-paper; component list ReceiptPanel; not in sheet.  
**Fix:** ReceiptPanel states: sent / offered on screen / print queued / deferred + reason.

---

## Dimension summary

| Dimension | Result |
|---|---|
| **Implementability** | Critical gaps: input mapping, interactive states, spacing, z-index/scrim, incomplete Desk/chrome from mockups. |
| **Completeness** | Critical/major gaps for statuses, Desk edge components, chart chrome, density, breakpoints — limited to UX-plan screens. |
| **Consistency** | Input border, text-ink floor vs muted/disabled, AI $ projections, monogram, JSON/CSS drift, approval ceremony completeness. |
| **Accessibility (structural)** | Disabled/muted text recipe missing; reduced-motion zeroing; table keyboard/row focus underspecified; touch targets mostly OK on Desk/phone tabs (≥48) but not systematized for all controls. |
| **White-label risk** | Critical: allowlist/denylist and AA intake pairs not defined; “palette” vs “action color” conflict. |
| **Missing entirely** | Hold/Terminal/Waiver/step-up/resumable/waitlist visuals; scrim+z-index; spacing+density scales; semantic text/action/focus layer; alert bell + More; member Identify/Waiver; concurrent-staff & room-readiness language. |

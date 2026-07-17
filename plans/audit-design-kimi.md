• I'll start by checking the sizes of the files I need to read in full.

• Manageable sizes. Reading all seven files in full now.

• Now the prototypes and the UX plan.

• The stylescape output was truncated. Paging through the full output file now, and reading the remaining two prototypes.

• Now the main P0 screens file (593 lines) — reading in chunks.

• All seven files are read in full. Cross-checking is complete — writing the audit report now.

• # Kelo design system — verification audit (findings only)

  ## Critical

  **1. The canonical token file and guide body still prescribe the deprecated `Approve & send` verb, contradicting the round-2 amendment in the same files.**
  Evidence: `docs/design/tokens.json` (v1.1, declared "the single source of truth") — `"$rule": "…approval is an explicit ceremony with a recipient-count verb ('Approve & send to 18')."`; `docs/design/DESIGN-GUIDE.md` §4 — "verb with the count (`Approve & send to 18`)"; vs. the same guide's Amendments round 2, rule 3 — "only the ceremony's final button sends, and its verb names channel + count ("Send SMS to 18 people"). 'Approve & send' is deprecated." The plan agrees with the amendment ("the button names the act ('Send SMS to 18 people')", `plans/plan-ux-final.md` §1 doctrine 7). An agent implementing from the canonical JSON builds the banned copy.
  Fix: update `tokens.json` `domain.ai-accent.$rule` and guide §4 to the channel+count verb; add a lint note that "Approve & send" is a banned string.

  **2. Reduced-motion behavior is defined two opposite ways across the canonical pair.**
  Evidence: `docs/design/tokens.json` — `"reduced-motion": "opacity-only, 0ms movement"` and `DESIGN-GUIDE.md` §7 — "`prefers-reduced-motion`: opacity-only"; vs. `docs/design/tokens.css` — `@media (prefers-reduced-motion: reduce)` retains 80/120/120ms durations with the comment "Opacity-only, NOT motionless… zeroing all durations killed even the opacity confirmations" — the round-2 fix the amendment says "shipped in tokens.json v1.1". It did not; the JSON was left pre-fix, so the declared-canonical file mandates the behavior the generated file and amendment reject (and promise to CI-enforce against).
  Fix: rewrite `motion.reduced-motion` in `tokens.json` to "short opacity fades retained (80/120/120ms); transforms/translate/scale/shimmer banned" and align guide §7.

  ## Major

  **3. "Mockups amended to comply" is verifiably false, so no amendment's claim about prototype state can be trusted.**
  Evidence: `DESIGN-GUIDE.md` round 2 — "**Content & conduct rules (mockups amended to comply)**"; but `docs/design/stylescape-route-01.html` §07 still contains the exact canonical counter-examples the round claims removed — the draft "…Reply YES and we'll hold one." (rule 5: "'Reply YES…' removed") and a literal `<button …>Approve &amp; send</button>` (rule 3); `p0-screens.html` §07 still captions the heatmap "Cell tint = booking demand (searches + waitlists, last 8 weeks)" with a "DEMAND 8W" legend (rule 7 defers that overlay); sidebar search placeholders are still `color:#97A0A4` (`p0-screens.html` §01) despite amendment 1's n600 floor. Agents told "build follows tokens + written rules where prototypes conflict" still read these files as references; the amendment ledger misstates their contents.
  Fix: either actually amend the three offending mockup sections or add a per-file deviations banner listing every known mockup violation.

  **4. The Health trust-streak headline contradicts the canonical verification-trio definition — on the very screen that displays it.**
  Evidence: `p0-screens.html` §08 shows "DAYS SINCE AN UNVERIFIED FIGURE SHOWN — 41" while the same screen shows "Glofox archive … UNVERIFIED 37 → VERIFY QUEUE" (i.e., unverified figures *are* shown, marked, today); `DESIGN-GUIDE.md` round-2 rule 1 defines the streak as "days with zero failed-check figures rendered and zero unverified figures shown unmarked" — under which imported-unverified-shown-marked does *not* break the streak. The mockup label encodes the wrong definition; `plan-ux-final.md` §3F carries yet a third phrasing ("days since an unverified figure shown").
  Fix: relabel the headline to the rule-1 definition (e.g., "days since an unchecked or unmarked figure") and align §3F copy.

  **5. ApprovalCeremony's placement and anatomy are self-contradictory across sources.**
  Evidence: `tokens.json` elevation — `"e3": "…(modal: approval ceremony, toasts)"` (a modal); `plans/plan-ux-final.md` §3B — "**two-checkpoint ceremony on one screen**" (inline); `p0-screens.html` §06 renders the ceremony inline on the Segments screen with the final send button present; round-2 rule 3 says entry points "navigate to `ApprovalCeremony`" (a destination). Required slots also diverge: rule 3 demands "audience + exclusions-by-name" while §06 shows "3 EXCLUDED — OPTED OUT (2) · NO PHONE (1)" (reasons, no names), and the component-sheet ceremony (`p0-screens.html` §04) omits "Send test to me" and quiet-hours entirely despite rule 3 making both required slots.
  Fix: pin one anatomy (route or modal), one slot list (resolve "exclusions-by-name" vs "reasons shown by name" in plan §3B), and correct the component sheet.

  **6. The member funnel has zero designed failure or edge states although the plan mandates them for the same surface.**
  Evidence: `p0-screens.html` §03 ships only Choose / Review & pay / Confirmed happy path; `plans/plan-ux-final.md` §3H/§7 require visible hold expiry ("offers expire visibly"), payment-failure honesty ("If the slot fills first, you pay nothing" implies a slot-lost state), OTP/identify errors, waitlist join with "honest position and offer-window", and durable states that survive refresh. The round-2 deferred-debts list covers "member Identify/Waiver/account frames (phase 8)" but not declined-payment, hold-expired, slot-lost-race, or member waitlist anatomy. No token or mockup exists for any of these.
  Fix: add a member-surface state sheet (or explicit deferred-debt entries with owners) for the five failure states before phase 8.

  **7. The member-theme schema is under-specified for what the member mockup actually renders, and immutable tokens assume light surfaces the schema doesn't require.**
  Evidence: `tokens.json` `member-theme` allows only logo/display-font/action/action-fg/surface-app/surface-card/text-primary/text-secondary — "Everything else … is immutable Kelo system" — but the funnel mockup renders elements with no governing slot: links (`Manage booking`), hairlines/borders on tenant surfaces (`rgba(35,32,27,.10–.18)` ad hoc), selected states, and scarcity/freshness semantics ("7:00p · 1 left" in `#C9A227/#FBF4DC/#6B4E0A`, "REAL-TIME AVAILABILITY" dot `#4F8A5B` — both outside the allowlist and not Kelo status tokens). Nothing constrains tenant surfaces to light values, while immutable chrome is light-assumed (`--kelo-hairline: rgba(16,22,27,.10)`, hatch `#F5F0E6/#EBE1CE`, tints): a dark tenant surface makes hairlines, hatch, and tint chips illegible or inverted. No intake rule guards tenant-action colliding with reserved status/AI hues (a red brand's Pay button vs. danger; a teal brand vs. `#2F7B80`).
  Fix: extend the schema with link/border/selected derivation rules, constrain tenant surfaces to a lightness band (or derive member hairlines from tenant tokens), and add a hue-collision rejection at intake.

  **8. The status registry cannot exhaustively map states the plan's own flows require.**
  Evidence: `tokens.json` `status-registry-extended` — "Every discriminated-union state the build renders maps here BEFORE implementation" — but the plan requires states with no entry: no-show as a money event (`plan-ux-final.md` §3C, §9.7), dunning start/pause and the "staged list" (`§3D`, screen inventory) with no stage names or tones, the waitlist offer lifecycle "offered / expires-in / declined / expired-passed-to-next" (`§3C`) where only `waitlist-offer-active` exists, and room states "ready / turnover / not-ready / out-of-service" (`§9.3`) where only `room-not-ready` exists.
  Fix: add registry entries (tone/shape/icon per state) for no-show, dunning stages, waitlist offer terminal states, and the full room-readiness set.

  **9. Heatmap tint semantics conflict between the mockup and the governing amendment.**
  Evidence: `p0-screens.html` §07 header — "Cell tint = booking demand (searches + waitlists, last 8 weeks)", legend "DEMAND 8W", footer "TINT = DEMAND, LAST 8 WEEKS (SEARCHES + WAITLISTS + SELLOUT SPEED)", plus a selected "Demand overlay" filter chip; vs. `DESIGN-GUIDE.md` round-2 rule 7 — "**Heatmap tint = 30-day fill** … the mockup's 'demand (searches + waitlists, 8w)' becomes a **separately named overlay** deferred until its input signals exist" (and `plan-ux-final.md` Part III addendum: "the heatmap's tint is 30-day fill with any demand overlay as a separately named, later layer"). The mockup actively teaches the deferred layer as the shipping one.
  Fix: relabel the §07 mockup (tint = 30-day fill; remove/mark the 8W legend and overlay chip as deferred).

  **10. The type scale lacks eight sizes the P0/P1 screens actually use, and one rule prescribes a size no token provides.**
  Evidence: scale (`tokens.json` typography.scale) tops out at 8 steps, but mockups use 15px (Desk buttons, `p0-screens.html` §02), 16px (roster names), 19px (Desk panel titles), 21px (phone KPI values, `p0-today-phone.html`), 28px (payment hero, §05), 38px (Health hero numerals, §08), plus 9.5px phone tab labels; `tokens.json` typography.rules separately mandates "10px mono headers with 0.10em tracking" for dense tables — a step that exists nowhere in the scale (micro is 10.5/0.12em). Agents must either improvise tokens or visibly change the design's density.
  Fix: add the missing steps (or a documented "nearest-token mapping" rule for prototypes), and tokenize the dense-table header.

  **11. The radius scale lacks the 8px (and member 12px) values used throughout the mockups — including the component sheet itself.**
  Evidence: `tokens.json` radius — "r1: 4, r2: 6, r3: 10, r4: 16, full: 999" with "$usage: … r3 cards/banners"; but Desk check-in/tender buttons are `border-radius:8px` (`p0-screens.html` §02), the component sheet's own "Large · 44 / Desk · 56" buttons are `border-radius:8px` (§04), phone tab pills are 8px (`p0-today-phone.html`), and member funnel buttons are 12px with 16px cards (§03) — the latter also conflicting with "r3 cards" even though member structure is declared immutable.
  Fix: add an 8px step (and a member-surface radius statement) or correct the mockups to the scale.

  **12. The touch-target law from round 2 is violated by the mockups the same round claims are compliant.**
  Evidence: round-2 rule 12 — "touch surfaces (Desk, member, owner phone) render ≥44px visual"; but member slot chips are `padding:9px 15px` at 13px type (~36px tall, `p0-screens.html` §03), Quick Book's "Change" button is bare 12.5px text (~20px, §02, a Desk touch surface), and week-nav arrows are `width:30px;height:30px` (§07) — below even the 36px pointer-surface floor. Agents copying the prototypes will ship illegal targets.
  Fix: correct the three mockups and add a CI/checklist assertion that member and Desk surfaces render no sub-44px control.

  **13. Text-minimum rules are violated pervasively by the mockups, are internally inconsistent in tokens.json, and don't cover the member surface at all.**
  Evidence: `DESIGN-GUIDE.md` §10 — "Text minimums: 12px desktop chrome, 13px tables, micro mono 10.5px only for uppercase labels, never sentences"; mockups use 8.5px chips ("IN SESSION", "WL 5", §07), 9px KPI labels (`p0-today-phone.html`), 9.5px provenance lines (§01), and micro-mono sentences ("NOTHING IS BOOKED UNTIL THE CREDIT CLEARS · SMS CONFIRMATION SENDS ON SUCCESS", §02; "THIS CANNOT BE UNDONE", §05). §10 defines no member-surface minimum, yet the funnel renders 10.5px sentences. Either the floor or a large class of shipped patterns is wrong.
  Fix: define a tokenized sub-micro/label scale (with allowed contexts) or restate the floor with explicit exceptions; add member-surface minimums.

  **14. Owner-phone KPI freshness is color-only, violating the system's own freshness contract and never-color-alone rule.**
  Evidence: `p0-today-phone.html` KPI tiles carry bare 6px dots (green `#2E7D56` / gray `#97A0A4`) with no label; `DESIGN-GUIDE.md` §4 — "**Freshness chips** on every data region"; §10 — "Status never by color alone"; `plan-ux-final.md` §3A — "KPI grid (each tile: … own freshness chip …)". Green-vs-gray is precisely a color-only distinction, and "SYNCED 2M" information is lost.
  Fix: give phone tiles the labeled chip (or a tokenized compact labeled variant).

  **15. Outgoing member-facing comms (email/SMS/receipt templates) are undesigned, including who brands them.**
  Evidence: the plan requires "exact final preview" of Email/SMS sends (§3B), receipt delivery by print/SMS/email (§3C), dunning email/SMS links, and member confirmations — but no design file covers any outgoing template, and nothing states whether member-facing email/SMS is studio-branded (white-label boundary) or Kelo-branded. The ceremony previews an SMS body in a mockup, but the email channel has no anatomy at all.
  Fix: add a comms-template spec (layout, branding rule, merge-field rendering, plain-text fallback) to the design package.

  ## Minor

  **16. Freshness contract gaps.** `tokens.json` defines no threshold for when `freshness-live` becomes `freshness-aged` ("SYNCED {n}M" exists, but the live window is undefined), and no label templates for stale states ("STALE 2H" vs literal "STALE 4H+" — computed or fixed?). Fix: add `liveWindow` and label templates per state.

  **17. Input state matrix is incomplete and self-conflicting.** The component sheet's focused input (`p0-screens.html` §04: `border:1.5px solid #3E5A74; box-shadow:0 0 0 3px rgba(62,90,116,.18)`) matches neither the token focus ring ("2px brand-600, offset 2px") nor any tokenized glow, and its resting fields still show `rgba(16,22,27,.16)` borders instead of `--kelo-border-input: #8A9296` from amendment 2. Error/disabled border treatments are untokenized. Fix: tokenize input rest/focus/error/disabled borders and correct the sheet.

  **18. Off-token colors on operator screens.** `#8A939A` (all inactive nav icon strokes), `#FDF8EC` (warning row surfaces, §02/§05), `#5C3F0B` (warning emphasis text, §02/§04), `#F1F3F4` (semantic hover, not in the primitive scale), `#9E3B33/#8A342C` (destructive hover/active, not derived from any danger scale). Round 2 claims "link/icon/avatar/badge … tokens" shipped, but those cover scales only — icon/avatar/badge *colors* remain untokenized. Fix: either admit these hexes into the semantic layer or correct the mockups to tokens.

  **19. Unspecified recurring component semantics.** Selected-state text color and border width (1px on §07 filter chips vs 2px on §02 slots, token specifies neither); nav-badge color rules (when does a count go danger — §01 Today `#DCE4EA` vs Payments `#FAEAE8`?); avatar color algorithm (hash? fixed? — §02 uses both brand and amber); fill-bar "complete" color (`#324A60` at 100%, §07, untokenized); ▲/▼ delta coloring rule (is a negative delta danger-red or neutral?). Fix: one line per behavior in tokens.json.

  **20. Skeleton/shimmer spec is absent.** The sheet shows skeleton bars (`#E7EAEA/#EFF1F1`) and tokens.css bans "shimmer" under reduced motion — implying a default shimmer whose colors, duration, and direction are specified nowhere, while plan §4 mandates "geometry-stable skeleton" for every data region. Fix: tokenize skeleton base/highlight and the shimmer animation (or state "static, no shimmer").

  **21. Plan-mandated UI with zero design coverage.** 👍/👎 insight feedback (§3A), focus-queue dismiss-with-reason and "snooze until tomorrow" (§3A — mockups show only act buttons), DraftEditor tracked-changes styling (§3B — no diff tokens; inventing green/red would collide with the status-reserved-hue rule), Ask Q&A anatomy with citations (screen inventory vs. component allowlist), and "larger-text mode for 50+ owners" (§6 — no scale/breakpoint spec). Fix: add minimal specs or explicit deferred-debt entries.

  **22. Live-region policy omits countdowns.** `plan-ux-final.md` §6 scopes live regions to "processing/queued/confirmed/failed/offline transitions," but HoldTimer and waitlist offer countdowns (registry: `hold-active`, `waitlist-offer-active`) update continuously with no politeness/throttle rule — agents will either spam `aria-live` per second or never announce expiry. Fix: specify announcement cadence for timer components.

  **23. The mandated "unknown state" fallback is itself undesigned.** `tokens.json` — "unknown states render as a visible 'unknown state' error, never fall through to success" — with no token, icon, or copy spec for that rendering. Fix: one registry entry defining the fallback's appearance.

  **24. Member payment form uses placeholder-only fields against the plan's forms rule.** `p0-screens.html` §03 — "Card number / MM / YY / CVC" with no visible labels; `plan-ux-final.md` §4 — "Visible labels (placeholders are examples)". Fix: add labels to the member payment mockup (or state the Stripe Elements exception explicitly).

  **25. Toast and stacking details unspecified.** No duration, stacking, or dismissal rule for toasts (money-relevant confirmations included); the z-scale's "critical 1080" tier has no defined use; palette (1070) over modal (1050) behavior is unstated. Fix: one line each in tokens.json.

  **26. Canonical values are prose, and JSON↔CSS parity residue already exists.** E.g. `"demand-ramp": "rgba(62,90,116,.05) / .11 / .18 / .27 — sequential heatmap tint"` (one string, hand-split into 4 CSS tokens); `--kelo-chart-tooltip-*` in CSS omits the hairline the JSON specifies ("card bg + shadow-2 + hairline"); the stale-critical square dot's 2px radius has no token; and the parity CI check is admitted to be only "a build task" while finding 2 shows drift is already live. Fix: structure machine-consumed values as arrays/objects and close the two parity gaps.

  **27. No brand asset files exist.** The "canonical mark" is defined as "the circled-k SVG as used in the P0 headers" (`DESIGN-GUIDE.md` round-2 rule 14) — inline SVG inside an HTML prototype; there is no standalone SVG, favicon set, or app-icon export spec despite §2 defining 16/32/64 favicon and app-icon geometry. Fix: ship `kelo-mark.svg` + export sizes as files.

  **28. Refund "Deny…" has no designed downstream.** `p0-screens.html` §05 offers "Deny…" with no specified member-facing outcome (notification? timeline entry? member-site state?). Fix: one line in plan §3D and a registry/timeline note.

  **29. Money/Payments terminology drift inside the plan.** Ruling 6 (Part I) still says phone tabs "Today · **Money** · People · Schedule · More" while amended §2, the guide (amendment 4), and `p0-today-phone.html` all say "Payments"; §3D is titled "Money opens on queues." Fix: sweep Part I text for the pre-amendment label.

  **30. Sidebar chrome is inconsistent across mockups.** `DESIGN-GUIDE.md` §8 defines "232px sidebar (search ⌘K, icon nav with count badges, Desk-mode launcher, tenant card, user row)" — present in §01, but §05–§08 sidebars omit the Desk launcher and the user row (tenant card + avatar only). Fix: normalize the §05–08 sidebars or state the variance is intentional.

  **31. Tenant asset fallbacks unspecified.** No defined behavior when a tenant has no logo uploaded (is the hatched "LOGO" placeholder a runtime state or mockup-only?) or when the tenant display font fails to load. Fix: two lines in the member-theme schema.

  ---

  Dimension coverage: (1) implementability — findings 10, 11, 16, 17, 20, 25, 26; (2) completeness — 8, 15, 19, 21, 23, 27; (3) consistency — 1, 2, 3, 4, 5, 9, 29, 30; (4) structural accessibility — 12, 13, 14, 22, 24 (contrast itself not re-litigated per scope); (5) white-label boundary — 7, 15, 31; (6) missing entirely — 6, 15, 21, 23, 27.


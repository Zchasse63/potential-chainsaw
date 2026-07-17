# Kelo Design Guide — Route 01 "The Quiet Instrument"

Prepared 2026-07-17 · Light mode only (v1) · Token contract: `tokens.json` / `tokens.css`

## 1. The idea

Kelo exists because its predecessor showed **wrong numbers confidently** for ten weeks. The visual
language makes truth-telling look intentional: a calibrated instrument where data lives, human
warmth where people live. Cool birch-smoke grays and slate blue; warmth comes from material
moments (birch), generous space, and type with a human hand — **never** from warm status colors.

Anti-goals: generic SaaS-blue admin, clinical white, gym aggression, spa pastels, AI-purple
gradients. No dark patterns. Nothing that reads medical.

## 2. Brand

- **Wordmark:** lowercase `kelo`, Familjen Grotesk 700, letter-spacing −0.02 to −0.03em.
- **Mark / favicon:** circled lowercase "k" monogram — circle stroke ≈ 2.6 units at a 32-unit
  viewBox, `k` set in Familjen 700 at ~62% of frame. App icon: monogram reversed (#EDF1F4) on
  brand-900 `#1C2A37`, container radius ≈ 22% of size.
- **Lockup:** mark + wordmark, optionally `| STUDIO OPERATIONS` in micro mono, hairline-divided.
- The operator app is Kelo-branded. The **member funnel is white-labeled per studio** — Kelo is
  invisible there (no "powered by").

## 3. Color rules

- Most of the app is data on neutral. Brand-600 `#3E5A74` is the only saturated element on a
  typical screen (primary buttons, selection, focus ring).
- **Birch is a material, never a status.** Uses: imported-data surfaces (hatch), logo-slot
  placeholders, rare brand moments.
- Functional tints are backgrounds only; text on tint uses the matching `onTint` value (AA).
- **AI accent (glacial teal `#2F7B80`)** marks AI-generated content exclusively. If everything
  is teal, nothing is.

## 4. Domain semantics (Kelo's own words)

**Money status — shape + icon + color, never color alone:**
| State | Shape | Fill | Icon |
|---|---|---|---|
| Confirmed | full-radius pill | success tint | check |
| Processing | radius r1 (4px), outlined | card bg | clock |
| Failed | radius 3px (dedicated `--kelo-radius-status-failed`, sharper than r1) | SOLID danger, white text — loudest thing on screen | x |
| Refund pending | full-radius pill, **dashed** border | warning tint | diamond |

**Freshness chips** on every data region: `● LIVE` (green) → `● SYNCED {n}M` (neutral, from 1 min)
→ `● STALE 2H` (amber tint, **≥2h**) → `■ STALE 4H+` (red tint, **≥4h**, dot becomes a **square**,
weight 600). Thresholds align to the build plan (2h/4h). Micro mono type, full-radius chip,
hairline border when healthy.

**Provenance:** Kelo-native data sits on plain surfaces with solid hairlines. Imported legacy
data (e.g. Glofox) is a different material: birch hatch background, dashed `#9C875F` border,
`VIA GLOFOX` tag, and a trailing `*` on any unverified figure.

**AI surfaces:** dotted 1.5px teal border + `#F7FBFB` bg + `DRAFT · KELO INTELLIGENCE` micro tag
+ evidence chips (row counts, sources, date ranges). Draft-shaped until approved. The **approval
ceremony** is explicit: summary line in micro mono (`SMS · 18 RECIPIENTS · EST $1.26`), verb
naming channel + count (`Send SMS to 18 people` — `Approve & send` is a banned string), plus `Edit draft` / `Send test to me`. After sending,
show a receipt state: `SENT · APPROVED BY {name} {time}` with per-recipient delivery truth
(`DELIVERED 16 · FAILED 2 → RETRY QUEUED`). AI suggestions elsewhere (schedule ghosts) are
dotted and **never auto-applied**.

## 5. Typography

Familjen Grotesk (display — the voice, ~once per screen, never <20px) · Schibsted Grotesk
(all UI) · Spline Sans Mono (every timestamp, ID, money amount; tabular). Scale in `tokens.json`.
4px baseline; line-heights are multiples of 4. The sans→mono switch itself signals "this is a
reading off the gauge."

## 6. Shape, depth, honesty states

Radius 4/6/10/16/full. Default elevation is **flat + hairline** (engraved rules); shadow means
"this demands a decision" (dropdown < popover < modal/ceremony). Dashed = draft or money in
transit; dotted = AI; hatched = imported.

Every honest state is designed, not defaulted: skeletons match final layout; empty states say
whether emptiness is real or a sync problem; offline keeps working and shows a queue count;
degraded AI shows `YESTERDAY'S BRIEFING` and says why; error states state plainly what did NOT
happen ("No charge was attempted").

## 7. Motion

120/200/320ms, `cubic-bezier(.2,0,0,1)` (exit `.4,0,1,1`). Confirms state change only. A needle
settling, never a splash. `prefers-reduced-motion`: opacity-only.

## 8. Surfaces

- **Owner desktop (1440):** 232px sidebar (search ⌘K, icon nav with count badges, Desk-mode
  launcher, tenant card, user row). Comfortable density; dense tables at 13px.
- **Front desk (landscape tablet):** targets ≥48px, primary actions 56px; glanceable states;
  safe for the customer to see; blocking states are buttons ("Sign waiver first"), not errors.
- **Member funnel (phone, white-label):** boutique-hotel polish, studio brand tokens
  (logo, palette, display face are per-tenant slots). Honest microcopy: "You're only charged
  when your spot is confirmed."

## 9. Per-studio configuration (important)

The Sauna Guys sell **one combined service — Contrast Session, 60 min, 3 rounds of 15m sauna +
3m cold plunge**. Other tenants may sell rooms/services separately. Service catalog, durations,
protocol copy, capacity, and whether services book separately are **tenant config, not design**.
Never hard-code the session model.

## 10. Accessibility

WCAG 2.2 AA. All fg/bg pairs in `tokens.json` pass at their listed pairings (CI-verify on
change). Status never by color alone (shapes/icons above). Focus ring: 2px brand-600, 2px
offset. Text minimums: 12px desktop chrome, 13px tables, micro mono 10.5px only for
uppercase labels, never sentences.

---

## Amendments — 2026-07-17 review (accepted by owner)

1. **Text-ink floor.** `neutral-400` is never a text color at any size — the lightest text ink is
   `neutral-600` (#555F66). This corrects four mockup usages (source micro-labels, struck
   "FULL" slot times, and the member-skin placeholder grays); the P0/P1 mockups are prototypes —
   the build follows this rule, not the prototype's ink choices. Tenant (white-label) text
   tokens are **AA-validated mechanically at intake**: sub-AA values are rejected.
2. **Input boundary token.** `--kelo-border-input: #8A9296` (3.05:1 on card white) for form
   controls; 10–16%-ink hairlines remain decorative-only. Rationale: fields must be findable on a
   glare-lit counter tablet — the boundary is operational.
3. **Chart palette (validated for AA + deutan/protan separability).** Categorical: slate
   `#3E5A74` → amber `#9A6B14` → birch `#746348`, **max 3 hues per chart**; series 4+ repeat hues
   with patterns (hatch/dash — already this system's language) or the chart gets rethought.
   Green/red never appear as neutral categories: a series colored success/danger must *be* that
   status. Single-series marks use `#4F708A`; the demand heatmap keeps its brand-alpha ramp.
4. **Navigation labels adopted from the mockups** (UX plan amended to match): rail = Today ·
   Schedule · People · **Payments** · **Marketing** · Reports · **Health**; Desk is the launcher
   card into its full-screen route group; phone tabs = Today · Payments · People · Schedule ·
   More.
5. **Wordmark status.** The circled-k monogram is the **final mark** (owner-confirmed
   2026-07-17), lowercase `kelo` wordmark in Familjen Grotesk 700.
6. **Canvas note.** App background = `surface.app` (#F5F6F6); #E5E7E8 in handoff frames is
   presentation chrome, not a token.
7. **Today phone variant** added as `p0-today-phone.html` (composed from the component sheet per
   the system's rules; two-column KPI grid, no carousels).

---

## Amendments — round 2 (external design audit, 2026-07-17)

Three frontier models audited the finalized system (45+ findings; verified against files before
adoption). Token changes shipped in `tokens.json` v1.1 (canonical) + regenerated `tokens.css`:
**semantic text roles** (primary/secondary/muted/placeholder/disabled — disabled is n600 @55%,
tokenized and WCAG-exempt, never improvised), **action state matrices** (primary/secondary/ghost/
destructive × hover/active/disabled + selected), **focus-ring tokens**, **scrim + closed z-index
scale**, **spacing scale + density packs** (comfortable/dense/desk), **status-registry
extensions** (refunded, written-off, change-pending, verifying-do-not-retry, hold-active,
waitlist-offer, room-not-ready, queued-offline, receipt-deferred — shape grammar: solid=final,
outlined=in-motion, dashed=in-transit, dotted=AI), **pinned status radii** (processing=r1;
failed=3px dedicated token), **member-theme schema v1** (the exact tenant-overridable allowlist +
AA intake validation; everything else immutable), corrected **shadcn mapping** (`--input` →
`--kelo-border-input`; `--muted-foreground` → n600), **freshness-aged split** (dot n400 / text
n600), **reduced-motion fix** (short opacity fades retained; transforms/shimmer banned — zeroing
everything killed the promised confirmations), link/icon/avatar/badge/chart-tooltip tokens.

**Content & conduct rules (mockups amended to comply):**
1. **Verification-state trio, canonically:** *verified* (plain), *imported-unverified* (shown,
   hatched + trailing `*` — honesty about provenance; does **not** break the trust streak),
   *failed-check* (greyed out + reason; never rendered as a plain number — **this** breaks the
   streak). The Health streak counts days with zero failed-check figures rendered and zero
   unverified figures shown unmarked.
2. **AI copy is evidence-only** — no unlabeled projections ("worth about $170" and "will sell
   out by ~2:30p" are the canonical counter-examples, now removed): counts, windows, and
   historical outcomes only. This is also a tone-lint rule.
3. **No send action outside the ceremony.** Entry points (Today cards, palette) say
   "Review & send…" and navigate to `ApprovalCeremony`; only the ceremony's final button sends,
   and its verb names channel + count ("Send SMS to 18 people"). "Approve & send" is deprecated.
   Ceremony required slots: audience + exclusions-by-name, exact content preview, cost,
   quiet-hours check, **Send test to me**.
4. **Toasts confirm; they never carry failures.** Failures are persistent inline/banner/result
   states (the sheet's failure example is retitled as inline, not Toast).
5. **No reply-CTA copy in v1** — there is no operator inbox; outreach may not solicit replies
   Kelo processes ("Reply YES…" removed; replies go to the studio phone). Tone-lint enforces.
6. **Refund ceremony state machine:** edit → consequence review (resulting balance +
   credit/booking effects) → actor PIN re-auth (always) → manager step-up (above threshold) →
   processing. The §05 mockup omits the auth steps; the state machine governs.
7. **Heatmap tint = 30-day fill** (UX plan + revenue dictionary govern); the mockup's
   "demand (searches + waitlists, 8w)" becomes a **separately named overlay** deferred until its
   input signals exist (member-surface search arrives phase 8; waitlist-depth chips allowed
   sooner). Tint and overlay are never one ambiguous layer.
8. **Waitlist affordance is mandatory on full slots** (member funnel + Quick Book) and
   **HoldTimer is mandatory on every post-selection booking state** — the mockups' omissions are
   deviations; the UX plan governs.
9. **Shared-device defaults:** Desk auto-locks after 2 min idle (15 s warning); PIN re-entry;
   person search clears on lock; in-progress work parks as resumable cards.
10. **Timezone labeling:** one persistent page-level studio-timezone label; per-value labels only
    where zones differ (UX plan §4 relaxed to match).
11. **Prototype frames are canvases:** fixed heights/`overflow:hidden` in mockups are
    presentation cropping — build surfaces scroll and reflow at 200% zoom.
12. **Touch targets:** pointer surfaces may render 36px controls with a ≥44px hit area; touch
    surfaces (Desk, member, owner phone) render ≥44px visual.
13. **Component allowlist clarified:** base shadcn/Radix primitives (Dialog, Sheet, Tabs,
    Tooltip, Input, Select, Checkbox, Radio, OTP, DatePicker, Pagination, BottomNav) are
    pre-approved; the written-reason rule guards *novel domain components* only.
14. **Canonical mark:** the circled-k SVG as used in the P0 headers (viewBox 0 0 32, ring stroke
    2.6, Familjen 700 "k") is the single source; the stylescape's concentric-rings mark (§01) is
    **superseded** and must not be implemented.

**Deferred spec debts (owned by build phases, not blockers):** Desk shell tab-group mock
(phase 6 — UX plan §2 governs the structure), member Identify/Waiver/account frames (phase 8),
CommandMenu results + AlertCenter panel anatomy (phase 2), ChartWithTable tooltip/table-toggle
chrome + heatmap keyboard/table alternative (phase 2), receipt print template + printer states
(phase 5), DataBoundary compositional-state model (phase 0 component work: primary render state +
independent freshness/connectivity/mutation flags with banner precedence).

---

## Amendments — round 3 (Kimi K3 CLI audit closure, 2026-07-17)

A third audit (Kimi K3, repo-aware, read-only) checked the round-2 state and caught that several
round-2 rules were declared but not fully landed. All resolved:

- **The "mockups amended to comply" claim is now true.** Round 2 stated it prematurely: the
  stylescape still taught `Reply YES` and `Approve & send`, and the heatmap still read "demand,
  8 weeks." Fixed: stylescape carries a **SUPERSEDED — reference only** banner and its two
  teaching strings are corrected; `p0-screens.html` §07 now reads **30-day fill** (tint + legend +
  footer), the "Demand overlay" chip is marked *later*; the Health streak headline uses the
  canonical definition; `p0-today-phone.html` KPI tiles now carry **labeled** freshness chips
  (was color-only — a never-color-alone violation in our own artifact).
- **Canonical files aligned to their own amendments:** `tokens.json` `ai-accent.$rule` and guide
  §4 dropped the banned `Approve & send`; `tokens.json` `motion.reduced-motion` now matches the
  CSS opacity-fade behavior (was still "0ms movement").
- **tokens.json v1.1 filled the remaining implementability holes** (agents would have guessed):
  input rest/focus/error/disabled border states; admitted chrome hexes (`icon-inactive`,
  warning wash/emphasis) into the semantic layer; `data-hero` (38px) + `dense-header` (10px) type
  steps; `desk` radius (8px); micro-rules (selected border widths, nav-badge danger trigger,
  avatar hashing, fill-bar-complete, delta coloring); static-skeleton spec; countdown aria-live
  cadence (start/60s/10s/expiry, never per-second); toast lifetime/stack; the **unknown-state**
  fallback appearance; freshness thresholds (aged ≥1m, stale ≥2h, critical ≥4h); demand-ramp as
  a real array; Stripe-Elements label exception.
- **Status registry extended** to every state the flows render: no-show (money event), dunning
  stages, waitlist offer terminal states, full room-readiness set, refund-denied.
- **Member-theme schema hardened:** derived link/border/selected/hover rules, a light-surface
  luminance constraint (immutable chrome assumes light ground), reserved-hue collision rejection
  at intake, and no-logo / font-load-failure fallbacks.

**Still deferred (owned by build phases, unchanged):** member failure-state frames + email/SMS/
receipt comms templates (phase 8 / phase 5), Desk shell tab-group, CommandMenu + AlertCenter
anatomy (phase 2), standalone `kelo-mark.svg` + favicon/app-icon exports, DataBoundary
compositional-state model, larger-text-mode scale. These are spec debts with phase owners, not
blockers to starting.

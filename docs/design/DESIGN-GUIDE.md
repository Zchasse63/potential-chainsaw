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
| Processing | radius 4–5, outlined | card bg | clock |
| Failed | radius 3, sharp | SOLID danger, white text — loudest thing on screen | x |
| Refund pending | full-radius pill, **dashed** border | warning tint | diamond |

**Freshness chips** on every data region: `● LIVE` (green) → `● SYNCED 12M` (neutral) →
`● STALE 2H` (amber tint, >1h) → `■ STALE 4H+` (red tint, dot becomes a **square**, weight 600).
Micro mono type, full-radius chip, hairline border when healthy.

**Provenance:** Kelo-native data sits on plain surfaces with solid hairlines. Imported legacy
data (e.g. Glofox) is a different material: birch hatch background, dashed `#9C875F` border,
`VIA GLOFOX` tag, and a trailing `*` on any unverified figure.

**AI surfaces:** dotted 1.5px teal border + `#F7FBFB` bg + `DRAFT · KELO INTELLIGENCE` micro tag
+ evidence chips (row counts, sources, date ranges). Draft-shaped until approved. The **approval
ceremony** is explicit: summary line in micro mono (`SMS · 18 RECIPIENTS · EST $1.26`), verb
with the count (`Approve & send to 18`), plus `Edit draft` / `Send test to me`. After sending,
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

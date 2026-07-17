# Kelo — Visual Design Brief

*For the engaged designer. Self-contained: everything you need is in this document; deeper
references are linked but optional. Prepared 2026-07-17. Contact: Zach (owner).*

---

## 1. What Kelo is

Kelo is a studio-operations platform for boutique **recovery/wellness studios** — sauna and cold
plunge. It replaces the booking software these studios rent (Mindbody, Glofox, etc.) with a
system the studio owns: scheduling, bookings, memberships, payments, front-desk point of sale,
member marketing — plus an AI layer that gives the owner a daily "here's what matters today"
briefing. The first studio is **The Sauna Guys, Tampa, Florida**; Kelo then sells to other
studios as SaaS.

**The name:** *kelo* is the prized silver, weather-hardened dead-standing pine used to build the
most coveted Finnish saunas. The brand territory that implies — craft, patience, warmth, premium
natural materials, Nordic restraint — is yours to interpret, not a prescription.

**The product's soul, which the design must carry:** this product exists because its predecessor
showed the owner *wrong numbers presented confidently* for ten weeks. Kelo's entire UX doctrine
is built around **visible trustworthiness** — every number on screen carries its source and
freshness, money states are unambiguous, nothing ever fakes success. The visual language must
make truth-telling look intentional: precise, calm, instrument-like where data lives; warm and
human where people live. Not clinical. Not sterile SaaS. Not gym-aggressive.

## 2. Who uses it

| Persona | Device & context | What they see |
|---|---|---|
| **Studio owner** | Phone in the morning (coffee-line briefing), desktop for money/schedule work | The daily briefing, KPIs, customer segments, revenue |
| **Front desk** | Shared tablet at a counter, customer standing two feet away, sometimes damp hands | Check-in board, quick booking, point of sale, waiver capture |
| **Trainer** | Phone | Their schedule + rosters only |
| **Member** (later phase) | Their phone, arriving from an Instagram link | A booking funnel on the *studio's* domain and brand — Kelo itself is invisible here |

Two-brand reality: the **operator app is Kelo's brand** (what you're designing). The **member
surface is white-labeled per studio** — your system must show how a studio's own logo/color/type
plug into it (The Sauna Guys is the demonstration tenant; assets from the owner).

## 3. What is already decided — the fixed frame you design within

The UX architecture is complete and approved-track ([plan-ux-final.md](plan-ux-final.md) for
depth). You are **not** doing UX/IA — you are giving it a visual identity. Fixed:

- **Structure:** navigation, screen inventory, and flow layouts are specified (summarized in §5).
- **Component base:** shadcn/ui (Radix primitives) + Tailwind. Your identity lands as **design
  tokens** (§4) — the components restyle from tokens with zero rework. You may propose component
  styling (buttons, cards, pills, tables), not new component types.
- **Interaction rules that shape the visuals:**
  - Every data region shows **provenance** — a freshness chip ("Live" / "Synced 12m ago" /
    amber "Stale 2h" / red "Stale 4h+"). These chips are core product language; design them
    beautifully, not as afterthought badges.
  - **Money status pills** — `confirmed / processing / failed / refund pending` — must differ by
    **shape + icon + color** (never color alone).
  - Honest states are first-class: empty, loading (skeletons matching layout), error, stale,
    degraded-AI ("Yesterday's briefing" badge) all need designed treatments.
  - AI-drafted content is visibly **draft-shaped** until a human approves it — the approval
    moment ("Send SMS to 18 people") is a deliberate ceremony.
  - Density: comfortable default; dense tables; **≥48px targets on the front-desk tablet**.
- **Accessibility: WCAG 2.2 AA.** All semantic color pairs pass AA contrast (we verify
  automatically in CI — token values that fail bounce back). Status never encoded by color
  alone. `prefers-reduced-motion` respected; motion is minimal by doctrine.
- **Light mode only for v1.** The token system supports a dark pair later; do not design it now.
- **No dark patterns** anywhere, and nothing that reads medical/clinical — Kelo deliberately
  stores no health data and must not *look* like it does.

## 4. Deliverable 1 — the design guide, as a token contract

Your identity ships as values for the token layers below (Figma variables named to match, or a
simple table/JSON — our variable names, your values):

**Color primitives:** a neutral scale (backgrounds/surfaces/text — most of the app is data on
neutral); a brand/accent scale; functional scales: success, warning, danger, info. Plus the
**domain semantics** unique to Kelo — values for: `status-confirmed`, `status-processing`,
`status-failed`, `status-refund-pending`, `freshness-live`, `freshness-aged`, `freshness-stale`,
`data-native` vs `data-imported`, and `ai-accent` (the color that marks AI-generated content —
it needs to feel distinct-but-trustworthy, used sparingly).

**Typography:** primary sans family (licensing suitable for web app + commercial SaaS), a mono
family for timestamps/IDs/money amounts in logs, a type scale (we run a 4px-base spacing
system), weights, line heights. If you propose a display face for the brand/wordmark, keep app
chrome to two families max.

**Shape & depth:** radius scale, shadow/elevation scale, border treatments — the "personality"
layer (sharp-precise vs soft-warm is a real decision here; the brand tension is *instrument
precision + sauna warmth*).

**Motion:** durations + easings only (we use motion sparingly: state transitions, confirmations).

**Optional scope (owner to confirm budget):** the **Kelo wordmark/logo** and favicon; the brief
works with a typographic wordmark if identity-only is the engagement.

## 5. Deliverable 2 — screen mockups

Priority-ordered; P0 is the engagement's core. Flow-level layout specs exist for every P0/P1
screen (we'll hand you the relevant spec pages).

**P0 — the identity-defining set:**
1. **Today** (owner home) — desktop + phone: 2–3 AI insight cards with evidence, KPI tiles with
   deltas/sparklines + freshness chips, a "focus queue" of ranked actions. The flagship screen;
   it must feel like a calm, credible instrument panel, not a dashboard collage.
2. **Desk — Check-in + Quick Book** (landscape tablet): roster with one-tap check-in; the
   single-surface booking stepper (person → slot grid → waiver → tender tabs → confirmation).
   Big targets, glanceable states, safe to be seen by the customer standing there.
3. **Member funnel** (phone, white-labeled as The Sauna Guys): availability → review & pay →
   confirmed. The polish bar is "boutique hotel booking," on the studio's domain, faster and
   honester than any competitor.
4. **Component sheet:** buttons, form fields, cards, tables, the freshness chips, money status
   pills, banners (stale/offline/error), toasts, empty states, skeletons, the AI-draft surface
   treatment + approval ceremony module.

**P1:** Payment detail w/ timeline + refund flow · Segments + outreach approval screen ·
Schedule calendar + demand heatmap · Health (data-trust) page.

**P2 (pattern application, no individual mockups needed):** People/profile, Reports, Settings,
Staff, Waivers, onboarding checklist — they compose from the P0 component sheet.

## 6. Taste references & anti-references

Competitors win on member-facing polish (Bsport) and lose on lag and clutter; Kelo's stated edge
is **speed and boring correctness made visible**. Aesthetic territory worth exploring: Nordic
restraint, natural-material warmth against precise instrument UI (think: quality thermometer in
a cedar room). **Avoid:** generic SaaS-blue admin template, clinical/medical white, gym-bro
black-and-red aggression, spa-brochure pastels, and AI-product purple-gradient clichés.

## 7. Process & acceptance

- Working cadence with the owner: identity direction (1–2 routes) → chosen route refined →
  token contract + P0 mockups → P1. Async review is fine.
- **Acceptance test for the token contract:** we drop your values into the code's token layer;
  if any component needs a structural change to look right, we iterate the tokens — the
  components are the fixed contract. AA contrast checks must pass.
- Files: Figma (variables for tokens; components using them), exported token table, font
  licenses documented.

## 8. Open items the owner supplies

1. The Sauna Guys brand assets (logo, any existing colors) for the member-surface demonstration.
2. Whether the Kelo wordmark/logo is in scope (§4 optional scope).
3. Budget + timeline for the engagement.

# Kelo — Owner Decisions Needed

*2026-07-16. Every open decision across all planning documents, consolidated. Nothing here blocks
phase 0 from starting — each question lists the phase where a builder hits the wall without an
answer. Defaults are pre-chosen so a one-word "yes" per line is enough; changing a default is
equally fine. Sources: [plan-final.md](plan-final.md), [plan-ux-final.md](plan-ux-final.md),
[plan-intelligence.md](plan-intelligence.md), [legal-readiness.md](legal-readiness.md),
[threat-model.md](threat-model.md).*

## A. Facts only you know (no defaults possible)

| # | Question | Needed by | Why |
|---|---|---|---|
| A1 | ~~Who owns the Stripe account?~~ **ANSWERED 2026-07-17: Glofox-gated** — the build plan's negative branch is active (Glofox-only reconciliation pre-phase-5; PAN-portability request via Glofox/ABC as early as possible; failed payments detected from the Glofox report) | — | Done |
| A2 | ~~What state?~~ **ANSWERED: Tampa, Florida** — Florida law now governs the legal-readiness items (waiver, health-studio/ARL, gift-card/credit expiry, sales tax, breach rules) | — | Done |
| A3 | **Where is your Glofox contract/ToS?** (credentials received ✓, portal docs pulled ✓ — the *contract* review for extraction/write rights remains) | Phase 0 | Extraction-rights review + the write-capability conversation with ABC/Glofox |
| A3b | **Ask ABC/Glofox support for the webhook signing secret** (comes with API credentials; needed to receive member/booking events) — email `glofox.apisupport@abcfitness.com` | Phase 1 | Webhooks are the best deletion-detection and freshness channel |
| A4 | **ClassPass payout per visit** — owner checking (may not be in use; no aggregator markers in 30 days of live transactions) | Phase 2 | Aggregator revenue metric; if ClassPass isn't used, the segment simply stays empty |
| A5 | **Do any members reside in the EU?** | Phase 3 | GDPR language in the privacy policy or not |
| A6 | **Current sales-tax practice:** are sessions taxed in your state? Retail? Who files? (One question for your accountant.) | Phase 5 | The POS tax configuration must mirror reality |
| A7 | **Is there anything in the corrupt prototype DB you personally authored and want preserved** (notes, drafts)? Default: nothing — full reset. | Phase 1 | The data reset is destructive by design |
| A8 | **Glofox catalog mapping:** ~30 minutes in phase 1 to label each Glofox membership/pack catalog item as recurring / unlimited / pack / drop-in / **intro** | Phase 1 | The trial-graduated segment can't identify intro offers without it |
| A9 | **Gold-label session:** ~2 hours in phase 1 labeling ~80 real people's true relationship | Phase 1 gate | The ≥99% derivation gate needs your ground truth |
| A10 | **Brand-voice card:** 3–5 tone adjectives; phrases you always/never use; sign-off; emoji stance; discount philosophy; one past message you loved | Phase 2–3 | Every AI draft inherits this; it cannot be derived |

## B. Policy defaults to confirm (or change) — one line each

| # | Setting | Default | Used by |
|---|---|---|---|
| B1 | Briefing generation hour | 6:00 AM studio time | Phase 2 |
| B2 | Dunning grace window (past_due still counts as member) | 14 days | Member KPI/MRR, phase 2 |
| B3 | Quiet hours for outreach + dunning comms | 9 PM – 9 AM studio time | Phase 3 |
| B4 | Marketing-touch cooldown per person | 7 days | Phase 3 |
| B5 | Cancellation window / late-cancel / no-show consequence | Cancel free ≥12h before; late cancel or no-show forfeits 1 credit (members: counts against plan per its terms); no cash fees in v1 | Phases 4–6; also goes to the lawyer for the ToS |
| B6 | Refund step-up threshold (manager approval above) | $100 | Phase 5 |
| B7 | Credit-pack expiry on **native** packs going forward | 12 months from purchase (subject to B-state law check, legal item 4d) | Phase 5 |
| B8 | Minimum age + guardian policy | 16+ unaccompanied; 13–15 with guardian acknowledgment + on premises; under 13 not permitted | Phase 4 waiver + booking |
| B9 | At-risk threshold (member, no visit) | 21 days | Segments |
| B10 | Hooked threshold (non-member visits) | 3 visits / 30 days | Segments |
| B11 | Stale-credits threshold | balance > 0, 30 days no visit | Segments |
| B12 | Credits-expiring alert horizon | 14 days | Segments |
| B13 | High-value definition | Top 10% trailing-12-month collected revenue | Segments |
| B14 | AI token budget alert | $50/tenant/month | Phase 2 |
| B15 | Workload assumptions: ~30–60 bookable slots/day, ~15–40 attendances/day | Confirm against reality | Phase 2 load tests |
| B16 | SMS geo-permissions | US-only sending | Phase 3 (blocks SMS-pumping attacks) |
| B17 | Comms/AI retention: message bodies 2 years, AI artifacts 1 year | Confirm | Phase 3 retention matrix |

## Design gate — CLOSED 2026-07-17

The visual design guide is delivered, reviewed, amended, and accepted: [docs/design/](../docs/design/)
(Route 01 "The Quiet Instrument" — guide, AA/CVD-validated token contract, stylescape, all P0+P1
mockups incl. the Today phone variant). UX plan confirmed with design-round amendments
(plan-ux-final.md Part III). Remaining, **non-gating**: final wordmark (circled-k is the working
mark) and The Sauna Guys brand assets for the member-surface skin (C6 below).

## C. Actions only you can take (start now — all have lead times)

1. **Buy `getkelo.com` and `kelo.studio`** — minutes, no legal gate, do it today.
2. **Engage the trademark/business attorney** — clearance + filing (Classes 9/42), and hand them
   [legal-readiness.md](legal-readiness.md) as the scope: waiver, privacy policy, member money-ToS
   (needed by phase 5, not 8), health-studio/ARL check, gift-card/credit-expiry law, retention
   matrix review.
3. **Call the insurance broker** — digital-waiver coverage + any required waiver wording (phase 4).
4. **Locate Glofox contract + API credentials** (A3) and answer the Stripe dashboard question (A1).
5. **Sign Anthropic zero-data-retention terms** when the account is set up (phase 2).
6. **Send The Sauna Guys brand assets** (logo, any existing colors/type) — slots into the member-
   surface skin via the validated tenant tokens; non-gating until phase 8.

## D. Two build-plan choices you may want to weigh in on (defaults chosen, reversible)

| # | Decision | Default in plan | The alternative |
|---|---|---|---|
| D1 | MFA is **mandatory** for owner/manager | Yes (threat model: a hacked inbox must not equal refund authority) | Optional MFA — faster login, real takeover risk |
| D2 | Imported Glofox contacts get **transactional messages only** until they re-confirm marketing consent via a first-touch reconfirmation campaign | Conservative consent posture | **Update 2026-07-17:** the live API exposes per-channel consent (`consent.{email,sms,push}`) on every member — this imports as consent *evidence*, so counsel has something concrete to review; treating consented imports as opted-in is now a realistic option |

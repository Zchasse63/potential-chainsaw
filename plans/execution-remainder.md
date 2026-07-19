# Execution plan — the remainder (phases 5c → 8)

_Author: Fable 5 (director). 2026-07-19. This is the WORKING execution DAG for the remaining build,
derived from [plan-final.md](plan-final.md) §6 (which stays authoritative — any scope deviation gets
a §10 changelog entry). Model arrangement per owner directive 2026-07-19: **Opus 4.8 implements**
(workflow subagents, worktree-isolated), **Fable 5 reviews** (adversarial, money-grade), Fable 5
directs + integrates + performs every live action (merge, migrate, attack suite, backfills)._

## Ground state (start of remainder)

Phases 0–4 complete; Phase 5 core merged (schema 0033, idempotency, @kelo/stripe, webhook receiver,
inbox/outbox processors, payment+refund RPCs w/ step-up; 3 reviewer-caught money bugs fixed).
35 migrations live · 578 tests · RLS attack suite 317 assertions/54 tables.

## Wave plan

Each wave = one Workflow run: parallel worktree-isolated Opus implementers → Fable adversarial
reviewers → director integrates, applies migrations live, runs the attack suite, pushes.

### Wave 5c — prove the money engine
| Unit | Scope | Gate it serves |
|---|---|---|
| **5.5 verify_money + chaos harness** | Nightly cross-ledger invariant job (payments ↔ stripe_commands ↔ stripe_events: missing/orphaned/mismatched, refund-exceeds, command-without-event past SLA → critical alerts + a verify_runs record). The **webhook chaos harness**: a test harness firing dupes, reordered, replayed, delayed event sequences at the inbox — the phase-5 gate test ("webhook chaos harness passes"). | §6 phase-5 gate |
| **5.6 subscriptions + dunning** | subscriptions table (Stripe-Billing-for-recurrence per §5 ruling), subscription lifecycle events into the inbox mapper, the **dunning state machine** (failed payment → grace window (owner default 14d) → dunning comms via `transactional_quiet` (quiet-hours-aware, consent-exempt) → focus-queue surfacing → `past_due`/cancel), plan_prices → stripe price wiring. | dunning fires on failed payment |

### Wave 5d — the operator money surface
| Unit | Scope |
|---|---|
| **5.7 POS backend** | Checkout RPC composing: line items (retail/plans/gift-card SALE), **cash tender recording**, simple discounts (manager step-up grant), tax config (tenant settings; owner Q A6 pending → build the config, default 0), receipts via the comms path (email, transactional). Gift-card **sale** (payment → issue + ledger) + **redemption** (definer RPC by code hash, ledger debit). Terminal is stubbed behind the adapter (needs the live account). |
| **5.8 Payments web** | /payments screen: payments list w/ status provenance, refund flow with the StepUpPrompt (over-threshold), the dunning queue, a minimal POS (cash) checkout screen. |

### Wave 6a — the booking engine core
| Unit | Scope | Gate |
|---|---|---|
| **6.1 availability + holds + booking RPCs** | Native bookings on scheduled_sessions: availability computation (capacity − active bookings − active holds, readiness-aware), **server holds** (TTL + btree_gist exclusion constraint — DB-enforced no-oversell), book/cancel RPCs (idempotent; **credit debit via credit_ledger** append-only entries; refund of credit on policy-compliant cancel). | zero double-bookings (storm) |
| **6.2 waitlist + check-in + policy + waiver block** | Waitlist (FIFO w/ hold-on-promote), check-in (+ degraded mode), no-show/late-cancel policy engine (≥12h free / else forfeit 1 credit — owner defaults), the **enforcing booking-time waiver block** (retires the phase-4 advisory queue; desk queue stays as monitored backstop). |

### Wave 6b — booking surface + the storm
| Unit | Scope |
|---|---|
| **6.3 booking UI + concurrency storm** | Quick Book flow (UX §3D: person-pick → slot → hold w/ countdown → waiver preflight → tender/credit → confirmation), roster/check-in screen. The **concurrency storm test** (N parallel bookers vs 1 slot; runs in CI's Postgres job — not prod). |

### Wave 7 — ramp machinery (code-buildable slice)
| Unit | Scope |
|---|---|
| **7.1 readiness dashboard + authority flips** | The per-capability authority matrix as a first-class config (tenant settings + health surface), the readiness dashboard (launch hard-gates per UX §Setup: reconciliation green, payment verified, active waiver, resources+plans configured, roles assigned, delivery tested), onboarding checklist assets. |

### Wave 8 — member surface (code-buildable slice)
| Unit | Scope |
|---|---|
| **8.1 member app** | The member-facing SSR surface (on-domain booking, account claiming, credits/cards, waiver signing via the tokenized link path, receipts, unsubscribe prefs) per §6 phase 8 — built against the booking engine; deploys with the Netlify gate. |

### Live-ops / owner-gated (NOT code — tracked in BLOCKERS)
Netlify deploy (P0-3, unlocks scheduler cadence + every URL) · Stripe Connect account (P0-5 → live
charges, Terminal, "reconcile to the cent") · Resend/Twilio + 10DLC (P3-2 → live sends + the waiver
link flow) · restore drill #2 (PITR, P0-8) · Glofox write-probe sign-off (phase-4 decision) ·
parallel-run/cutover execution (phases 7–8 gates are operational by nature).

## Standing rules (unchanged)
Reviews are adversarial and money-grade; FAIL blocks merge until fixed with a regression test.
Director applies every migration live + runs the attack suite after schema changes. Append-only
ledgers, RLS-on-everything, webhook-as-authority, outbox-before-call, no optimistic money UI.

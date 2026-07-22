# Execution plan — the remainder (to cutover and Glofox retirement)

_Author: Fable 5 (director). **2026-07-22.** This SUPERSEDES the 2026-07-19 version entirely and is
the current source of truth for "what's next." Derived from [plan-final.md](plan-final.md) §6
(authoritative — deviations get §10 entries) and the verified mid-project review
([review-2026-07-22.md](review-2026-07-22.md) — read it first; every claim here carries evidence
there). Model arrangement: **Opus 4.8 implements**, **Fable 5 plans/reviews/directs**; Kimi K3 is
an auxiliary planner/reviewer; **Sol/ChatGPT is OUT (no credits — never route work there).**_

## How to work (standing instructions — do not skip)

1. **Increment discipline:** branch `wf/<name>` → implement → `pnpm -w typecheck && pnpm -w lint
   && pnpm -w test` → independent review for app code (feature-dev:code-reviewer, or a multi-lens
   Workflow for money/security surfaces) → fix findings with fail-before-fix tests → `git merge
   --no-ff` to main → delete branch → push. Test-only/doc increments take the light path (no
   formal review).
2. **Merging = deploying.** Migrations auto-apply to production on merge to main. After ANY schema
   change, run the full attack suite; add an attack block for every new SECURITY DEFINER RPC —
   **the suite does NOT auto-detect new RPCs** (the 0047 bug is the proof of what slips through).
3. **Verify live before merge** (schema/RPC work): Supabase MCP `execute_sql` on project
   `ysnijttvprwymwheyyfm`, wrapped in a DO block ending `raise exception 'ROLLBACK_SENTINEL'` with
   a `raise notice '... OK'` immediately before — sentinel firing = all assertions passed, nothing
   persisted.
4. **Release rule (invariant #1):** no "done" without (a) captured evidence, (b) a test that failed
   before the fix, (c) a production-visible health signal. Put the evidence in the commit body.
5. **The repo is PUBLIC.** No PII in commits, docs, tests, or Playwright artifacts — aggregates
   only. Member scope always from `resolveMember`, never the request.
6. Record any plan deviation in plan-final §10. Update THIS file's status lines as waves complete.

## Ground state (verified 2026-07-22)

Phases 0–7 machinery merged; member web (W8-1…W8-3) complete minus the Stripe Pay stage;
test-hardening WS-1…9 done + WS-10 read-only slice green (mutating slice env-blocked). 47
migrations · 150 vitest files / 1217 cases · 43 attack blocks / 352 assertions · CI green ·
3 Playwright specs green vs the live DB (run manually — **no CI e2e job exists yet**).

**Live production reality (probed 2026-07-22):** 1,366 people · 258 credit holders / 870
outstanding credits · 0 waiver signatures · 0 person claims · **the recurring cadence is FROZEN
since 2026-07-18** (nothing enqueues `glofox.sync.all`; jobs queue empty; 3 warning alerts
unacknowledged) · nothing is deployed (P0-3 open — the tick itself is not running anywhere).

---

## The remaining work, in order

Waves are dependency-ordered. R0 is not optional and not owner-gated — nothing downstream is
trustworthy until the system runs itself.

### R0 — Make it run itself + close the live holes _(code only, no owner gates — DO THIS FIRST)_

| Unit | Scope | Key refs |
|---|---|---|
| **R0.1 cadence producer** | The missing "unit 1.7": seed `glofox.sync.all` per active tenant from the tick (in-tick hour-keyed enqueue is sufficient — the fan-out's idempotency buckets already make double-fire safe; a schedule table is acceptable if cleaner). Test: a cold queue self-populates. | workers/src/glofox/processors.ts:52-57; netlify/functions/scheduler-tick.mts |
| **R0.2 watchdog + alert push** | Sync-staleness alert (no sync_run inside the expected window), dead-lettered-job alert, and PUSH delivery of critical alerts to a human (email via the comms adapter, dry-run-aware). /health surfaces `jobs.status='dead'` count. | alert writers: pipeline.ts, reconcile.ts, outbox.ts, inbox.ts |
| **R0.3 member purge registration** | Register `member_otp_purge` / `member_session_purge` processors (thin delegations to the 0044 definer fns) + day-keyed fan-out enqueues + tests. Currently kinds-only → unbounded auth-table growth. | workers/src/member/purge.ts; workers/src/processors.ts |
| **R0.4 member OTP → comms adapter** | Replace the hard-coded no-op `sendMemberOtp` default with the @kelo/comms adapter behind the standard env-key dry-run switch, so P3-2 keys flip it live with everything else. Send-path test. | apps/api/src/routes/member.ts:153-155 |
| **R0.5 grant_gift_card idempotency** | Add `p_idempotency_key` to the RPC (migration) or mount `persistIdempotency`; failing-first duplicate-grant test; attack-suite rerun. The one live invariant-#5 hole (duplicate stored-value liability). | routes/retail.ts:151-156; migration 0031:113-158 |
| **R0.6 attack-coverage closure** | Blocks for the 9 uncovered authenticated definer RPCs (priority: grant_gift_card, pseudonymize_person, publish_sessions) + a webhook_events deny-all probe + a **definer-RPC catalog meta-guard** (every `app.*` SECURITY DEFINER name must appear in rls_attack.sql — extends the block-26 pattern). | review §3 P1 |
| **R0.7 credits reconciliation** | Add credits to RECONCILE_ENTITIES: Kelo-vs-Glofox balance diff per person; explicit expiry semantics (3 expired grants exist; no `expire` entries materialized). This is the pre-flip attestation input for the 258 holders / 870 credits. | workers/src/glofox/reconcile/reconcile.ts:76-81 |
| **R0.8 /health authority truth** | Replace the hardcoded 5-capability constant with a read of `current_authority` (0042's 8 domains). | apps/api/src/authority.ts |
| **R0.9 hygiene batch** | Bundle-grep existence assertions (`test -d` before grep, both jobs); Idempotency-Key on `POST /member/holds`; grantGiftCard 22023/P0002 + data-booking 23514 error mappings; route the two raw envelope casts through inspectEnvelope (marketing-screen.tsx:84, import-screen.tsx:135). | review §3 P2 |

_Gate: production queue self-populates from a cold start; a manufactured staleness fires an alert
that reaches a human channel; the 07-18-style silent freeze is impossible to repeat; attack suite
green with the new blocks; credits reconciliation runs green (or surfaces real drift honestly)._

**Immediate op (director, before/alongside R0.1):** hand-run the sync cadence once against prod to
unfreeze reconciliation data, and acknowledge/triage the 3 open warnings.

### R1 — Member-surface completion (web)

| Unit | Scope |
|---|---|
| **R1.1 cancel-booking UI** | Wire the existing tested `cancelBooking` into booking-panel/account with the refund-vs-forfeit branch surfaced. The panel already PROMISES this in copy. |
| **R1.2 claim resolution path** | Member claim-status screen (first-name-only, polls `/member/claim/status` — endpoint built); operator resolution workspace over `person_claims`; desk claim-code mint/consume routes + screen (0044 table exists, nothing mints). Fixes the needs_resolution bounce loop. |
| **R1.3 session refresh spine** | `member-core.refreshSession()` + a rotation **grace window** migration (plan §14.3 — 0045 currently insta-revokes the family on any replay; mobile will hit spurious revocations without it) + concurrent-refresh test. Prereq for mobile. |
| **R1.4 waiver-links flow** | The mass re-sign de-risker: `waivers.send_links` worker processor + minting route calling `enqueue_waiver_links` (RPC + tokens exist; both ends dead today). BUILD now; live delivery gates on P3-2; **waiver TEXT gates on lawyer review (legal 4c) — do not mass-send before sign-off.** |
| **R1.5 account completeness** | Receipts + unsubscribe prefs + balance expiry in contract/data/UI (receipts partially Stripe-gated → can trail into R4). |

### R2 — Operator-surface completion

| Unit | Scope |
|---|---|
| **R2.1 marketing screen** | Refactor to the injectable seam (mirror routes/staff.tsx) + RTL tests incl. no-optimistic-approve. Last non-injectable screen; gates real sends; currently zero tests. |
| **R2.2 scheduling route tests** | HTTP-layer tests for all 22 `/scheduling/*` routes (role walls, idempotency, envelope, publish atomicity) — largest untested API surface. + marketing/tenant/retail/payments stragglers. |
| **R2.3 People surface (XL)** | Profile API endpoints (people.ts is search/export/delete only) + People index + person profile screens (visits/credits/payments/comms/waivers/relationship history). Without it operators keep Glofox open, defeating cutover. Merge tooling: decide person_merges scope (never built — §10). |
| **R2.4 Reports consumer** | Screen consuming `GET /reports/revenue` (live, zero consumers) + definitions drill-down; CSV per plan or record deferral. |
| **R2.5 test tail** | AskScreen tests; thicken retail/app-shell/heatmap; component-allowlist decision (extract or record deviation per invariant #10). |

### R3 — Cutover machinery _(the strangler-fig actually strangles)_

| Unit | Scope |
|---|---|
| **R3.1 authority enforcement** | Sync upserts, deletion detection, and reconciliation consult `current_authority` per domain (skip/demote Glofox for kelo-owned domains). Today a flip is a diary entry, not a lever. |
| **R3.2 freeze + partition** | Final-import trigger, per-domain import pause, freeze-window runbook, inventory-partition rule for bookings during coexistence (Glofox-app members can otherwise oversell flipped capacity). Owner decision partition-vs-writeback still open (phase-4 probe). |
| **R3.3 subscription migration tool** | Bulk Stripe customer+subscription creation with billing anchors + an explicit no-double-billing guard (the plan's cohort rule). Rehearse in Stripe test mode. |
| **R3.4 member cutover comms** | Claim/switch/re-card templates + campaign wiring through ApprovalCeremony. All 258 credit holders have email (verified) — the claim blast is email-first and NOT 10DLC-gated. |
| **R3.5 Glofox webhook receiver** | HMAC verify + inbox + MEMBER_UPDATED soft-delete handling. Buildable now; live needs P0-7 secret. |
| **R3.6 final-archive task** | Scripted full Glofox export (incl. entities outside the 6 synced) before contract cancellation — data outside sync dies with the account. |

### R4 — Money live _(owner-gated: P0-5 Stripe, P0-3 Netlify, P3-2 comms)_

Stripe go-live wiring (stripe_accounts row, keys, public webhook URL → one real charge flips
`payment_verified`) · member **Pay stage** (`/member/bookings/:id/pay` PaymentIntent +
`/payment-methods` SetupIntent over the existing 5.4 RPCs, Payment Element, webhook-confirmed) ·
member **step-up spine** (`/member/auth/step-up` + `requireRecentVerification` — prereq for card
update) · receipts · POS Terminal later.

### R5 — Mobile (W8-4) — **blocked on an owner ruling, see Open decisions**

Expo apps per plan-member-app §4: member-core TokenStore + hooks layer, `apps/member-mobile`
scaffold, `member_push_tokens` migration + expo-push adapter + receipt-poll job, EAS Build/Submit,
Maestro smokes. Prereqs: R1.3 (refresh + grace window), P8-1 (assets), P8-2 (store accounts).
Store review lead time sits on the critical path **if** mobile stays cutover-gating.

### R6 — Verification & ops gates _(interleave with R1–R4; several unblock in CI)_

- **CI e2e job**: read-only live specs now (proven safe); **mutating specs on GitHub Actions** —
  runners have Docker, so `supabase start` + the Mailpit OTP-capture seam (`server.e2e.ts`
  injecting `sendMemberOtp`) work in CI even though the local machine is blocked. Keep
  non-required/opt-in initially.
- Operator Playwright money flows (refund step-up 423 lockout, POS ledger, desk booking/check-in).
- Executable segment-engine fixture on real PG + the owner gold-label pass (≥99% gate).
- **Restore drill #1 then #2** (P0-8 — plan's own hard gate; money is live in schema NOW).
- Heartbeat proven by unplugging the tick (never run).
- Perf: pin budgets, measure p95 for 7+ days pre-cutover; rate-limit or cache `GET /member/schedule`.
- Briefing tail: feedback-loop summarizer, fill-rate candidate, AI budget caps, tone-lint
  expansion, /ask growth toward ~20.

### The cutover event (ops, rehearsed — from plan-final §4/§6 + review)

Claim campaign (email-first) + pre-arrival waiver links → re-card campaign only if PAN portability
fails → staged per-domain authority flips WITH enforcement live → rehearsed freeze window + final
import → Glofox read-only 30 days, parallel reconciliation green (now including credits) →
documented rollback decision point → final archive export → contract cancelled one cycle later.

---

## Owner-action list (start these clocks NOW — they, not code, set the cutover date)

| Action | Why now | Blocker |
|---|---|---|
| File 10DLC | Weeks of carrier lead time; gates all SMS (not the email claim blast) | P0-4 |
| Create/deploy Netlify sites (+ swap member `PRIMARY-SITE-PLACEHOLDER`) | Unblocks the tick runtime, webhook URLs, the 10DLC-required public privacy page | P0-3 |
| Enable PITR + schedule restore drill #1 | Money live in schema; plan's own hard gate | P0-8 |
| Stripe Connect account + PAN-portability request to Glofox/ABC | Long external clock; determines re-card need | P0-5 |
| Resend (domain verify) + Twilio accounts | Claim campaign channel; OTP delivery | P3-2 |
| Sign Anthropic ZDR | Briefing ships aggregates; required before PII-bearing drafting | P2-1 |
| Lawyer: waiver text (FL check "can change the build") + member money-ToS | Upstream of mass re-sign build-out and first live charge | legal 4c/4 |
| Rule on mobile-vs-cutover (below) and, if in, enroll Apple + Play NOW | Store review lead time | P8-2 |

## Open decisions (owner — each currently blocks a wave)

1. **Mobile scope:** ruling 2026-07-19 made native apps cutover-gating; directive 2026-07-20
   sequenced them last. Both can't stand without cutover waiting on store review. Either descope
   mobile from the cutover gate (record in §10) or start P8-1/P8-2 clocks immediately.
2. **Partition vs write-back** for bookings coexistence (phase-4 decision, never made — R3.2
   depends on it). The Glofox client is read-only today; write-back would be new scope.
3. **Waiver text** — lawyer sign-off before the mass re-sign flow sends anything (R1.4 gate).
4. **person_merges** — plan-promised, never built; decide build-vs-descope for R2.3 (§10 either way).

## Deferred / descoped register (recorded in plan-final §10, 2026-07-22 entry)

Binary authority ledger (vs 4-state + write_back_log) · person_merges · cancellation_policies /
policy_version / booked_by_person_id · resource+tstzrange GIST bookings (session-lock design
instead, documented) · written_off payment state · refunds table (commands+webhook instead) ·
automation_flows/enrollments · import_conflicts · /outreach→/marketing, /billing→/payments ·
operator stack substitution (no shadcn/Radix/Storybook/TanStack-Table/axe; hand-rolled token
components) · If-Match stub unwired.

<!-- Plan of record for the test-hardening pass (owner directive 2026-07-20). Generated
     by the test-coverage-audit workflow: 7 domain auditors + E2E strategy → synthesis.
     Coverage ratings at audit time: AI/Intelligence = THIN; everything else = MODERATE. -->

# Kelo Test-Hardening Roadmap (plan of record)

Synthesized from six domain coverage audits + the E2E setup strategy. Ordered by RISK×IMPACT (money / booking / auth / legal-evidence / tenancy before cosmetics), with dependency ordering respected (SQL-execution harness before SQL golden suites) and the Playwright scaffold elevated as an early first-class layer. Each workstream is a reviewable increment (larger ones carry a suggested split).

**Size legend:** S ≈ 1 increment · M ≈ 1–2 · L ≈ 3+ (split it) · XL ≈ many specs.

---

## The 5 gaps to fix first (by name)

1. **Jobs-queue SQL — `app.claim_jobs` (FOR UPDATE SKIP LOCKED), `fail_job` backoff, `reap_expired_leases`, complete/fail stale-worker guards** — *integrations-workers, CRITICAL*. Invariant #4's entire safety proof is unexecuted; **two** functions call `runTick` (`scheduler-tick.mts`, `worker-run-background.mts`), so concurrent double-fire is a real runtime condition. Dropping SKIP LOCKED or flipping the attempts comparison could double-run a money job and all 1123 tests stay green.
2. **The three unexecuted intelligence derivation engines — `app.recompute_segments`, `app.recompute_all_relationships`, `kpi_*`** — *ai-intelligence, CRITICAL*. Every headline number (member_count, MRR, collected_revenue, segment/outreach assignment) is validated only by migration-text grep or mocked RPCs. A wrong figure ships silently wearing a "trustworthy v1" definition badge; some test *titles* claim guarantees their assertions never verify.
3. **Subscription event-time monotonicity guard — `syncSubscriptionStatus` `last_event_at` (F6)** — *integrations-workers, CRITICAL*. Only the SQL *shape* is asserted; no out-of-order schedule is ever executed. A replayed/delayed `customer.subscription` webhook could revive a CANCELLED member or regress a PAID one.
4. **POS money routes — `apps/api/src/routes/pos.ts` (`/pos/checkout`, `/pos/gift-cards/redeem`, `/pos/orders`)** — *api-routes, CRITICAL*. An entire money-mutation route surface has **zero** HTTP-layer test: role gate, Idempotency-Key 422, persistIdempotency replay, zod body, and the `data-pos.ts` `mapRpcError` translation are all unverified in JS.
5. **front-desk-screen waitlist accept/decline mutations + staff-screen credential surface** — *operator-web, CRITICAL*. The waitlist accept/decline booking mutations are stubbed as `vi.fn()` and **never invoked** by any test; the PIN set/reset + step-up credential screen is entirely untested and not even injectable.

Honorable mention (invariant violation): **Step-up auth RPCs, migration 0026** — *database-rls, HIGH* — zero runtime/attack coverage, violating invariant #7 ("every RPC gets a cross-tenant attack test") for the gate that protects money and data-rights operations. Fixed in WS-5.

---

## Ordered workstreams

### WS-1 — Real-Postgres golden/integration harness + wire orphaned SQL proofs *(foundational unblocker)*
**Goal:** make SQL *executable* in CI — extend the existing `packages/db/test` DATABASE_URL/`new Pool` pattern into a shared golden-suite fixture layer that runs in the CI `db` job, and stop shipping orphaned proofs.
**Closes now:**
- *database-rls, HIGH* — `supabase/tests/data_rights.sql` is orphaned (grep-confirmed zero references); wire it into `scripts/db-test.sh` so the GDPR/legal-evidence RPCs (export / pseudonymize / retention + the `keep_deleted_person_pseudonymous` guard) get a CI runtime signal.
- *integrations-workers, HIGH* — no guard enforces invariant #4; add the repo-grep CI step: exactly one Netlify `schedule:`, and no `pg_cron`/`node-cron`/`setInterval` in shipped worker code (mirror the member-bundle Supabase grep).
**Enables:** every SQL golden suite in WS-3/WS-4.
**Size:** M.

### WS-2 — Playwright E2E scaffold *(early first-class layer; parallel with WS-1)*
**Goal:** stand up the whole E2E harness and prove it green with one trivial spec — the single biggest missing test *type*.
**Deliverables (per the E2E strategy):** root `playwright.config.ts` + `webServer[]` (API 8787 / web 4173 / member 4174); env-gated `KELO_E2E` Vite dev proxies in both apps (config-only, doesn't trip the member `src`/`netlify.toml` greps); `apps/api/src/server.e2e.ts` wiring `sendMemberOtp` → Mailpit SMTP (**the load-bearing OTP seam — member auth E2E is impossible without it; the code is only sha256 at rest**); `supabase/tests/seed.e2e.sql` (test-harness artifact, never a migration — respects invariant #2); `scripts/e2e-db.sh` (reset→migrate→seed); `e2e/` helpers (Mailpit reader, Stripe webhook signer, Supabase-admin/storageState/global-setup); exclude `**/e2e/**` from the root vitest include globs; CI `e2e` job with trace/video/axe artifact upload. Prove with **one** SSR-renders-from-seed spec.
**Closes:** the "zero E2E exists" gap that every domain's `e2e_candidates` depends on (no flow coverage yet — that lands in WS-10).
**Size:** L.

### WS-3 — Jobs-queue + money-write RPC execution suite (real Postgres) *(depends on WS-1)*
**Goal:** execute — under genuine parallelism and replay — the SQL that guards the money/booking spine.
**Closes:**
- *integrations-workers, CRITICAL* — jobs queue: two concurrent `claim_jobs` never return the same id (SKIP LOCKED); `fail_job` walks attempts→backoff→`dead` at max; `reap_expired_leases` requeues vs dead-letters; `complete_job`/`fail_job` are no-ops for a stale `locked_by`; `enqueue_job` idempotency-key conflict returns the existing id; `job_runs` UPDATE/DELETE revoked.
- *integrations-workers, HIGH* — money RPCs executed: `create_payment_intent`/`create_refund` idempotency-key collision → one command + one payment; `issue_order_gift_cards` exactly-once under at-least-once redelivery + succeeded-payment gate; `record_dunning_stage` no-op-at-stage + rollback when the comms enqueue raises.
- *database-rls, HIGH* — concurrency proof beyond bookings: gift-card redemption storm (N parallel `redeem_gift_card` on one card → exactly M succeed, ledger never negative, FOR UPDATE proven); `pos_checkout` / payment-intent idempotency-under-parallelism storm (one key, K concurrent calls → one order/payment/command).
**Size:** L — split **3a** jobs queue, **3b** money RPCs + concurrency storms. (pglite/pg-mem won't honor SKIP LOCKED — use a throwaway Postgres/testcontainer or Supabase preview branch.)

### WS-4 — Intelligence derivation golden suites (real Postgres) *(depends on WS-1)*
**Goal:** execute the derivation SQL and assert exact outputs, so a wrong member_count / MRR / segment / revenue can't ship green under a v1 trust badge.
**Closes:**
- *ai-intelligence, CRITICAL* — `app.recompute_segments` (13-segment engine): exact membership + evidence per segment; fixtures on every window edge (21/74/15/60/180/14/30/45, inclusive vs exclusive); priority-complement (a recurring member also at_risk must NOT get active_recurring); person-ref union; NOEQL override exclusion; `segment_current` single-highest-priority reduction.
- *ai-intelligence, CRITICAL* — `app.recompute_all_relationships`: full status/type/override/credit/activity classification matrix; precedence (recurring > pack_holder > guest > lead); `person_relationship_log` fires exactly once on a real transition and never on idempotent re-run (this field is literally what `member_count` and MRR key off).
- *ai-intelligence, CRITICAL* — `kpi_*` (collected_revenue / mrr / attendance / credit_liability / failed_payments): refund sign on a same-day PAID+REFUNDED pair; NOEQL-override exclusion; MRR member exactly on vs just past the 45-day boundary; attendance denominator excludes cancelled/late-cancel and a future booking is not yet a no-show; credit-lot earliest-expiring attribution.
- *ai-intelligence, HIGH* — the seven `ask_*` SQL functions (**zero** coverage today): exact rows + tenant scoping + divide-by-zero-safe fill_rate on zero-capacity/over-booked slots (the digit-fence trusts these rows as ground truth).
- *ai-intelligence, HIGH* — `buildCandidates` briefing SQL: prior_net=0 branch, run_rank 1-vs-2 at_risk delta, impact_score desc ordering/tie-break.
**Size:** L — split **4a** segments, **4b** relationships, **4c** KPI, **4d** ask + briefing.

### WS-5 — SQL attack-suite hardening (`rls_attack.sql`) *(auth guard + immutability + taxonomy)*
**Goal:** cover the SECURITY DEFINER guards and immutability triggers the attack suite skips, and pin failure *modes*, not just failure.
**Closes:**
- *database-rls, HIGH* — step-up auth RPCs (0026): cross-tenant `set_step_up_pin` refusal (42501); the role-escalation guard (front_desk may not set an owner/manager PIN); `record_step_up_attempt` lockout-threshold ledger + reset-on-success; actor≠caller rejected. **Restores invariant #7.** Pin exact SQLSTATEs the way blocks 38-39 do.
- *database-rls, MEDIUM* — `activate_waiver_version` lifecycle (v2 activation flips v1 inactive, exactly one active) + `protect_waiver_version` / `protect_campaign_approval` immutability triggers.
- *database-rls, MEDIUM* — convert blocks 27-33's 64 `exception when others` catch-alls to typed SQLSTATE/message catches (over-refund, capacity, `insufficient_credits`, `refund exceeds refundable amount`); add a zero-credit booking refusal asserting `insufficient_credits` specifically (guards the wrong-reason regression + vacuous-pass meta-risk).
- *database-rls, LOW* — make block-26 append-only sweep generic (drive from the `APPEND-ONLY` table-comment convention) instead of the hand-maintained 18-name array.
**Size:** M — split **5a** step-up block, **5b** waiver/campaign immutability, **5c** taxonomy pinning + generic block-26.

### WS-6 — Subscription monotonicity + comms compliance execution (workers, stateful stores)
**Goal:** execute the subscription state guard and the consent/suppression mapping that shape-only tests leave unproven.
**Closes:**
- *integrations-workers, CRITICAL* — F6 subscription monotonicity: extend the ChaosStore (or a new stateful subscriptions store) to honor `last_event_at` verbatim and run adversarial schedules through the real inbox — older `updated` after newer = no-op; same-second `updated`+`deleted` both apply when deleted lands second (member ends cancelled); stale `active` never revives a cancelled sub; monotonic advance. Also assert `mapStripeEvent` extracts `created`→`eventCreatedAt` in `events.test.ts`.
- *integrations-workers, HIGH* — comms `statusMap`: table-driven every provider status/error code → expected `SuppressionReason` (+ unknown-code path never silently suppresses); webhook signature verify for Twilio and Resend (valid/tampered/missing/replayed).
- *integrations-workers, MEDIUM* — comms `send.ts` provider-failure/retry (row stays retryable, no double-dispatch on status-write failure); `glofox/envelopes.ts` direct extractor tests (empty/malformed/pagination-boundary); pipeline duplicate-email savepoint isolation verified on real Postgres (rows 1+3 commit, row 2 quarantined).
**Size:** M.

### WS-7 — API HTTP-layer tests for the untested money/booking route modules
**Goal:** give the two entirely-untested money/booking route modules real behavioral tests and pin the RPC-error mappers.
**Closes:**
- *api-routes, CRITICAL* — `pos.ts`: checkout happy path/native envelope; idempotent replay writes one RPC + sets header; 422 without Idempotency-Key (RPC never called); 403 trainer before RPC; drive `mapRpcError` codes (22023→422, P0002→404, 23505→409, 42501→403); redeem over-balance 422 + gift-card hashing (no raw code echoed); the front_desk `discount_cents` boundary (42501→403).
- *api-routes, HIGH* — `waitlist.ts`: join/accept/decline/position/check-in/roster role gates + 422 no-key; **accept→`book_session` waiver 42501→403** and 23514 capacity mapping; idempotent replay on join/accept.
- *api-routes, HIGH* — `data-pos.ts` + `data-booking.ts` `mapRpcError` unit-tested directly (42501→403, 22023→422, P0002→404, 23505→409, unmapped→throws 500; Zod result-schema rejects malformed RPC row as server defect).
- *api-routes, MEDIUM/LOW* — member-booking replay + waiver-blocked (403 `booking_waiver_required`) + forfeit pass-through; `GET /payments/:id` 404 branch + `GET /pos/orders`; payment-intent currency validation + step-up misconfig 500; schedule/marketing param-validation + non-owner 403-before-RPC depth.
**Size:** L — split **7a** pos, **7b** waitlist, **7c** mappers + the mediums.

### WS-8 — Operator-web RTL for the untested booking + credential surfaces
**Goal:** cover the booking-mutation path and the credential screen that ship today with zero behavioral guard, and prove provenance refusal on the *actual* money screens.
**Closes:**
- *operator-web, CRITICAL* — front-desk-screen waitlist accept/decline: click accept → `onAccept` once with a stable key; retry-after-failure reuses the same key; independent per-entry keys; server error surfaces a named "nothing was promoted" state, not a silent drop.
- *operator-web, CRITICAL* — staff-screen: **refactor to injectable queries/mutations first** (it's the only screen calling `useQuery`/`postEnvelope` directly), then RBAC (`can_manage_pin=false` hides Reset), 4–6-digit + matching-confirm gate, locked state, grant-less step-up rejection, PIN never echoed / never in a query string.
- *operator-web, HIGH* — POS & Payments feed their own `DataBoundary` a `status:'error'`, `status:'pending'`, and a **meta-less payload** → refuse to render any price/tender (invariant #3 on the money surfaces, not just import-review).
- *operator-web, HIGH* — front-desk timed-commit (fake timers: window elapses → `onCheckIn` once), offline-at-commit → enqueue, failed-commit → enqueue + syncError, reconnect → `runReplay` drains + roster refetch; roster boundary error/meta-less refusal.
- *operator-web, HIGH* — auth-context state machine (unconfigured/loading token-null/signed_in/onAuthStateChange/unmount-unsubscribe) + sign-in-screen (password error, magic-link sent, unconfigured banner).
- *operator-web, MEDIUM/LOW* — marketing/ask screen wiring (no-optimistic-status on approve); `lib/api` non-2xx → `ApiRequestError` carries status+code+correlation-id; money/booking route-wiring smoke (idempotency key forwarded verbatim, correct invalidation key); waivers no-provenance refusal; step-up-prompt 401/cancel/reset branches.
**Size:** L — split **8a** front-desk mutations + timed-commit, **8b** staff-screen refactor+tests, **8c** money-screen provenance + auth, **8d** mediums.

### WS-9 — Member-web + shared-package unit gaps (money/legal adapters + honesty fence)
**Goal:** close the untested legal-evidence and money adapters on the client shared with mobile, and the anti-hallucination carve-out.
**Closes:**
- *member-web-packages, HIGH* — `waiver-outcome.ts` (no test file exists; sibling `booking-outcome.ts` has one): pin `waiver_version_changed`/`waiver_version_not_found`→`version_changed`, `waiver_sign_invalid`→`invalid`, unknown/absent→`retry`, non-http→`retry`; `toWaiverLoad` cases. A renamed code currently degrades a stale-version reload into a blind re-sign against a stale waiver.
- *member-web-packages, HIGH* — `cancelBooking` forfeit branch + shape rejection + a new `toCancelOutcome` adapter with a per-code test before cancel UI is wired (12h refund-vs-forfeit is a money decision on a shared client).
- *ai-intelligence, HIGH* — honesty-fence digit carve-out: `collectAllowedDigits`/`validateHonesty` (briefing) and `validateAskNarration` (ask) — a UUID/id digit sequence must NOT authorize a prose number; `validateHonesty` throws on missing/duplicate/unknown id and `insights.length != candidates.length`.
- *member-web-packages, MEDIUM* — `packages/contracts/test/member.test.ts` negatives (acknowledged literal, positive position, cancel-branch enum, verify-code min/max bound, schedule superRefine); BookingPanel synchronous in-flight guard on Book/Join + a rapid-double-tap test (idempotency currently rests on React render timing); auth error-code asymmetry made a documented decision.
- *member-web-packages, LOW* — `inspectEnvelope` direct test (the invariant-#3 chokepoint); member-bundle grep vacuous-pass fix (assert dist exists before grepping); waitlist retry-key reuse; DataBoundary offline/`Updating…` flags.
- *ai-intelligence, MEDIUM* — definition-version snapshot freeze (metric_definitions / 13 segment_definitions / ask_catalog tuples, so a v1 wording/param change forces a version bump); reconcile active-member canary provenance fix (detail must describe the `recurring_member` cohort it actually counts, not the retired `subscription_payment` proxy — and update the test that pins the stale text); `select.ts` fill-pass + tie-break; `localSelection` robustness.
**Size:** L — split **9a** waiver + cancel + honesty-fence (the HIGHs), **9b** contracts + BookingPanel + provenance/definition mediums.

### WS-10 — E2E flows (member golden path, then operator money) *(depends on WS-2 scaffold + seed)*
**Goal:** exercise the wiring unit suites can't — OTP capture, host-only cookie, webhook close-the-loop, cross-app schedule→member.
**Closes (all six domains' `e2e_candidates`):**
- **Member (ranked):** (1) booking→Confirmed with signed-webhook close-the-loop — assert **no optimistic confirm before the webhook** (invariant #5) and Confirmed durable across hard reload; (2) over-capacity / hold-expiry refusal (browser companion to `booking_storm`); (3) OTP contract — neutral 202 on hit vs miss, **host-only cookie has no `Domain`** (assert via `context.cookies()`), logout→neutral 401; (4) account→logout.
- **Operator (ranked):** (1) refund/void behind step-up PIN — idempotency (double-submit = one effect) + **423 lockout**; (2) POS checkout — ledger append, no mutable balance (invariant #6); (3) desk booking / front-desk check-in; (4) schedule authoring→publish→appears in member schedule (cross-app proof); (5) waiver desk capture reflected in member status; (6) sign-in + `/health` freshness-envelope + DataBoundary smoke.
- Then layer `@axe-core/playwright` + per-route JS budgets (the member plan's beta gate).
**Size:** XL — sequence member 1→4, then operator 1→6, then axe/budgets.

---

## Recommended execution order

**First (foundations, in parallel across two tracks):**
- **WS-1** (real-PG golden harness + wire `data_rights.sql` + invariant-#4 CI guard) — unblocks every SQL golden suite and bags the cheap orphan-fix.
- **WS-2** (Playwright scaffold) — the biggest missing layer; independent track (E2E infra vs SQL), so it runs alongside WS-1/3/4 without contention.

**Second (highest-risk correctness, once WS-1 lands):**
- **WS-3** (jobs queue + money RPCs) → **WS-4** (intelligence engines). This is where the top-5 CRITICALs #1 and #2 get real execution coverage.

**Third (remaining guards and route/UI holes, interleavable):**
- **WS-5** (rls_attack step-up + immutability + taxonomy — invariant #7) and **WS-6** (subscription monotonicity F6 + comms compliance — top-5 #3) next, since they close CRITICAL/HIGH guard behavior.
- **WS-7** (pos/waitlist API routes — top-5 #4) → **WS-8** (front-desk + staff-screen — top-5 #5) → **WS-9** (member adapters + honesty fence). These TS-unit workstreams can run concurrently with WS-5/6 on a separate track.

**Last:**
- **WS-10** (E2E flows) — depends on the WS-2 scaffold + seed, is the slowest/most brittle layer, and much of what it would catch is already caught cheaper by the golden suites (WS-3/4) and RTL (WS-8) landing earlier. Sequence member flows before operator flows; add axe/JS-budgets only after the core flows are stable and green.

**Parallelization summary:** Track A (SQL: WS-1→3→4→5→6) and Track B (E2E infra: WS-2→10) run in parallel from day one; Track C (TS unit: WS-7→8→9) joins once WS-1 is merged and can overlap WS-5/6. The two Vite majors (web=5, member=7) mean per-app dev servers stay separate throughout — do not unify.

**One trap to enforce in review (from the E2E strategy):** any member booking spec that asserts "Confirmed" without POSTing the signed Stripe webhook is testing a bug, not a feature — Confirmed state is webhook-authoritative (invariant #5).

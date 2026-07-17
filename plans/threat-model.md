# Kelo — Threat Model (architecture-level, pre-build)

*2026-07-16. STRIDE-flavored pass over the planned architecture
([plan-final.md](plan-final.md) + [plan-ux-final.md](plan-ux-final.md)). Scope: what must be
designed in from phase 0 versus verified at the two review gates (end of phase 0; pre-phase-5
money review). Assets, in order of blast radius: (1) tenant isolation, (2) money movement,
(3) member PII + card references, (4) Glofox/Stripe/Twilio credentials, (5) the trust of the
numbers themselves.*

## Trust boundaries

Browser (operator SPA / member SSR) ↔ Hono API ↔ Postgres(RLS) · webhooks (Stripe/Resend/Twilio)
→ API · workers ↔ Glofox API · workers ↔ Anthropic · shared front-desk devices ↔ operator
sessions · the member's phone ↔ OTP/claiming endpoints.

## Threats and dispositions

### 1. Tenancy (existential for the SaaS future)
- **Cross-tenant read/write via missing or buggy RLS** → membership-based policies + generated
  cross-tenant attack tests on every table (new table w/o policy fails CI) + second tenant seeded
  day 0. *(Built, phase 0.)*
- **RLS bypass via `SECURITY DEFINER` functions and views** — the classic Supabase foot-gun: a
  definer function or view runs as owner and ignores RLS → **rule: every definer function
  re-verifies tenancy explicitly in its body; views are `security_invoker = true`; the attack
  suite calls every RPC cross-tenant.** *(Phase-0 review checklist item.)*
- **RLS bypass via materialized views** — the build plan uses a matview for credit-balance reads,
  and **matviews support neither RLS nor `security_invoker`** → rule: matviews (and any future
  denormalized read model) are `REVOKE`d from client roles, live outside the exposed schema, and
  are readable only through a tenancy-verifying function; **the generated attack suite enumerates
  matviews, not just tables** (the "new table w/o policy fails CI" trigger would otherwise miss
  them). *(Phase-0 checklist.)*
- **Service-role key leakage** (workers/webhooks hold it) → key lives only in Netlify function
  env, never in client bundles (CI greps built artifacts for the key prefix); service-role
  queries still filter tenant explicitly; audit event per use. *(Built.)*
- **Tenant-id spoofing in API params** → tenant always derived server-side from membership,
  never trusted from the request body. *(Convention — enforced by a single tenant-resolution
  middleware; checklist item.)*

### 2. Money
- **Webhook forgery/replay** → Stripe signature verification + `stripe_events` unique-on-event-id
  inbox + idempotent processors. *(Built.)* **Verify the signing secret is per-connected-account
  scoped when Connect lands** — a phase-5 checklist item, easy to miss.
- **Idempotency-key abuse** (same key, different payload → confused replay) → request-hash check
  rejects mismatches. *(Built.)*
- **Refund/comp/write-off abuse by staff** (the most likely real-world money loss) → manager
  step-up above threshold, reason codes, audit events, and a **weekly anomaly line in the digest:
  refunds/comps by actor** — social accountability, not just logging. *(Digest line: add in
  phase 5.)*
- **Race-based double-spend of credits** → ledger debits inside the booking RPC transaction with
  balance check under lock; negative-balance invariant in `verify_money`. *(Built.)*
- **Client-side price tampering** → prices resolve server-side from the catalog; the client sends
  plan/slot ids, never amounts (discounts are server-validated against role + reason). *(Rule —
  checklist item.)*

### 3. Member surface & claiming (the public attack surface, phase 8)
- **Account-claiming takeover** (attacker knows a member's email/phone) → OTP to the *imported*
  contact only, neutral anti-enumeration responses, rate limits, no balance disclosure
  pre-verification, ambiguous matches → audited support workspace. *(Designed in the UX plan.)*
  Residual risk: **recycled phone numbers** — mitigation: claiming reveals nothing but first name
  until a booking exists, and the owner can freeze claiming per person.
- **OTP brute force** → 6 digits, ≤5 attempts, per-contact + per-IP throttles, code TTL ≤10 min.
- **SMS pumping** (bots trigger OTP sends to premium-rate numbers — a real Twilio cost attack) →
  Twilio Verify with geo-permissions locked to the studio's country **[OWNER: US-only?]**,
  per-IP/per-session send caps, and a spend alert on the Twilio account. *(Phase-8 checklist;
  cheap to configure, expensive to discover live.)*
- **IDOR on member endpoints** → member role scopes to the claimed person id server-side; the
  cross-tenant attack suite gets a member-role sibling (cross-*person* attack tests) in phase 8.
- **Booking-hold denial-of-service** (bot holds all slots) → holds require a verified session;
  per-person concurrent-hold cap (2); short TTL. *(Design note for the hold engine.)*

### 4. AI surface
- **Prompt injection via customer-authored data** (a person named "Ignore previous instructions…",
  notes fields, campaign titles) → person-derived strings enter prompts only as JSON values with a
  data-not-instructions system rule; **briefing/draft generation has zero tool access**; output is
  schema-validated and lint-checked; `/ask` can only select from the parameterized catalog — the
  model never writes SQL. *(Designed; phase-2 eval includes an injection fixture day.)*
- **PII exfiltration to the provider** → de-identified drafting by default, zero-retention terms,
  per-tenant toggle, retention matrix governs stored prompts. *(Decided.)*
- **Cost blowout** → per-tenant token budgets + alerts. *(Built.)*

### 4b. Evidence integrity & break-glass (the legal plan rests on these rows)
- **Tampering/repudiation on evidence-class records** (waiver acknowledgments, consent evidence,
  audit events, comms logs) → **append-only at the database level**: `REVOKE UPDATE/DELETE` from
  all app roles on evidence tables; corrections happen only through definer-guarded reversal
  functions that append. A liability defense built on mutable rows is no defense.
- **Break-glass tooling abused or quietly used** → every break-glass invocation (impersonation,
  ledger reversal, import replay) fires a **real-time owner notification**, not just an audit
  row — the forensic trail must be observed, not merely recorded.

### 5. Shared devices & staff
- **Session theft / shoulder access on the counter tablet** → auto-lock, PIN re-entry for money
  actions, actor always visible, person-search clears on timeout, re-auth on sensitive deep
  links, autofill disabled on person fields. *(UX plan; PIN machinery is a build amendment.)*
- **PIN brute force** → 4–6 digit PINs rate-limited (5 tries → full credential re-auth), hashed,
  per-user. *(Amendment spec.)*
- **Departed-staff access** → deactivating a `tenant_users` row kills access at next request
  (membership-based RLS makes this immediate — a deliberate advantage over JWT-claim tenancy);
  offboarding runbook item.
- **Remote owner/manager account takeover** (compromised email inbox → password reset or magic
  link → an account that approves refunds) → **MFA mandatory for owner/manager roles** (revising
  the build plan's "optional MFA" for those two roles; front_desk/trainer stay optional), and
  **step-up PINs are never resettable via the same email channel that grants login** (PIN reset
  requires an authenticated session + MFA re-challenge). *(Build-plan delta, folded.)*

### 6. Credentials & supply chain
- **Glofox/Twilio/Resend/Anthropic keys** → Supabase Vault per tenant, rotation supported,
  `import_paused_auth_failed` health state on auth failure; keys never in the repo (gitleaks in
  CI). *(Built.)*
- **Stripe platform keys** (blast-radius asset #4 — money movement across all connected
  accounts): platform secret + per-account webhook signing secrets live only in Netlify function
  env; **restricted keys** wherever Stripe supports them; documented rotation procedure; CI greps
  built artifacts for `sk_live`/`rk_live` prefixes; Stripe anomaly/Radar alerting is the
  compromise tripwire. *(Phase-5 checklist.)*
- **Publicly addressable worker endpoints** (Netlify Background Functions are HTTP URLs) →
  workers verify an internal shared secret and act solely on queue rows (no request-supplied
  parameters trusted); **phase-0 gate includes an unauthenticated-invocation test.**
- **npm supply chain** → shadcn components are vendored source (no live dependency); lockfile
  pinning + `pnpm audit` in CI; Netlify build env isolated. Dependency-review cadence: monthly,
  and before each money phase.
- **Backup exfiltration** → Supabase PITR + cold archives inherit Supabase encryption; the
  corrupt-DB archive (data-reset step) goes to a private bucket, not a laptop.

### 7. Platform & availability
- **Netlify/Supabase outage** → the external dead-man heartbeat catches total death; check-in
  degrades offline; money actions refuse honestly (designed). RPO/RTO documented with the restore
  drills. No further mitigation warranted at this scale — accepting platform risk *is* the
  low-operational-surface constraint.

## Review gates

**End of phase 0 (checklist):** RLS attack suite green incl. RPCs, views, **and matviews**;
tenant-resolution middleware sole source of tenant id; no service or Stripe key in client bundles;
gitleaks clean; Vault wired; heartbeat proven; **unauthenticated worker-invocation test passes**;
MFA enforced for owner/manager; evidence-class tables verified append-only (UPDATE/DELETE
revoked).
**Pre-phase-5 money review:** webhook signature + per-account scoping; idempotency hash checks;
price-resolution server-side; step-up auth live; refund/comp anomaly digest; `verify_money`
invariants enumerated against this document.
**Pre-phase-8 member review:** OTP throttles + geo-permissions + spend alerts; cross-person attack
suite; hold caps; claiming freeze control.

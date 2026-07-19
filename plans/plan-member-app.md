# Kelo — Member Surface Plan (Wave 8: web + iOS + Android)

Status: **authoritative for wave 8**. Produced by a cross-model process: a three-proposal Fable
design council (ecosystem / member-experience / security-auth priors) with judge synthesis, an
independent Kimi K3 proposal, and a final cross-model reconciliation verified against the repo on
2026-07-19 — including the owner plan change of the same date (plan-final §10: **native iOS +
Android via Expo/React Native are REQUIRED at cutover; the web app ships first; one member
API/auth spine serves all three surfaces**). Subordinate to [plan-final.md](plan-final.md) and
[plan-ux-final.md](plan-ux-final.md); deviations from either land in plan-final §10. Where this
document is concrete (table names, middleware, packages, routes), it is the build spec.

Verification basis (checked against code, not memory): apps/web pins TanStack Router 1.170.18 +
Query 5 + Vite 5 + Tailwind 3.4 · `apps/web/src/styles/tokens.css` is a declared copy of
canonical `docs/design/tokens.css` · RLS helpers `app.current_tenant_ids()` /
`app.has_tenant_role()` (0003) resolve via `tenant_users` membership · `requireAuth` verifies
Supabase tokens by issuer round-trip; `resolveTenant` is the sole source of tenant id
(apps/api/src/middleware) · the only Netlify site carries `api.mts`, `scheduler-tick.mts`,
`worker-run-background.mts` · migrations run through **0037** (wave 5c consumed 0036/0037 —
member migrations take the **next free number at build time**; this document never hard-codes
one) · 0027 ships `publish_sessions` only — **no booking/hold RPCs exist yet** · the
hashed-credential + atomic-consume house pattern is established three times over: 0026 step-up
PINs (scrypt hashes, `record_step_up_attempt` with in-DB attempt counting + lockout, append-only
`step_up_events`), 0028 waiver link tokens (sha256, single-use `consumed_at`, expiring), 0031
gift-card codes (sha256, raw returned exactly once, mirroring 0002 invitation tokens) ·
`packages/comms` owns the messaging policy gate (`policy.ts`: kinds
`transactional | transactional_quiet | marketing`, consent statuses, quiet hours, suppressions)
with Resend + Twilio adapters · root vitest already globs `apps/*/test/**/*.test.ts(x)`.

## 0. Pinned rulings (recap — law, not choices)

1. Separate **small SSR app at `apps/member`** in this pnpm monorepo; the operator app stays a Vite SPA.
2. Served on the **studio's domain**, phone-first, implementing the five-stage §3H booking flow
   (Choose → Identify → Waiver → Review & pay → Confirmed).
3. **Same API contracts** (`/schedule`, `/bookings`, `/billing`) with a member-scoped role —
   person-scoped design, **no second API** (plan-final ~L384).
4. Account claiming = **contact-verified one-time code**; **no unverified guest checkout**;
   claiming handles recycled emails/phones as identity resolution; a phoneless staff-assisted
   desk path exists.
5. **Embedded Stripe elements on-domain** (no hosted redirects) for card entry + self-serve card
   update. In-app payments stay on Stripe card rails — Apple guideline 3.1.3(e) exempts
   physical-world services; **no IAP**.
6. **WCAG 2.2 AA**; returning member books in **≤3 taps**; **no PWA install** in v1 (superseded
   on the "installable" axis by the native apps, not by a PWA); tenant branding via the token
   layer 1→2 remap with zero component rewrites (plan-ux §6/§7).
7. **Waiver** read + typed-name + checkbox in-flow when missing/outdated; self-serve account
   shows bookings, balances w/ expiry, receipts, waiver status, unsubscribe preferences.
8. **Waitlist honesty**: visible position + offer window; offers expire visibly.
9. Netlify is the only host; Supabase the only backend; the single Hono API (`apps/api`) is the
   only server code path; **exactly one scheduler** (invariant 4).
10. Money/booking mutations are **Postgres RPCs with idempotency keys**; **webhooks are the
    confirmation authority**; **no optimistic money/booking UI**.
11. **Owner plan change 2026-07-19**: native iOS + Android member apps (Expo/React Native, one
    codebase) are cutover-gating — app parity with the Glofox member app members use today. Web
    ships first (claiming/no-install path, earns beta metrics during store review); the beta gate
    counts web + apps combined.

Anything below that would touch a ruling is flagged in §13 (owner questions), never decided here.

---

## 1. Decision summary

| Area | Decision | Losing alternatives |
|---|---|---|
| Web framework | TanStack Start (React SSR) on Netlify Functions — **cross-family confirmed** (Fable council and Kimi K3 chose it independently) | Astro islands; Next.js; React Router 7 (kept as escape hatch) |
| Credential layer | **Custom API-minted opaque sessions + OTP through `@kelo/comms`** (re-judged on the full 2-2 record, §3.1) | Supabase Auth email OTP (what it got right is recorded and adopted where portable) |
| Data access | **API-only** via `/api/v1/member/*`; zero member dimension in RLS; **member clients ship zero Supabase material** — cross-family confirmed | Direct PostgREST with member RLS policies |
| Person resolution | `person_claims` (verified-contact ↔ person binding) + `resolveMember` middleware (twin of `resolveTenant`) — claiming-as-identity-resolution cross-family confirmed | JWT custom claims; request-supplied person ids (never) |
| Code sharing | **`packages/member-core` (pure TS) + two thin clients**: `apps/member` (TanStack Start web) and `apps/member-mobile` (Expo) | Universal Expo app with web output (§4.1) |
| Topology | Second Netlify site, base `apps/member`, `/api/*` proxy to the primary site's Hono function — cross-family confirmed | Same-site dual publish; separate API deploy |
| Design system | New `packages/ui`: canonical tokens + Tailwind preset + brands/ + small shared React set — cross-family confirmed | Full component-library extraction; per-app token copies |
| Push | Expo push (APNs/FCM), token registry in Postgres, **sends through the `@kelo/comms` policy gate**, transactional-first | Direct Expo SDK calls from route handlers; marketing push in v1 |
| Testing | vitest (existing harness) + cross-person attack suite + no-Supabase-material artifact greps + Playwright (2 web specs) + Maestro mobile smoke + axe + budgets | Broad E2E surface; manual gate evidence |
| Public scope | `/` = the schedule + Choose stage; all else session-gated; explicit non-goals | Marketing site, CMS, SEO program |

---

## 2. Web framework: TanStack Start

`apps/member` is a TanStack Start app (React 18, Vite, streaming SSR) deployed as Netlify
Functions on the second site. **Cross-family confirmation:** Kimi K3, working independently from
the same repo, reached the identical choice on the identical grounds — one router mental model
(apps/web already runs TanStack Router code-based routes), one toolchain, Netlify-first deploy,
and a thin shell over the Hono API so the framework bet stays cheap to reverse.

**Rejected.** *Next.js*: council-rejected for this repo already (RSC = second React paradigm,
agent-error surface, heavyweight adapter). *Astro*: best performance argument, but a second
framework + hydration model for a flow whose core is all-interactive. *React Router 7*: credible,
zero gain over Start here; it is the **documented fallback**, cheap precisely because of the
thin-server rule.

**Binding disciplines (grafted from the Astro proposal):**
- **Per-route JS budgets in CI**: schedule route ≤30KB gz app JS; Stripe's bundle loads **only**
  on the Review & pay stage; budgets fail the build.
- **Thin-server rule**: Start server functions/loaders do exactly two things — read the member
  session cookie and fetch from the Hono API forwarding it. No business logic, no privileged
  secrets, no DB access, **no Supabase client** in `apps/member` server code. The RR7 escape
  hatch stays a routing-shell rewrite, and the mobile app consumes the same logic from
  `packages/member-core` (§4).
- Fonts self-host in `apps/member` (canonical tokens.css carries a "self-host in production"
  note — the member app is production).

## 3. Auth and data access (the keystone)

### 3.1 The credential-layer adjudication (re-judged on the full 2-2 record)

The record: Fable's ecosystem + security-auth proposals chose **Supabase Auth email OTP**; Fable's
member-experience proposal and **Kimi K3 independently** chose **custom API-minted opaque
sessions**. The original judge synthesis broke the tie for Supabase Auth. Re-judged with Kimi's
cross-family vote and the mobile requirement on the table, the ruling **reverses**:

**RULING — custom API-minted opaque sessions, OTP delivered through `@kelo/comms`.**

Decisive grounds, each verified against this repo:

1. **The comms policy gate is load-bearing.** The threat model deliberately homes
   messaging-abuse, spend, and consent controls in `packages/comms` (verified: `policy.ts` owns
   consent/quiet-hours/suppression; adapters own Twilio geo-lock + spend posture). Supabase
   Auth's own sender bypasses that gate entirely — the exact controls the threat model requires
   would not apply to the highest-volume member message we send. With custom OTP, every code
   rides the same pipeline as every other message. **Policy for OTP (binding):** OTP is
   transactional and time-critical — it uses the consent-exempt `transactional` kind and is
   **exempt from quiet-hours suppression**, but remains subject to suppression lists (hard
   bounces / SMS STOP), per-contact + per-IP send caps, and per-channel spend budgets (the
   SMS-pumping control). Exemption from quiet hours is never exemption from budgets.
2. **Members hold no PostgREST-capable token — by construction, not by policy discipline.** A
   Supabase member JWT is an `authenticated`-role token valid against PostgREST forever; the
   Supabase-Auth design mitigated this with a "fail-closed CI assertion" (membership-based
   policies return zero rows). True today — but it converts every future RLS policy into a
   member-facing decision. An opaque DB token has no PostgREST meaning at all: strictly smaller
   surface than fails-closed. Corollary (Kimi's strongest addition): **the member web and mobile
   apps ship zero Supabase material** — no anon key, no `@supabase/*` imports, no Supabase URL —
   enforced by artifact greps (§7).
3. **No shared session/rate/template policy with staff.** Supabase Auth settings (refresh TTLs,
   OTP rate limits, email templates) are project-wide. Staff (counter tablets, step-up PINs) and
   members (personal phones, 90-day sessions) want opposite postures; one knob serving both is a
   real coupling, permanently.
4. **This is the house pattern, not novel crypto.** Verified three prior shipping instances:
   0026 step-up PINs (hashed credential, in-DB atomic attempt counting + lockout, append-only
   event ledger), 0028 waiver link tokens (sha256 single-use expiring bearer), 0031 gift-card
   codes (sha256, raw-returned-once). The member OTP + session tables are the fourth verse of a
   song this repo already sings, with the same tests.
5. **The staff-email-crossover hazard class disappears.** Members never enter `auth.users`; a
   staff email claiming as a member resolves against `people` rows like any other contact — there
   is no possible session that is simultaneously a member session and a staff-capable JWT.
6. **Mobile tips the balance further.** The Expo app authenticates with a plain bearer token in
   SecureStore against plain fetch — no supabase-js session plumbing, no anon key in the store
   binary, and the exact same `/member/auth` endpoints the web uses.

**What the Supabase-Auth side got right (recorded, and adopted where portable):** zero
hand-rolled credential machinery is a genuine virtue — Supabase would have supplied OTP
generation, hashing, throttling, and resend cooldowns for free, and `requireAuth` reuse would
have made members ride five phases of hardened middleware unchanged. Its anti-enumeration-
by-construction framing (the OTP step does identical work on hit and miss) is adopted verbatim
into our own endpoints, where it is easier to prove byte-for-byte. Its insistence on
`@supabase/ssr`-style httpOnly cookie handling for web SSR is adopted as the cookie contract
below. The cost of rejecting it is real: we own the credential machinery. That cost is priced in
§3.2's mandatory mitigations, every one of which maps to an existing tested pattern in this repo.

**Mandatory mitigations (the custom path carries all of these, non-negotiable):**
- DB-backed **hashed** opaque tokens, ≥256-bit random (`kmb_` + 32 url-safe random bytes;
  sha256 stored, raw never persisted — the 0031 rule).
- **Per-session revocation** (row update, effective immediately — no JWT-expiry wait) plus
  per-person mass revoke.
- **Atomic OTP consume with in-DB attempt counting** (an `app.consume_member_otp` RPC modeled on
  0026's `record_step_up_attempt`: single statement, attempt cap 5, lockout, no TOCTOU window; a
  concurrency test proves parallel verifies consume at most once).
- **Rate limits per contact + per IP** (5 sends/contact/hour, 20/IP/hour — threat-model numbers)
  at the API layer, backed by the challenge table.
- **Timing-neutral, shape-identical responses** on `/auth/start` hit vs miss (asserted by test).
- **Append-only `member_verification_events`** ledger mirroring 0026's `step_up_events`
  (UPDATE/DELETE revoked from app roles).
- **Web:** httpOnly + Secure + SameSite=Lax host-only cookie. **Mobile:** bearer token in
  `expo-secure-store`. **The API accepts both** (cookie or `Authorization: Bearer kmb_…`) on
  every member route.
- Token **rotation on refresh with reuse detection** (a presented pre-rotation hash revokes the
  session family).

### 3.2 Session and token shape

- Opaque token `kmb_<32 url-safe random bytes>`; only sha256 stored in `member_sessions`.
  90-day rolling expiry on activity, 12-month absolute cap, rotation + reuse-revocation as above.
  Long-lived by design — the ≤3-tap returning booking depends on members staying signed in.
- Person identity is resolved **server-side per request** from `person_claims` — never from
  anything the client sends (the "claims go stale, rows don't" philosophy that shaped staff RLS,
  plan-final L165, now applied without any JWT at all).
- Web: the Hono API sets the `kelo_member` cookie (host-only, no `Domain` attr — it must survive
  the Netlify 200-proxy untouched, per Kimi's cookie-through-proxy analysis); Start loaders
  forward it. Mobile: the same endpoints return the token in-body once; the app stores it in
  SecureStore and sends it as a Bearer header. One session table, one middleware, three surfaces.

### 3.3 Claiming = post-verification identity resolution (cross-family confirmed)

`POST /api/v1/member/auth/start { contact }`:
- Always performs identical work and returns a neutral 202 `{ data: { sent: true } }` regardless
  of whether the contact matches an imported person; a code is dispatched (through
  `@kelo/comms`, kind `transactional`, quiet-hours-exempt, budget-capped) **only to the contact
  on file** when one matches, or to the typed contact when none does (new-member signup path —
  verified-contact rule, no guest checkout). Anti-enumeration is by construction; a test asserts
  response-shape and timing neutrality.
- Rate-limited per contact + per IP (§3.1 numbers).
- If the contact belongs to a `tenant_users`-linked staff email: respond neutrally, send a "use
  the staff app" email instead of an OTP. (With no shared identity plane this is now hygiene, not
  a security control — the hazard class is structurally gone.)

`POST /api/v1/member/auth/verify { contact, code }` → atomic consume via
`app.consume_member_otp` → on success, resolve contact→person with the service client (exact
match on canonical `people.email`/phone):
- exactly one unclaimed match → insert `person_claims` (`status='active'`,
  `claimed_via='self_email'`) and mint a session.
- no match → create a native `people` row and claim it (new-member signup).
- ambiguous / recycled / already-actively-claimed / `claim_frozen` → `status='needs_resolution'`,
  routed to the audited staff resolution workspace; the session sees **first-name-only** and its
  held slot; balances never render pre-resolution; a claim over an active claim notifies the
  previously verified contact.
- Every attempt/outcome appends to `member_verification_events` (contact_hash, ip_hash).

`POST /member/auth/refresh` (rotation) · `POST /member/auth/logout` (revoke) ·
`GET /member/me` · `POST /member/auth/step-up { code }` (§3.6).

### 3.4 Middleware and data layer (implementable detail)

Route chain for member routes: **`resolveMember`** (new,
`apps/api/src/middleware/member.ts`) → handlers. `requireAuth`/`resolveTenant` stay untouched for
staff routes; the two chains never mix.

`resolveMember` — the structural twin of `resolveTenant` and the **sole source of person_id**:
1. Reads the `kelo_member` cookie **or** an `Authorization: Bearer kmb_…` header.
2. Service-role select on `member_sessions` by token hash; checks `revoked_at is null and
   expires_at > now()`; slides `last_seen_at`/rolling expiry.
3. Joins the session's active `person_claims` row. 0 rows or needs_resolution → 403 with the
   same neutral shape as unknown (needs_resolution sessions get only the claim-status endpoint).
   Active → set `memberTenantId`, `memberPersonId`, `memberSessionId`, `memberStepUpAt` on
   context.
4. Request-supplied person or tenant ids are **never consulted** on member routes.

Handlers call **`apps/api/src/data-member.ts`** only. Every exported function's first parameter
is `{ tenantId, personId }` (compile-enforced); reads use the service client with explicit
filters; mutations call the existing booking/payment RPCs passing person scope in-body, mirroring
the SECURITY DEFINER re-verify rule (invariant 7), with idempotency keys per invariant 5.

### 3.5 Route surface (same contracts, member mode)

Contracts (Zod shapes in `packages/contracts`) are shared exactly as plan-final L384 requires —
and they are what `packages/member-core`'s typed client is generated over, so web and mobile
cannot drift from the API. The member mode is a scoped route group, not a second API:

| Route | Auth | Serves |
|---|---|---|
| `GET /api/v1/member/schedule` | **anonymous** | Published sessions with real availability, prices/credit costs; zero attendee data; same schedule response contract + freshness envelope. Tenant pinned by `KELO_TENANT_ID` (public UUID) in client env for v1; hostname→tenant mapping is the multi-tenant evolution. |
| `POST /api/v1/member/auth/start`, `/verify`, `/refresh`, `/logout`, `/step-up`, `GET /member/me`, `GET /member/claim/status` | anon / session | §3.3 |
| `GET /api/v1/member/account` (bookings, balances w/ expiry, receipts, waiver status, prefs) | member | reads via data-member.ts |
| `POST /api/v1/member/holds`, `/bookings`, `/bookings/:id/cancel`, `/waitlist` | member | phase-6 RPCs, person scope from context, idempotency keys; **holds require a verified session** (hold-DoS), per-person concurrent-hold cap 2 |
| `POST /api/v1/member/bookings/:id/pay` (PaymentIntent), `/payment-methods` (SetupIntent) | member (+ step-up for card update) | existing 5.4 payment RPCs; webhook is the confirmation authority |
| `POST /api/v1/member/waivers` | member | existing waiver RPCs (0028), typed-name + checkbox artifact |
| `POST /api/v1/member/push-tokens`, `DELETE /member/push-tokens/:id` | member | Expo push token registry (§4.3); registration is idempotent per (person, token) |

### 3.6 Step-up, desk path, and the structural proofs

- **Step-up**: card update, contact change, and dunning deep links require a fresh OTP within
  10 minutes — `requireRecentVerification` middleware reading `member_sessions.step_up_at`, set
  by `POST /member/auth/step-up` through the same atomic-consume RPC, appended to
  `member_verification_events` (the 0026 pattern, member edition). Contact change notifies the
  old contact with a 7-day undo. Identical semantics on web and mobile.
- **Desk path**: phoneless members are booked by staff operator-side (§3H, 0032 desk waiver).
  For account claiming assistance, staff mint a single-use hashed `claim_codes` row (15-min TTL,
  audited with actor); the code attests identity, but a session is only minted once the member
  verifies control of an attached contact via OTP — desk assistance never silently creates an
  account. Owner can freeze claiming per person (`people.claim_frozen`).
- **Structural proofs in CI** (§7): cross-person attack suite on every member route; the
  **no-Supabase-material greps** on both member client artifacts (the successor to the old
  fail-closed PostgREST assertion — with no member JWTs in existence, there is no token to
  assert against; the control moves to "no credential material ships at all").

## 4. The mobile track (owner plan change, woven in)

### 4.1 Architecture ruling: `packages/member-core` + two thin clients

**Ruling: a shared pure-TS core consumed by two thin apps — NOT a universal Expo app.**
Adjudicated against the §3H flow and the pinned rulings:

- The web pinned ruling is **SSR** with per-route JS budgets (schedule ≤30KB gz, streamed first
  paint — the parking-lot phone standard). Expo's web output is a client-rendered React Native
  Web bundle: no streaming SSR, an order of magnitude over the schedule budget, and it would
  silently overturn the pinned TanStack Start ruling. A universal app makes the web surface
  worse to make the mobile surface marginally cheaper — the wrong trade for the surface that
  ships first and earns the beta metrics.
- The §3H flow's risky logic — auth/claiming state, hold lifecycle, booking state machine,
  idempotency-key handling, envelope/staleness interpretation — is **UI-free**. That is exactly
  the layer where web/mobile drift would cause money-adjacent bugs, and exactly the layer a pure
  package can share. The chrome (SSR shell vs native navigation) is where the platforms
  genuinely differ and sharing buys nothing.

**`packages/member-core`** (pure TS — **no DOM, no react-native, no `@supabase/*` imports;
enforced by lint + a dependency-cruiser CI check**):
- Typed API client over `@kelo/contracts` (fetch-based, injectable fetch + base URL + token
  provider), freshness-envelope aware.
- Auth/claiming/session module: start/verify/refresh/step-up flows, rotation handling, a
  `TokenStore` interface (web SSR: no-op — the cookie is server-managed; mobile: SecureStore
  implementation lives in the app, not the package).
- The **five-stage booking state machine** (§3H): Choose → Identify → Waiver → Review & pay →
  Confirmed, hold countdown reconciliation against server `expires_at` (display-only, never
  authoritative), waitlist join/offer states, idempotency-key generation per mutation.
- React hooks layer (`react` is a peer dep; hooks import React only) consumed by both apps.

**`apps/member`** (TanStack Start, §2) and **`apps/member-mobile`** (Expo, TypeScript,
expo-router) are thin renderers over member-core. The mobile app adds only: SecureStore token
store, push registration, deep-link handling, native navigation, and the same embedded Stripe
Payment Element via `@stripe/stripe-react-native` (Stripe rails, no IAP — ruling 5).

### 4.2 Expo delivery pipeline (on the critical path)

- **EAS Build** for iOS + Android; **EAS Submit** to App Store Connect / Play Console. Store
  accounts are **owner gates P8-2** (Apple Developer Program + Google Play Console) — needed at
  W8-4 start, not before; enrollment + review lead time (1–2 weeks buffer) sits on the cutover
  critical path (ruling 11: apps ready at cutover).
- **TestFlight / Play internal track** carries the mobile beta cohort (owner question §13).
- OTA updates (EAS Update) for JS-only fixes post-review; native-module changes require store
  review — member-core's pure-TS discipline keeps most fixes OTA-eligible.
- App icon/splash assets are **owner input P8-1** (the brand seam's mobile face); the apps
  scaffold with the Kelo-neutral default so assets are a config drop, not a rebuild decision.

### 4.3 Push notifications (through the policy gate)

- **Registry:** `member_push_tokens` (tenant_id, person_id, expo_push_token, platform
  `ios|android`, created_at, last_seen_at, revoked_at) — RLS deny-all like the other member
  tables; registered/refreshed via `POST /member/push-tokens` under a member session; ships in
  the W8-4 migration (schema ships with the feature, invariant 9).
- **Send path:** a `push` channel adapter in `packages/comms/src/adapters/expo-push.ts`. Every
  push passes the same `policy.ts` gate as email/SMS: **transactional-first** — booking
  confirmations, booking changes/cancellations, waitlist offers (time-critical → `transactional`
  kind, quiet-hours-exempt like OTP, budget-capped), class reminders
  (`transactional_quiet` — respects quiet hours). **No marketing push in v1** and none ever
  without explicit consent (`ConsentStatus` per channel already models this).
- **Receipts:** Expo push receipts are polled by a new `jobs` kind on the existing tick
  (invariant 4 — no new scheduler); dead tokens are revoked in the registry.
- **Deep links:** notifications and confirmation emails carry universal/app links on the studio
  domain (`https://<member-host>/b/:bookingId`) + the `kelo-member://` scheme; the link opens the
  app when installed, the web app otherwise — one URL, three surfaces. Dunning deep links keep
  their step-up requirement on every surface.

### 4.4 What the mobile apps do NOT do in v1

No offline booking or offline queue (view-cached schedule at most; every mutation is online —
invariant 10 makes offline money UI a contradiction) · no biometric-only auth — biometrics may
re-lock an existing valid session as a convenience, but session establishment always has the OTP
path and biometric failure falls back to OTP · no push-marketing (transactional-first; marketing
push requires explicit consent machinery that is deliberately out of scope) · no IAP (ruling 5)
· no tablet/iPad layouts (phone-first, letterboxed is fine) · no widgets, watch apps, or Live
Activities · no in-app account deletion beyond the existing data-rights flow (0025) surfaced as
a link.

### 4.9 The owner/staff mobile app — a SEPARATE app, post-cutover (owner ruling 2026-07-19)

Owner decision (in chat, after reviewing the Glofox two-app precedent): Kelo follows the industry
two-app pattern. **Owner/staff functionality NEVER ships inside the member binary** — the member
apps carry zero staff capability (preserving §3's isolation: no staff code paths, no PostgREST-
capable credential, white-label-ready). A thin **"Kelo Pro" staff companion** (today's briefing,
focus queue, push alerts, roster check-in) ships **post-cutover** as its own Expo app reusing the
same packages/member-core-style seams, EAS pipeline, and push infrastructure — it is explicitly
NOT cutover-gating (operators run on the web app, which works in a phone browser). Dual-role
people (an owner who is also a member) install both apps, per the industry norm.

## 5. Repo and deploy topology

- `apps/member`, `apps/member-mobile`, `packages/member-core`, `packages/ui` join the pnpm
  workspace (existing globs match). Root vitest gains the new aliases only.
- **Second Netlify site**, same repo, base directory `apps/member`, its own
  `apps/member/netlify.toml` (per-site config is a Netlify monorepo standard — Kimi):
  build `pnpm -w build --filter @kelo/member...`, publish = the Start output dir, functions dir
  for the SSR handler only, and the redirect
  `/api/* → https://<primary-site>/.netlify/functions/api/:splat` (status 200). The studio's
  domain fronts this site; the operator site is untouched. One Hono deployment serves
  everything; no CORS exists; Stripe Elements stay on-domain. Cookie-through-proxy works because
  the session cookie is **host-only** (no `Domain` attribute — §3.2); this is verified by e2e on
  a deploy preview **before any member is invited** (Kimi), with a CORS-allowlisted
  direct-origin fallback documented in the runbook, not built.
- `apps/member-mobile` does not deploy to Netlify at all — EAS is its pipeline (§4.2). It talks
  to the API by direct origin (`KELO_API_ORIGIN`) with Bearer auth; no proxy, no cookies, still
  no CORS (native fetch).
- **Env split (member web site)**: `KELO_API_ORIGIN`, `KELO_TENANT_ID`,
  `STRIPE_PUBLISHABLE_KEY`, `SENTRY_DSN`. **Mobile app config (app.config.ts / EAS env)**: the
  same four. **Zero Supabase values anywhere in either client — no anon key, no URL** (Kimi;
  §3.1 ground 2). No service-role key, no Stripe secret, no Glofox credentials, no DB URL — ever.
- **One-scheduler invariant, by machine**: the member site ships zero scheduled/background
  functions. CI fails if `schedule` appears in `apps/member/netlify.toml` or any
  scheduled-function import appears under `apps/member/`; the built-artifact secret grep extends
  to the member web bundle **and the EAS build output**. All new recurring work (OTP purge,
  session purge, push-receipt polling) is `jobs` kinds on the existing tick.
- **Previews**: standard PR deploy previews on site 2, deploy-context env pointing at the
  staging tenant + Supabase preview branch (migration PRs keep working exactly as today). Mobile
  previews are Expo dev builds against staging.

## 6. Design-system packaging

One new package, **`packages/ui`** (cross-family confirmed as the seam; Kimi's split into
design-tokens + ui collapses into one package with subpaths — fewer workspace units, same
boundaries):

1. **`tokens/`** — the canonical `tokens.css` **moves here from `docs/design/tokens.css`**;
   `apps/web/src/styles/tokens.css` (verified: a declared hand-copy) becomes an import, killing
   the copy-drift. Byte-identical move; zero visual change; `docs/design` keeps generator
   inputs. A `tokens.json` export feeds the mobile theme (§ below).
2. **`tailwind-preset`** — maps semantic CSS variables into the Tailwind theme; consumed by both
   web apps' `tailwind.config`. Raw hex / arbitrary values stay lint-blocked (plan-ux §5).
3. **`brands/`** — the layer-1→2 remap seam: `default.css` now, `the-sauna-guys.css` later
   (P8-1). Each file is a **validated token subset** (logo tokens, action color, surfaces, type —
   never arbitrary tenant CSS), validated in CI against `validateTenantBrandTokens` (Zod, in
   `packages/contracts`) plus the AA/CVD contrast check. The member web app's root SSR layout
   selects the brand stylesheet; **the mobile apps consume the same validated subset via
   `tokens.json`** (a generated TS theme object — same source, no drift); primitives remap →
   semantics resolve → zero component rewrites on any surface. The later multi-tenant evolution
   reads the same subset from `tenants.settings` — a data-source swap, not a redesign.
4. **`react/`** — deliberately small, only surface-neutral, contract-bearing pieces (each with
   tests): `DataBoundary` (the provenance contract governs member screens identically —
   invariant 3; the member variant renders staleness as quiet copy, not operator chips),
   `FreshnessChip`, `StatusPill`, `EmptyState`/`ErrorPanel`/`Skeleton`, `StepWizard`,
   `WaiverCapture` (typed-name + checkbox — the sole waiver artifact everywhere), `AsyncButton`,
   and `OtpField` (new; accessible per plan-ux §6 — paste/autofill-friendly; written reason:
   required by §3H Identify and step-up on all surfaces). These are **react-dom components** —
   the mobile app renders its own native equivalents over the same member-core state; only the
   *state* is shared with mobile, by design (§4.1).

Everything else member-facing — SlotPicker, HoldTimer, WaitlistPanel, TenderReview, the stage
shell, Confirmed page — is built **phone-first inside each member app**, driven by member-core's
state machine. The operator versions are desk/tablet-density; forcing reuse would double QA
surface for zero real sharing.

## 7. Testing and gate evidence

- **Unit**: `apps/member/test/**` and `packages/member-core/test/**` — matched by existing
  vitest globs; member-core carries the highest-value tests (booking state machine, auth flows,
  idempotency-key discipline, envelope handling) **once, for all three surfaces**; component
  tests use the repo's jsdom-docblock pattern; SSR loaders are plain functions tested by mocking
  the member-core client.
- **API**: `/member/*` routes get the existing in-memory Hono + fakes.ts pattern
  (member-auth, member-claiming, member-booking, member-push specs), plus:
  - **Generated cross-PERSON attack suite**: member A's session against member B's bookings /
    balances / receipts / waivers / push tokens on every member route must 404-neutral —
    generated from the route table like the existing cross-tenant suite (new dimension, same
    generator).
  - **Credential-machinery proofs**: atomic-consume concurrency test (parallel verifies of one
    OTP consume at most once — the 0026-pattern test); rotation reuse-revocation; throttle
    trips; revocation immediacy; timing/response-shape neutrality on `/auth/start`;
    `claim_frozen`; recycled-email-over-active-claim → needs_resolution; staff-email crossover
    behavior.
  - **No-Supabase-material artifact greps**: the member web bundle and the EAS-built JS bundles
    contain no Supabase URL, no anon key, no `@supabase/` specifier (the structural successor to
    the retired fail-closed PostgREST assertion — see §3.6); dependency-cruiser forbids
    `@supabase/*` and react-native/react-dom imports in `packages/member-core`.
- **SQL suite**: all new member tables enter the generated cross-tenant attack suite; deny-all
  assertions for `anon`/`authenticated` on every member table; append-only enforcement on
  `member_verification_events`.
- **E2E (web)**: Playwright, scoped to `apps/member/e2e`, exactly two specs:
  1. **Claiming** — email OTP end-to-end against local stack (Mailpit captures the code; staging
     uses a test-inbox hook), including neutral-response assertions.
  2. **The five-stage booking flow** — hold countdown, in-flow waiver, Stripe test-mode Payment
     Element, simulated signed webhook closing the loop, durable Confirmed page surviving reload.
- **E2E (mobile)**: one **Maestro smoke flow** per platform on EAS builds (launch → OTP sign-in
  via test inbox → book with Stripe test card → webhook-confirmed state visible → push token
  registered). Deliberately thin: member-core owns the logic coverage; Maestro proves the native
  shell. Runs on EAS build completion, not per-PR.
- **Member-beta gate evidence (the release rule, invariant 1)**: archived Playwright traces +
  video + Maestro recordings; `@axe-core/playwright` green on every stage (WCAG 2.2 AA); the
  ≤3-tap returning-member bar as a literal tap-count assertion; per-route JS budgets green
  (schedule ≤30KB gz; Stripe confined to pay); Sentry RUM by funnel step live before beta with
  p95 <1s/step numbers; **beta channel attribution from `bookings.booked_via`**
  (`desk|member_web|member_ios|member_android|import` — Kimi; rides the phase-6 booking surface,
  §10) rendered continuously on the readiness dashboard (web + apps combined per ruling 11); the
  pre-phase-8 threat-model checklist executed with captured evidence.

## 8. Public scope v1

**Public (no session, indexable)**: `/` — a minimal landing that **is** the SSR schedule (studio
mark, address, hours, real availability, honest prices/credit costs) — and the Choose stage.
Booking **holds require a verified session** (hold-DoS). `robots.txt` indexes `/` only;
everything under `/book` and `/account` is `noindex`. App Store / Play Store listing pages link
here and vice versa (smart-app-banner meta on `/`).

**Session-gated**: Identify onward; the account area (bookings, balances w/ expiry, receipts,
waiver status, unsubscribe preferences, card update).

**Explicit NON-goals for v1**: marketing/brochure pages · blog/CMS/SEO program (basic meta +
LocalBusiness schema on the one page only) · plan/membership sales pages (desk-only; drop-in
purchase is in per §3H) · gift-card or retail purchase · instructor bios/reviews/social ·
sitemap machinery · PWA manifest/install (pinned; the native apps are the installable surface) ·
dark-mode pass (token-ready only) · multi-location · i18n — plus the mobile non-goals of §4.4.
~250 locals arrive by link, word of mouth, and the store listings; every deferred surface is
maintenance avoided.

## 9. Wave-8 build order (five units, each independently gateable)

**W8-1 — Foundations + ui.** `packages/ui` extraction (canonical tokens move + preset +
`tokens.json` + shared primitives with tests; apps/web switched to imports, byte-identical);
`apps/member` TanStack Start scaffold on Netlify site 2 with the `/api/*` proxy;
`packages/member-core` scaffold (client + envelope handling, no auth yet); public SSR schedule
page consuming the schedule contract through DataBoundary + envelope; Playwright + axe harness
bootstrapped; CI guards live (no-Supabase/secret greps on the member artifact, zero-scheduler
grep, JS budgets, member-core import bans).
*Gate: public schedule deployed on site 2; both apps green in `pnpm -w test`; guards proven.*

**W8-2 — Identity spine.** Member-identity migration (**next free number at build time**, §10);
`/member/auth/*` (OTP through `@kelo/comms`, atomic consume, rotation, step-up) + claiming with
anti-enumeration + timing test; `resolveMember` + `data-member.ts`; member-core auth/claiming
module (the same code the mobile app will use); needs_resolution routing into the operator
resolution workspace + desk claim-code screen; read-only account area; cross-person +
credential-machinery suites green.
*Gate: real member claims and sees their account on staging via web; attack suites green.*
*Exit check (hard): the phase-6 booking/hold RPC contract exists — else W8-3 is re-sliced
explicitly to absorb it (verified today: 0027 has `publish_sessions` only).*

**W8-3 — The web booking flow.** The §3H state machine lands in member-core; Choose → Identify
(claim-in-flow) → Waiver (typed-name + checkbox, guardian path) → Review & pay (credits-first,
embedded Payment Element via existing payment RPCs + idempotency keys, webhook-confirmed, zero
optimistic UI) → Confirmed (durable, survives refresh/back); member hold with visible countdown;
waitlist join with honest position + offer window.
*Gate: five-stage Playwright spec green end-to-end incl. webhook confirmation.*

**W8-4 — The mobile apps.** `apps/member-mobile` Expo scaffold consuming member-core
(SecureStore token store, native navigation, `@stripe/stripe-react-native` Payment Element);
booking-flow + account parity with web; push migration (`member_push_tokens`, next free number)
+ `expo-push` comms adapter + receipt-polling job kind + deep links; EAS Build + Submit
configured; Maestro smoke green on both platforms; TestFlight / Play internal track live with
the mobile beta cohort. **Store submission starts here — review time overlaps W8-5.**
*Gate: a booking made end-to-end on physical iOS and Android devices from internal-track builds,
webhook-confirmed; push confirmation received; submissions in review. Owner gates P8-2 (store
accounts) and P8-1 (icon/splash) land at this unit's start.*

**W8-5 — Money self-serve + beta evidence.** Embedded card update (SetupIntent) + dunning deep
link behind step-up wired to the dunning queue ("card updated ✓, next retry …") on web and
mobile; cancel/reschedule per policy-shown-at-booking; waitlist offer accept with visible expiry
and pass-along (push + email offer delivery through comms); RUM by funnel step; brand seam
proven with a test skin (web CSS + mobile tokens.json); threat-model checklist executed.
*Gate: the full member-beta evidence bundle (§7) archived — web + apps combined channels — this
is the plan-final "member beta strictly before cutover" gate input, and store approval is the
cutover-gating output tracked from W8-4's submissions.*

## 10. Migration surface

Numbers are assigned at build time (**next free** — wave 5c consumed 0036/0037; this document
deliberately names no numbers). All new tables: RLS enabled, deny-all for
`anon`/`authenticated` (the API is the only path; a member self-SELECT policy is deliberately
absent), staff SELECT on claim tables via `app.has_tenant_role` for the resolution workspace;
every table enters the generated cross-tenant **and** cross-person attack suites (invariant 7).
**No policy changes to any existing table. No `auth.users` links. No new roles, no new
schedulers.**

**W8-2 — member identity migration:**
- `person_claims` — tenant_id, person_id (composite-FK via the `(tenant_id, id)` unique-index
  pattern from 0026), `verified_contact citext`, `channel ∈ email|sms`,
  `status ∈ active|needs_resolution|frozen|revoked`,
  `claimed_via ∈ self_email|self_sms|desk_assisted`, `desk_actor_tenant_user_id`, timestamps;
  partial uniques: one **active** claim per person and per `(tenant_id, verified_contact)`.
- `member_otp_challenges` — tenant_id, `contact_hash`, `channel`, `code_hash` (sha256; raw never
  persisted), `expires_at` (10 min), `attempts int`, `consumed_at`, `ip_hash`; plus
  **`app.consume_member_otp(...)`** — SECURITY DEFINER, in-body tenant re-verify, single-statement
  attempt increment + cap-5 lockout + consume (the 0026 `record_step_up_attempt` shape).
- `member_sessions` — id, tenant_id, person_id, `token_hash unique` (sha256 of `kmb_…`),
  created_at, last_seen_at, `expires_at` (rolling 90d), `absolute_expires_at` (12mo),
  `revoked_at`, `rotated_from uuid` (reuse detection), `step_up_at`, `device_label`,
  `platform ∈ web|ios|android`.
- `claim_codes` — tenant_id, person_id, `code_hash`, `created_by`, `expires_at` (15 min),
  `used_at`; single-use, append-only (desk path).
- `member_verification_events` — append-only audit mirroring `step_up_events` (0026):
  `kind ∈ otp_sent|otp_verified|otp_failed|claim_attempt|claim_conflict|claim_resolved|step_up|contact_changed|card_updated|session_revoked`,
  `contact_hash`, `ip_hash`; UPDATE/DELETE revoked from all app roles.
- `people.claim_frozen boolean not null default false`.
- New `jobs` kinds: `member_otp_purge`, `member_session_purge` (existing tick).

**W8-4 — member push migration:** `member_push_tokens` (§4.3) + `jobs` kind
`expo_push_receipt_poll`. Ships with the feature that writes it (invariant 9), not before.

**Contingent (rides phase 6, invariant 9)**: `holder_person_id` on booking holds; waitlist
`position` / `offer_expires_at`; an acting-principal parameter on book/cancel RPCs so audit
distinguishes member-self from staff-on-behalf; **`bookings.booked_via ∈
desk|member_web|member_ios|member_android|import`** (Kimi — the beta-gate attribution column).
W8-3 extends what phase 6 ships rather than pre-building.

## 11. Risks and mitigations

1. **Phase-6 RPC dependency** (verified real): hard existence check at the W8-2 exit gate;
   explicit re-slice if absent — never discovered mid-W8-3.
2. **Owning credential machinery** (the price of the §3.1 ruling): every mechanism is a copy of
   a shipped, tested house pattern (0026/0028/0031); the §3.1 mitigation list is
   compile/test-enforced, not aspirational; the credential-machinery test suite (§7) is the
   regression net; the append-only ledger is the forensic net.
3. **Store review timing** (new, cutover-gating): submissions start at W8-4 with a 1–2 week
   review buffer; owner accounts (P8-2) requested at W8-4 start with Apple D-U-N-S lead time
   flagged; EAS Update covers post-approval JS fixes; the web app is the designed fallback for
   any member while review drags (ruling 11 makes web the first-ship surface for exactly this
   reason).
4. **TanStack Start maturity**: thin-server rule, pinned versions, RR7 escape hatch confined to
   the routing shell; member-core keeps the logic portable by construction.
5. **Expo/RN churn**: pin the Expo SDK for the wave; member-core is pure TS (unaffected);
   native-module surface deliberately tiny (SecureStore, Stripe RN, notifications, router).
6. **Staff-email crossover**: structurally eliminated by the disjoint identity plane (§3.1
   ground 5); the neutral "use the staff app" email remains as hygiene.
7. **Recycled/shared contacts**: first-name-only pre-resolution; claims over active claims →
   needs_resolution + notification to the prior contact; per-person freeze; 7-day contact-change
   undo; balances never pre-resolution.
8. **Service-role in data-member.ts**: structurally mitigated — signatures require
   `(tenantId, personId)`, routes only registerable behind `resolveMember`, cross-person suite
   as the regression net.
9. **OTP deliverability / SMS pumping**: email-first via Resend through comms;
   resend-with-cooldown UI; desk path as designed fallback; SMS later via Twilio with US
   geo-lock + spend alerts; OTP quiet-hours exemption never exempts budgets (§3.1).
10. **Claim enumeration/abuse**: uniform OTP step, post-verification matching, neutral +
    timing-tested responses, append-only audit with attempt-spike alert rule; session-gated
    holds with a per-person cap.
11. **Push abuse/misfires**: all sends through the comms policy gate; transactional-first; dead
    tokens revoked via receipt polling; deep links re-verify session (and step-up where
    required) on open.
12. **Stripe JS weight (web)**: pay-stage-only loading, enforced by CI budgets.
13. **packages/ui extraction risk**: byte-identical token move, only tested components
    extracted, `pnpm -w test` runs both web apps on every ui change.
14. **Second-site drift / proxy edge cases**: both netlify.toml files checked in; proxy origin a
    single env var; member-domain health monitoring; host-only cookie verified through the proxy
    on a deploy preview before beta; CI asserts zero schedulers + zero secrets/Supabase material
    in member artifacts.

## 12. Dissents and the adjudication record (recorded honestly)

- **Supabase Auth OTP (Fable ecosystem + security-auth) lost the credential ruling 2-2 →
  reversed on re-judgment** (§3.1). The final synthesis had initially ruled for it; the
  cross-family record (Kimi independently choosing custom sessions), the verified comms-gate
  argument, the mobile bearer requirement, and the shared-project-policy coupling reversed it.
  What it got right is recorded in §3.1 and adopted where portable: anti-enumeration-by-
  construction, httpOnly SSR cookie handling, and the honest warning that hand-rolled credential
  machinery is where teams bleed — answered here by pattern-reuse plus a dedicated test suite,
  not by confidence. The director's adjudication guidance was stress-tested, not rubber-stamped:
  each of its five grounds was verified against code (§3.1) and all five held; no ground was
  found wrong.
- **Universal Expo app** (considered for the mobile track) lost to member-core + two thin
  clients: it would overturn the pinned SSR ruling and the per-route JS budgets for the
  first-ship surface (§4.1).
- **Astro (member-experience prior)** lost the framework decision despite the best performance
  argument. Its budgets, Stripe-only-on-pay, and timing-neutrality test are adopted as binding.
- **Brand-as-data at SSR (security-auth)** is the right multi-tenant end state but lost for v1
  to a checked-in, schema-validated `brands/*.css` + generated `tokens.json` — fewer moving
  parts for a single-tenant beta; the contracts schema makes the settings-driven path a later
  data-source swap.
- **Kimi's separate `packages/design-tokens`** collapsed into `packages/ui` subpaths (one
  workspace unit, same boundaries); its `tenant_domains` host→tenant table is deferred in favor
  of the pinned-env `KELO_TENANT_ID` for the single-tenant v1 (the table is the documented
  multi-tenant evolution). Its zero-Supabase-keys rule, `booked_via` attribution column,
  host-only-cookie proxy analysis, and per-site netlify.toml detail are adopted with
  attribution.
- **Token canonicality**: the ecosystem proposal misidentified `apps/web`'s tokens.css as the
  source; verification shows it is a declared copy of `docs/design/tokens.css`, which governs.

## 13. Owner questions (genuinely the owner's — flagged, not decided)

1. **Member hostname + DNS**: which host on the studio's domain (recommend
   `book.<studio-domain>`)? Do we have DNS access, and does this interact with the unpurchased
   P0-9 kelo domains? (Universal/app links require serving `apple-app-site-association` /
   `assetlinks.json` from this host — decided technically once the host is named.)
2. **Apple Developer Program + Google Play Console accounts (P8-2)**: enroll now — Apple
   enrollment (and D-U-N-S if enrolling as an organization) has multi-day lead time and sits on
   the cutover-critical path. Whose legal entity owns the store listings, Kelo's or the
   studio's? (Affects listing name, support URL, and privacy-policy URL.)
3. **App identity assets (P8-1)**: app icon, splash, store listing name/screenshots/description.
   The seam ships Kelo-neutral either way; should W8-5's test skin use real studio assets if
   available?
4. **Push notification stance + copy**: confirm transactional-only push for v1 (confirmations,
   changes, waitlist offers, reminders) and approve the notification copy set; marketing push
   stays off until an explicit consent surface exists. Reminder timing default (e.g. 2h before
   class) — confirm or adjust.
5. **TestFlight / Play internal beta cohort**: which members test the apps (suggest a subset of
   the ~22 recurring members already in the web beta), and does the cutover comms calendar
   mention the apps ("download before Glofox retires")?
6. **OTP/transactional sender domain**: studio domain (needs SPF/DKIM on their DNS) or a kelo
   domain? Deliverability and member trust hinge on it.
7. **Email-only claiming at launch** (SMS is 10DLC-gated): acceptable, given some of the ~272
   contacts may be phone-only (we can query the count)? Is "claim at the desk" acceptable for
   them until SMS lands? Also confirm **US-only geo-permissions** for future SMS OTP now.
8. **Policy text**: cancellation/reschedule wording + windows and the waitlist offer-window
   duration — needed before the W8-3 copy freeze (the flow shows the policy accepted at
   booking).
9. **Dual-role staff-members**: is "staff email → redirected to the staff app" acceptable in v1,
   or is true dual-surface access wanted?
10. **Claiming rollout**: all ~272 at once or staged cohorts (recurring members first)?
    Interacts with the cutover comms calendar and the app-download comms.
11. **Purchase scope confirmation**: drop-in single-session purchase is in per §3H — confirm
    pricing/tax display expectations, and confirm pack/membership **sales** stay desk-only in v1
    (on web AND in the apps — no IAP either way).
12. **Stripe dashboard toggles** (Kimi): enable Apple Pay / Google Pay for the Payment Element —
    the domain-verification + wallet toggles sit on the owner-controlled Stripe account; wallet
    support materially helps the ≤3-tap bar on phones.

---

*Changelog: adopting this document adds a wave-8 entry to plan-final §10 (member surface: web +
mobile architecture, custom-session auth ruling, second-site topology, packages/ui +
packages/member-core, push-through-comms). The credential-layer ruling herein supersedes the
draft council synthesis's Supabase-Auth ruling — recorded in §12 with the full 2-2 record. No
pinned ruling is deviated from; the 2026-07-19 owner plan change (ruling 11) is implemented, not
deviated from.*

---

## 14. Cross-model review amendments (Kimi K3 review pass, 2026-07-19 — folded by the director)

The Kimi review (its second seat: reviewer of the reconciled draft) surfaced five material findings;
each is RULED here and amends the section it names.

**14.1 React 19 (amends §2 — implementability, confirmed against the repo).** TanStack Start
requires React 19; `apps/web` is pinned to React 18.3.1. Ruling: `apps/member` pins **React 19**
(pnpm workspaces isolate per-app React majors cleanly); every `packages/ui` react/ component must be
18/19-compatible (they are plain function components — CI runs both apps' suites on any ui change,
which proves it); `apps/web` upgrades to 19 opportunistically, never as a member-app prerequisite.
If Start-on-19 destabilizes, the React Router 7 escape hatch (§2) already covers it.

**14.2 The desk path must be able to ATTACH a contact (amends §3.6 — closes a circularity).** As
drafted, a staff-minted claim code still required OTP to an *existing* contact — a phone-only-at-
launch or contact-less member could never claim (contradicting pinned ruling §0.4). Ruling: the desk
flow lets staff **attach a new contact** — the member states an email at the desk, the OTP goes to
it in-session, and on verify the claim binds that contact to the staff-selected person (the claim
code selects WHO; the OTP still proves contact control — desk assistance never silently mints a
session). A member with NO reachable contact at all cannot hold a self-serve session — explicitly a
non-goal; desk booking continues operator-side for them.

**14.3 Rotation grace window (amends §3.1 sessions — prevents spurious logouts).** Refresh-token
rotation with instant reuse-revocation false-positives under concurrent requests (parallel SSR
loaders, multiple tabs, mobile refresh races). Ruling: a pre-rotation token presented within a
**60-second grace window** of its rotation is honored once more WITHOUT family revocation; reuse
OUTSIDE the window revokes the family as designed. A concurrent-refresh test joins the credential-
machinery suite (§7).

**14.4 In-app account deletion (amends §4 mobile v1 scope — an App Store gate).** Apple guideline
5.1.1(v) REQUIRES apps supporting account creation to offer account deletion IN the app; a bare web
link risks rejection. Ruling: the mobile apps ship an in-app deletion-request flow that submits
through the existing data-rights path (migration 0025 `pseudonymize_person`), with the plan's
retention disclosures. Added to the mobile v1 scope, the store-submission checklist, and the owner
questions (the deletion-confirmation copy).

**14.5 Canonical phone in claiming (amends §3.3).** `person_claims.verified_contact` phone matching
uses **`people.phone_e164`** via the existing `toE164US`/`to_e164_us` canonicalizer (migrations
0023/0029) — never raw-string comparison against imported Glofox phone data. Email matching stays
citext-exact.

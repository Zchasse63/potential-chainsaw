# Kelo — Legal Readiness Plan

*2026-07-16, updated 2026-07-17. This plans the legal work; it does not perform it — every
drafted artifact below needs a licensed attorney's review before use. Items marked **[OWNER]**
are inputs only the owner can supply; **[LAWYER]** marks the attorney's scope. Deadlines are
keyed to build-plan phases. **Jurisdiction confirmed: Tampa, Florida** — all state-law items
(waiver enforceability, health-studio act §501.012+ applicability, auto-renewal rules,
gift-card/credit expiry under Fla. Stat. §501.95, sales tax, breach notification §501.171)
resolve against Florida law.*

## Artifact inventory, by deadline

| # | Artifact | Needed by | Who | Status |
|---|---|---|---|---|
| 1 | **Trademark clearance + filing — "Kelo"**, Classes 9 & 42 (software/SaaS), and **domain purchase** (`getkelo.com` / `kelo.studio`) | ASAP — before any public surface carries the name; the original brief itself flags this as required | [LAWYER] search + file; **[OWNER]** buy domains now (cheap insurance, no legal gate) | Open |
| 2 | **Privacy policy** (member-facing) | Phase 3 — before the first real outreach send | [LAWYER] from Kelo's disclosure requirements below | Open |
| 3 | **Liability waiver template** | Phase 4 — the waiver engine ships it | **[OWNER] — handled: the studio already has a waiver.** The engine digitizes the existing document (versioned, typed-name + checkbox). Optional-but-cheap when counsel is engaged anyway: confirm the existing text supports digital execution in Florida | Owner-handled |
| 4 | **Member terms of service — money terms** (booking, cancellation windows, no-show fees, subscription auto-renewal, credit packs, gift cards) | **Phase 5 — before the first live Kelo charge** (Kelo bills members from phase 5; no-show fees fire in phase 6; the original phase-8 keying was 2–3 phases too late) | [LAWYER] | Open — **critical path** |
| 4b | **Member ToS — surface terms** (account creation, claiming, acceptable use) | Phase 8 with the member app | [LAWYER] addendum | Open |
| 4c | **State health-studio / health-spa act + automatic-renewal law (ARL) applicability** | **Before phase-5 design freeze** — these statutes constrain cancellation *mechanics* and prepaid handling, not just document text (e.g., click-to-cancel, renewal notices) | [LAWYER]; **[OWNER]** studio state | Open — **can change the build** |
| 4d | **Gift-card / stored-value compliance** (CARD Act expiration/fee rules, state expiration bans, escheatment posture) + legality of pack-credit expiry in the studio's state | Phase 5 (gift-card sales ship then; credit expiry policy affects phase 1 import labeling) | [LAWYER]; **[OWNER]** state | Open |
| 4e | **Sales-tax posture** — registration status, taxability of recovery sessions vs retail goods vs gift cards, rate sourcing for the phase-5 tax configuration | Phase 5 | **[OWNER]** confirms current practice with their accountant; [LAWYER/CPA] confirms taxability | Open |
| 5 | **SMS/email marketing compliance posture** (TCPA / CAN-SPAM / A2P 10DLC truthfulness) | Phase 3 | Mostly engineering (already planned: consent evidence, STOP, unsubscribe, quiet hours); [LAWYER] sanity pass on consent language | Partially covered by build |
| 6 | **Data-handling addendum for the AI provider** (Anthropic zero-data-retention terms) | Phase 2 — before customer-derived data flows at volume | **[OWNER]** signs; already a build-plan decision | Open |
| 7 | **SaaS terms + DPA for future tenants** | Tenant #2, not v1 | [LAWYER] later | Deferred, on record |
| 8 | **Insurance check** — confirm the studio's liability policy covers digitally-executed waivers and that the carrier has no waiver-wording requirements | Phase 4 | **[OWNER]** one call to the broker | Open |
| 9 | **Glofox agreement review** — API/data-extraction rights (hourly pulls over a multi-month coexistence), write permission, termination exposure, data-portability obligations (incl. Stripe PAN portability cooperation) | Phase 0 — it gates the write-capability discovery and the Stripe contingency | [LAWYER] light-touch; **[OWNER]** locate the contract | Open |
| 10 | **Breach-notification runbook** — the state's trigger/timing rules + a contact tree (the system holds PII, DOB, and minors' guardian data; notification duties exist in all 50 states) | Phase 3, alongside the retention matrix | [LAWYER] confirms rules; **[OWNER]** owns the contact tree | Open |

## Waiver template — requirements Kelo hands the lawyer

The engine (built in phase 4) supports: versioned templates; typed-name + checkbox acknowledgment
(no drawn signature); timestamp + IP + version evidence; per-session enforcement; re-sign on
version change; guardian identity + acknowledgment for minors; pre-arrival signing links. The
**content** must come from counsel, informed by: **[OWNER]** studio's state/jurisdiction (governs
waiver enforceability language), minimum-age policy per offering, whether guardians must remain
on premises, and any heat/cold-exposure acknowledgment wording the insurer requires. Hard product
constraint the lawyer must respect: **no medical questions, no free-text health fields** — the
waiver is a legal acknowledgment, not an intake form. Retention: signed acknowledgments are
retained per the retention matrix (financial/liability evidence class — effectively indefinite;
[LAWYER] confirms the statute-of-limitations horizon for the jurisdiction).

## Privacy policy — the disclosures Kelo's design already commits to

Counsel drafts; Kelo's build supplies these facts: what's collected (contact, booking/payment
history, DOB for age policy — explicitly no health data); processors used (Supabase, Stripe,
Resend, Twilio, Anthropic, Netlify, Sentry); **the AI disclosure** — customer data is processed
by an AI provider under zero-retention terms, outreach drafting is de-identified by default;
member rights — deletion/pseudonymization and export are *built features* (phase 3), so the
policy can promise them concretely; cookie/analytics posture (first-party RUM only, PII-redacted);
contact for requests. **[OWNER]**: studio legal entity name + state, and whether any members are
EU residents (drives whether GDPR language is needed; otherwise the studio's state privacy law
governs — [LAWYER] determines applicability).

## Marketing compliance — engineering posture (already in the build plan) + open items

Built: consent capture with evidence, per-channel; suppression checked at send time; STOP/unsub
honored immediately and non-overridable; quiet hours; A2P 10DLC registration (phase 0);
campaign-recipient logging. [LAWYER] reviews: the consent-collection wording at signup/booking,
whether imported Glofox contacts carry usable marketing consent (**consent provenance for
imported people is the one real legal question in the import** — default posture: imported
contacts get *transactional* messages only until they re-confirm marketing consent via a
first-touch reconfirmation campaign; **[OWNER]** may know what Glofox's signup flow promised).

## Retention matrix v1 (draft values — counsel reviews contents, not just the concept)

The phase-3 gate executes a person deletion "per the matrix," so the matrix needs values now:

| Data class | Retention | On person deletion |
|---|---|---|
| Waiver acknowledgments | Indefinite pending [LAWYER] statute-of-limitations horizon | Retained (liability evidence); person pseudonymized, waiver row keeps legal name |
| Payments / orders / ledgers / Stripe events | 7 years **[LAWYER confirm]** | Retained (financial records); pseudonymized linkage |
| Consent + suppression evidence | Life of the consent + 4 years **[LAWYER]** | Retained (compliance evidence), pseudonymized |
| Comms content (emails/SMS bodies) | 2 years **[OWNER]** | Deleted |
| Glofox raw payloads | Until cutover + 1 year, then cold archive | Row-level redaction impractical; pseudonymization map deleted instead |
| AI prompts/outputs (`ai_artifacts`) | 1 year **[OWNER]** | Person-scoped drafts deleted; briefings retained (aggregate) |
| Webhook payloads (non-Stripe) | 90 days | n/a |
| Booking/attendance history | Indefinite (business analytics) | Pseudonymized |
| Contact fields, DOB, notes | Life of the relationship | **Erased** (the deletion's core) |
| Backups / cold archives | Roll off per PITR window + annual archive cycle | Deletion propagates at next archive cycle; documented in the policy |

## Trademark note (from the original brief, unchanged)

"Kelo" is semi-generic inside the sauna vertical (the wood), so the mark is mildly descriptive in
class — the brief's own recommendation stands: clear and file with a modifier strategy if needed,
and buy both domains regardless of filing outcome.

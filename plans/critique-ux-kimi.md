# Critique of Kelo UX/UI Plans A–D

## Per-plan assessment

### Plan A

**Strongest ideas**
- The mandatory `DataBoundary` / provenance contract is the most concrete answer to the brief’s central trust problem: it forces freshness and source labels at the component level, not as an afterthought.
- Waiver **preflight before payment** is the correct sequencing, and the explicit call-out that the interim “waiver-at-check-in” policy is a UX footgun is exactly the kind of disagreement the brief asks for.
- The money-state handling is honest about external-processor reality: the UI waits for the webhook and shows `processing` rather than faking finality to hit a metric.
- The “explicit tension with locked engineering” section names real risks (SPA first-load on morning phone use, no optimistic UI, waiver policy) instead of pretending the constraints are harmless.
- Token architecture plus lint rules, Storybook state coverage, and “no direct Radix imports” are agent-maintainability controls that go beyond library picking.

**Weakest points**
- The required component inventory is large (~28 named components) for a one-owner-plus-agents team; several items feel like thin wrappers that will become maintenance surface area.
- There is no global command palette / power-search hotkey; the global person search is useful but not a keyboard-first shortcut for “new booking,” “refund,” etc.
- Member booking omits brute-force/OTP rate-limiting UX and session-timeout handling, which matters for a public-facing account-claiming flow.
- Reports allow per-user compact-density persistence — a customization premium before the core briefing experience is proven.
- It does not design for the **social moment of a failed card payment** in front of a member; honest state is necessary but not sufficient for dignity-preserving staff copy.

**Contradictions / skipped flows**
- No major violations of the brief. It correctly excludes retail/gift cards, dark mode, medical data, and multi-location UI.  
- The schedule editor is “desktop-preferred” on mobile, which is acceptable but could have stated the exact mobile fallback more crisply.

---

### Plan B

**Strongest ideas**
- “Role-shaped surfaces, not permission-gated menus” is a clear doctrine and the nav model largely follows it.
- The morning-review state table makes empty/stale/AI-down behavior scannable and testable.
- The explicit “tension with locked engineering” section calls out SSR first-load risk, no optimistic UI, and the interim waiver policy.
- Member booking sets a strong honesty bar: real availability, no fake scarcity, on-domain end-to-end.
- The not-design list cleanly cuts seat maps, drag-and-drop automation builders, and native apps.

**Weakest points**
- The IA adds **Retail & gift cards / Retail catalog / Gift cards** screens, which are outside the locked POS v1 scope (Stripe Terminal + cash + credits + comp + discounts + tax + receipts only). That is scope creep and a direct contradiction of the engineering decision.
- Owner/manager primary nav includes **Front desk** and **Insights** while burying **Reports** under More, diluting the decision-first home.
- “Marketing” as a top-level nav item includes “automations,” which sits uneasily with the AI-never-sends principle and the not-design rejection of journey builders.
- It is thinner on the import exception resolver and schedule-publish ceremony than Plans A and D.
- It does not propose a dedicated, interruption-resilient Desk workspace; front-desk work is threaded through generic screens.

**Contradictions / skipped flows**
- Retail/gift-card surfaces appear in the IA despite POS v1 explicitly excluding them.  
- “Automations” in nav conflicts with the principle that AI never sends autonomously.

---

### Plan C

**Strongest ideas**
- The explicit UX disagreement about the **no-optimistic-UI rule taxing the 90-second front-desk target** is the kind of honest constraint analysis the brief rewards.
- “One conversation, one surface” and the global **Book** button / Quick Book modal keep front-desk speed central.
- The Data Health page gives a concrete per-entity freshness table, quarantine list, and authority matrix.
- Member booking foregrounds credits-first, Apple/Google Pay, and full price/policy disclosure.
- The component/token stack is concrete and agent-friendly (shadcn, Tailwind, RHF+Zod, TanStack Table).

**Weakest points**
- **Dark mode “from day one”** is a risky scope increase for an agent-built codebase before a visual identity exists; it directly contradicts the brief’s preference to avoid duplicate QA and maintenance surface.
- **Guest checkout** for members is not in the brief and adds duplicate-resolution complexity to the already-critical account-claiming flow.
- Navigation is weakly role-shaped; a global “Book” tab is front-desk-centric and competes with the owner’s decision-first home.
- There is no dedicated Desk route or persistent counter workspace — continuous shift operations are squeezed into modals and Schedule.
- The AAA contrast target for money/status is stricter than justified and may constrain the later visual-identity pass; the cost/benefit claim is hand-wavy.

**Contradictions / skipped flows**
- Dark-mode implementation contradicts the brief’s “prefer fewer surfaces / no dual QA until identity” spirit.  
- Guest checkout is an unprompted addition.  
- It does not explicitly exclude retail/gift-card UI, though it does exclude advanced POS features.

---

### Plan D

**Strongest ideas**
- **Desk as a separate full-screen route group** with four fat tabs is the clearest counter-facing workspace of the four plans.
- The **resumable half-finished booking card** and “flip-to-customer” waiver flow show real operational empathy for interruptions and physical context.
- The `DataRegion` wrapper enforcing five states across every data region is an elegant way to make provenance unavoidable.
- Outreach includes tracked-changes vs. the AI draft, quiet-hours checks, and named consent exclusions — the strongest trust ceremony.
- The “design-tool socket” token architecture, domain semantic tokens (`--status-confirmed`, `--freshness-live`), and chart-wrapper kit are the most designer-ready of the four.

**Weakest points**
- Like Plan B, it adds **Retail & gift cards / Gift cards / Retail catalog** screens, which are outside locked POS v1 and contradict the engineering scope.
- **Marketing** primary nav lists “automations,” conflicting with the AI-never-sends doctrine and the not-design rejection of automation builders.
- Member account claiming hand-waves ambiguous matches (“later merge tooling, invisible to the member”) without a support-assisted path that preserves the held slot.
- The operator-app accessibility posture is “AA-pragmatic” and explicitly skips screen-reader optimization of dense reports; the brief asks for a justified target, but this may leave the product exposed.
- The command palette and quick-add button are proposed as power paths without safety rules for money actions.

**Contradictions / skipped flows**
- Retail/gift-card screens and “automations” in nav appear despite being out of v1 scope / rejected in not-design.  
- PWA-installable surfaces and i18n string externalization are introduced without being required.

---

## Comparative judgment

| Section | Strongest plan | Why |
|---|---|---|
| **Design principles** | **D** | The doctrines are memorable, measurable, and explicitly named after failure modes (“counter test,” “speed is a feature with a budget,” “approval is a ceremony”). |
| **Information architecture** | **D** | Desk as a dedicated full-screen workspace, role-based landing, click-depth rules, and a concise 24-screen inventory make the structure the most operable. |
| **Core flow specifications** | **A** | The most exhaustive step-by-step coverage, especially the money/webhook nuance, onboarding exception resolver, and edge-case catalog. |
| **UI guidelines** | **A** | Broad, specific rulebook with designed state templates, notification taxonomy, and export/report patterns. |
| **Component/theming** | **A** | Goes beyond library selection to lint rules, Storybook state mandates, and component-import restrictions optimized for agents. |
| **Accessibility/devices** | **A** | Detailed WCAG 2.2 AA target, keyboard/SR posture, device table with explicit limits, and SPA first-load mitigation. |
| **Member surface** | **A** | Most complete funnel, account-claiming, and polish-bar specification, with explicit no-dark-pattern constraints. |
| **Not-design list** | **A** | Strictest alignment with the brief; it is the only plan that does not smuggle retail/gift-card surfaces into the architecture. |

---

## What EVERY plan missed

The following are real product risks, operational realities, and user-experience details that none of the four plans adequately addressed.

1. **The physical recovery-studio environment.** None of the plans design for wet hands, steam, cold-plunge humidity, or staff in robes. A front-desk tablet at a plunge studio will be used with damp fingers; 44 px touch targets may be too small, and capacitive screens become unreliable. There is no mention of splash-resistant hardware, glare-resistant screen brightness, glove-friendly inputs, haptic feedback, or a “wet-hand” mode with larger targets. The counter test in Plan D is good, but it ignores the *environment* of the counter.

2. **The social/emotional moment of a declined payment.** Every plan correctly shows honest `failed` states, but none design the *human* experience: a member standing two feet away while their card declines. There is no customer-facing secondary display, discreet staff-facing error copy, one-tap “hold slot while you grab another card,” or scripted fallback (“Let’s try a different tender”) that preserves dignity. Money states being unambiguous is table stakes; preventing humiliation is not.

3. **Shared-device privacy and session hygiene.** Front-desk tablets are shared across shifts and sometimes left on the counter. None of the plans specify auto-lock after inactivity, biometric/PIN re-auth before refunds/comps, clearing the last-member search, privacy-screen orientation, or how to prevent the next staffer from seeing the previous member’s profile and payment history. This is a support and liability time bomb.

4. **Members without phones at check-in.** The plans assume account claiming, QR codes, or phone-based identity. None address a member in a robe who left their phone in a locker: lookup by locker number, first-name pronunciation, a printed check-in code, or a staff-assisted flow that does not require the member to authenticate on their own device.

5. **New-staff training after launch.** The owner is self-serve on day one, but front-desk turnover is high in boutique studios. None propose a sandbox/practice mode, a trainee role with supervisory overrides, or progressive disclosure for novice vs. experienced staff. The 90-second walk-in target will decay the first time a new hire uses production data to learn the flow.

6. **Compliance and tone guardrails for AI outreach.** Consent is mentioned, but none detail TCPA/CAN-SPAM unsubscribe handling, quiet-hours enforcement per member timezone, AI tone guardrails to avoid creepy or pseudo-medical language, or escalation when a draft crosses into health/wellness claims. Given the product’s recovery-studio domain, this is both an emotional-trust and legal risk.

7. **Long-term data-volume and usability decay.** None specify archiving, table virtualization thresholds, report row limits, or how the UI degrades after years of bookings. There is no UX performance-budget enforcement plan (RUM, synthetic tests, alerting), no pattern-retirement process, and no strategy for when the simple component vocabulary starts to strain under feature creep.

8. **Hardware failure modes for Terminal and printers.** Terminal status is mentioned, but none design for reader disconnect, low battery, failed pairing, or paper-jam/out-of-paper receipt printing. A front-desk flow that promises <90 seconds must have a fallback when the hardware itself is the blocker.

9. **The member-facing waitlist experience.** Plans describe staff waitlist management, but none detail what the *member* sees: honest position, expected notification window, how long an offer lasts, or what happens if they decline. Bsport’s auto-reallocating waitlist is the competitive bar; the plans leave the member side vague.

10. **Transition write-guards with a “why” and an escape hatch.** All mention an authority matrix, but none specify the UX when an owner tries to edit an entity that is still Glofox-authoritative. The right answer is not just a disabled field — it is a clear label (“Kelo is read-only for schedules until cutover”) plus a one-click action: “Open in Glofox,” “Request cutover,” or “See migration timeline.” This is central to the staged strangler-fig takeover and is under-designed everywhere.

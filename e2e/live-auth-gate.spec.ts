import { expect, test, type Page } from "@playwright/test";

/**
 * TanStack Start deletes `window.$_TSR` once the client has hydrated AND the
 * SSR stream has ended. Interacting before that types into server-rendered HTML
 * whose React handlers aren't attached yet, so controlled state never updates
 * (the submit button would stay disabled forever).
 */
async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as { $_TSR?: unknown }).$_TSR === undefined, null, {
    timeout: 15_000,
  });
}

/**
 * WS-10 (read-only slice) — the member AUTH GATE, driven in a real browser
 * against a live stack.
 *
 * These exercise the SIGNED-IN surface's entry points without ever mutating:
 * every request here is a GET that ends in a 401 or an empty state. Nothing is
 * booked, no OTP is requested (the "Send me a code" button is asserted but
 * never clicked — submitting it would write an otp_challenge row), and no PII
 * is rendered or captured. That makes this safe against the live project, while
 * the mutating flows (book / join waitlist / OTP verify) stay gated behind an
 * isolated instance.
 *
 * It covers what the jsdom component tests can't: real SSR + hydration, real
 * routing, and the real /api round-trip through the member origin (the dev
 * proxy added alongside this), i.e. that a signed-OUT visitor to a protected
 * route is actually bounced to sign-in rather than shown a broken or empty page.
 */

test("a signed-out visit to /account is bounced to the sign-in screen", async ({ page }) => {
  await page.goto("/account");

  // The gate runs client-side: fetchAccount → 401 → onRequireSignIn → navigate.
  await page.waitForURL("**/signin", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: /^Sign in$/i })).toBeVisible();

  // Never leaks a member surface to an unauthenticated visitor.
  await expect(page.getByRole("heading", { name: /Your account/i })).toHaveCount(0);
});

test("the sign-in screen gates its first step until a contact is entered", async ({ page }) => {
  await page.goto("/signin");
  await waitForHydration(page);

  const contact = page.getByLabel(/email or mobile/i);
  await expect(contact).toBeVisible();

  // Step 1 is inert until there's something to send to — and we never submit it
  // (a submit would request a real OTP and write a challenge row).
  const send = page.getByRole("button", { name: /send me a code/i });
  await expect(send).toBeDisabled();
  await contact.fill("e2e-probe@example.com");
  await expect(send).toBeEnabled();

  // The code step is not reachable before a code is requested.
  await expect(page.getByLabel(/6-digit code/i)).toHaveCount(0);
});

test("an unknown session id shows the honest can't-book state, not an error page", async ({ page }) => {
  const response = await page.goto("/book/00000000-0000-4000-8000-000000000000");
  expect(response?.status()).toBe(200);
  await expect(page.getByText(/can.t book this session/i)).toBeVisible();
});

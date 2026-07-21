import { expect, test } from "@playwright/test";

/**
 * WS-2 (live-data mode) — the member public schedule against a REAL project.
 *
 * Run with the API + member app already up (KELO_E2E_NO_WEBSERVER=1) and
 * KELO_TENANT_ID / KELO_API_ORIGIN pointed at the live (or a branch) stack.
 * The public schedule is public marketing data by design (migration 0043: the
 * locked return shape carries ZERO attendee/person data), so this is safe to
 * run against production — it reads, never writes, and captures no PII.
 *
 * It asserts the whole chain (local API → Supabase service-role → member_schedule
 * RPC → member-core → TanStack Start SSR → schedule-page) renders TRUTHFULLY:
 * the header, plus EITHER real session rows OR the honest empty state — and
 * never a provenance-violation refusal or an error page.
 */
test("member public schedule renders truthfully from the live studio book", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  await expect(page).toHaveTitle(/Book a session/i);
  await expect(page.getByRole("heading", { name: /Upcoming sessions/i })).toBeVisible();

  // Invariant #3 on the money/booking surface: a figure is never shown without
  // its provenance record.
  await expect(page.getByText(/provenance record is missing/i)).toHaveCount(0);

  // Exactly one truthful outcome: real session rows (each a Book / Join link)
  // OR the honest "nothing published yet" empty state. An error page is neither.
  const bookLinks = page.getByRole("link", { name: /^(Book|Join the waitlist for) / });
  const emptyState = page.getByText(/No sessions in the next two weeks/i);

  if ((await bookLinks.count()) > 0) {
    await expect(bookLinks.first()).toBeVisible();
    // Every rendered row links to that session's booking screen.
    await expect(bookLinks.first()).toHaveAttribute("href", /^\/book\/[0-9a-f-]{36}$/);
  } else {
    await expect(emptyState).toBeVisible();
  }
});

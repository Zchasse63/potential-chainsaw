import { expect, test } from "@playwright/test";

/**
 * WS-2 smoke — the whole harness in one assertion: the member app SSRs the
 * anonymous public schedule, and the row seeded by supabase/tests/seed.e2e.sql
 * (offering "Morning Contrast") is visible with its honest "Book …" affordance.
 *
 * This proves the full chain end to end — local Supabase → member_schedule RPC
 * → Hono API (/api/v1/member/schedule) → member-core fetchSchedule → the
 * TanStack Start SSR loader → schedule-page.tsx render. If this passes, the
 * plumbing is sound and WS-10's flow specs (auth/OTP, booking, waitlist) can be
 * layered on the same harness.
 *
 * Selectors are the real ones from apps/member/src/components/schedule-page.tsx:
 * the offering name is rendered as text, and each session is an anchor labelled
 * `Book <offering_name>` (or `Join the waitlist for <offering_name>` when full).
 */
test("member public schedule SSRs the seeded session", async ({ page }) => {
  await page.goto("/");

  // The seeded offering renders as a visible row…
  await expect(page.getByText("Morning Contrast").first()).toBeVisible();

  // …with its booking affordance (the seed leaves the session non-full).
  await expect(page.getByRole("link", { name: /^Book Morning Contrast$/ })).toBeVisible();
});

test("the schedule row links to that session's booking screen", async ({ page }) => {
  await page.goto("/");
  const bookLink = page.getByRole("link", { name: /^Book Morning Contrast$/ });
  // href is /book/<session_id> (schedule-page.tsx) — the seeded session id.
  await expect(bookLink).toHaveAttribute(
    "href",
    "/book/e2e00000-0000-4000-8000-000000000004",
  );
});

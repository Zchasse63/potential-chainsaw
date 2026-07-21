// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * WS-8c — the operator auth state machine (AuthProvider) had no coverage. It
 * derives the whole app's gate — loading → signed_out/signed_in, live updates
 * via onAuthStateChange, and (the leak-prone bit) unsubscribing on unmount.
 * The real Supabase client is mocked so the machine is exercised in isolation.
 */

const getSession = vi.fn();
const unsubscribe = vi.fn();
let authChangeCb: ((event: string, session: unknown) => void) | null = null;
const onAuthStateChange = vi.fn((cb: (event: string, session: unknown) => void) => {
  authChangeCb = cb;
  return { data: { subscription: { unsubscribe } } };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getSession, onAuthStateChange } }),
}));
vi.mock("../src/lib/env.js", () => ({
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
}));

import { AuthProvider, useAuth } from "../src/auth/auth-context.jsx";

function Probe() {
  const auth = useAuth();
  return (
    <div
      data-testid="probe"
      data-status={auth.status}
      data-token={auth.accessToken ?? ""}
      data-email={auth.userEmail ?? ""}
    />
  );
}
function probe() {
  return screen.getByTestId("probe");
}

afterEach(cleanup);
beforeEach(() => {
  getSession.mockReset();
  onAuthStateChange.mockClear();
  unsubscribe.mockReset();
  authChangeCb = null;
});

describe("AuthProvider — the operator auth state machine (WS-8c)", () => {
  it("resolves to signed_out when getSession returns no session", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(probe().getAttribute("data-status")).toBe("signed_out"));
    expect(probe().getAttribute("data-token")).toBe("");
  });

  it("resolves to signed_in and exposes the access token + email from the session", async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: "tok-123", user: { email: "owner@studio.test" } } },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(probe().getAttribute("data-status")).toBe("signed_in"));
    expect(probe().getAttribute("data-token")).toBe("tok-123");
    expect(probe().getAttribute("data-email")).toBe("owner@studio.test");
  });

  it("promotes to signed_in when onAuthStateChange later delivers a session", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(probe().getAttribute("data-status")).toBe("signed_out"));

    // A later auth event (e.g. a magic-link redirect completing) flips the app.
    act(() => {
      authChangeCb?.("SIGNED_IN", { access_token: "tok-late", user: { email: "late@studio.test" } });
    });
    await waitFor(() => expect(probe().getAttribute("data-status")).toBe("signed_in"));
    expect(probe().getAttribute("data-token")).toBe("tok-late");
  });

  it("unsubscribes from the auth listener on unmount (no leaked subscription)", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const { unmount } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(onAuthStateChange).toHaveBeenCalledTimes(1));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

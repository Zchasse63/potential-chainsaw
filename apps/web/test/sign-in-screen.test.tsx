// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * WS-8c — the operator sign-in screen shipped with zero coverage. It is the
 * front door, and every outcome must be STATED (invariant-style honesty): a
 * failed password says what went wrong, the magic-link path confirms where the
 * email went, and an unconfigured deployment refuses plainly instead of a dead
 * form. useAuth is mocked so these run without a real Supabase client.
 */

const authState = vi.fn();
vi.mock("../src/auth/auth-context.jsx", () => ({
  useAuth: () => authState() as unknown,
}));

import { SignInScreen } from "../src/auth/sign-in-screen.jsx";

type MockAuth = {
  status: string;
  client: { auth: { signInWithPassword: ReturnType<typeof vi.fn>; signInWithOtp: ReturnType<typeof vi.fn> } } | null;
  accessToken: string | null;
  userEmail: string | null;
};

function configured(overrides: Partial<MockAuth["client"]> = {}): MockAuth {
  return {
    status: "signed_out",
    client: {
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
        signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
        ...overrides?.auth,
      },
    },
    accessToken: null,
    userEmail: null,
  };
}

afterEach(cleanup);
beforeEach(() => authState.mockReset());

function fillEmail(value: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value } });
}
function fillPassword(value: string) {
  fireEvent.change(screen.getByLabelText("Password"), { target: { value } });
}

describe("SignInScreen — unconfigured deployment (WS-8c)", () => {
  it("refuses plainly (no dead form) when Supabase env is not set", () => {
    authState.mockReturnValue({ status: "unconfigured", client: null, accessToken: null, userEmail: null });
    render(<SignInScreen />);
    expect(screen.getByRole("alert").textContent).toContain("configured for this deployment");
    // No form is offered — there is nothing to submit.
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
});

describe("SignInScreen — password sign-in (WS-8c)", () => {
  it("states the failure verbatim when the credential is rejected", async () => {
    const auth = configured();
    auth.client!.auth.signInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    authState.mockReturnValue(auth);
    render(<SignInScreen />);

    fillEmail("owner@studio.test");
    fillPassword("wrong-pass");
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByText(/sign-in failed: invalid login credentials/i)).toBeDefined();
    expect(auth.client!.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "owner@studio.test",
      password: "wrong-pass",
    });
  });

  it("shows no error on a successful password sign-in (AuthContext flips the app)", async () => {
    const auth = configured();
    authState.mockReturnValue(auth);
    render(<SignInScreen />);
    fillEmail("owner@studio.test");
    fillPassword("correct");
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => expect(auth.client!.auth.signInWithPassword).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/sign-in failed/i)).toBeNull();
  });
});

describe("SignInScreen — magic link (WS-8c)", () => {
  it("confirms exactly where the sign-in link was sent", async () => {
    const auth = configured();
    authState.mockReturnValue(auth);
    render(<SignInScreen />);

    fillEmail("member@studio.test");
    fireEvent.click(screen.getByRole("button", { name: /email me a sign-in link/i }));

    expect(await screen.findByText(/sign-in link sent to member@studio\.test/i)).toBeDefined();
    expect(auth.client!.auth.signInWithOtp).toHaveBeenCalledTimes(1);
  });

  it("states the failure when the link can't be sent", async () => {
    const auth = configured();
    auth.client!.auth.signInWithOtp.mockResolvedValue({ error: { message: "rate limited" } });
    authState.mockReturnValue(auth);
    render(<SignInScreen />);

    fillEmail("member@studio.test");
    fireEvent.click(screen.getByRole("button", { name: /email me a sign-in link/i }));

    expect(await screen.findByText(/send the sign-in link: rate limited/i)).toBeDefined();
  });

  it("disables the magic-link button until an email is entered", () => {
    authState.mockReturnValue(configured());
    render(<SignInScreen />);
    const magic = screen.getByRole("button", { name: /email me a sign-in link/i }) as HTMLButtonElement;
    expect(magic.disabled).toBe(true);
    fillEmail("member@studio.test");
    expect(magic.disabled).toBe(false);
  });
});

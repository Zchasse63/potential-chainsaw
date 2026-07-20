// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SignInScreen } from "../src/components/sign-in-screen.jsx";

/**
 * The Identify stage (plan-member-app §3H): a two-step OTP form driving
 * @kelo/member-core's start/verify. The screen is presentational — these tests
 * inject fake onStart/onVerify/onSignedIn and pin the flow, the anti-enumeration
 * neutrality, and the error surfaces. NO network, no member-core, no DOM env
 * beyond jsdom.
 */

afterEach(cleanup);

function fill(labelText: RegExp, value: string) {
  const input = screen.getByLabelText(labelText);
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("SignInScreen", () => {
  it("step 1 requests a code, then step 2 verifies and hands off", async () => {
    const onStart = vi.fn().mockResolvedValue({ ok: true });
    const onVerify = vi.fn().mockResolvedValue({ ok: true });
    const onSignedIn = vi.fn();
    render(<SignInScreen onStart={onStart} onVerify={onVerify} onSignedIn={onSignedIn} />);

    fill(/email or mobile/i, "member@example.com");
    fireEvent.click(screen.getByRole("button", { name: /send me a code/i }));

    await waitFor(() => expect(onStart).toHaveBeenCalledWith("member@example.com"));

    // Advanced to the code step.
    const code = await screen.findByLabelText(/6-digit code/i);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /verify & sign in/i }));

    await waitFor(() => expect(onVerify).toHaveBeenCalledWith("member@example.com", "123456"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  it("advances to the code step even when the contact is unknown (anti-enumeration)", async () => {
    // The API returns the SAME neutral 202 whether or not the contact exists —
    // the UI must reveal nothing, so an ok:true start always shows code entry.
    const onStart = vi.fn().mockResolvedValue({ ok: true });
    render(<SignInScreen onStart={onStart} onVerify={vi.fn()} onSignedIn={vi.fn()} />);

    fill(/email or mobile/i, "nobody@nowhere.example");
    fireEvent.click(screen.getByRole("button", { name: /send me a code/i }));

    expect(await screen.findByLabelText(/6-digit code/i)).toBeDefined();
    // No "no such member" leak anywhere on screen.
    expect(screen.queryByText(/no such|not found|unknown/i)).toBeNull();
  });

  it("shows an error and does NOT hand off when the code is rejected", async () => {
    const onVerify = vi.fn().mockResolvedValue({ ok: false });
    const onSignedIn = vi.fn();
    render(
      <SignInScreen onStart={vi.fn().mockResolvedValue({ ok: true })} onVerify={onVerify} onSignedIn={onSignedIn} />,
    );

    fill(/email or mobile/i, "member@example.com");
    fireEvent.click(screen.getByRole("button", { name: /send me a code/i }));
    const code = await screen.findByLabelText(/6-digit code/i);
    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /verify & sign in/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/invalid or expired/i);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("surfaces a retryable message when the start request is rejected", async () => {
    const onStart = vi.fn().mockResolvedValue({ ok: false });
    render(<SignInScreen onStart={onStart} onVerify={vi.fn()} onSignedIn={vi.fn()} />);

    fill(/email or mobile/i, "member@example.com");
    fireEvent.click(screen.getByRole("button", { name: /send me a code/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't send a code/i);
    // Still on the contact step — no code field appeared.
    expect(screen.queryByLabelText(/6-digit code/i)).toBeNull();
  });

  it("strips non-digits from the code and keeps the verify button disabled until 6 digits", async () => {
    render(
      <SignInScreen
        onStart={vi.fn().mockResolvedValue({ ok: true })}
        onVerify={vi.fn().mockResolvedValue({ ok: true })}
        onSignedIn={vi.fn()}
      />,
    );
    fill(/email or mobile/i, "member@example.com");
    fireEvent.click(screen.getByRole("button", { name: /send me a code/i }));

    const code = (await screen.findByLabelText(/6-digit code/i)) as HTMLInputElement;
    const verify = screen.getByRole("button", { name: /verify & sign in/i }) as HTMLButtonElement;

    fireEvent.change(code, { target: { value: "12ab3" } });
    expect(code.value).toBe("123"); // letters stripped
    expect(verify.disabled).toBe(true); // <6 digits

    fireEvent.change(code, { target: { value: "123456" } });
    expect(verify.disabled).toBe(false);
  });
});

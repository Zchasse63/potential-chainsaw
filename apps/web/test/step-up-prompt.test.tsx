// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StepUpPrompt } from "../src/components/step-up-prompt.jsx";
import { ApiRequestError } from "../src/lib/api.js";

afterEach(cleanup);

describe("StepUpPrompt", () => {
  it("uses a non-echoing numeric PIN field and returns the scoped grant", async () => {
    const verify = vi.fn(async (pin: string, context: string) => {
      expect(pin).toBe("1234");
      expect(context).toBe("refund_over_threshold");
      return { grantToken: "signed-grant", expiresAt: "2026-07-18T12:05:00Z" };
    });
    const granted = vi.fn();
    render(
      <StepUpPrompt
        open
        context="refund_over_threshold"
        onVerify={verify}
        onGranted={granted}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Personal PIN") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.inputMode).toBe("numeric");
    fireEvent.change(input, { target: { value: "12a34" } });
    expect(input.value).toBe("1234");
    fireEvent.click(screen.getByRole("button", { name: "Verify PIN" }));
    await waitFor(() =>
      expect(granted).toHaveBeenCalledWith({
        grantToken: "signed-grant",
        expiresAt: "2026-07-18T12:05:00Z",
      }),
    );
  });

  it("clears the PIN and enters a disabled lock state after HTTP 423", async () => {
    const verify = vi.fn(async () => {
      throw new ApiRequestError(423, "step_up_locked", "locked", undefined);
    });
    render(
      <StepUpPrompt
        open
        context="manual_grant"
        onVerify={verify}
        onGranted={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Personal PIN") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify PIN" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("locked"));
    expect(input.value).toBe("");
    expect(input.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Verify PIN" }).hasAttribute("disabled")).toBe(true);
  });
});

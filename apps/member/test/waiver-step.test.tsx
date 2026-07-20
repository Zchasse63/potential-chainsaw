// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WaiverStep, type SignWaiverOutcome, type WaiverLoad } from "../src/components/waiver-step.jsx";

/**
 * The in-flow Waiver stage (unit 8.3i). Presentational + self-contained; these
 * tests inject the member-core-wired callbacks and pin: load → form → sign →
 * onSigned; the already-signed race (auto-onSigned); load error retry; and the
 * version-changed reload vs. invalid/retry sign errors.
 */

afterEach(cleanup);

const NEEDS: WaiverLoad = { ok: true, needsSignature: true, title: "Liability", body: "Assume all risk." };

function fillAndSign() {
  fireEvent.change(screen.getByLabelText(/type your full name/i), { target: { value: "Jane Member" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /sign & continue/i }));
}

describe("WaiverStep", () => {
  it("loads the waiver, signs, and hands back via onSigned", async () => {
    const onSign = vi.fn<(n: string) => Promise<SignWaiverOutcome>>().mockResolvedValue({ ok: true });
    const onSigned = vi.fn();
    render(<WaiverStep loadWaiver={vi.fn().mockResolvedValue(NEEDS)} onSign={onSign} onSigned={onSigned} />);

    expect(await screen.findByText(/assume all risk/i)).toBeDefined();
    fillAndSign();
    await waitFor(() => expect(onSign).toHaveBeenCalledWith("Jane Member"));
    await waitFor(() => expect(onSigned).toHaveBeenCalledTimes(1));
  });

  it("auto-completes when the waiver is already signed (race between gate and mount)", async () => {
    const onSigned = vi.fn();
    render(
      <WaiverStep
        loadWaiver={vi.fn().mockResolvedValue({ ok: true, needsSignature: false, title: null, body: null })}
        onSign={vi.fn()}
        onSigned={onSigned}
      />,
    );
    await waitFor(() => expect(onSigned).toHaveBeenCalledTimes(1));
    // No form rendered for an already-signed waiver.
    expect(screen.queryByRole("button", { name: /sign & continue/i })).toBeNull();
  });

  it("keeps the sign button disabled until BOTH name and the checkbox are set", async () => {
    render(<WaiverStep loadWaiver={vi.fn().mockResolvedValue(NEEDS)} onSign={vi.fn()} onSigned={vi.fn()} />);
    const btn = (await screen.findByRole("button", { name: /sign & continue/i })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/type your full name/i), { target: { value: "Jane" } });
    expect(btn.disabled).toBe(true); // name only
    fireEvent.click(screen.getByRole("checkbox"));
    expect(btn.disabled).toBe(false); // name + ack
  });

  it("surfaces a load error with a retry", async () => {
    const loadWaiver = vi
      .fn<() => Promise<WaiverLoad>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue(NEEDS);
    render(<WaiverStep loadWaiver={loadWaiver} onSign={vi.fn()} onSigned={vi.fn()} />);
    expect(await screen.findByText(/couldn't load the waiver/i)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText(/assume all risk/i)).toBeDefined();
  });

  it("reloads the text on a version-changed sign (never resubmits a stale acceptance)", async () => {
    const loadWaiver = vi
      .fn<() => Promise<WaiverLoad>>()
      .mockResolvedValueOnce(NEEDS)
      .mockResolvedValue({ ok: true, needsSignature: true, title: "Updated", body: "New terms." });
    const onSign = vi.fn<(n: string) => Promise<SignWaiverOutcome>>().mockResolvedValue({ ok: false, reason: "version_changed" });
    const onSigned = vi.fn();
    render(<WaiverStep loadWaiver={loadWaiver} onSign={onSign} onSigned={onSigned} />);

    await screen.findByText(/assume all risk/i);
    fillAndSign();
    // The step reloaded the (new) text rather than completing.
    expect(await screen.findByText(/new terms/i)).toBeDefined();
    expect(onSigned).not.toHaveBeenCalled();
    expect(loadWaiver).toHaveBeenCalledTimes(2);
    // Re-affirmation required for the CHANGED text — name + checkbox reset,
    // sign disabled (no v1 acceptance carried onto v2).
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/type your full name/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: /sign & continue/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an inline error and stays on the form for an invalid/retry sign", async () => {
    const onSign = vi.fn<(n: string) => Promise<SignWaiverOutcome>>().mockResolvedValue({ ok: false, reason: "invalid" });
    const onSigned = vi.fn();
    render(<WaiverStep loadWaiver={vi.fn().mockResolvedValue(NEEDS)} onSign={onSign} onSigned={onSigned} />);

    await screen.findByText(/assume all risk/i);
    fillAndSign();
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(onSigned).not.toHaveBeenCalled();
    // Still on the form (name field present) for a corrected re-submit.
    expect(screen.getByLabelText(/type your full name/i)).toBeDefined();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StaffScreen, type StaffScreenProps } from "../src/screens/staff-screen.jsx";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { ApiRequestError } from "../src/lib/api.js";

/**
 * WS-8b — the staff/PIN screen shipped with ZERO behavioral coverage and was
 * the only operator screen wiring useQuery/postEnvelope directly (untestable).
 * It is now injectable (StaffScreenProps: staffQuery + onSetPin + onVerifyPin),
 * so these pin the credential surface's load-bearing rules:
 *   - RBAC: no can_manage_pin ⇒ no Set/Reset control at all;
 *   - the PIN gate: 4–6 digits AND a matching confirmation, digits only;
 *   - the raw PIN reaches onSetPin as an argument (POST body), never the URL,
 *     and is masked in the DOM (type=password);
 *   - honest failure: a rejected save surfaces a named error and leaves the
 *     editor OPEN (nothing silently "changed").
 */

afterEach(cleanup);

const META = {
  as_of: "2026-07-20T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "staff:v1",
  correlation_id: "corr-staff",
};
function success(data: unknown): BoundaryQuery {
  return { status: "success", data: { data, meta: META }, isRefetching: false, refetch: vi.fn() };
}

type StaffMember = {
  id: string;
  user_id: string;
  role: string;
  status: string;
  pin_set: boolean;
  locked_until: string | null;
  fail_count: number;
  last_step_up_at: string | null;
  last_step_up_kind: string | null;
  is_self: boolean;
  can_manage_pin: boolean;
};

function member(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    id: "m1",
    user_id: "11111111-2222-3333-4444-555555555555",
    role: "front_desk",
    status: "active",
    pin_set: true,
    locked_until: null,
    fail_count: 0,
    last_step_up_at: null,
    last_step_up_kind: null,
    is_self: false,
    can_manage_pin: true,
    ...overrides,
  };
}

function renderStaff(members: StaffMember[], overrides: Partial<StaffScreenProps> = {}) {
  const onSetPin = vi.fn().mockResolvedValue(undefined);
  const onVerifyPin = vi.fn().mockResolvedValue({ grantToken: "g", expiresAt: META.as_of });
  const props: StaffScreenProps = {
    staffQuery: success({ staff: members }),
    onSetPin,
    onVerifyPin,
    ...overrides,
  };
  const result = render(<StaffScreen {...props} />);
  return { ...result, onSetPin, onVerifyPin };
}

function rowFor(userIdPrefix: string): HTMLElement {
  const row = screen.getAllByRole("row").find((r) => r.textContent?.includes(userIdPrefix));
  if (row === undefined) throw new Error(`no staff row for ${userIdPrefix}`);
  return row;
}

async function openEditor(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /set pin|reset pin/i }));
  await screen.findByRole("dialog");
}

describe("StaffScreen — RBAC on the credential action (WS-8b)", () => {
  it("shows a Set/Reset control ONLY when the operator can manage that member's PIN", () => {
    renderStaff([
      member({ id: "a", user_id: "aaaaaaaa-0000", can_manage_pin: true, pin_set: true }),
      member({ id: "b", user_id: "bbbbbbbb-0000", can_manage_pin: false }),
    ]);
    // The manageable row has the action; the unmanageable row has none.
    expect(within(rowFor("aaaaaaaa")).getByRole("button", { name: /reset pin/i })).toBeDefined();
    expect(within(rowFor("bbbbbbbb")).queryByRole("button")).toBeNull();
  });

  it("labels the PIN state: Locked overrides, else Set / Not set", () => {
    renderStaff([
      member({ id: "a", user_id: "aaaaaaaa-0000", locked_until: "2999-01-01T00:00:00Z", pin_set: true }),
      member({ id: "b", user_id: "bbbbbbbb-0000", locked_until: null, pin_set: true }),
      member({ id: "c", user_id: "cccccccc-0000", locked_until: null, pin_set: false }),
    ]);
    expect(within(rowFor("aaaaaaaa")).getByText("Locked")).toBeDefined();
    expect(within(rowFor("bbbbbbbb")).getByText("Set")).toBeDefined();
    expect(within(rowFor("cccccccc")).getByText("Not set")).toBeDefined();
  });
});

describe("StaffScreen — the PIN entry gate (WS-8b)", () => {
  it("keeps Save disabled until the PIN is 4–6 digits AND matches its confirmation", async () => {
    renderStaff([member({ user_id: "aaaaaaaa-0000" })]);
    await openEditor();
    const dialog = screen.getByRole("dialog");
    const pin = within(dialog).getByLabelText("New PIN") as HTMLInputElement;
    const confirm = within(dialog).getByLabelText("Confirm PIN") as HTMLInputElement;
    const save = within(dialog).getByRole("button", { name: /save pin/i });

    expect(save).toHaveProperty("disabled", true); // empty
    fireEvent.change(pin, { target: { value: "123" } }); // too short
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(pin, { target: { value: "1234" } });
    fireEvent.change(confirm, { target: { value: "9999" } }); // mismatch
    expect(within(dialog).getByText(/do not match/i)).toBeDefined();
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(confirm, { target: { value: "1234" } }); // match, valid length
    expect(save).toHaveProperty("disabled", false);
  });

  it("strips non-digits and caps at 6 (numeric-only credential)", async () => {
    renderStaff([member({ user_id: "aaaaaaaa-0000" })]);
    await openEditor();
    const dialog = screen.getByRole("dialog");
    const pin = within(dialog).getByLabelText("New PIN") as HTMLInputElement;
    fireEvent.change(pin, { target: { value: "12ab34" } });
    expect(pin.value).toBe("1234");
    fireEvent.change(pin, { target: { value: "1234567" } });
    expect(pin.value).toBe("123456");
  });

  it("masks the PIN inputs (type=password — never rendered in the clear)", async () => {
    renderStaff([member({ user_id: "aaaaaaaa-0000" })]);
    await openEditor();
    const dialog = screen.getByRole("dialog");
    for (const input of within(dialog).getAllByLabelText(/pin/i) as HTMLInputElement[]) {
      expect(input.type).toBe("password");
    }
  });
});

describe("StaffScreen — save path (WS-8b)", () => {
  it("a valid save passes the raw PIN to onSetPin as an argument (body), keyed by user id", async () => {
    const { onSetPin } = renderStaff([member({ user_id: "aaaaaaaa-1111-2222-3333-444444444444" })]);
    await openEditor();
    const dialog = screen.getByRole("dialog");
    const pin = within(dialog).getByLabelText("New PIN") as HTMLInputElement;
    const confirm = within(dialog).getByLabelText("Confirm PIN") as HTMLInputElement;
    fireEvent.change(pin, { target: { value: "4821" } });
    fireEvent.change(confirm, { target: { value: "4821" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save pin/i }));

    await waitFor(() => expect(onSetPin).toHaveBeenCalledTimes(1));
    expect(onSetPin).toHaveBeenCalledWith("aaaaaaaa-1111-2222-3333-444444444444", "4821");
    // On success the editor closes.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a FAILED save surfaces the API error message and leaves the editor open (no silent change)", async () => {
    const onSetPin = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(423, "staff_locked", "That account is locked.", "corr-x"));
    renderStaff([member({ user_id: "aaaaaaaa-0000" })], { onSetPin });
    await openEditor();
    const dialog = screen.getByRole("dialog");
    const pin = within(dialog).getByLabelText("New PIN") as HTMLInputElement;
    const confirm = within(dialog).getByLabelText("Confirm PIN") as HTMLInputElement;
    fireEvent.change(pin, { target: { value: "4821" } });
    fireEvent.change(confirm, { target: { value: "4821" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save pin/i }));

    expect(await screen.findByText(/that account is locked/i)).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined(); // still open — nothing changed
  });

  it("a FAILED save RETAINS the entered PIN so the operator can retry (not wiped)", async () => {
    const onSetPin = vi.fn().mockRejectedValue(new ApiRequestError(500, "boom", "Server error.", "corr-y"));
    renderStaff([member({ user_id: "aaaaaaaa-0000" })], { onSetPin });
    await openEditor();
    const dialog = screen.getByRole("dialog");
    const pin = within(dialog).getByLabelText("New PIN") as HTMLInputElement;
    const confirm = within(dialog).getByLabelText("Confirm PIN") as HTMLInputElement;
    fireEvent.change(pin, { target: { value: "4821" } });
    fireEvent.change(confirm, { target: { value: "4821" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save pin/i }));

    expect(await screen.findByText(/server error/i)).toBeDefined();
    // The masked fields are still populated — a failed save is not a reset.
    expect((within(dialog).getByLabelText("New PIN") as HTMLInputElement).value).toBe("4821");
    expect((within(dialog).getByLabelText("Confirm PIN") as HTMLInputElement).value).toBe("4821");
  });

  it("a non-ApiRequestError failure falls back to the honest 'no credential was changed' copy", async () => {
    const onSetPin = vi.fn().mockRejectedValue("network gone"); // not an Error instance
    renderStaff([member({ user_id: "aaaaaaaa-0000" })], { onSetPin });
    await openEditor();
    const dialog = screen.getByRole("dialog");
    const pin = within(dialog).getByLabelText("New PIN") as HTMLInputElement;
    const confirm = within(dialog).getByLabelText("Confirm PIN") as HTMLInputElement;
    fireEvent.change(pin, { target: { value: "4821" } });
    fireEvent.change(confirm, { target: { value: "4821" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save pin/i }));

    expect(await screen.findByText(/no credential was changed/i)).toBeDefined();
  });
});

describe("StaffScreen — step-up verify wiring (WS-8b)", () => {
  it("Verify my PIN opens the step-up prompt wired to onVerifyPin", async () => {
    renderStaff([member({ user_id: "aaaaaaaa-0000" })]);
    // No dialog until the operator asks to verify.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /verify my pin/i }));
    expect(await screen.findByRole("dialog")).toBeDefined();
  });
});

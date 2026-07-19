// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { WaiversScreen, type WaiversScreenProps } from "../src/screens/waivers-screen.jsx";
import type {
  ActivateWaiverInput,
  CreateWaiverVersionInput,
  SignWaiverInput,
  WaiverMutationHandle,
} from "../src/lib/waivers.js";

// The provenance-violation report funnels through telemetry — mock it so a
// stray refusal path asserts behavior, not Sentry side effects.
vi.mock("../src/lib/telemetry.js", () => ({
  initTelemetry: vi.fn(),
  reportError: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const META = {
  as_of: "2026-07-18T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "waivers:v1",
  correlation_id: "corr-waivers-1",
};

function success(data: unknown, meta = META): BoundaryQuery {
  return { status: "success", data: { data, meta }, isRefetching: false, refetch: vi.fn() };
}

const ACTIVE_ID = "a1111111-1111-4111-8111-111111111111";
const DRAFT_ID = "b2222222-2222-4222-8222-222222222222";
const PERSON_ID = "c3333333-3333-4333-8333-333333333333";

const ACTIVE = {
  id: ACTIVE_ID,
  version: 2,
  title: "Liability waiver",
  body: "I assume all risk of sauna and cold-plunge use.",
  active: true,
  effective_from: "2026-07-18T00:00:00.000Z",
  created_at: "2026-07-18T00:00:00.000Z",
};
const DRAFT = {
  id: DRAFT_ID,
  version: 1,
  title: "Liability waiver",
  body: "Superseded waiver text.",
  active: false,
  effective_from: "2026-07-10T00:00:00.000Z",
  created_at: "2026-07-10T00:00:00.000Z",
};

const VERSIONS = { versions: [ACTIVE, DRAFT] };
const NEEDS_SIGNATURE = {
  status: {
    has_current_signature: false,
    signed_version: null,
    active_version: 2,
    needs_signature: true,
  },
};

function idleHandle<T>(): WaiverMutationHandle<T> {
  return { status: "idle", mutate: vi.fn(), reset: vi.fn() };
}

function renderScreen(overrides: Partial<WaiversScreenProps> = {}) {
  const createVersion = overrides.createVersion ?? idleHandle<CreateWaiverVersionInput>();
  const activateVersion = overrides.activateVersion ?? idleHandle<ActivateWaiverInput>();
  const signWaiver = overrides.signWaiver ?? idleHandle<SignWaiverInput>();
  const statusQueryFor = overrides.statusQueryFor ?? (() => success(NEEDS_SIGNATURE));
  const props: WaiversScreenProps = {
    role: "owner",
    versionsQuery: success(VERSIONS),
    createVersion,
    activateVersion,
    statusQueryFor,
    signWaiver,
    ...overrides,
  };
  render(<WaiversScreen {...props} />);
  return { createVersion, activateVersion, signWaiver };
}

describe("WaiversScreen — version management", () => {
  it("marks the active version with a text label and a marker, never color alone", () => {
    renderScreen();
    const badge = screen.getByTestId("waiver-active-badge");
    // The badge carries the state in readable text, not just a hue.
    expect(badge.textContent).toContain("Active");
    expect(badge.getAttribute("data-marker")).not.toBeNull();
    expect(badge.textContent?.trim().length ?? 0).toBeGreaterThan("Active".length);
    // The superseded version offers an explicit activate action.
    expect(screen.getByRole("button", { name: "Activate version 1" })).toBeDefined();
  });

  it("never activates a version without an explicit confirmation", () => {
    const { activateVersion } = renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Activate version 1" }));
    // The confirm dialog appears; nothing is mutated yet (no optimistic action).
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(activateVersion.mutate).not.toHaveBeenCalled();

    // Cancelling backs out without a mutation.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(activateVersion.mutate).not.toHaveBeenCalled();

    // Reopening and confirming is what commits it.
    fireEvent.click(screen.getByRole("button", { name: "Activate version 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm activation" }));
    expect(activateVersion.mutate).toHaveBeenCalledWith({ id: DRAFT_ID });
  });
});

describe("WaiversScreen — desk capture", () => {
  it("keeps the sign form disabled until BOTH a typed name and the acknowledgement are given", () => {
    // front_desk: only the capture form renders, so the waiver body appears once.
    const { signWaiver } = renderScreen({ role: "front_desk" });
    // Look up the person to reveal their status and the capture form.
    fireEvent.change(screen.getByLabelText("Person ID"), { target: { value: PERSON_ID } });
    fireEvent.click(screen.getByRole("button", { name: "Look up status" }));

    // The active waiver text is shown for the signer to read.
    expect(screen.getByText(/assume all risk/)).toBeDefined();

    const nameInput = screen.getByLabelText("Typed full name") as HTMLInputElement;
    // Never pre-filled — the signer types their own name.
    expect(nameInput.value).toBe("");
    const ack = screen.getByLabelText(/acknowledge/i);
    const submit = screen.getByRole("button", { name: "Record signature" }) as HTMLButtonElement;

    expect(submit.disabled).toBe(true);

    // Name alone is not enough.
    fireEvent.change(nameInput, { target: { value: "Dana Rivers" } });
    expect(submit.disabled).toBe(true);

    // Checkbox alone is not enough.
    fireEvent.change(nameInput, { target: { value: "   " } });
    fireEvent.click(ack);
    expect(submit.disabled).toBe(true);

    // Both present → enabled, and the payload targets the ACTIVE version.
    fireEvent.change(nameInput, { target: { value: "Dana Rivers" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(signWaiver.mutate).toHaveBeenCalledWith({
      person_id: PERSON_ID,
      waiver_version_id: ACTIVE_ID,
      typed_name: "Dana Rivers",
      acknowledged: true,
    } satisfies SignWaiverInput);
  });

  it("never carries a typed name from one person's lookup to the next", () => {
    renderScreen({ role: "front_desk" });
    const idInput = screen.getByLabelText("Person ID");

    fireEvent.change(idInput, { target: { value: PERSON_ID } });
    fireEvent.click(screen.getByRole("button", { name: "Look up status" }));
    fireEvent.change(screen.getByLabelText("Typed full name"), {
      target: { value: "Dana Rivers" },
    });

    // Look up a different person — the signature field must reset to empty.
    const OTHER_PERSON = "d4444444-4444-4444-8444-444444444444";
    fireEvent.change(idInput, { target: { value: OTHER_PERSON } });
    fireEvent.click(screen.getByRole("button", { name: "Look up status" }));
    expect((screen.getByLabelText("Typed full name") as HTMLInputElement).value).toBe("");
  });
});

describe("WaiversScreen — role gating", () => {
  it("hides version-management actions from front_desk but keeps desk capture", () => {
    renderScreen({ role: "front_desk" });
    // No version-management affordances.
    expect(screen.queryByRole("button", { name: "New version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Activate version 1" })).toBeNull();
    // But desk capture is fully available.
    expect(screen.getByLabelText("Person ID")).toBeDefined();
    expect(screen.getByRole("button", { name: "Look up status" })).toBeDefined();
  });

  it("gives owner both the new-version form and per-version activate actions", () => {
    renderScreen({ role: "owner" });
    expect(screen.getByRole("button", { name: "New version" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Activate version 1" })).toBeDefined();
  });
});

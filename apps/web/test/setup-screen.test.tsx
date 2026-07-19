// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { SetupScreen, type SetupScreenProps } from "../src/screens/setup-screen.jsx";

afterEach(cleanup);

const READINESS_META = {
  as_of: "2026-07-19T12:00:00.000Z",
  source: "mixed",
  stale: false,
  definition_version: "readiness:v1",
  correlation_id: "corr-readiness",
};
const AUTHORITY_META = {
  as_of: "2026-07-19T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "authority:v1",
  correlation_id: "corr-authority",
};

function success(data: unknown, meta: unknown): BoundaryQuery {
  return { status: "success", data: { data, meta }, isRefetching: false, refetch: vi.fn() };
}

// --- fixtures (all obviously synthetic) --------------------------------------

type GateStatus = "pass" | "fail" | "warn";
function gate(
  key: string,
  hard: boolean,
  status: GateStatus,
  evidence: { counts?: Record<string, number>; as_of?: string | null; detail?: string | null } = {},
) {
  return {
    key,
    hard,
    status,
    evidence: {
      counts: evidence.counts ?? { items: 1 },
      as_of: evidence.as_of ?? "2026-07-19T10:00:00.000Z",
      detail: evidence.detail ?? null,
    },
    acknowledged: null,
  };
}

const MIXED_GATES = [
  gate("roles_assigned", true, "warn", {
    counts: { active_members: 1 },
    as_of: null,
    detail: "single-operator studio — no delegate to cover the owner",
  }),
  gate("resources_configured", true, "pass", {
    counts: { resources: 1, offering_templates: 1 },
    as_of: null,
  }),
  gate("native_booking_exercised", false, "warn", {
    counts: { bookings: 0 },
    as_of: null,
    detail: "no native booking rung yet — exercise the booking flow before opening",
  }),
  gate("plans_configured", true, "pass", { counts: { plans: 1 }, as_of: null }),
  gate("reconciliation_green", true, "pass", {
    counts: { runs: 12, entities: 4, variances: 0 },
    as_of: "2026-07-19T11:00:00.000Z",
  }),
  gate("payment_verified", true, "fail", {
    counts: { succeeded: 0 },
    as_of: null,
    detail: "no SUCCEEDED payment yet — take one live/test charge to verify the money path",
  }),
  gate("active_waiver", true, "pass", {
    counts: { active: 1 },
    as_of: "2026-07-18T09:00:00.000Z",
  }),
  gate("delivery_tested", true, "pass", {
    counts: { delivered: 1 },
    as_of: "2026-07-19T08:00:00.000Z",
  }),
];

const STAGES = [
  { key: "studio_team", label: "Studio & team", gate_keys: ["roles_assigned"], complete: true },
  {
    key: "rooms_services",
    label: "Rooms & services",
    gate_keys: ["resources_configured", "native_booking_exercised"],
    complete: true,
  },
  {
    key: "plans_prices_tax",
    label: "Plans, prices & tax",
    gate_keys: ["plans_configured"],
    complete: true,
  },
  {
    key: "import_reconciliation",
    label: "Import & reconciliation",
    gate_keys: ["reconciliation_green"],
    complete: true,
  },
  {
    key: "payments_waivers_launch",
    label: "Payments, waivers & launch readiness",
    gate_keys: ["payment_verified", "active_waiver", "delivery_tested"],
    complete: false,
  },
];

const MIXED_READINESS = { gates: MIXED_GATES, stages: STAGES };

const ALL_PASS_READINESS = {
  gates: MIXED_GATES.map((g) => ({ ...g, status: "pass" as const })),
  stages: STAGES.map((s) => ({ ...s, complete: true })),
};

const ALL_GLOFOX_MATRIX = {
  matrix: [
    "people",
    "bookings",
    "schedule",
    "memberships",
    "payments",
    "comms",
    "waivers",
    "retail",
  ].map((domain) => ({ domain, authority: "glofox" as const, flipped_at: null, reason: null })),
};

function renderSetup(
  overrides: Partial<SetupScreenProps> = {},
  readiness: unknown = MIXED_READINESS,
  matrix: unknown = ALL_GLOFOX_MATRIX,
) {
  const onAcknowledge = vi
    .fn()
    .mockResolvedValue({ at: "2026-07-19T12:01:00.000Z", note: "noted for audit" });
  const onFlip = vi
    .fn()
    .mockResolvedValue({ id: "ffffffff-1111-4111-8111-ffffffffffff", domain: "payments", authority: "kelo" });
  const onVerifyStepUp = vi
    .fn()
    .mockResolvedValue({ grantToken: "signed-grant", expiresAt: "2026-07-19T12:05:00.000Z" });
  const props: SetupScreenProps = {
    role: "owner",
    readinessQuery: success(readiness, READINESS_META),
    authorityQuery: success(matrix, AUTHORITY_META),
    onAcknowledge,
    onFlip,
    onVerifyStepUp,
    ...overrides,
  };
  render(<SetupScreen {...props} />);
  return { onAcknowledge, onFlip, onVerifyStepUp };
}

describe("SetupScreen — launch readiness", () => {
  it("renders the five stages with pass/fail/warn pills from the mocked envelope", () => {
    renderSetup();
    for (const label of [
      "Studio & team",
      "Rooms & services",
      "Plans, prices & tax",
      "Import & reconciliation",
      "Payments, waivers & launch readiness",
    ]) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(
      within(screen.getByTestId("gate-reconciliation_green")).getByTestId("status-pill-pass"),
    ).toBeDefined();
    expect(
      within(screen.getByTestId("gate-native_booking_exercised")).getByTestId("status-pill-warn"),
    ).toBeDefined();
    expect(
      within(screen.getByTestId("gate-payment_verified")).getByTestId("status-pill-fail"),
    ).toBeDefined();
  });

  it("a hard failing gate marks its stage incomplete and blocks ready-to-launch", () => {
    renderSetup();
    const verdict = screen.getByTestId("launch-verdict");
    expect(verdict.textContent).toContain("Not ready to launch");
    expect(verdict.textContent).toContain("Payment verified");
    // The stage header reads the SERVER's complete flag (false here).
    const stage = screen.getByTestId("stage-payments_waivers_launch");
    const header = stage.querySelector("header") as HTMLElement;
    expect(within(header).getByTestId("status-pill-fail")).toBeDefined();
  });

  it("every hard gate passing renders the ready-to-launch verdict", () => {
    renderSetup({}, ALL_PASS_READINESS);
    expect(screen.getByTestId("launch-verdict").textContent).toContain("Ready to launch");
  });

  it("reads the verdict from server stage.complete, not a client hard-and-fail re-derivation", () => {
    // Review finding (7.1c): the verdict must read the server-owned
    // stage.complete, never recompute the blocking policy. Construct the
    // divergence: NO gate is hard-and-fail (a client rule of
    // `gates.filter(g => g.hard && g.status === 'fail')` would yield [] and
    // declare "ready"), yet a SOFT gate fails so the server marks its stage
    // incomplete. The server verdict is NOT ready; the client must agree.
    const softFailReadiness = {
      gates: [
        gate("resources_configured", true, "pass", { counts: { resources: 1 }, as_of: null }),
        // soft (hard:false) gate in FAIL — invisible to a hard-and-fail rule.
        gate("native_booking_exercised", false, "fail", {
          counts: { bookings: 0 },
          as_of: null,
          detail: "synthetic: a soft gate the server treats as blocking",
        }),
      ],
      stages: [
        { key: "rooms_services", label: "Rooms & services", gate_keys: ["resources_configured"], complete: true },
        {
          key: "payments_waivers_launch",
          label: "Payments, waivers & launch readiness",
          gate_keys: ["native_booking_exercised"],
          complete: false, // server: a failing gate (hard or not) blocks the stage
        },
      ],
    };
    renderSetup({}, softFailReadiness);
    const verdict = screen.getByTestId("launch-verdict");
    expect(verdict.textContent).toContain("Not ready to launch");
    expect(verdict.textContent).not.toContain("Ready to launch — every hard launch gate passes");
  });

  it("shows the acknowledge affordance ONLY for soft warn gates", () => {
    renderSetup();
    // Soft warn gate → the affordance exists.
    const softRow = screen.getByTestId("gate-native_booking_exercised");
    const acknowledge = within(softRow).getByRole("button", { name: "Acknowledge" });
    expect((acknowledge as HTMLButtonElement).disabled).toBe(true);
    // Hard warn gate (single-operator) → NO affordance; it is not acknowledgeable.
    const hardRow = screen.getByTestId("gate-roles_assigned");
    expect(within(hardRow).queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });

  it("requires a non-empty note and keeps the gate a warn after acknowledging", async () => {
    const { onAcknowledge } = renderSetup();
    const softRow = screen.getByTestId("gate-native_booking_exercised");
    const noteInput = within(softRow).getByLabelText("Acknowledge with note");
    const acknowledge = within(softRow).getByRole("button", { name: "Acknowledge" });

    // Empty note → the affordance stays inert.
    fireEvent.click(acknowledge);
    expect(onAcknowledge).not.toHaveBeenCalled();

    fireEvent.change(noteInput, { target: { value: "Opening without a rehearsal booking is accepted" } });
    fireEvent.click(acknowledge);
    await waitFor(() =>
      expect(onAcknowledge).toHaveBeenCalledWith(
        "native_booking_exercised",
        "Opening without a rehearsal booking is accepted",
        expect.any(String),
      ),
    );

    // Acknowledge ≠ resolve: the gate still renders WARN (not hidden, not passed).
    expect(await within(softRow).findByTestId("ack-recorded-native_booking_exercised")).toBeDefined();
    expect(within(softRow).getByTestId("status-pill-warn")).toBeDefined();
    expect(within(softRow).queryByTestId("status-pill-pass")).toBeNull();
  });

  it("renders a previously-recorded acknowledgement note on a still-warn gate", () => {
    const withAck = {
      gates: MIXED_GATES.map((g) =>
        g.key === "native_booking_exercised"
          ? { ...g, acknowledged: { at: "2026-07-19T11:30:00.000Z", note: "accepted for launch week" } }
          : g,
      ),
      stages: STAGES,
    };
    renderSetup({}, withAck);
    const softRow = screen.getByTestId("gate-native_booking_exercised");
    expect(within(softRow).getByTestId("status-pill-warn")).toBeDefined();
    expect(within(softRow).getByTestId("ack-native_booking_exercised").textContent).toContain(
      "accepted for launch week",
    );
    // Already acknowledged → no second ack form.
    expect(within(softRow).queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });
});

describe("SetupScreen — authority matrix", () => {
  it("renders all 8 domains with their current authority", () => {
    renderSetup();
    for (const domain of [
      "people",
      "bookings",
      "schedule",
      "memberships",
      "payments",
      "comms",
      "waivers",
      "retail",
    ]) {
      const row = screen.getByTestId(`authority-row-${domain}`);
      expect(within(row).getByTestId(`authority-current-${domain}`).textContent).toContain("glofox");
    }
  });

  it("an owner flip requires a reason + step-up, and NEVER flips optimistically", async () => {
    const { onFlip, onVerifyStepUp } = renderSetup();
    const row = screen.getByTestId("authority-row-payments");
    fireEvent.click(within(row).getByRole("button", { name: "Flip to Kelo" }));

    // Reason is mandatory before the ceremony can even start.
    const submit = within(row).getByRole("button", { name: "Flip to Kelo" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(row).getByLabelText(/Reason/), {
      target: { value: "Kelo booking ledger verified for two weeks" },
    });
    fireEvent.click(submit);

    // No flip posts until the owner PIN ceremony grants.
    expect(onFlip).not.toHaveBeenCalled();
    const pin = screen.getByLabelText("Personal PIN") as HTMLInputElement;
    fireEvent.change(pin, { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify PIN" }));

    await waitFor(() => expect(onVerifyStepUp).toHaveBeenCalledWith("1234", "authority_flip"));
    await waitFor(() =>
      expect(onFlip).toHaveBeenCalledWith(
        {
          domain: "payments",
          authority: "kelo",
          reason: "Kelo booking ledger verified for two weeks",
          evidenceUrl: undefined,
        },
        "signed-grant",
        expect.any(String),
      ),
    );

    // NO optimistic update: the row still renders the last SERVER-CONFIRMED
    // authority (the query data did not change).
    expect(await within(row).findByTestId("flip-confirmed-payments")).toBeDefined();
    expect(within(row).getByTestId("authority-current-payments").textContent).toContain("glofox");
  });

  it("a manager sees the matrix read-only — no flip buttons, no ack affordance", () => {
    renderSetup({ role: "manager" });
    expect(screen.queryByRole("button", { name: /flip to/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    // …but the data itself renders.
    expect(screen.getByTestId("authority-row-people")).toBeDefined();
    expect(screen.getByTestId("gate-payment_verified")).toBeDefined();
  });
});

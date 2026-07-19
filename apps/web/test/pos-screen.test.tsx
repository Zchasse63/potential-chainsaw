// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { PosScreen, type PosScreenProps } from "../src/screens/pos-screen.jsx";

afterEach(cleanup);

const META = {
  as_of: "2026-07-19T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "pos-catalog:v1",
  correlation_id: "corr-pos",
};
function success(data: unknown): BoundaryQuery {
  return { status: "success", data: { data, meta: META }, isRefetching: false, refetch: vi.fn() };
}

const CATALOG = {
  retail_products: [
    { id: "ret-1", name: "Recovery towel", sku: "TWL-01", price_cents: 3500, active: true },
  ],
  gift_card_products: [{ id: "gc-1", name: "Fifty", amount_cents: 5000, active: true }],
  drop_in_plans: [{ id: "plan-1", name: "Single class", amount_cents: 2500, currency: "usd" }],
};

function renderPos(overrides: Partial<PosScreenProps> = {}) {
  const onCheckout = vi
    .fn()
    .mockResolvedValue({ payment_id: "pay-1", order_id: "ord-1", gift_card_codes: ["ABCD-EFGH-JKMN-PQRS"] });
  const onRedeem = vi.fn().mockResolvedValue({ gift_card_id: "gc-issued-1", balance_cents: 4200 });
  const props: PosScreenProps = {
    catalogQuery: success(CATALOG),
    onCheckout,
    onRedeem,
    ...overrides,
  };
  render(<PosScreen {...props} />);
  return { onCheckout, onRedeem };
}

describe("PosScreen", () => {
  it("labels the client subtotal as display-only — the final total is computed at sale", () => {
    renderPos();
    fireEvent.click(screen.getByRole("button", { name: /Recovery towel/ }));
    expect(screen.getByTestId("pos-total-disclaimer").textContent?.toLowerCase()).toContain(
      "final total is computed at sale",
    );
  });

  it("checks out with SERVER-PRICED line refs only — never a client price — and carries a member", async () => {
    const { onCheckout } = renderPos();
    fireEvent.click(screen.getByRole("button", { name: /Recovery towel/ }));
    fireEvent.click(screen.getByRole("button", { name: /Single class/ }));
    fireEvent.change(document.querySelector("#pos-person") as HTMLInputElement, {
      target: { value: "person-42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Take cash payment" }));

    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(1));
    const request = onCheckout.mock.calls[0]?.[0] as {
      lines: Record<string, unknown>[];
    };
    expect(request).toEqual({
      person_id: "person-42",
      tender: "cash",
      lines: [
        { kind: "retail", ref: "ret-1", qty: 1 },
        { kind: "drop_in", ref: "plan-1", qty: 1 },
      ],
    });
    // No line carries a price — prices belong to the server.
    for (const line of request.lines) {
      expect(line).not.toHaveProperty("price_cents");
      expect(line).not.toHaveProperty("unitCents");
    }
  });

  it("reveals the one-time gift-card code exactly once with a shown-once warning", async () => {
    renderPos();
    fireEvent.click(screen.getByRole("button", { name: /Fifty/ }));
    fireEvent.click(screen.getByRole("button", { name: "Take cash payment" }));

    expect(await screen.findByText("ABCD-EFGH-JKMN-PQRS")).toBeDefined();
    expect(screen.getByTestId("gift-code-warning").textContent?.toLowerCase()).toContain(
      "shown once",
    );
  });

  it("redeems a gift card and shows the new balance", async () => {
    const { onRedeem } = renderPos();
    fireEvent.change(document.querySelector("#redeem-code") as HTMLInputElement, {
      target: { value: "WXYZ-1234-5678-ABCD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Redeem" }));

    await waitFor(() => expect(onRedeem).toHaveBeenCalledWith("WXYZ-1234-5678-ABCD"));
    expect(await screen.findByText(/new balance \$42\.00/)).toBeDefined();
  });
});

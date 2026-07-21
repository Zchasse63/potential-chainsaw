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
function errorQuery(): BoundaryQuery {
  return { status: "error", data: undefined, isRefetching: false, refetch: vi.fn() };
}
function pendingQuery(): BoundaryQuery {
  return { status: "pending", data: undefined, isRefetching: false, refetch: vi.fn() };
}
// A success payload WITHOUT the freshness envelope meta — the money surface
// must refuse to price a sale off an unprovenanced catalog (invariant #3).
function metaLessQuery(data: unknown): BoundaryQuery {
  return { status: "success", data: { data }, isRefetching: false, refetch: vi.fn() };
}

const CATALOG = {
  retail_products: [
    { id: "ret-1", name: "Recovery towel", sku: "TWL-01", price_cents: 3500, active: true },
  ],
  gift_card_products: [{ id: "gc-1", name: "Fifty", amount_cents: 5000, active: true }],
  drop_in_plans: [{ id: "plan-1", name: "Single class", amount_cents: 2500, currency: "usd" }],
};

const CHECKOUT_OK = {
  payment_id: "pay-1",
  order_id: "ord-1",
  gift_card_codes: [{ card_id: "gc-issued-1", code: "ABCD-EFGH-JKMN-PQRS" }],
};

function renderPos(overrides: Partial<PosScreenProps> = {}) {
  const onCheckout = vi.fn().mockResolvedValue(CHECKOUT_OK);
  const onRedeem = vi
    .fn()
    .mockResolvedValue({ gift_card_id: "gc-issued-1", redeemed_cents: 800, balance_cents: 4200 });
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

  // W1 regression: the posted line field is ref_id (the API zod schema's field),
  // NOT ref — a body with `ref` 422s server-side on every cash sale.
  it("checks out with SERVER-PRICED line refs only (ref_id, never a client price) and carries a member", async () => {
    const { onCheckout } = renderPos();
    fireEvent.click(screen.getByRole("button", { name: /Recovery towel/ }));
    fireEvent.click(screen.getByRole("button", { name: /Single class/ }));
    fireEvent.change(document.querySelector("#pos-person") as HTMLInputElement, {
      target: { value: "person-42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Take cash payment" }));

    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(1));
    const request = onCheckout.mock.calls[0]?.[0] as { lines: Record<string, unknown>[] };
    expect(request).toEqual({
      person_id: "person-42",
      tender: "cash",
      lines: [
        { kind: "retail", ref_id: "ret-1", qty: 1 },
        { kind: "drop_in", ref_id: "plan-1", qty: 1 },
      ],
    });
    // Each posted line carries ref_id (the API contract) and no client price.
    for (const line of request.lines) {
      expect(line).toHaveProperty("ref_id");
      expect(line).not.toHaveProperty("ref");
      expect(line).not.toHaveProperty("price_cents");
      expect(line).not.toHaveProperty("unitCents");
    }
    // A per-intent idempotency key rides the second argument.
    expect(typeof onCheckout.mock.calls[0]?.[1]).toBe("string");
  });

  // W2 regression: the confirm step offers a gift-card tender that posts
  // tender:'gift_card' + the raw code (server settles + raises on over-redeem).
  it("settles a sale on a gift card with tender='gift_card' + the card code", async () => {
    const { onCheckout } = renderPos();
    fireEvent.click(screen.getByRole("button", { name: /Recovery towel/ }));
    fireEvent.click(screen.getByTestId("pos-tender-gift_card"));
    fireEvent.change(document.querySelector("#pos-gift-card-code") as HTMLInputElement, {
      target: { value: "GIFT-1111-2222-3333" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Settle on gift card" }));

    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(1));
    expect(onCheckout.mock.calls[0]?.[0]).toEqual({
      person_id: null,
      tender: "gift_card",
      gift_card_code: "GIFT-1111-2222-3333",
      lines: [{ kind: "retail", ref_id: "ret-1", qty: 1 }],
    });
  });

  it("blocks a gift-card settlement until a code is entered", () => {
    const { onCheckout } = renderPos();
    fireEvent.click(screen.getByRole("button", { name: /Recovery towel/ }));
    fireEvent.click(screen.getByTestId("pos-tender-gift_card"));
    const button = screen.getByRole("button", { name: "Settle on gift card" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onCheckout).not.toHaveBeenCalled();
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

  // W3 regression: a failed-then-retried checkout REUSES its idempotency key
  // (no double charge); a new cart after success mints a DIFFERENT one.
  it("reuses ONE idempotency key across a failed-then-retried sale and rotates it for the next", async () => {
    const onCheckout = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValue(CHECKOUT_OK);
    renderPos({ onCheckout });

    // Intent 1: fails, then the operator retries the SAME sale.
    fireEvent.click(screen.getByRole("button", { name: /Recovery towel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Take cash payment" }));
    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Take cash payment" }));
    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(2));

    const key1 = onCheckout.mock.calls[0]?.[1] as string;
    const key2 = onCheckout.mock.calls[1]?.[1] as string;
    expect(key1).toBe(key2); // the retry replays — it never rings a second order

    // Intent 2: a new sale after the confirmed success mints a fresh key.
    fireEvent.click(screen.getByRole("button", { name: /Recovery towel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Take cash payment" }));
    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(3));
    const key3 = onCheckout.mock.calls[2]?.[1] as string;
    expect(key3).not.toBe(key2);
  });

  // W2 regression: redeem posts the amount and its per-intent key; the result
  // shows the redeemed amount and the new balance.
  it("redeems a gift card for a specific amount and shows the redeemed amount + new balance", async () => {
    const { onRedeem } = renderPos();
    fireEvent.change(document.querySelector("#redeem-code") as HTMLInputElement, {
      target: { value: "WXYZ-1234-5678-ABCD" },
    });
    fireEvent.change(document.querySelector("#redeem-amount") as HTMLInputElement, {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Redeem" }));

    await waitFor(() =>
      expect(onRedeem).toHaveBeenCalledWith("WXYZ-1234-5678-ABCD", 800, expect.any(String)),
    );
    expect(await screen.findByText(/Redeemed \$8\.00/)).toBeDefined();
    expect(screen.getByText(/new balance \$42\.00/)).toBeDefined();
  });

  it("blocks a redemption until both a code and a positive amount are entered", () => {
    const { onRedeem } = renderPos();
    fireEvent.change(document.querySelector("#redeem-code") as HTMLInputElement, {
      target: { value: "WXYZ-1234-5678-ABCD" },
    });
    const button = screen.getByRole("button", { name: "Redeem" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onRedeem).not.toHaveBeenCalled();
  });
});

  // Re-review blocker B2a: the idempotency key is PER-INTENT — an EDITED cart
  // after a failure is a NEW intent and must post a DIFFERENT key (the same key
  // with different content would 409 against the server hash-check and lock the
  // till out of the sale).
  it("rotates the idempotency key when the cart changes after a failed attempt", async () => {
    const { onCheckout } = renderPos();
    onCheckout.mockRejectedValueOnce(new Error("network dropped"));
    fireEvent.click(screen.getByRole("button", { name: /Recovery towel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Take cash payment" }));
    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(1));
    const firstKey = onCheckout.mock.calls[0]?.[1] as string;

    // Edit the cart (add another item) — a new intent.
    fireEvent.click(screen.getByRole("button", { name: /Recovery towel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Take cash payment" }));
    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(2));
    const secondKey = onCheckout.mock.calls[1]?.[1] as string;

    expect(typeof firstKey).toBe("string");
    expect(typeof secondKey).toBe("string");
    expect(secondKey).not.toBe(firstKey);
  });

// WS-8c — invariant #3 on the POS money surface: no catalog item (and thus no
// sale) may be priced off a query that errored, is still loading, or arrived
// without its freshness envelope.
describe("PosScreen — catalog provenance refusal (WS-8c, invariant #3)", () => {
  it("shows no catalog item when the catalog query ERRORED (states no sale can start)", () => {
    renderPos({ catalogQuery: errorQuery() });
    expect(screen.queryByText(/Recovery towel/)).toBeNull();
    expect(screen.getByText(/catalog didn't load; no sale can be started/i)).toBeDefined();
  });

  it("shows no catalog item while the catalog query is PENDING", () => {
    renderPos({ catalogQuery: pendingQuery() });
    expect(screen.queryByText(/Recovery towel/)).toBeNull();
  });

  it("REFUSES a meta-less catalog — never prices a sale without provenance", () => {
    renderPos({ catalogQuery: metaLessQuery(CATALOG) });
    expect(screen.queryByText(/Recovery towel/)).toBeNull();
    expect(screen.getByText(/provenance record is missing/i)).toBeDefined();
  });
});

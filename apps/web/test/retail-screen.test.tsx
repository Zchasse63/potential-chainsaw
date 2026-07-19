// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { RetailScreen, type RetailScreenProps } from "../src/screens/retail-screen.jsx";

afterEach(cleanup);

const META = {
  as_of: "2026-07-18T18:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "retail:v1",
  correlation_id: "corr-retail",
};
function success(data: unknown): BoundaryQuery {
  return { status: "success", data: { data, meta: META }, isRefetching: false, refetch: vi.fn() };
}

function renderRetail(overrides: Partial<RetailScreenProps> = {}) {
  const onCreateProduct = vi.fn().mockResolvedValue(undefined);
  const onUpdateProduct = vi.fn().mockResolvedValue(undefined);
  const onCreateGiftCardProduct = vi.fn().mockResolvedValue(undefined);
  const onGrant = vi
    .fn()
    .mockResolvedValue({ card_id: "card-1", code: "ABCD-EFGH-JKMN-PQRS", amount_cents: 5000 });
  const props: RetailScreenProps = {
    productsQuery: success({
      products: [
        { id: "p1", name: "Recovery towel", sku: "TWL-01", price_cents: 3500, tax_category: "goods", active: true, created_at: "2026-07-18T00:00:00.000Z" },
      ],
    }),
    giftCardProductsQuery: success({
      gift_card_products: [{ id: "g1", name: "Fifty", amount_cents: 5000, active: true, created_at: "2026-07-18T00:00:00.000Z" }],
    }),
    giftCardsQuery: success({
      gift_cards: [{ id: "abcdef12-3456-4789-8abc-def012345678", issued_to_person_id: null, status: "active", created_at: "2026-07-18T00:00:00.000Z", balance_cents: 4200 }],
    }),
    onCreateProduct,
    onUpdateProduct,
    onCreateGiftCardProduct,
    onGrant,
    ...overrides,
  };
  render(<RetailScreen {...props} />);
  return { onCreateProduct, onUpdateProduct, onCreateGiftCardProduct, onGrant };
}

describe("RetailScreen", () => {
  it("renders the catalog, denominations, and issued balances from their envelopes", () => {
    renderRetail();
    expect(screen.getByText("Recovery towel")).toBeDefined();
    expect(screen.getByText("$35.00")).toBeDefined();
    expect(screen.getByText("Fifty")).toBeDefined();
    // Issued card shows its ledger-summed balance, never a mutable column.
    expect(screen.getByText("$42.00")).toBeDefined();
  });

  it("comps a gift card in cents and reveals the one-time code exactly once", async () => {
    const { onGrant } = renderRetail();
    const amountInput = document.querySelector("#comp-amount") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "50" } });
    fireEvent.change(document.querySelector("#comp-reason") as HTMLInputElement, {
      target: { value: "loyalty" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comp gift card" }));

    await waitFor(() =>
      expect(onGrant).toHaveBeenCalledWith({ amount_cents: 5000, person_id: null, reason: "loyalty" }),
    );
    expect(await screen.findByText("ABCD-EFGH-JKMN-PQRS")).toBeDefined();
    expect(screen.getByText(/shown once/)).toBeDefined();
  });

  it("adds a retail product with the dollar amount converted to cents", async () => {
    const { onCreateProduct } = renderRetail();
    fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    fireEvent.change(document.querySelector("#retail-name") as HTMLInputElement, {
      target: { value: "Sauna hat" },
    });
    fireEvent.change(document.querySelector("#retail-price") as HTMLInputElement, {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add product" }));

    await waitFor(() =>
      expect(onCreateProduct).toHaveBeenCalledWith({
        name: "Sauna hat",
        sku: null,
        price_cents: 2000,
        tax_category: null,
        active: true,
      }),
    );
  });
});

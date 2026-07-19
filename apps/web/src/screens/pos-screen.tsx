import { useMemo, useState, type FormEvent } from "react";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import type {
  CheckoutLine,
  CheckoutRequest,
  CheckoutResult,
  LineKind,
  PosCatalog,
  RedeemResult,
} from "../lib/pos.js";

/**
 * Point of sale — the minimal CASH checkout (unit 5.8; UX plan §3D cash-day
 * reality). Owner/manager/front_desk. A presentational screen: catalog, cart,
 * checkout, and redeem are all injected so it is unit-testable without a
 * network.
 *
 * SERVER-PRICED DISCIPLINE (invariant #5): a cart line posts { kind, ref, qty }
 * — a catalog id and a quantity, NEVER a price. The client-side subtotal is
 * DISPLAY-ONLY and labelled "final total computed at sale"; the checkout RPC
 * re-prices from the catalog. There is NO optimistic sale: the order and its
 * one-time gift-card codes are shown ONLY from the confirmed checkout response.
 */

export interface CartLine {
  key: string;
  kind: LineKind;
  ref: string;
  name: string;
  unitCents: number;
  qty: number;
}

export interface PosScreenProps {
  catalogQuery: BoundaryQuery;
  onCheckout: (request: CheckoutRequest) => Promise<CheckoutResult>;
  onRedeem: (code: string) => Promise<RedeemResult>;
}

const INPUT_CLASS =
  "h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600";
const LABEL_CLASS = "block text-body font-medium text-ink";
const FIELD_HINT = "font-mono text-micro uppercase tracking-wide text-ink-muted";

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const KIND_LABEL: Record<LineKind, string> = {
  retail: "Retail",
  gift_card: "Gift card",
  drop_in: "Drop-in",
};

function CatalogPicker({
  catalog,
  onAdd,
}: {
  catalog: PosCatalog;
  onAdd: (line: Omit<CartLine, "key" | "qty">) => void;
}) {
  const groups: { kind: LineKind; heading: string; items: { ref: string; name: string; unitCents: number }[] }[] = [
    {
      kind: "retail",
      heading: "Retail",
      items: catalog.retail_products.map((product) => ({
        ref: product.id,
        name: product.name,
        unitCents: product.price_cents,
      })),
    },
    {
      kind: "gift_card",
      heading: "Gift cards",
      items: catalog.gift_card_products.map((product) => ({
        ref: product.id,
        name: product.name,
        unitCents: product.amount_cents,
      })),
    },
    {
      kind: "drop_in",
      heading: "Drop-ins",
      items: catalog.drop_in_plans.map((plan) => ({
        ref: plan.id,
        name: plan.name,
        unitCents: plan.amount_cents,
      })),
    },
  ];

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.kind} aria-labelledby={`pos-group-${group.kind}`} className="space-y-2">
          <h3 id={`pos-group-${group.kind}`} className={FIELD_HINT}>
            {group.heading}
          </h3>
          {group.items.length === 0 ? (
            <p className="text-body text-ink-muted">Nothing sellable in this group yet.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {group.items.map((item) => (
                <li key={item.ref}>
                  <button
                    type="button"
                    onClick={() =>
                      onAdd({ kind: group.kind, ref: item.ref, name: item.name, unitCents: item.unitCents })
                    }
                    className="flex w-full items-center justify-between gap-2 rounded-2 border border-hairline bg-surface-card px-3 py-2 text-left hover:bg-neutral-050"
                  >
                    <span className="text-body text-ink">{item.name}</span>
                    <span className="font-mono text-table text-ink-secondary">
                      {formatCents(item.unitCents)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function Cart({
  lines,
  personId,
  discount,
  pending,
  error,
  onQty,
  onRemove,
  onPersonId,
  onDiscount,
  onConfirm,
}: {
  lines: CartLine[];
  personId: string;
  discount: string;
  pending: boolean;
  error: string | null;
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onPersonId: (value: string) => void;
  onDiscount: (value: string) => void;
  onConfirm: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const subtotal = lines.reduce((sum, line) => sum + line.unitCents * line.qty, 0);

  return (
    <form className="space-y-4 rounded-3 border border-hairline bg-surface-card p-4" onSubmit={onConfirm}>
      <h2 className="font-display text-title font-bold text-ink">Cart</h2>
      {lines.length === 0 ? (
        <p className="text-body text-ink-muted">Add catalog items to start a sale.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {lines.map((line) => (
            <li key={line.key} className="flex items-center justify-between gap-2 py-2">
              <div>
                <p className="text-body text-ink">{line.name}</p>
                <p className={FIELD_HINT}>
                  {KIND_LABEL[line.kind]} · {formatCents(line.unitCents)} each
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor={`qty-${line.key}`}>
                  Quantity for {line.name}
                </label>
                <input
                  id={`qty-${line.key}`}
                  type="number"
                  min={1}
                  max={999}
                  value={line.qty}
                  onChange={(event) => onQty(line.key, Math.max(1, Math.floor(Number(event.target.value) || 1)))}
                  className="h-9 w-16 rounded-2 border border-input-border bg-surface-input px-2 text-body text-ink"
                />
                <Button variant="ghost" className="h-9" onClick={() => onRemove(line.key)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor="pos-person">
            Member <span className={FIELD_HINT}>optional</span>
          </label>
          <input
            id="pos-person"
            className={INPUT_CLASS}
            value={personId}
            onChange={(event) => onPersonId(event.target.value)}
            placeholder="person id (uuid)"
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="pos-discount">
            Discount <span className={FIELD_HINT}>USD, optional</span>
          </label>
          <input
            id="pos-discount"
            inputMode="decimal"
            className={INPUT_CLASS}
            value={discount}
            onChange={(event) => onDiscount(event.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>

      <div className="rounded-2 border border-dashed border-hairline bg-surface-app px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-body text-ink-secondary">Provisional subtotal</span>
          <span className="font-mono text-table font-medium text-ink">{formatCents(subtotal)}</span>
        </div>
        <p className="mt-1 text-body text-ink-muted" data-testid="pos-total-disclaimer">
          Display only — the final total is computed at sale from server prices.
        </p>
      </div>

      {error !== null && (
        <p role="alert" className="text-body text-danger-on-tint">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className={FIELD_HINT}>Tender · cash</span>
        <Button type="submit" disabled={lines.length === 0 || pending}>
          {pending ? "Ringing…" : "Take cash payment"}
        </Button>
      </div>
    </form>
  );
}

function SaleSuccess({
  result,
  onNewSale,
}: {
  result: CheckoutResult;
  onNewSale: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const codes = result.gift_card_codes ?? [];

  return (
    <div role="status" className="space-y-4 rounded-3 border border-success-border bg-success-tint p-5">
      <div>
        <p className="text-body font-medium text-success-on-tint">Cash sale complete.</p>
        <p className="mt-1 font-mono text-table text-success-on-tint">
          Order {result.order_id.slice(0, 8)}… · Payment {result.payment_id.slice(0, 8)}…
        </p>
      </div>

      {codes.length > 0 && (
        <div className="space-y-2">
          <p className="text-body font-medium text-success-on-tint">
            Gift-card {codes.length === 1 ? "code" : "codes"} — hand over now.
          </p>
          <p className="text-body text-success-on-tint" data-testid="gift-code-warning">
            Each code is shown once and cannot be retrieved again — the server keeps only its hash.
          </p>
          <ul className="space-y-2">
            {codes.map((code) => (
              <li
                key={code}
                className="flex items-center justify-between gap-2 rounded-2 border border-success-border bg-surface-card px-3 py-2"
              >
                <span className="select-all font-mono text-body font-bold tracking-widest text-ink">
                  {code}
                </span>
                <Button
                  variant="ghost"
                  className="h-9"
                  onClick={() => {
                    void navigator.clipboard?.writeText(code);
                    setCopied(code);
                  }}
                >
                  {copied === code ? "Copied" : "Copy"}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Button variant="secondary" onClick={onNewSale}>
        New sale
      </Button>
    </div>
  );
}

function RedeemPanel({ onRedeem }: { onRedeem: (code: string) => Promise<RedeemResult> }) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RedeemResult | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (code.trim() === "" || pending) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      setResult(await onRedeem(code.trim()));
      setCode("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That code could not be redeemed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-3 rounded-3 border border-hairline bg-surface-card p-4" onSubmit={(event) => void submit(event)}>
      <h2 className="font-display text-title font-bold text-ink">Redeem a gift card</h2>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className={LABEL_CLASS} htmlFor="redeem-code">
            Gift-card code
          </label>
          <input
            id="redeem-code"
            className={INPUT_CLASS}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={code.trim() === "" || pending}>
          {pending ? "Checking…" : "Redeem"}
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-body text-danger-on-tint">
          {error}
        </p>
      )}
      {result !== null && (
        <div role="status" className="rounded-2 border border-success-border bg-success-tint px-3 py-2">
          <p className="text-body font-medium text-success-on-tint">
            Redeemed — new balance {formatCents(result.balance_cents)}.
          </p>
        </div>
      )}
    </form>
  );
}

export function PosScreen({ catalogQuery, onCheckout, onRedeem }: PosScreenProps) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [personId, setPersonId] = useState("");
  const [discount, setDiscount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sale, setSale] = useState<CheckoutResult | null>(null);

  const nextKey = useMemo(() => {
    let counter = 0;
    return () => {
      counter += 1;
      return `line-${counter}-${Date.now()}`;
    };
  }, []);

  function addLine(line: Omit<CartLine, "key" | "qty">) {
    setSale(null);
    setLines((current) => {
      const existing = current.find((item) => item.kind === line.kind && item.ref === line.ref);
      if (existing !== undefined) {
        return current.map((item) =>
          item === existing ? { ...item, qty: item.qty + 1 } : item,
        );
      }
      return [...current, { ...line, key: nextKey(), qty: 1 }];
    });
  }

  function discountCents(): number | null {
    const trimmed = discount.trim();
    if (trimmed === "") return null;
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
    return Math.round(Number(trimmed) * 100);
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lines.length === 0 || pending) return;
    const parsedDiscount = discountCents();
    if (discount.trim() !== "" && parsedDiscount === null) {
      setError("The discount must be a dollar amount, or blank.");
      return;
    }
    setPending(true);
    setError(null);
    // Only server-priced refs cross the wire — NEVER a client unit price.
    const checkoutLines: CheckoutLine[] = lines.map((line) => ({
      kind: line.kind,
      ref: line.ref,
      qty: line.qty,
    }));
    try {
      const result = await onCheckout({
        person_id: personId.trim() === "" ? null : personId.trim(),
        lines: checkoutLines,
        tender: "cash",
        ...(parsedDiscount !== null ? { discount_cents: parsedDiscount } : {}),
      });
      setSale(result);
      setLines([]);
      setPersonId("");
      setDiscount("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The sale wasn't completed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-8">
      <header>
        <p className={FIELD_HINT}>Point of sale · cash checkout</p>
        <h1 className="mt-1 font-display text-hero font-bold tracking-tight text-ink">Point of sale</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">
          Ring up retail, gift cards, and drop-ins for cash. Prices are the server&apos;s — the till
          never sets them.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="Catalog" className="space-y-4">
          <DataBoundary<PosCatalog>
            name="pos-catalog"
            query={catalogQuery}
            skeleton={<Skeleton className="h-64 w-full rounded-3" />}
            errorConsequence="The catalog didn't load; no sale can be started."
            isEmpty={(data) =>
              data.retail_products.length === 0 &&
              data.gift_card_products.length === 0 &&
              data.drop_in_plans.length === 0
            }
            emptyState={
              <EmptyState
                title="Nothing to sell yet."
                body="Add retail products, gift-card denominations, or drop-in plans in Retail first."
              />
            }
          >
            {(catalog) => <CatalogPicker catalog={catalog} onAdd={addLine} />}
          </DataBoundary>
        </section>

        <section aria-label="Sale" className="space-y-6">
          {sale !== null ? (
            <SaleSuccess result={sale} onNewSale={() => setSale(null)} />
          ) : (
            <Cart
              lines={lines}
              personId={personId}
              discount={discount}
              pending={pending}
              error={error}
              onQty={(key, qty) =>
                setLines((current) => current.map((line) => (line.key === key ? { ...line, qty } : line)))
              }
              onRemove={(key) => setLines((current) => current.filter((line) => line.key !== key))}
              onPersonId={setPersonId}
              onDiscount={setDiscount}
              onConfirm={(event) => void confirm(event)}
            />
          )}
          <RedeemPanel onRedeem={onRedeem} />
        </section>
      </div>
    </div>
  );
}

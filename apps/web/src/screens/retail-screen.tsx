import { useState, type FormEvent } from "react";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { Skeleton } from "../components/skeleton.jsx";

/**
 * Retail — owner/manager catalog authoring plus MANUAL (comp) gift-card grants.
 * A presentational screen: every query and mutation is injected so the surface
 * is unit-testable without a network. The one-time redemption code is revealed
 * once after a grant and never re-fetched (the server keeps only its hash).
 */

export interface RetailProduct {
  id: string;
  name: string;
  sku: string | null;
  price_cents: number;
  tax_category: string | null;
  active: boolean;
  created_at: string;
}
export interface GiftCardProduct {
  id: string;
  name: string;
  amount_cents: number;
  active: boolean;
  created_at: string;
}
export interface IssuedGiftCard {
  id: string;
  issued_to_person_id: string | null;
  status: "active" | "void";
  created_at: string;
  balance_cents: number;
}

export interface ProductDraft {
  name: string;
  sku: string | null;
  price_cents: number;
  tax_category: string | null;
  active: boolean;
}
export interface GrantDraft {
  amount_cents: number;
  person_id: string | null;
  reason: string | null;
}
export interface GrantReveal {
  card_id: string;
  code: string;
  amount_cents: number;
}

export interface RetailScreenProps {
  productsQuery: BoundaryQuery;
  giftCardProductsQuery: BoundaryQuery;
  giftCardsQuery: BoundaryQuery;
  onCreateProduct: (input: ProductDraft) => Promise<void>;
  onUpdateProduct: (id: string, patch: ProductDraft) => Promise<void>;
  onCreateGiftCardProduct: (input: { name: string; amount_cents: number }) => Promise<void>;
  onGrant: (input: GrantDraft) => Promise<GrantReveal>;
}

const INPUT_CLASS =
  "h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600";
const LABEL_CLASS = "block text-body font-medium text-ink";
const FIELD_HINT = "font-mono text-micro uppercase tracking-wide text-ink-muted";

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Parse a dollars string to integer cents; null if not a non-negative number. */
function dollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || !/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

function ProductForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: RetailProduct;
  submitLabel: string;
  onSubmit: (draft: ProductDraft) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [sku, setSku] = useState(initial?.sku ?? "");
  const [price, setPrice] = useState(initial === undefined ? "" : (initial.price_cents / 100).toFixed(2));
  const [taxCategory, setTaxCategory] = useState(initial?.tax_category ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = dollarsToCents(price);
  const valid = name.trim().length > 0 && cents !== null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || cents === null) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        sku: sku.trim() === "" ? null : sku.trim(),
        price_cents: cents,
        tax_category: taxCategory.trim() === "" ? null : taxCategory.trim(),
        active,
      });
      if (initial === undefined) {
        setName("");
        setSku("");
        setPrice("");
        setTaxCategory("");
        setActive(true);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The product wasn't saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-3 rounded-3 border border-hairline bg-surface-card p-4" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor="retail-name">
            Name
          </label>
          <input id="retail-name" className={INPUT_CLASS} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="retail-sku">
            SKU <span className={FIELD_HINT}>optional</span>
          </label>
          <input id="retail-sku" className={INPUT_CLASS} value={sku} onChange={(event) => setSku(event.target.value)} />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="retail-price">
            Price <span className={FIELD_HINT}>USD</span>
          </label>
          <input id="retail-price" inputMode="decimal" className={INPUT_CLASS} value={price} onChange={(event) => setPrice(event.target.value)} placeholder="0.00" />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="retail-tax">
            Tax category <span className={FIELD_HINT}>optional</span>
          </label>
          <input id="retail-tax" className={INPUT_CLASS} value={taxCategory} onChange={(event) => setTaxCategory(event.target.value)} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-body text-ink-secondary">
        <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} className="h-4 w-4 rounded-1 border-input-border text-brand-600 focus:ring-brand-600" />
        Active (sellable)
      </label>
      {error !== null && (
        <p role="alert" className="text-body text-danger-on-tint">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel !== undefined && (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={!valid || pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function ProductRow({ product, onUpdate }: { product: RetailProduct; onUpdate: (id: string, patch: ProductDraft) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li className="p-3">
        <ProductForm
          initial={product}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (draft) => {
            await onUpdate(product.id, draft);
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-3">
      <div>
        <p className="text-body font-medium text-ink">{product.name}</p>
        <p className={FIELD_HINT}>
          {product.sku ?? "no sku"}
          {!product.active && " · inactive"}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-table text-ink-secondary">{formatCents(product.price_cents)}</span>
        <Button variant="ghost" className="h-9" onClick={() => setEditing(true)}>
          Edit
        </Button>
      </div>
    </li>
  );
}

function GiftCardProductForm({ onSubmit }: { onSubmit: (input: { name: string; amount_cents: number }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = dollarsToCents(amount);
  const valid = name.trim().length > 0 && cents !== null && cents > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || cents === null) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), amount_cents: cents });
      setName("");
      setAmount("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The gift-card denomination wasn't saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="rounded-3 border border-hairline bg-surface-card p-4" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className={LABEL_CLASS} htmlFor="gcp-name">
            Denomination name
          </label>
          <input id="gcp-name" className={INPUT_CLASS} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="flex-1">
          <label className={LABEL_CLASS} htmlFor="gcp-amount">
            Amount <span className={FIELD_HINT}>USD</span>
          </label>
          <input id="gcp-amount" inputMode="decimal" className={INPUT_CLASS} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" />
        </div>
        <Button type="submit" disabled={!valid || pending}>
          {pending ? "Saving…" : "Add denomination"}
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="mt-3 text-body text-danger-on-tint">
          {error}
        </p>
      )}
    </form>
  );
}

function CompGiftCardForm({ onGrant }: { onGrant: (input: GrantDraft) => Promise<GrantReveal> }) {
  const [amount, setAmount] = useState("");
  const [personId, setPersonId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<GrantReveal | null>(null);

  const cents = dollarsToCents(amount);
  const personValid = personId.trim() === "" || /^[0-9a-f-]{36}$/i.test(personId.trim());
  const valid = cents !== null && cents > 0 && personValid;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || cents === null) return;
    setPending(true);
    setError(null);
    setReveal(null);
    try {
      const result = await onGrant({
        amount_cents: cents,
        person_id: personId.trim() === "" ? null : personId.trim(),
        reason: reason.trim() === "" ? null : reason.trim(),
      });
      setReveal(result);
      setAmount("");
      setPersonId("");
      setReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No gift card was issued.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <form className="grid gap-3 rounded-3 border border-hairline bg-surface-card p-4" onSubmit={(event) => void submit(event)}>
        <p className={FIELD_HINT}>Comp a gift card · no money is charged</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL_CLASS} htmlFor="comp-amount">
              Amount <span className={FIELD_HINT}>USD</span>
            </label>
            <input id="comp-amount" inputMode="decimal" className={INPUT_CLASS} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label className={LABEL_CLASS} htmlFor="comp-person">
              Recipient person id <span className={FIELD_HINT}>optional</span>
            </label>
            <input id="comp-person" className={INPUT_CLASS} value={personId} onChange={(event) => setPersonId(event.target.value)} placeholder="uuid" />
          </div>
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="comp-reason">
            Reason <span className={FIELD_HINT}>optional</span>
          </label>
          <input id="comp-reason" className={INPUT_CLASS} value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        {!personValid && personId.trim() !== "" && (
          <p role="alert" className="text-body text-danger-on-tint">
            A recipient must be a valid person id (uuid), or leave it blank.
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-body text-danger-on-tint">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" disabled={!valid || pending}>
            {pending ? "Issuing…" : "Comp gift card"}
          </Button>
        </div>
      </form>

      {reveal !== null && (
        <div role="status" className="rounded-3 border border-success-border bg-success-tint p-4">
          <p className="text-body font-medium text-success-on-tint">
            Issued {formatCents(reveal.amount_cents)} gift card.
          </p>
          <p className="mt-1 text-body text-success-on-tint">
            Hand this code to the recipient now — it is shown once and cannot be retrieved again.
          </p>
          <p className="mt-3 select-all rounded-2 border border-success-border bg-surface-card px-3 py-2 text-center font-mono text-title font-bold tracking-widest text-ink">
            {reveal.code}
          </p>
        </div>
      )}
    </div>
  );
}

export function RetailScreen({
  productsQuery,
  giftCardProductsQuery,
  giftCardsQuery,
  onCreateProduct,
  onUpdateProduct,
  onCreateGiftCardProduct,
  onGrant,
}: RetailScreenProps) {
  const [addingProduct, setAddingProduct] = useState(false);

  return (
    <div className="space-y-8">
      <header>
        <p className={FIELD_HINT}>Retail · catalog and gift cards</p>
        <h1 className="mt-1 font-display text-hero font-bold tracking-tight text-ink">Retail & gift cards</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">
          Author the sellable catalog and gift-card denominations. Comp a gift card by hand here; paid sales arrive with the point of sale.
        </p>
      </header>

      <section aria-labelledby="retail-catalog" className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 id="retail-catalog" className="font-display text-title font-bold text-ink">
            Retail catalog
          </h2>
          <Button variant="secondary" onClick={() => setAddingProduct((open) => !open)}>
            {addingProduct ? "Close" : "Add product"}
          </Button>
        </div>
        {addingProduct && (
          <ProductForm
            submitLabel="Add product"
            onCancel={() => setAddingProduct(false)}
            onSubmit={async (draft) => {
              await onCreateProduct(draft);
              setAddingProduct(false);
            }}
          />
        )}
        <DataBoundary<{ products: RetailProduct[] }>
          name="retail-products"
          query={productsQuery}
          skeleton={<Skeleton className="h-40 w-full rounded-3" />}
          errorConsequence="The retail catalog didn't load; nothing was changed."
          isEmpty={(data) => data.products.length === 0}
          emptyState={<EmptyState title="No retail products yet." body="Add the first sellable item to build the catalog." />}
        >
          {(data) => (
            <ul className="divide-y divide-hairline rounded-3 border border-hairline bg-surface-card">
              {data.products.map((productItem) => (
                <ProductRow key={productItem.id} product={productItem} onUpdate={onUpdateProduct} />
              ))}
            </ul>
          )}
        </DataBoundary>
      </section>

      <section aria-labelledby="giftcard-catalog" className="space-y-4">
        <h2 id="giftcard-catalog" className="font-display text-title font-bold text-ink">
          Gift-card denominations
        </h2>
        <GiftCardProductForm onSubmit={onCreateGiftCardProduct} />
        <DataBoundary<{ gift_card_products: GiftCardProduct[] }>
          name="gift-card-products"
          query={giftCardProductsQuery}
          skeleton={<Skeleton className="h-32 w-full rounded-3" />}
          errorConsequence="The gift-card denominations didn't load; nothing was changed."
          isEmpty={(data) => data.gift_card_products.length === 0}
          emptyState={<EmptyState title="No gift-card denominations yet." body="Add a denomination customers can buy or receive." />}
        >
          {(data) => (
            <ul className="divide-y divide-hairline rounded-3 border border-hairline bg-surface-card">
              {data.gift_card_products.map((giftProduct) => (
                <li key={giftProduct.id} className="flex items-center justify-between gap-2 p-3">
                  <div>
                    <p className="text-body font-medium text-ink">{giftProduct.name}</p>
                    {!giftProduct.active && <p className={FIELD_HINT}>inactive</p>}
                  </div>
                  <span className="font-mono text-table text-ink-secondary">{formatCents(giftProduct.amount_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </DataBoundary>
      </section>

      <section aria-labelledby="issued-gift-cards" className="space-y-4">
        <h2 id="issued-gift-cards" className="font-display text-title font-bold text-ink">
          Issued gift cards
        </h2>
        <CompGiftCardForm onGrant={onGrant} />
        <DataBoundary<{ gift_cards: IssuedGiftCard[] }>
          name="issued-gift-cards"
          query={giftCardsQuery}
          skeleton={<Skeleton className="h-32 w-full rounded-3" />}
          errorConsequence="Issued gift cards didn't load; nothing was changed."
          isEmpty={(data) => data.gift_cards.length === 0}
          emptyState={<EmptyState title="No gift cards issued yet." body="Comp one above, or sell one once the point of sale ships." />}
        >
          {(data) => (
            <ul className="divide-y divide-hairline rounded-3 border border-hairline bg-surface-card">
              {data.gift_cards.map((card) => (
                <li key={card.id} className="flex items-center justify-between gap-2 p-3">
                  <div>
                    <p className="font-mono text-table text-ink">{card.id.slice(0, 8)}…</p>
                    <p className={FIELD_HINT}>{card.status === "void" ? "void" : "active"}</p>
                  </div>
                  <span className="font-mono text-table font-medium text-ink-secondary">{formatCents(card.balance_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </DataBoundary>
      </section>
    </div>
  );
}

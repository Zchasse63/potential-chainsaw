import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-context.jsx";
import { checkout, fetchCatalog, redeemGiftCard } from "../lib/pos.js";
import { PosScreen } from "../screens/pos-screen.jsx";

/** /pos — owner/manager/front_desk cash checkout. The catalog is server-priced;
 *  checkout and redeem post through the typed POS client (unit 5.7 contract). */
export function PosRoute() {
  const auth = useAuth();
  const accessToken = auth.accessToken ?? undefined;
  const queryClient = useQueryClient();

  const catalogQuery = useQuery({
    queryKey: ["pos", "catalog"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchCatalog(accessToken as string),
    retry: 1,
  });

  return (
    <PosScreen
      catalogQuery={catalogQuery}
      onCheckout={async (request, idempotencyKey) => {
        const result = await checkout(accessToken as string, request, idempotencyKey);
        // A completed sale can change sellable stock/gift-card state — refresh
        // the catalog from the server rather than mutating it locally.
        await queryClient.invalidateQueries({ queryKey: ["pos", "catalog"] });
        return result;
      }}
      onRedeem={(code, amountCents, idempotencyKey) =>
        redeemGiftCard(accessToken as string, code, amountCents, idempotencyKey)
      }
    />
  );
}

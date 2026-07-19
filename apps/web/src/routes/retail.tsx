import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-context.jsx";
import { fetchEnvelope, patchEnvelope, postEnvelope } from "../lib/api.js";
import { inspectEnvelope } from "../lib/envelope.js";
import { RetailScreen, type GrantReveal } from "../screens/retail-screen.jsx";

/** /retail — owner/manager catalog authoring + manual gift-card grants. */
export function RetailRoute() {
  const auth = useAuth();
  const accessToken = auth.accessToken ?? undefined;
  const queryClient = useQueryClient();

  const productsQuery = useQuery({
    queryKey: ["retail", "products"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/retail/products", accessToken as string),
    retry: 1,
  });
  const giftCardProductsQuery = useQuery({
    queryKey: ["retail", "gift-card-products"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/retail/gift-card-products", accessToken as string),
    retry: 1,
  });
  const giftCardsQuery = useQuery({
    queryKey: ["retail", "gift-cards"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/retail/gift-cards", accessToken as string),
    retry: 1,
  });

  return (
    <RetailScreen
      productsQuery={productsQuery}
      giftCardProductsQuery={giftCardProductsQuery}
      giftCardsQuery={giftCardsQuery}
      onCreateProduct={async (draft) => {
        await postEnvelope("/retail/products", accessToken as string, draft);
        await queryClient.invalidateQueries({ queryKey: ["retail", "products"] });
      }}
      onUpdateProduct={async (id, patch) => {
        await patchEnvelope(`/retail/products/${id}`, accessToken as string, patch);
        await queryClient.invalidateQueries({ queryKey: ["retail", "products"] });
      }}
      onCreateGiftCardProduct={async (input) => {
        await postEnvelope("/retail/gift-card-products", accessToken as string, input);
        await queryClient.invalidateQueries({ queryKey: ["retail", "gift-card-products"] });
      }}
      onGrant={async (input) => {
        const response = await postEnvelope("/retail/gift-cards/grant", accessToken as string, input);
        const inspection = inspectEnvelope<GrantReveal>(response);
        if (!inspection.ok) {
          throw new Error("The grant response was missing its provenance record; nothing is shown.");
        }
        await queryClient.invalidateQueries({ queryKey: ["retail", "gift-cards"] });
        return inspection.data;
      }}
    />
  );
}

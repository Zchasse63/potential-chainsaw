import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchEnvelope, postEnvelope } from "./api.js";

/**
 * The /import response shapes, mirrored from the API (the client-side
 * contract): apps/api/src/routes/import.ts assembled from apps/api/src/data.ts
 * (import_quarantine from migration 0007; reconciliations in the pinned
 * unit-1.5 read-shape). Buckets/statuses are server-computed; the client
 * renders what it is given.
 */

export type QuarantineStatus = "open" | "resolved" | "dismissed";

/** One review-queue row. `payload` is detail-route only, never in the list. */
export interface QuarantineItem {
  id: string;
  entity: string;
  external_ref: string | null;
  reason: string;
  status: QuarantineStatus;
  sync_run_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

/** The detail row adds the raw payload — the "what came in" preview. */
export interface QuarantineDetail extends QuarantineItem {
  payload: unknown;
}

/** "Exceptions grouped by cause" (UX plan §3G) — the batch-decision unit. */
export interface QuarantineCause {
  entity: string;
  reason: string;
  open_count: number;
}

export interface QuarantineListData {
  causes: QuarantineCause[];
  items: QuarantineItem[];
  next_cursor: string | null;
}

export type ReconciliationStatus = "match" | "drift" | "error";

/** The pinned unit-1.5 reconciliations row (Kelo-vs-Glofox comparison). */
export interface Reconciliation {
  id: string;
  tenant_id: string;
  entity: string;
  window_start: string | null;
  window_end: string | null;
  glofox_count: number | null;
  kelo_count: number | null;
  glofox_sum: number | null;
  kelo_sum: number | null;
  drift_count: number | null;
  drift_sum: number | null;
  status: ReconciliationStatus;
  detail: unknown;
  checked_at: string;
  created_at: string;
}

export interface ReconciliationsData {
  reconciliations: Reconciliation[];
  /**
   * true while unit 1.5's table doesn't exist yet — render the honest
   * pending banner, NOT an error and NOT an empty state.
   */
  reconciliation_pending: boolean;
}

/** GET /import/quarantine — causes + first page of open rows. 60s polling. */
export function useQuarantineQuery(accessToken: string | undefined) {
  return useQuery({
    queryKey: ["import-quarantine"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/import/quarantine", accessToken as string),
    retry: 1,
    refetchInterval: 60_000,
  });
}

/** GET /import/quarantine/:id — one row WITH payload (the detail drawer). */
export function useQuarantineDetailQuery(accessToken: string | undefined, id: string | null) {
  return useQuery({
    queryKey: ["import-quarantine", "detail", id],
    enabled: accessToken !== undefined && id !== null,
    queryFn: () => fetchEnvelope(`/import/quarantine/${id as string}`, accessToken as string),
    retry: 1,
  });
}

/** GET /import/reconciliations — recent Kelo-vs-Glofox checks. */
export function useReconciliationsQuery(accessToken: string | undefined) {
  return useQuery({
    queryKey: ["import-reconciliations"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/import/reconciliations", accessToken as string),
    retry: 1,
    refetchInterval: 60_000,
  });
}

export interface ResolveQuarantineInput {
  ids: string[];
  status: "resolved" | "dismissed";
  note?: string;
}

/**
 * The batch-decision commit. NO optimistic update (money-action discipline):
 * the queue re-reads the durable server state on settle — rows flip to
 * resolved only after the server confirms, and a failed commit re-reads too
 * so the UI never claims a decision the server didn't durably take.
 */
export function useResolveQuarantineMutation(accessToken: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ResolveQuarantineInput) =>
      postEnvelope("/import/quarantine/resolve", accessToken as string, input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["import-quarantine"] });
    },
  });
}

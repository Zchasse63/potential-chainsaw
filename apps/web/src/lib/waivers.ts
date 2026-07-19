import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchEnvelope, postEnvelope } from "./api.js";

/**
 * The /waivers response shapes, mirrored from the API (the client-side
 * contract): apps/api/src/routes/waivers.ts assembled from
 * apps/api/src/data-waivers.ts (migration 0028). Publishing goes through
 * activate; signatures are append-only legal evidence recorded via the desk
 * capture RPC. The client renders exactly what the server confirms — no
 * optimistic version state and no optimistic signature.
 */

/** Roles the API recognises (apps/api/src/routes/waivers.ts gates on these). */
export type StaffRole = "owner" | "manager" | "front_desk" | "trainer";

/** One versioned waiver document (GET /waivers/versions row). */
export interface WaiverVersion {
  id: string;
  version: number;
  title: string | null;
  body: string;
  active: boolean;
  effective_from: string;
  created_at: string;
}

export interface WaiverVersionsData {
  versions: WaiverVersion[];
}

/** The advisory per-person status (GET /waivers/status/:personId). */
export interface WaiverStatus {
  has_current_signature: boolean;
  signed_version: number | null;
  active_version: number | null;
  needs_signature: boolean;
}

export interface WaiverStatusData {
  status: WaiverStatus;
}

export interface CreateWaiverVersionInput {
  /** Optional short title; the API stores null when blank. */
  title: string | null;
  body: string;
}

export interface ActivateWaiverInput {
  id: string;
}

export interface SignWaiverInput {
  person_id: string;
  waiver_version_id: string;
  typed_name: string;
  /** The API requires the literal true (acknowledgement is not optional). */
  acknowledged: true;
}

/**
 * Structural minimum of the TanStack useMutation result the screen consumes —
 * status-driven so the UI can render committing / server-confirmed / failed
 * states without ever claiming a mutation the server did not confirm.
 */
export interface WaiverMutationHandle<TInput> {
  status: "idle" | "pending" | "error" | "success";
  variables?: TInput;
  error?: unknown;
  data?: unknown;
  mutate: (input: TInput) => void;
  reset: () => void;
}

/** GET /waivers/versions — every version for the tenant, newest first. */
export function useWaiverVersionsQuery(accessToken: string | undefined) {
  return useQuery({
    queryKey: ["waivers", "versions"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/waivers/versions", accessToken as string),
    retry: 1,
  });
}

/** GET /waivers/status/:personId — the advisory signing status for one person. */
export function useWaiverStatusQuery(accessToken: string | undefined, personId: string | null) {
  return useQuery({
    queryKey: ["waivers", "status", personId],
    enabled: accessToken !== undefined && personId !== null,
    queryFn: () =>
      fetchEnvelope(`/waivers/status/${encodeURIComponent(personId as string)}`, accessToken as string),
    retry: false,
  });
}

/**
 * POST /waivers/versions — creates an INACTIVE draft (publishing is the
 * separate activate below). Re-reads the version list on settle.
 */
export function useCreateWaiverVersionMutation(accessToken: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWaiverVersionInput) =>
      postEnvelope("/waivers/versions", accessToken as string, input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["waivers", "versions"] });
    },
  });
}

/**
 * POST /waivers/versions/:id/activate — the sole publication path (activating
 * a version deactivates the previously active one, server-side). NO optimistic
 * update: the list re-reads durable state on settle.
 */
export function useActivateWaiverVersionMutation(accessToken: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ActivateWaiverInput) =>
      postEnvelope(
        `/waivers/versions/${encodeURIComponent(input.id)}/activate`,
        accessToken as string,
        {},
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["waivers", "versions"] });
    },
  });
}

/**
 * POST /waivers/sign — desk capture of an in-person signature. The row is
 * append-only legal evidence (the server always appends, never mutates); the
 * person's status re-reads on settle.
 */
export function useSignWaiverMutation(accessToken: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SignWaiverInput) =>
      postEnvelope("/waivers/sign", accessToken as string, input),
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["waivers", "status", variables.person_id],
      });
    },
  });
}

/**
 * The actor's effective role, read from /auth/me (the same membership shape
 * the app shell already caches). The most privileged membership wins so the UI
 * offers every action the API would allow; the API remains the real gate.
 */
const ROLE_RANK: Record<StaffRole, number> = { owner: 4, manager: 3, front_desk: 2, trainer: 1 };

export function useActorRole(accessToken: string | undefined): StaffRole | undefined {
  const me = useQuery({
    queryKey: ["auth", "me"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/auth/me", accessToken as string),
    retry: false,
  });
  if (me.status !== "success") return undefined;
  const tenants = (me.data as { data?: { tenants?: { role?: string }[] } }).data?.tenants ?? [];
  let best: StaffRole | undefined;
  for (const tenant of tenants) {
    const role = tenant.role;
    if (role === "owner" || role === "manager" || role === "front_desk" || role === "trainer") {
      if (best === undefined || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
    }
  }
  return best;
}

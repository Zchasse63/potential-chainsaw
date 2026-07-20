import {
  inspectEnvelope,
  memberScheduleQuery,
  memberScheduleResponse,
  type EnvelopeMeta,
  type MemberScheduleResponse,
} from "@kelo/contracts";
import {
  startAuth,
  verifyAuth,
  type StartAuthParams,
  type StartAuthResult,
  type VerifyAuthParams,
  type VerifyAuthResult,
} from "./auth.js";
import { MemberApiError } from "./errors.js";

/**
 * The typed member API client (plan-member-app §4.1). Pure TS over fetch:
 * injectable `fetchImpl` (tests pass a fake — NO network in tests), no DOM,
 * no react-native, no Supabase packages (the member surfaces ship ZERO
 * Supabase material; test/import-guard.test.ts enforces it). The only backend
 * contact is the single Hono API behind `${origin}/api/v1/member/*`.
 *
 * Extension seam: W8-2 adds the auth/claiming methods (start/verify/refresh/
 * step-up) over this same envelope + error plumbing, W8-3 the booking state
 * machine. Each method is small and self-contained like fetchSchedule — add
 * methods to the client object, don't grow a monolith.
 */

export type FetchImpl = typeof fetch;

export interface FetchScheduleParams {
  /**
   * API origin, e.g. "https://member.studio.example" — or "" for same-origin
   * (the member site's /api/* proxy rewrite, plan §5). Trailing slashes are
   * tolerated. This is a PUBLIC value (KELO_API_ORIGIN), never a secret.
   */
  origin: string;
  /** The PUBLIC tenant uuid (client env KELO_TENANT_ID — no Supabase material). */
  tenant: string;
  /** Window start, inclusive — ISO 8601 instant. */
  from: string;
  /** Window end, exclusive — ISO 8601 instant. */
  to: string;
  /** Per-call fetch override; wins over the client-level and global fetch. */
  fetchImpl?: FetchImpl;
}

export type FetchScheduleResult =
  | { ok: true; sessions: MemberScheduleResponse; meta: EnvelopeMeta }
  | { ok: false; error: MemberApiError };

export interface MemberApiClient {
  /**
   * GET /api/v1/member/schedule — the ANONYMOUS public schedule (unit 8.1c).
   * Runs the body through inspectEnvelope (the provenance contract) and
   * validates data against memberScheduleResponse before any surface sees it.
   */
  fetchSchedule(params: FetchScheduleParams): Promise<FetchScheduleResult>;
  /**
   * POST /api/v1/member/auth/start — request an OTP (unit 8.2b). ALWAYS the
   * same neutral 202 shape; `ok: true` means "accepted", never "the contact
   * exists" (anti-enumeration by construction, §3.3).
   */
  startAuth(params: StartAuthParams): Promise<StartAuthResult>;
  /**
   * POST /api/v1/member/auth/verify — consume the OTP, resolve the claim, and
   * mint the session. Web rides the host-only cookie the API sets; mobile gets
   * the `kmb_…` token in `view.token` exactly once — store it in SecureStore.
   */
  verifyAuth(params: VerifyAuthParams): Promise<VerifyAuthResult>;
}

export interface MemberApiClientConfig {
  /** Default fetch for every method (per-call `fetchImpl` still wins). */
  fetchImpl?: FetchImpl;
}

export function createMemberApiClient(config: MemberApiClientConfig = {}): MemberApiClient {
  return {
    fetchSchedule: (params) => fetchSchedule(params, config.fetchImpl),
    startAuth: (params) => startAuth(params, config.fetchImpl),
    verifyAuth: (params) => verifyAuth(params, config.fetchImpl),
  };
}

async function fetchSchedule(
  params: FetchScheduleParams,
  clientFetch: FetchImpl | undefined,
): Promise<FetchScheduleResult> {
  const fetchImpl = params.fetchImpl ?? clientFetch ?? globalThis.fetch;

  // Fail fast on a malformed call — the API would 400 anyway, and the query
  // contract (uuid tenant, ISO window, ≤45 days) is already the truth here.
  const query = memberScheduleQuery.safeParse({
    tenant: params.tenant,
    from: params.from,
    to: params.to,
  });
  if (!query.success) {
    return {
      ok: false,
      error: new MemberApiError(
        "invalid_params",
        `schedule params failed the query contract: ${query.error.issues[0]?.message ?? "invalid"}`,
      ),
    };
  }

  const origin = params.origin.replace(/\/+$/, "");
  const url = `${origin}/api/v1/member/schedule?${new URLSearchParams(query.data).toString()}`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (cause) {
    return {
      ok: false,
      error: new MemberApiError("network_error", "schedule request failed to reach the API", {
        cause,
      }),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: new MemberApiError(
        "http_error",
        `schedule request returned HTTP ${response.status}`,
        { status: response.status },
      ),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    return {
      ok: false,
      error: new MemberApiError("shape_invalid", "schedule response body was not JSON", { cause }),
    };
  }

  // Provenance-or-nothing: a 2xx without valid freshness meta is a defect
  // (invariant #3), surfaced as envelope_invalid — never rendered.
  const inspection = inspectEnvelope<unknown>(body);
  if (!inspection.ok) {
    return {
      ok: false,
      error: new MemberApiError(
        "envelope_invalid",
        "schedule response is missing the freshness envelope meta",
      ),
    };
  }

  const sessions = memberScheduleResponse.safeParse(inspection.data);
  if (!sessions.success) {
    return {
      ok: false,
      error: new MemberApiError(
        "shape_invalid",
        `schedule data failed the response contract: ${
          sessions.error.issues[0]?.message ?? "invalid"
        }`,
      ),
    };
  }

  return { ok: true, sessions: sessions.data, meta: inspection.meta };
}

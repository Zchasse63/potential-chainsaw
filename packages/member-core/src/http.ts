import { IDEMPOTENCY_KEY_HEADER, inspectEnvelope, type EnvelopeMeta } from "@kelo/contracts";
import type { FetchImpl } from "./client.js";
import { MemberApiError } from "./errors.js";

/**
 * The shared request helper for SESSION-SCOPED member calls (account, booking).
 * Pure TS over an injected fetch — no DOM, no node builtins, no Supabase
 * material (the import-guard test enforces it).
 *
 * Credential (§3.2): WEB rides the host-only `kelo_member` cookie, sent via
 * `credentials: "include"` (a no-op on native fetch). MOBILE passes the
 * `kmb_…` token, attached as `Authorization: Bearer` — the app holds it in
 * SecureStore and it never touches a cookie. Money mutations carry a
 * per-intent Idempotency-Key the caller owns (rotates on content change).
 *
 * Provenance-or-nothing (invariant #3): a 2xx without valid freshness meta is a
 * defect surfaced as `envelope_invalid`, never handed to a surface.
 */

export interface MemberRequestOptions {
  origin: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  /** Mobile session token (kmb_…). Omit on web (the cookie carries it). */
  token?: string;
  /** Required on money mutations (book / cancel / waitlist). */
  idempotencyKey?: string;
  fetchImpl?: FetchImpl;
  label: string;
}

export type MemberRequestOutcome =
  | { ok: true; data: unknown; meta: EnvelopeMeta }
  | { ok: false; error: MemberApiError };

export async function memberRequest(
  opts: MemberRequestOptions,
  clientFetch: FetchImpl | undefined,
): Promise<MemberRequestOutcome> {
  const impl = opts.fetchImpl ?? clientFetch ?? globalThis.fetch;
  const url = `${opts.origin.replace(/\/+$/, "")}${opts.path}`;

  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token !== undefined && opts.token !== "") {
    headers["authorization"] = `Bearer ${opts.token}`;
  }
  if (opts.idempotencyKey !== undefined) headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] = opts.idempotencyKey;

  let response: Response;
  try {
    response = await impl(url, {
      method: opts.method,
      headers,
      credentials: "include",
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (cause) {
    return {
      ok: false,
      error: new MemberApiError("network_error", `${opts.label} request failed to reach the API`, {
        cause,
      }),
    };
  }

  if (!response.ok) {
    // Pull the structured `error.code` from the body so callers can branch on
    // the condition (e.g. 409 session_at_capacity vs 409 idempotency_key_conflict)
    // rather than an overloaded status. Best-effort — a bodyless/non-JSON error
    // just yields an undefined code.
    const code = await readErrorCode(response);
    return {
      ok: false,
      error: new MemberApiError("http_error", `${opts.label} request returned HTTP ${response.status}`, {
        status: response.status,
        ...(code !== undefined ? { code } : {}),
      }),
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    return {
      ok: false,
      error: new MemberApiError("shape_invalid", `${opts.label} response body was not JSON`, { cause }),
    };
  }

  const inspection = inspectEnvelope<unknown>(parsed);
  if (!inspection.ok) {
    return {
      ok: false,
      error: new MemberApiError(
        "envelope_invalid",
        `${opts.label} response is missing the freshness envelope meta`,
      ),
    };
  }
  return { ok: true, data: inspection.data, meta: inspection.meta };
}

/**
 * Best-effort read of the API's `{ error: { code, ... } }` body on a non-2xx.
 * Never throws — a missing/non-JSON/oddly-shaped body just returns undefined,
 * so the caller falls back to status-only handling.
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body === "object" && body !== null && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "object" && err !== null && "code" in err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

import type { GlofoxFetch } from "@kelo/contracts";
import type { GlofoxConfig } from "./config.js";
import { createEndpoints, type GlofoxEndpoints } from "./endpoints.js";
import {
  BODY_SNIPPET_MAX,
  GlofoxAuthError,
  GlofoxHttpError,
  GlofoxRateLimitError,
  GlofoxSuccessFalseError,
} from "./errors.js";

/**
 * The ONE shared Glofox HTTP client (CLAUDE.md invariant #8;
 * docs/glofox/README.md §1–§3). Every Glofox call in Kelo goes through
 * `createGlofoxClient` — no other module may speak to Glofox. The core
 * `glofoxFetch` owns, in ONE place:
 *
 *   - the three auth headers on EVERY request (`x-glofox-branch-id`,
 *     `x-api-key`, `x-glofox-api-token`) — sent, never logged;
 *   - status mapping: 401/403 → GlofoxAuthError (the import-pause signal),
 *     429 → GlofoxRateLimitError, other non-2xx → GlofoxHttpError;
 *   - TRAP 1: a parsed 2xx body carrying `success !== true` throws
 *     GlofoxSuccessFalseError — applied here, once, for every endpoint
 *     (Style C bodies have no `success` field, so the check does not apply);
 *   - the rate budget: ≤10 req/s pacing (README §1: live limit 10 req/s,
 *     burst 1000) plus bounded retries with exponential backoff + jitter on
 *     429 / 5xx / network errors — NEVER on other 4xx (a request bug);
 *   - envelope ignorance: it returns the JSON-parsed body as `unknown`;
 *     per-endpoint Zod parsing lives in endpoints.ts (a malformed 2xx body
 *     propagates the JSON SyntaxError — quarantine territory, never silently
 *     stripped).
 */
export interface GlofoxClientOptions {
  /** HTTP implementation. Tests stub this — tests NEVER hit the network. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock/sleep so pacing and backoff tests run without real waits. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter source (defaults to Math.random). */
  readonly random?: () => number;
  /** Retries AFTER the initial attempt (default 3 → up to 4 wire attempts). */
  readonly maxRetries?: number;
  /** Pacing budget in requests/second (default 10 — the live Glofox limit). */
  readonly requestsPerSecond?: number;
  /** Backoff floor for attempt 0; doubles per attempt (default 250ms). */
  readonly baseBackoffMs?: number;
  /** Backoff ceiling (default 10s). */
  readonly maxBackoffMs?: number;
}

export interface GlofoxRequestInit {
  readonly method?: "GET" | "POST";
  /** Query params; `undefined` values are dropped. */
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
}

/**
 * The internal fetch — the contracts `GlofoxFetch` plus an optional `query`
 * field (assignable to the contract; asserted in createGlofoxClient).
 */
export type GlofoxFetchCore = (path: string, init?: GlofoxRequestInit) => Promise<unknown>;

export interface GlofoxClient extends GlofoxEndpoints {
  /**
   * The raw fetch — for Glofox endpoints without a typed wrapper yet. Still
   * the ONE client: headers, pacing, retries, and trap 1 all apply. Matches
   * the phase-0 type contract (contracts/src/glofox/client-contract.ts).
   */
  readonly fetch: GlofoxFetch;
}

export function createGlofoxClient(
  config: GlofoxConfig,
  opts: GlofoxClientOptions = {},
): GlofoxClient {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? (() => Math.random());
  const maxRetries = opts.maxRetries ?? 3;
  const requestsPerSecond = opts.requestsPerSecond ?? 10;
  const baseBackoffMs = opts.baseBackoffMs ?? 250;
  const maxBackoffMs = opts.maxBackoffMs ?? 10_000;

  // Min-interval pacer: request slots are spaced ≥1000/rps ms apart, so any
  // 1-second window holds at most `requestsPerSecond` wire calls. Slots are
  // handed out over a promise chain so concurrent callers cannot take the
  // same slot.
  const intervalMs = 1000 / requestsPerSecond;
  let nextSlotAt = Number.NEGATIVE_INFINITY;
  let slotChain: Promise<void> = Promise.resolve();
  const pace = (): Promise<void> => {
    const acquire = async (): Promise<void> => {
      const t = now();
      const wait = Math.max(0, nextSlotAt - t);
      nextSlotAt = Math.max(t, nextSlotAt) + intervalMs;
      if (wait > 0) await sleep(wait);
    };
    const slot = slotChain.then(acquire);
    slotChain = slot.catch(() => undefined);
    return slot;
  };

  /** Equal jitter: 50–100% of the capped exponential (250ms, 500ms, 1s, …). */
  const backoffMs = (attempt: number): number => {
    const capped = Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempt);
    return Math.floor(capped * (0.5 + random() * 0.5));
  };

  const retryAfterMs = (res: Response): number | undefined => {
    const raw = res.headers.get("retry-after");
    if (raw === null) return undefined;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  };

  const buildUrl = (path: string, query: GlofoxRequestInit["query"]): string => {
    const url = new URL(`${config.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  };

  const glofoxFetch: GlofoxFetchCore = async (path, init = {}) => {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {
      accept: "application/json",
      // README §1: three auth headers on EVERY request.
      "x-glofox-branch-id": config.branchId,
      "x-api-key": config.apiKey,
      "x-glofox-api-token": config.apiToken,
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const requestInit: RequestInit = {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    };
    const url = buildUrl(path, init.query);

    for (let attempt = 0; ; attempt += 1) {
      await pace(); // every wire attempt spends rate budget, retries included
      let res: Response;
      try {
        res = await fetchImpl(url, requestInit);
      } catch (err) {
        // Network error — transient; same retry policy as 429/5xx.
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }

      const text = await res.text();
      const snippet = text.slice(0, BODY_SNIPPET_MAX);

      // 401/403 — credentials dead: the import-pause signal. NEVER retried.
      if (res.status === 401 || res.status === 403) {
        throw new GlofoxAuthError(res.status, path, snippet);
      }
      if (res.status === 429) {
        if (attempt < maxRetries) {
          // Honor Retry-After when the vendor sends one; never wait less.
          await sleep(Math.max(retryAfterMs(res) ?? 0, backoffMs(attempt)));
          continue;
        }
        throw new GlofoxRateLimitError(path, snippet, retryAfterMs(res));
      }
      if (res.status >= 500) {
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new GlofoxHttpError(res.status, path, snippet);
      }
      if (!res.ok) {
        // 4xx ≠ 429 is a request bug — throwing immediately, NEVER retried.
        throw new GlofoxHttpError(res.status, path, snippet);
      }

      // TRAP 1 (README §3): a 2xx whose body carries `success` that is not
      // `true` is an error dressed as OK. Style C has no `success` field, so
      // the check simply does not apply there.
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "success" in parsed &&
        (parsed as { success: unknown }).success !== true
      ) {
        throw new GlofoxSuccessFalseError(path, snippet);
      }
      return parsed;
    }
  };

  // Compile-time proof that the core implements the phase-0 type contract.
  const fetchContract: GlofoxFetch = glofoxFetch;

  return {
    fetch: fetchContract,
    ...createEndpoints(glofoxFetch, config),
  };
}

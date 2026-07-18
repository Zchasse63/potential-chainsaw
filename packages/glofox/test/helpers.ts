import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlofoxConfig } from "../src/index.js";

/** Absolute path to the pinned, PII-redacted Glofox samples (docs/glofox/samples/). */
const SAMPLES_DIR = fileURLToPath(new URL("../../../docs/glofox/samples/", import.meta.url));

export function loadSample(fileName: string): unknown {
  return JSON.parse(readFileSync(join(SAMPLES_DIR, fileName), "utf8")) as unknown;
}

/** Obviously-fake test credentials — real values never appear in code or logs. */
export const testConfig: GlofoxConfig = {
  baseUrl: "https://gf-api.aws.glofox.com/prod/",
  apiKey: "test-api-key",
  apiToken: "test-api-token",
  branchId: "test-branch-id",
  namespace: "test-namespace",
};

/** Skips pacing/backoff waits in tests that don't exercise the injected clock. */
export const noSleep = async (): Promise<void> => {};

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  /** Injected-clock time at which the wire call happened. */
  readonly atMs: number;
}

/**
 * A stubbed fetchImpl: records every call (URL, method, headers, parsed JSON
 * body, clock time) and delegates the response to `handler`. NO network —
 * tests replay the pinned samples only.
 */
export function stubFetch(
  handler: (url: string, init: RequestInit) => Response,
  now: () => number = () => 0,
): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method: init?.method ?? "GET", headers, body, atMs: now() });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

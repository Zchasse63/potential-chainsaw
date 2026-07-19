import type { PooledQueryable } from "../../src/glofox/types.js";

/**
 * Test doubles for the billing spine processors (Phase 5 · unit 5.3). NO
 * network, NO DB: a recording fake pool with a programmable responder keyed by
 * query text. `begin`/`commit`/`rollback` (the outbox's transaction) fall
 * through to an empty result, exactly as a single-threaded driver would run
 * them on itself (see pipeline.withTransaction).
 */

export interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

export type Responder = (
  text: string,
  values: readonly unknown[] | undefined,
  calls: readonly QueryCall[],
) => { rows: unknown[] } | undefined;

export function createBillingPool(respond: Responder = () => undefined): PooledQueryable & {
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  return {
    calls,
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      return respond(text, values, calls) ?? { rows: [] };
    },
  };
}

export function callsMatching(calls: readonly QueryCall[], needle: string): QueryCall[] {
  return calls.filter((call) => call.text.includes(needle));
}

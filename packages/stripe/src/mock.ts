import { StripeClient } from "./client.js";
import type { StripeCall } from "./types.js";

/**
 * A deterministic Stripe test double for later units' tests. It is a real
 * `StripeClient` forced into DRY-RUN with:
 *   - a seeded counter for ids (`dry_<prefix>_<seed+n>`) — NO Math.random /
 *     Date.now, so ids are stable and assertion-friendly;
 *   - a `fetchImpl` that rejects, proving no path touches the network;
 *   - a `calls` log capturing every intended mutation (kind, path, params,
 *     idempotency key) so tests can assert what the pipeline requested.
 */
export interface MockStripeOptions {
  readonly stripeAccountId?: string;
  /** Id counter start (ids are `dry_<prefix>_<seed + n>`, n from 1). Default 0. */
  readonly seed?: number;
}

export interface MockStripe {
  readonly client: StripeClient;
  /** Every intended mutation, in call order. */
  readonly calls: StripeCall[];
}

export function createMockStripe(options: MockStripeOptions = {}): MockStripe {
  const calls: StripeCall[] = [];
  let counter = options.seed ?? 0;
  const client = new StripeClient({
    stripeAccountId: options.stripeAccountId ?? "acct_mock",
    dryRun: true,
    newId: () => {
      counter += 1;
      return String(counter);
    },
    fetchImpl: () => Promise.reject(new Error("MockStripe must never touch the network")),
    recorder: (call) => calls.push(call),
  });
  return { client, calls };
}

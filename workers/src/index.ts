/**
 * @kelo/workers — placeholder. Real processors (Glofox import, AI generation)
 * are Netlify Background Functions (15-min cap) claiming chunked, resumable work
 * from the Postgres `jobs` queue (FOR UPDATE SKIP LOCKED, leases + heartbeats) —
 * exactly one scheduler, CLAUDE.md invariant #4. Implementation lands in a later
 * unit; this stub only pins the processor shape.
 */

/** A unit of work claimed from the `jobs` table. */
export type JobProcessor<Payload = unknown, Result = unknown> = (
  payload: Payload,
) => Promise<Result>;

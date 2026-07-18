// sample: docs/glofox/samples/credits.get.nonempty.json
// sample: docs/glofox/samples/credits.get.json (empty pack list — same envelope, data: [])
import { z } from "zod";
import { glofoxEnvelopeA } from "./envelopes.js";
import { glofoxUnixTimestamp } from "./primitives.js";

/**
 * Credit pack — `GET /2.0/credits?user_id=` (docs/glofox/README.md §5). Style A
 * envelope. PER-USER ONLY: there is no branch-wide credits list — import
 * iterates members inside the 10 req/s rate budget.
 */

export const glofoxCreditSchema = z.object({
  _id: z.string(),
  namespace: z.string(),
  branch_id: z.string(),
  user_id: z.string(),
  membership_id: z.string().nullish(),
  membership_name: z.string().optional(),
  /** Usage scope: "programs" = classes; "appointments"/"users" = trainer appts; "facilities". */
  model: z.string(),
  /** Sessions granted. */
  num_sessions: z.number().int(),
  /** Sessions remaining. */
  available: z.number().int(),
  active: z.boolean(),
  /** Booking ids consuming this pack. */
  bookings: z.array(z.string()),
  start_date: glofoxUnixTimestamp.nullish(),
  /**
   * Per-pack expiry. ABSENT (or null) means NO EXPIRY — callers must treat a
   * missing `end_date` as `no_expiry`, never as expired (README §5 must-answer
   * #1; prevalence measurement is a phase-1 open item).
   */
  end_date: glofoxUnixTimestamp.nullish(),
  created: glofoxUnixTimestamp,
  modified: glofoxUnixTimestamp,
  type: z.string(),
  image_url: z.string().optional(),
});
export type GlofoxCredit = z.infer<typeof glofoxCreditSchema>;

export const glofoxCreditsResponseSchema = glofoxEnvelopeA(glofoxCreditSchema);
export type GlofoxCreditsResponse = z.infer<typeof glofoxCreditsResponseSchema>;

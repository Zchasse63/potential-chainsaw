// sample: docs/glofox/samples/events.get.limit2.json
import { z } from "zod";
import { glofoxEnvelopeA } from "./envelopes.js";
import { glofoxUnixTimestamp } from "./primitives.js";

/**
 * Class/session — `GET /2.0/branches/{id}/events` (docs/glofox/README.md §5).
 * Style A envelope. Feeds sessions import and the demand heatmap: `size`
 * (capacity), `booked`, `waiting`.
 */

export const glofoxEventSessionSchema = z.object({
  _id: z.string(),
  namespace: z.string(),
  branch_id: z.string(),
  program_id: z.string(),
  active: z.boolean(),
  name: z.string(),
  description: z.string().optional(),
  time_start: glofoxUnixTimestamp,
  duration: z.number().int(),
  /** Capacity. */
  size: z.number().int(),
  booked: z.number().int(),
  waiting: z.number().int(),
  trainers: z.array(z.string()),
  facility: z.string(),
  private: z.boolean(),
  level: z.string().optional(),
  status: z.string(),
  is_online: z.boolean(),
  close_booking_time: glofoxUnixTimestamp.nullish(),
  open_booking_time: glofoxUnixTimestamp.nullish(),
  has_booked: z.boolean().optional(),
  booking_status: z.string().nullable().optional(),
  booking_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  current_user_eligibility: z.string().optional(),
  type: z.string().optional(),
  model: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  position: z.number().nullable().optional(),
  image_url: z.string().optional(),
  modified: glofoxUnixTimestamp.optional(),
});
export type GlofoxEventSession = z.infer<typeof glofoxEventSessionSchema>;

export const glofoxEventsResponseSchema = glofoxEnvelopeA(glofoxEventSessionSchema);
export type GlofoxEventsResponse = z.infer<typeof glofoxEventsResponseSchema>;

// sample: docs/glofox/samples/bookings.get.limit3.json
import { z } from "zod";
import { glofoxEnvelopeB } from "./envelopes.js";

/**
 * Booking — `GET /2.2/branches/{id}/bookings` (docs/glofox/README.md §5). Style
 * B envelope. NOTE: timestamps on this endpoint generation are ISO-ish STRINGS
 * ("2023-12-17 07:00:00"), not unix seconds (README §1) — they stay strings at
 * the boundary here; the mapper owns timezone-aware conversion later.
 */

/** Observed live; the vendor documents more (SPEC lists "…") — extend when a sample shows one. */
export const glofoxBookingStatusSchema = z.enum([
  "BOOKED",
  "WAITING",
  "CANCELED",
  "RESERVED",
  "FAILED",
]);
export type GlofoxBookingStatus = z.infer<typeof glofoxBookingStatusSchema>;

export const glofoxBookingSchema = z.object({
  _id: z.string(),
  namespace: z.string(),
  branch_id: z.string(),
  user_id: z.string(),
  user_name: z.string(),
  type: z.string(),
  program_id: z.string(),
  event_id: z.string(),
  event_name: z.string(),
  time_slot_id: z.string().nullable(),
  model: z.string(),
  model_id: z.string().nullable(),
  model_name: z.string(),
  course_id: z.string().nullable(),
  session_id: z.string().nullable(),
  guest_bookings: z.number().int(),
  status: glofoxBookingStatusSchema,
  /** The check-in fact. */
  attended: z.boolean(),
  paid: z.boolean(),
  payment_method: z.string().nullable(),
  time_start: z.string(),
  time_finish: z.string(),
  /** First-ever-visit marker — a free new-customer signal. */
  is_first: z.boolean(),
  is_from_waiting_list: z.boolean(),
  /** Maps straight to Kelo's cancellation-policy analytics. */
  is_late_cancellation: z.boolean(),
  canceled_at: z.string().nullable(),
  cancellations: z.array(z.unknown()),
  created: z.string(),
  modified: z.string(),
  date_start: z.string().nullable(),
  date_finish: z.string().nullable(),
  region: z.string().nullable(),
  timestamp: z.number().int(),
  /** Aggregator-channel candidate (null in all pinned samples — README §5 must-answer #2). */
  origin: z.string().nullable(),
  metadata: z
    .object({
      service: z.object({ type: z.string(), id: z.string() }).nullish(),
    })
    .nullish(),
  batch_id: z.string().nullable(),
});
export type GlofoxBooking = z.infer<typeof glofoxBookingSchema>;

export const glofoxBookingsResponseSchema = glofoxEnvelopeB(glofoxBookingSchema);
export type GlofoxBookingsResponse = z.infer<typeof glofoxBookingsResponseSchema>;

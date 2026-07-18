// sample: docs/glofox/samples/members.get.limit2.json
import { z } from "zod";
import { glofoxEnvelopeA } from "./envelopes.js";
import { glofoxUnixTimestamp } from "./primitives.js";

/**
 * Person — `GET /2.0/members` (docs/glofox/README.md §5). Style A envelope.
 * Incremental sync uses the `utc_modified_start_date`/`_end_date` watermark params.
 */

/** Glofox sub-second timestamp pair (consent + lead status modification times). */
const secUsecTimestampSchema = z.object({
  sec: z.number().int(),
  usec: z.number().int(),
});

/**
 * Per-channel marketing-consent evidence (README §5 — a major live find:
 * imported opt-in provenance for the D2 counsel decision).
 */
const consentChannelSchema = z.object({
  active: z.boolean(),
  modified_at: secUsecTimestampSchema.optional(),
  /** A single user id OR a list of them — both shapes observed live. */
  modified_by_user_id: z.union([z.string(), z.array(z.string())]).optional(),
  modified_from_ip_address: z.array(z.string()).optional(),
});

/** `gender` arrives either as a plain string or as `{name, label}` — both observed live. */
const genderSchema = z.union([z.string(), z.object({ name: z.string(), label: z.string() })]);

export const glofoxMemberSchema = z.object({
  _id: z.string(),
  branch_id: z.string(),
  namespace: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  gender: genderSchema.optional(),
  phone: z.string().nullish(),
  email: z.string(),
  /** Soft-delete flag: member deletion arrives as `MEMBER_UPDATED` with active:false (README §6). */
  active: z.boolean(),
  type: z.string(),
  /**
   * An OBJECT, not a name (README §8 trap). `type: "payg"` marks non-recurring
   * people; the plan NAME resolves by joining `user_membership_id` / transaction
   * `plan_code` to the memberships catalog.
   */
  // Population-variant tolerance (LIVE backfill 2026-07-18: the pinned 2-member
  // sample hid these — 644 payg members carry NO user_membership_id, 49 carry a
  // null/blank start_date, and status can be absent):
  membership: z.object({
    type: z.string(),
    start_date: glofoxUnixTimestamp.nullish(),
    user_membership_id: z.string().nullish(),
    status: z.string().nullish(),
  }),
  /** Aggregator-channel candidate (e.g. "classpass"); absent on some rows. */
  origin: z.string().nullable().optional(),
  source: z.string().optional(),
  lead_status: z.string().optional(),
  /** "Everyone is a lead" (README §8). */
  leads: z
    .object({
      status: z.string(),
      status_modified: secUsecTimestampSchema,
    })
    .optional(),
  consent: z
    .object({
      email: consentChannelSchema,
      sms: consentChannelSchema,
      push: consentChannelSchema,
    })
    .optional(),
  /** Unix seconds; may be a migration date, not real registration (README §8). */
  created: glofoxUnixTimestamp,
  modified: glofoxUnixTimestamp,
  origin_branch_id: z.string().optional(),
  name: z.string().optional(),
  image_url: z.string().optional(),
  account_email: z.string().optional(),
  contact_email: z.string().optional(),
  role: z.string().optional(),
});
export type GlofoxMember = z.infer<typeof glofoxMemberSchema>;

export const glofoxMembersResponseSchema = glofoxEnvelopeA(glofoxMemberSchema);
export type GlofoxMembersResponse = z.infer<typeof glofoxMembersResponseSchema>;

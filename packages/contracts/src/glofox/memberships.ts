// sample: docs/glofox/samples/memberships.get.json
import { z } from "zod";
import { glofoxEnvelopeA } from "./envelopes.js";

/**
 * Plan catalog — `GET /2.0/memberships` (docs/glofox/README.md §5). Style A
 * envelope. A catalog item holds one or more purchasable `plans`; plan `code`
 * (numeric id) joins to transactions' `metadata.plan_code`.
 */

/** Plan `type` vocabulary, verified live (README §5). */
export const glofoxPlanTypeSchema = z.enum(["num_classes", "time_classes", "time"]);
export type GlofoxPlanType = z.infer<typeof glofoxPlanTypeSchema>;

const planCreditSchema = z.object({
  branch_id: z.string(),
  namespace: z.string(),
  active: z.boolean(),
  /** Usage scope: "programs" = classes; "appointments"/"users" = trainer appts; "facilities". */
  model: z.string(),
  category_id: z.string().nullable(),
  num_sessions: z.number().int(),
  model_ids: z.array(z.string()),
  expiry: z.object({ interval: z.string(), interval_count: z.number().int() }).nullable(),
  end_date: z.number().int().nullable(),
});

export const glofoxPlanSchema = z.object({
  code: z.number().int(),
  name: z.string(),
  price: z.number(),
  type: glofoxPlanTypeSchema,
  /** Present on time-boxed plans (`time_classes`, `time`) only. */
  duration_time_unit: z.string().optional(),
  duration_time_unit_count: z.number().int().optional(),
  upfront_fee: z.number(),
  credits: z.array(planCreditSchema),
  starts_on: z.string(),
  is_group_membership: z.boolean(),
  max_group_membership_size: z.number().int().nullable(),
  free_time_unit_count: z.number().int(),
  min_price: z.number(),
  auto_renewal: z.boolean(),
  /** Subscription plans only. */
  accepted_payment_methods: z
    .array(z.object({ type_id: z.string(), active: z.boolean() }))
    .optional(),
  subscription_amount: z.number().optional(),
  subscription_plan_id: z.string().optional(),
  amount: z.number().optional(),
});
export type GlofoxPlan = z.infer<typeof glofoxPlanSchema>;

export const glofoxMembershipSchema = z.object({
  _id: z.string(),
  branch_id: z.string(),
  namespace: z.string(),
  active: z.boolean(),
  name: z.string(),
  description: z.string(),
  buy_just_once: z.boolean(),
  /** "membership" in the live sample. */
  type: z.string(),
  image_url: z.string().optional(),
  plans: z.array(glofoxPlanSchema),
});
export type GlofoxMembership = z.infer<typeof glofoxMembershipSchema>;

export const glofoxMembershipsResponseSchema = glofoxEnvelopeA(glofoxMembershipSchema);
export type GlofoxMembershipsResponse = z.infer<typeof glofoxMembershipsResponseSchema>;

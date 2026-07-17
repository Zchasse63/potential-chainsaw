// sample: docs/glofox/samples/branch.get.json
import { z } from "zod";

/**
 * Branch — `GET /2.0/branches/{id}` (docs/glofox/README.md §5). Branch ==
 * location for a single-location studio; `address.timezone_*` seeds Kelo
 * `locations` (the IANA-timezone "studio day" primitive). Only the fields Kelo
 * consumes are declared — the large `configuration`/`features` blobs are
 * stripped on parse.
 */

const branchAddressSchema = z.object({
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  country_code: z.string().optional(),
  district: z.string().optional(),
  postal_code: z.string().optional(),
  /** Feeds `locations.timezone` — all KPI day boundaries compute in location time. */
  timezone_id: z.string(),
  timezone_name: z.string(),
  currency: z.string(),
  continent: z.string().optional(),
  latitude: z.union([z.string(), z.number()]).optional(),
  longitude: z.union([z.string(), z.number()]).optional(),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
});

export const glofoxBranchSchema = z.object({
  _id: z.string(),
  name: z.string(),
  namespace: z.string(),
  type: z.string(),
  address: branchAddressSchema,
  email: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  language: z.string().optional(),
  image_url: z.string().optional(),
  categories: z.array(z.string()).optional(),
  opening_times: z
    .array(
      z.object({
        dow: z.string(),
        start: z.string(),
        end: z.string(),
        is_open: z.boolean(),
      }),
    )
    .optional(),
});
export type GlofoxBranch = z.infer<typeof glofoxBranchSchema>;

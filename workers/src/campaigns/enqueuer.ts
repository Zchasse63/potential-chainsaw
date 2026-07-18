import { canSend, type CanSendInput, type Channel } from "@kelo/comms";
import type { Queryable } from "../processors.js";

export type PlannedStatus =
  | "eligible"
  | "skip_no_consent"
  | "skip_suppressed"
  | "skip_quiet_hours"
  | "skip_no_address";

/**
 * Executable parity fixture for migration 0024's SQL preview. The preview is
 * informative only: comms.send calls @kelo/comms canSend again immediately
 * before provider delivery and that fresh decision is authoritative.
 */
export function plannedStatus(
  address: string | null | undefined,
  policy: CanSendInput,
): PlannedStatus {
  if (address?.trim() === "" || address == null) return "skip_no_address";
  const result = canSend(policy);
  if (result.allowed) return "eligible";
  return {
    no_consent: "skip_no_consent",
    suppressed: "skip_suppressed",
    quiet_hours: "skip_quiet_hours",
  }[result.reason] as PlannedStatus;
}

export async function buildCampaignPlan(pool: Queryable, campaignId: string): Promise<number> {
  const result = await pool.query(`select app.build_campaign_plan($1) as planned`, [campaignId]);
  const value = (result.rows[0] as { planned?: unknown } | undefined)?.planned;
  if (typeof value !== "number") throw new Error("build_campaign_plan returned no row count");
  return value;
}

/** Server-side merge-field reference implementation used by deterministic
 * tests and preview tooling. The approval RPC owns the actual enqueue path. */
export function resolveMergeFields(
  value: string,
  fields: { firstName: string | null; studioName: string },
): string {
  const resolved = value
    .replaceAll("{{first_name}}", fields.firstName?.trim() || "there")
    .replaceAll("{{studio_name}}", fields.studioName);
  if (/\{\{[^}]+\}\}/.test(resolved)) throw new Error("merge field is not in the allowlist");
  return resolved;
}

export function addressForChannel(
  channel: Channel,
  person: { email: string | null; phone: string | null },
): string | null {
  return channel === "email" ? person.email : person.phone;
}

// sample: docs/glofox/samples/members.get.limit2.json
import type { GlofoxMember } from "@kelo/contracts";
import type { MapperContext, MapperResult, PersonExternalRefRow, PersonRow } from "./types.js";
import { blankToNull, hasExternalId } from "./types.js";

/**
 * Member → people + person_external_refs rows (migration 0008; plan-final §2
 * "Tenancy & identity"). PURE — no DB, no network, no clock.
 *
 * Deliberately NOT mapped here:
 * - membership/relationship anything — phase 2 (plan-final §2 "Relationship
 *   typing": both layers are DERIVED from behavior, never imported).
 * - Glofox's lead_status / leads flag — "everyone is a lead" (README §8) and
 *   the §5-facts table rules the flag is never imported as meaning;
 *   people.lead_status is the NATIVE pipeline surface, owner-managed.
 * - source/origin channel hints — the full-history distinct-value scan is a
 *   phase-1 study; the raw zone keeps the payload verbatim.
 */
export const MAPPER_VERSION = 1;

/**
 * mapMember emits the people row AND its 'glofox' person_external_refs row in
 * one rows array (the people table's own external_ref is the import key; the
 * refs table is the multi-system registry, plan-final §2). The sync layer
 * separates them with partitionPersonRows: people first, then refs with the
 * resolved person_id.
 */
export type PersonMapperResult = MapperResult<PersonRow | PersonExternalRefRow>;

export function mapMember(member: GlofoxMember, ctx: MapperContext): PersonMapperResult {
  // The Glofox _id is the import key — a member without one cannot be keyed:
  // quarantine, never a row without identity.
  if (!hasExternalId(member._id)) {
    return {
      rows: [],
      quarantine: [
        { entity: "members", external_ref: null, payload: member, reason: "missing external id" },
      ],
    };
  }

  const person: PersonRow = {
    tenant_id: ctx.tenantId,
    // Empty string → NULL, never '' (a blank would poison the partial unique
    // index; a conflict on a REAL email quarantines for merge review by design).
    email: blankToNull(member.email),
    phone: blankToNull(member.phone),
    first_name: member.first_name,
    last_name: member.last_name,
    source: "glofox",
    external_ref: member._id,
    // The soft-delete mirror (README §6) — reactivation arrives as active:true.
    active: member.active,
    // Glofox `created`, labeled "first seen". date_quality is 'unverified'
    // ALWAYS at import — §5: created may be a migration date; the phase-1
    // validation study is what upgrades it.
    source_created_at: member.created,
    date_quality: "unverified",
    // Cohort anchor: NULL until the activity import derives it.
    first_activity_at: null,
    cohort_anchor_basis: null,
    // Native pipeline surface — NOT the Glofox lead flag (see header).
    lead_status: null,
    next_action: null,
    pipeline_owner: null,
    // Imported consent EVIDENCE (feeds owner decision D2): tri-state,
    // absent channel/object → NULL = unknown; false is evidence, not null.
    consent_email: member.consent?.email.active ?? null,
    consent_sms: member.consent?.sms.active ?? null,
    consent_push: member.consent?.push.active ?? null,
  };

  const externalRef: PersonExternalRefRow = {
    tenant_id: ctx.tenantId,
    system: "glofox",
    external_ref: member._id,
  };

  return { rows: [person, externalRef], quarantine: [] };
}

export function isPersonExternalRefRow(
  row: PersonRow | PersonExternalRefRow,
): row is PersonExternalRefRow {
  return "system" in row;
}

/** Splits a mapMember result for the sync layer's ordered inserts. */
export function partitionPersonRows(result: PersonMapperResult): {
  person: PersonRow[];
  externalRefs: PersonExternalRefRow[];
} {
  const person: PersonRow[] = [];
  const externalRefs: PersonExternalRefRow[] = [];
  for (const row of result.rows) {
    if (isPersonExternalRefRow(row)) externalRefs.push(row);
    else person.push(row);
  }
  return { person, externalRefs };
}

// sample: docs/glofox/samples/credits.get.nonempty.json
// sample: docs/glofox/samples/credits.get.json (empty pack list — no rows, no quarantine)
import type { GlofoxCredit } from "@kelo/contracts";
import type { CreditLedgerRow, MapperContext, MapperResult, QuarantineRow } from "./types.js";
import { hasExternalId } from "./types.js";

/**
 * Credit pack → append-only credit_ledger rows (migration 0008; invariant #6;
 * README §5). PURE — no DB, no network, no clock.
 *
 * One pack maps to ONE grant row (delta = num_sessions) plus DEBIT rows derived
 * from consumption (consumed = num_sessions − available):
 * - bookings[] length == consumed → one debit per consuming booking id
 *   (booking_external_ref set). This is the exact-attribution path.
 * - bookings[] length ≠ consumed → ONE aggregate debit (booking_external_ref
 *   NULL, reason noting the mismatch) AND a quarantine row — never silently
 *   guess per-booking attribution.
 *
 * Grant linkage: mappers cannot know the inserted grant's id, so debit rows
 * carry `grant_external_ref` (the credit _id); the sync layer joins it to the
 * grant row after insert. Imported debits carry external_ref NULL — the
 * partial unique index keys grants/expires, not debits.
 *
 * Mappers NEVER emit 'adjust' (a human act — reason + actor mandatory,
 * CHECK-enforced); 'expire'/'refund_credit' come from later sync processes.
 */
export const MAPPER_VERSION = 1;

export interface CreditMapperContext extends MapperContext {
  /**
   * The Kelo people.id owning this pack — the sync layer resolves
   * (tenant_id, credit.user_id) → people.external_ref BEFORE mapping.
   */
  readonly personId: string;
}

export function mapCredit(
  c: GlofoxCredit,
  ctx: CreditMapperContext,
): MapperResult<CreditLedgerRow> {
  // The credit _id keys the grant's idempotent re-import — no id, no rows.
  if (!hasExternalId(c._id)) {
    return {
      rows: [],
      quarantine: [
        { entity: "credits", external_ref: null, payload: c, reason: "missing external id" },
      ],
    };
  }

  const granted = c.num_sessions;
  const available = c.available;

  // Nonsensical values QUARANTINE the whole pack — no rows, no guessing.
  // granted <= 0 is included: a zero/negative grant delta would violate the
  // ledger's sign CHECK, so there is no honest row to emit.
  if (granted <= 0 || available < 0 || available > granted) {
    return {
      rows: [],
      quarantine: [
        {
          entity: "credits",
          external_ref: c._id,
          payload: c,
          reason: `nonsensical credit values: num_sessions ${granted} available ${available}`,
        },
      ],
    };
  }

  const rows: CreditLedgerRow[] = [
    {
      tenant_id: ctx.tenantId,
      person_id: ctx.personId,
      entry_type: "grant",
      delta: granted,
      // Absent end_date = no_expiry — the degraded rule (README §5
      // must-answer #1); NEVER treat a missing expiry as expired.
      expires_at: c.end_date ?? null,
      source: "glofox",
      external_ref: c._id,
      booking_external_ref: null,
      reason: null,
      actor_user_id: null,
    },
  ];
  const quarantine: QuarantineRow[] = [];

  const consumed = granted - available;
  if (consumed > 0) {
    if (c.bookings.length === consumed) {
      // Exact attribution: one debit per consuming booking.
      for (const bookingId of c.bookings) {
        rows.push(debit(ctx, c, -1, bookingId, null));
      }
    } else {
      // Attribution unknown: ONE aggregate debit keeps the balance exact, and
      // the mismatch is quarantined for review instead of guessed.
      rows.push(
        debit(
          ctx,
          c,
          -consumed,
          null,
          `aggregate debit: bookings list (${c.bookings.length}) does not match consumed count ` +
            `(${consumed}) — per-booking attribution unknown`,
        ),
      );
      quarantine.push(consumptionMismatch(c, granted, available));
    }
  } else if (c.bookings.length > 0) {
    // consumed == 0 with a non-empty bookings list is contradictory evidence:
    // nothing to debit, but flag it rather than trusting either side.
    quarantine.push(consumptionMismatch(c, granted, available));
  }

  return { rows, quarantine };
}

function debit(
  ctx: CreditMapperContext,
  c: GlofoxCredit,
  delta: number,
  bookingExternalRef: string | null,
  reason: string | null,
): CreditLedgerRow {
  return {
    tenant_id: ctx.tenantId,
    person_id: ctx.personId,
    entry_type: "debit",
    delta,
    expires_at: null,
    source: "glofox",
    external_ref: null,
    booking_external_ref: bookingExternalRef,
    reason,
    actor_user_id: null,
    grant_external_ref: c._id,
  };
}

function consumptionMismatch(c: GlofoxCredit, granted: number, available: number): QuarantineRow {
  return {
    entity: "credits",
    external_ref: c._id,
    payload: c,
    reason:
      `credit consumption mismatch: granted ${granted} available ${available} ` +
      `bookings ${c.bookings.length}`,
  };
}

/**
 * Pure Glofox→native mappers (migration 0008 rows + import_quarantine list).
 * Each mapper file exports its own MAPPER_VERSION; the barrel aliases them so
 * the names stay distinct package-wide.
 */
export * from "./types.js";
export {
  MAPPER_VERSION as PERSON_MAPPER_VERSION,
  isPersonExternalRefRow,
  mapMember,
  partitionPersonRows,
} from "./person.js";
export type { PersonMapperResult } from "./person.js";
export { MAPPER_VERSION as CATALOG_MAPPER_VERSION, mapMembership } from "./catalog.js";
export { MAPPER_VERSION as CREDITS_MAPPER_VERSION, mapCredit } from "./credits.js";
export type { CreditMapperContext } from "./credits.js";

// Facts slice (unit 1.3). facts-types keeps its own single-row MapperResult
// shape ({ row, quarantine } vs the list shape above) — unification is the
// sync layer's concern (unit 1.4), which consumes both.
export {
  branchWallTimeToUtc,
  MAPPER_VERSION as FACTS_MAPPER_VERSION,
} from "./facts-types.js";
export type {
  GlofoxBookingRow,
  GlofoxSessionRow,
  // Aliased: @kelo/contracts exports its own GlofoxTransactionRow (the parsed
  // report row); this is the DB-row shape the mapper emits.
  GlofoxTransactionRow as GlofoxTransactionFactRow,
  MapperContext,
} from "./facts-types.js";
export { mapEvent } from "./sessions.js";
export { mapBooking } from "./bookings.js";
export { mapTransactionRow } from "./transactions.js";

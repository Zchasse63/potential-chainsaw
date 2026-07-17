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

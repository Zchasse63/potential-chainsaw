/**
 * Wave 8.1b: `FreshnessBucket` moved to @kelo/contracts so packages/ui and
 * every app share the one type. The API still owns the thresholds
 * (apps/api/src/freshness.ts); this thin re-export keeps existing apps/web
 * import sites working unchanged.
 */
export type { FreshnessBucket } from "@kelo/contracts";

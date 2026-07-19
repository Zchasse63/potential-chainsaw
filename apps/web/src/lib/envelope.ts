/**
 * Wave 8.1b: `inspectEnvelope` moved to @kelo/contracts (the envelope schema
 * already lives there) so packages/ui and every app share ONE implementation.
 * This thin re-export keeps existing apps/web import sites working unchanged.
 */
export { inspectEnvelope, type EnvelopeInspection } from "@kelo/contracts";

/**
 * @kelo/stripe — the ONE injectable, dry-run-capable Stripe Connect adapter, the
 * webhook signature verifier, and the typed event mapper (Phase 5 billing spine;
 * CLAUDE.md invariant #5, threat-model §6). No live Stripe call happens until a
 * Connect account exists (BLOCKERS P0-5); without `STRIPE_SECRET_KEY` every
 * client runs dry-run, exactly like the @kelo/comms adapters. DB-free.
 */
export * from "./types.js";
export * from "./client.js";
export * from "./webhook.js";
export * from "./events.js";
export * from "./mock.js";

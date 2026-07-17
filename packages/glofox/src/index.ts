/**
 * @kelo/glofox — the ONE shared Glofox HTTP client (CLAUDE.md invariant #8).
 * Every Glofox call goes through createGlofoxClient; shapes come from
 * @kelo/contracts and parse at the Zod boundary. DB-free by design.
 */
export * from "./config.js";
export * from "./errors.js";
export * from "./client.js";
export * from "./endpoints.js";
export * from "./raw.js";

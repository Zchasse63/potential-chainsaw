/**
 * @kelo/netlify-functions — Netlify Function entrypoints (plan-final §1):
 * the /api/* adapter for the one Hono app, the SINGLE scheduler tick
 * (invariant #4), and the secret-gated worker background function.
 */
export { guardWorkerSecret, WORKER_SECRET_HEADER } from "./worker-guard.js";

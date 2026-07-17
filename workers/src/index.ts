/**
 * @kelo/workers — scheduler tick + job processors for the Postgres jobs queue
 * (exactly one scheduler, CLAUDE.md invariant #4). The Netlify Scheduled /
 * Background Function wrappers land in the next unit; everything they will
 * need is exported here.
 */
export {
  processors,
  type JobProcessor,
  type JobRow,
  type Queryable,
  type TickCtx,
} from "./processors.js";
export { runTick, type TickOptions, type TickResult } from "./tick.js";
export { assertWorkerSecret } from "./worker-auth.js";

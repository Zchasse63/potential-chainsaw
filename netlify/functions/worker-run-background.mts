// Netlify BACKGROUND Function (the `-background` name suffix → async 202
// invocation, 15-minute cap) for on-demand worker runs.
//
// Threat model §6: this is a publicly addressable HTTP URL, so the shared
// secret is verified BEFORE anything else — and once inside, the worker acts
// ONLY on rows claimed from the jobs queue. No request-supplied parameter is
// ever trusted.
import { createDbPool } from "@kelo/db";
import { runTick } from "@kelo/workers";
import { guardWorkerSecret } from "../src/worker-guard.js";

export { guardWorkerSecret };

export default async (req: Request): Promise<Response> => {
  const denied = guardWorkerSecret(req.headers, process.env.WORKER_SHARED_SECRET);
  if (denied !== null) {
    return denied;
  }

  const pool = createDbPool();
  try {
    const result = await runTick(pool, {
      workerId: "netlify-worker-run",
      batch: 25,
      heartbeatUrl: process.env.HEARTBEAT_PING_URL,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } finally {
    await pool.end();
  }
};

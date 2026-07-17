// INVARIANT #4: this is the SINGLE scheduled function in the ENTIRE repo — the
// one Netlify tick on a 5-minute cadence. Never add a second cron/schedule:
// all recurring work is a row in the Postgres jobs queue, claimed ONLY through
// runTick (FOR UPDATE SKIP LOCKED makes even a double-fire safe).
import type { Config } from "@netlify/functions";
import { createDbPool } from "@kelo/db";
import { runTick } from "@kelo/workers";

export const config: Config = { schedule: "*/5 * * * *" };

export default async (): Promise<Response> => {
  const pool = createDbPool();
  try {
    const result = await runTick(pool, {
      workerId: "netlify-tick",
      batch: 25,
      // External dead-man's switch (BLOCKERS P0-2): pinged AFTER the cycle.
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

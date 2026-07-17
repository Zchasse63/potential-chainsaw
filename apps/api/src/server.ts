/**
 * LOCAL DEV SERVER ONLY — production serves the app through Netlify
 * (netlify/functions/api.mts). Run: `pnpm --filter @kelo/api build && pnpm
 * --filter @kelo/api dev` with SUPABASE_URL / SUPABASE_ANON_KEY exported.
 */
import { serve } from "@hono/node-server";
import app from "./app.js";

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@kelo/api dev server listening on http://localhost:${info.port}/api/v1`);
});

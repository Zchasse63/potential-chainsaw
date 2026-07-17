// The /api/* function: serves the ONE Hono app (plan-final §1/§3). netlify.toml
// rewrites /api/* → this function with status 200, so the function sees the
// original /api/v1/... path, matching the app's basePath.
import { handle } from "hono/netlify";
import { createApp } from "@kelo/api";

export default handle(createApp());

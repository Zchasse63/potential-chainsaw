import netlify from "@netlify/vite-plugin-tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @kelo/member — TanStack Start SSR (plan-member-app §2). Plugin order is
// load-bearing: start first, the Netlify adapter, and the React plugin AFTER
// start. Tests run through the ROOT vitest config, not this file.
export default defineConfig({
  plugins: [tanstackStart(), netlify(), viteReact()],
});

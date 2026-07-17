import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @kelo/web — the operator SPA. Output lands in dist/ (netlify.toml publish
// dir). Tests run through the ROOT vitest config, not this file.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

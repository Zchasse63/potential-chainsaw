// Tailwind config for the operator app. The theme mapping lives in
// @kelo/ui/tailwind-preset (packages/ui) — the ONLY values allowed there are
// var(--kelo-*) references into the canonical tokens.css. Feature code
// consumes these semantic classes and never raw hex or arbitrary bracket
// values (ESLint guardrail 3). This file keeps only the app-local content
// globs; the resolved theme is unchanged by the extraction.
import keloPreset from "@kelo/ui/tailwind-preset";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  presets: [keloPreset],
  plugins: [],
};

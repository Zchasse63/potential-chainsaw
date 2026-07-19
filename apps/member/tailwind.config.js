// Tailwind config for the member app — same token contract as the operator
// app: the theme mapping lives in @kelo/ui/tailwind-preset (only var(--kelo-*)
// references); this file keeps only the app-local content globs
// (plan-member-app §6.2). Feature code uses semantic classes only — raw hex
// and arbitrary bracket values are lint-blocked (plan-ux §5).
import keloPreset from "@kelo/ui/tailwind-preset";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [keloPreset],
  plugins: [],
};

// Kelo ESLint flat config (ESLint 9 + typescript-eslint).
// Includes phase-0 guardrail rules enforcing CLAUDE.md invariants — violations
// are defects, not choices.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-test/**",
      "**/node_modules/**",
      "supabase/.temp/**",
      // Glofox scrape intermediates (regenerable source material, git-ignored).
      "docs/glofox/_*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // GUARDRAIL 1 — CLAUDE.md invariant #2: no fixture/seed/demo data reachable
  // from app code. Seed data lives in staging/CI only; nothing under apps/**
  // may import from a module whose path contains a fixture/seed segment.
  {
    files: ["apps/**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/*fixture*/**", "**/*fixture*", "**/*seed*/**", "**/*seed*"],
              message:
                "Invariant #2: fixture/seed/demo data must be unreachable from app code (staging/CI only).",
            },
          ],
        },
      ],
    },
  },

  // GUARDRAIL 2 — the service role key bypasses RLS and must never appear
  // client-side. The CI `secrets` job also greps apps/web sources for the
  // string literal; this rule catches it earlier, at lint time.
  {
    files: ["apps/web/**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value='SUPABASE_SERVICE_ROLE_KEY']",
          message:
            "SUPABASE_SERVICE_ROLE_KEY bypasses RLS — it must never be referenced from apps/web.",
        },
        {
          selector: "Identifier[name='SUPABASE_SERVICE_ROLE_KEY']",
          message:
            "SUPABASE_SERVICE_ROLE_KEY bypasses RLS — it must never be referenced from apps/web.",
        },
      ],
    },
  },

  // GUARDRAIL 3 — phase-0 SCAFFOLD (apps/web is a stub; the real Vite app lands
  // in a later unit). NOTE for that unit, per plans/plan-ux-final.md token
  // architecture: apps/web components must consume DESIGN TOKENS ONLY — ban raw
  // hex colors (e.g. "#1F3A3F") and arbitrary Tailwind values (e.g. "w-[13px]",
  // "bg-[#fff]"). Candidate implementation: extend the no-restricted-syntax
  // block above with selectors on string literals matching
  // /#(?:[0-9a-fA-F]{3,8})\b/ and /\[[^\]]+\]/, or a tiny local ESLint plugin
  // once the component allowlist exists. Left intentionally un-wired for now.
  {
    files: ["apps/web/**/*.{ts,tsx,js,jsx}"],
    rules: {},
  },
);

// Kelo ESLint flat config (ESLint 9 + typescript-eslint).
// Includes phase-0 guardrail rules enforcing CLAUDE.md invariants — violations
// are defects, not choices.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      // Director ops script — plain node .mjs, runs outside the TS project.
      "scripts/backfill-runner.mjs",
      ".claude/**",
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

  // GUARDRAILS 2+3 for apps/web — kept in ONE block because flat config does
  // not merge same-name rules across blocks: a second no-restricted-syntax
  // for the same files would REPLACE this one, silently disarming it
  // (probe-verified 2026-07-17).
  //
  // GUARDRAIL 2 — the service role key bypasses RLS and must never appear
  // client-side; SUPABASE_DB_URL is the direct Postgres pool string workers
  // use (service-level, bypasses RLS the same way) and is banned for the same
  // reason. The CI `secrets` job also greps apps/web sources for the string
  // literal; this rule catches it earlier, at lint time.
  //
  // GUARDRAIL 3 — token discipline (plans/plan-ux-final.md §5: feature code
  // uses semantic tokens ONLY; "raw hex and arbitrary Tailwind values are
  // lint-blocked"). apps/web code consumes design tokens via the Tailwind
  // mapping in apps/web/tailwind.config.js (var(--kelo-*) from
  // src/styles/tokens.css) — raw hex color literals and arbitrary Tailwind
  // bracket values ("w-[13px]", "bg-[#fff]") are banned in string literals
  // and JSX text. tokens.css itself is CSS, not linted TS.
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
        {
          selector: "Literal[value='SUPABASE_DB_URL']",
          message:
            "SUPABASE_DB_URL is the service-level Postgres pool string — it must never be referenced from apps/web.",
        },
        {
          selector: "Identifier[name='SUPABASE_DB_URL']",
          message:
            "SUPABASE_DB_URL is the service-level Postgres pool string — it must never be referenced from apps/web.",
        },
        {
          selector: "Literal[value=/#(?:[0-9a-fA-F]{3,8})\\b/]",
          message:
            "Raw hex colors are banned in apps/web — use the semantic design tokens (Tailwind classes mapped to var(--kelo-*)).",
        },
        {
          selector: "JSXText[value=/#(?:[0-9a-fA-F]{3,8})\\b/]",
          message:
            "Raw hex colors are banned in apps/web — use the semantic design tokens (Tailwind classes mapped to var(--kelo-*)).",
        },
        {
          // Targeted matcher: the utility-prefix + bracket signature of an
          // arbitrary Tailwind value ("w-[13px]", "max-w-[100ch]",
          // "data-[state=open]:…"). A plain bracketed string like a "[kelo]"
          // log prefix is NOT Tailwind syntax and is allowed.
          selector: "Literal[value=/[a-zA-Z][a-zA-Z0-9-]*-\\[[^\\]]+\\]/]",
          message:
            "Arbitrary Tailwind values (e.g. w-[13px]) are banned in apps/web — use token-backed scale classes from the design system.",
        },
        {
          selector: "JSXText[value=/[a-zA-Z][a-zA-Z0-9-]*-\\[[^\\]]+\\]/]",
          message:
            "Arbitrary Tailwind values (e.g. w-[13px]) are banned in apps/web — use token-backed scale classes from the design system.",
        },
      ],
    },
  },
);

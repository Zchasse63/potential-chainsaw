import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Decoupling guard (plan-member-app §4.1/§7 — the member-core import ban):
 * member-core is the PURE-TS spine shared by the web and mobile member
 * surfaces. It must never import:
 *   - @supabase/*           — member clients ship ZERO Supabase material
 *                             (no anon key, no URL, no client — §3.1 ground 2)
 *   - react / react-native  — platform chrome lives in the apps, not the core
 *   - node:* builtins       — unavailable in the React Native runtime
 *   - any app               — the dependency arrow points app → core only
 * Allowed: @kelo/contracts and same-directory relative modules.
 */

const srcDir = new URL("../src/", import.meta.url);

const sourceFiles = readdirSync(srcDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, code: readFileSync(new URL(name, srcDir), "utf8") }));

// Every import specifier in a file: `import/export … from "x"`, dynamic
// `import("x")`, AND a bare side-effect `import "x"` (which has no `from` — a
// naive from-only regex would miss `import "@supabase/foo"` for its side
// effects; that is exactly the kind of leak this guard must catch).
const IMPORT_SPECIFIER =
  /(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']|import\s+["']([^"']+)["']/g;

function specifiersOf(code: string): string[] {
  return [...code.matchAll(IMPORT_SPECIFIER)].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
}

describe("packages/member-core stays pure TS with zero Supabase material", () => {
  it("ships the client + errors + barrel", () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const { name, code } of sourceFiles) {
    it(`${name} imports no Supabase, no platform runtime, no app`, () => {
      for (const specifier of specifiersOf(code)) {
        expect(specifier, `${name} must not import @supabase`).not.toMatch(/^@supabase(\/|$)/);
        expect(specifier, `${name} must not reference supabase at all`).not.toMatch(/supabase/i);
        expect(specifier, `${name} must not import a UI runtime`).not.toMatch(
          /^react(-dom|-native)?(\/|$)/,
        );
        expect(specifier, `${name} must not import node builtins`).not.toMatch(/^node:/);
        expect(specifier, `${name} must not import an app`).not.toMatch(/(^|\/)apps\//);
        expect(specifier, `${name} must not escape the package`).not.toMatch(/^\.\.\//);
        expect(
          specifier === "@kelo/contracts" || specifier.startsWith("./"),
          `${name} may only import @kelo/contracts or ./siblings (got ${specifier})`,
        ).toBe(true);
      }
    });
  }
});

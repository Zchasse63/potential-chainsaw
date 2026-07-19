import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Decoupling guard (Wave 8.1b): packages/ui/react is the SHARED, surface-
 * neutral UI layer — it must never import an app (apps/web, apps/anything)
 * or an app-specific telemetry SDK (@sentry/*). Telemetry is INJECTED via
 * DataBoundary's onError prop. Allowed imports: react, react-dom,
 * @kelo/contracts, and same-directory relative modules.
 */

const reactDir = new URL("../react/", import.meta.url);

const sourceFiles = readdirSync(reactDir)
  .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
  .map((name) => ({ name, code: readFileSync(new URL(name, reactDir), "utf8") }));

// Every static/dynamic import specifier in a file.
const IMPORT_SPECIFIER = /(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g;

function specifiersOf(code: string): string[] {
  return [...code.matchAll(IMPORT_SPECIFIER)].map((m) => (m[1] ?? m[2]) as string);
}

describe("packages/ui/react stays decoupled from apps and telemetry SDKs", () => {
  it("ships at least the 7 contract-bearing components plus the barrel", () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(8);
  });

  for (const { name, code } of sourceFiles) {
    it(`${name} imports no app and no @sentry`, () => {
      for (const specifier of specifiersOf(code)) {
        expect(specifier, `${name} must not import an app`).not.toMatch(/^apps\//);
        expect(specifier, `${name} must not import an app`).not.toMatch(/apps\/web/);
        expect(specifier, `${name} must not import @sentry`).not.toMatch(/^@sentry(\/|$)/);
        expect(specifier, `${name} must not escape the package`).not.toMatch(/^\.\.\//);
        expect(
          ["react", "react-dom", "@kelo/contracts"].includes(specifier) ||
            specifier.startsWith("./"),
          `${name} may only import react, react-dom, @kelo/contracts, or ./siblings (got ${specifier})`,
        ).toBe(true);
      }
    });
  }
});

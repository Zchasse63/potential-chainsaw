import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * CI drift guard (plan-member-app §6.1): apps/web/src/styles/tokens.css used
 * to be a hand-copy of the canonical tokens — a declared copy that could
 * silently drift. It must now be an @import of @kelo/ui's canonical file,
 * never a copy. This test fails if anyone pastes token values back into it.
 */

const webTokens = readFileSync(
  new URL("../../../apps/web/src/styles/tokens.css", import.meta.url),
  "utf8",
);

describe("apps/web tokens.css is an import, not a copy", () => {
  it("imports the canonical @kelo/ui tokens", () => {
    expect(webTokens).toContain('@import "@kelo/ui/tokens/tokens.css";');
  });

  it("declares no --kelo-* variables itself", () => {
    expect(webTokens).not.toMatch(/--kelo-[a-z0-9-]+\s*:/);
  });
});

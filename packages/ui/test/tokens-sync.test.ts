import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseKeloTokens } from "./parse-kelo-tokens.js";

/**
 * Drift guard (plan-member-app §6.1): tokens/tokens.json is the TS-consumable
 * mirror of the canonical tokens/tokens.css — the source for the mobile theme.
 * It must list every --kelo-* custom property with the SAME value (var()
 * aliases included); CI fails if the two drift.
 */

const css = readFileSync(new URL("../tokens/tokens.css", import.meta.url), "utf8");
const json = JSON.parse(readFileSync(new URL("../tokens/tokens.json", import.meta.url), "utf8")) as {
  tokens: Record<string, string>;
};
const fromCss = parseKeloTokens(css);

describe("tokens.json ↔ tokens.css parity", () => {
  it("contains every --kelo-* variable with the same value", () => {
    expect(Object.keys(json.tokens).length).toBeGreaterThan(0);
    for (const [name, value] of fromCss) {
      expect(json.tokens[name], `--kelo-${name}`).toBe(value);
    }
  });

  it("contains no token absent from tokens.css", () => {
    expect(Object.keys(json.tokens).length).toBe(fromCss.size);
    for (const name of Object.keys(json.tokens)) {
      expect(fromCss.has(name), name).toBe(true);
    }
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertTenantBrandContrastAA, validateTenantBrandTokens } from "@kelo/contracts";
import { parseKeloTokens } from "./parse-kelo-tokens.js";

/**
 * Brand intake gate for packages/ui/brands/*.css (plan-member-app §6.3;
 * plan-ux §5 member-theme): each brand file is a VALIDATED TOKEN SUBSET —
 * never arbitrary CSS — checked against validateTenantBrandTokens (Zod, in
 * packages/contracts) plus the WCAG AA contrast matrix. This test is the CI
 * validation the plan requires; the same schema later validates the subset
 * read from tenants.settings.
 */

const systemTokens = parseKeloTokens(
  readFileSync(new URL("../tokens/tokens.css", import.meta.url), "utf8"),
);
const brandTokens = parseKeloTokens(
  readFileSync(new URL("../brands/default.css", import.meta.url), "utf8"),
);

/** Resolve var(--kelo-*) aliases (chained) against the canonical tokens. */
function resolveValue(value: string): string {
  const alias = /^var\(--kelo-([a-z0-9-]+)\)$/;
  const seen = new Set<string>();
  let current = value;
  let match = alias.exec(current);
  while (match !== null) {
    const name = match[1];
    if (name === undefined) break;
    if (seen.has(name)) throw new Error(`alias cycle at --kelo-${name}`);
    seen.add(name);
    const next = systemTokens.get(name) ?? brandTokens.get(name);
    if (next === undefined) throw new Error(`unresolvable alias: --kelo-${name}`);
    current = next;
    match = alias.exec(current);
  }
  return current;
}

function brandValue(cssVariable: string): string {
  const raw = brandTokens.get(cssVariable.replace(/^--kelo-/, ""));
  if (raw === undefined) throw new Error(`${cssVariable} missing from brands/default.css`);
  return resolveValue(raw);
}

const defaultBrand = {
  action: brandValue("--kelo-tenant-action"),
  actionFg: brandValue("--kelo-tenant-action-fg"),
  surfaceApp: brandValue("--kelo-tenant-surface-app"),
  surfaceCard: brandValue("--kelo-tenant-surface-card"),
  textPrimary: brandValue("--kelo-tenant-text-primary"),
  textSecondary: brandValue("--kelo-tenant-text-secondary"),
  displayFont: brandValue("--kelo-tenant-display-font"),
};

describe("brands/default.css — validated token subset", () => {
  it("passes validateTenantBrandTokens after alias resolution", () => {
    expect(() => validateTenantBrandTokens.parse(defaultBrand)).not.toThrow();
  });

  it("meets the WCAG AA contrast matrix", () => {
    const brand = validateTenantBrandTokens.parse(defaultBrand);
    expect(() => assertTenantBrandContrastAA(brand)).not.toThrow();
  });

  it("uses only var() aliases into the canonical tokens (the identity remap)", () => {
    for (const [name, value] of brandTokens) {
      expect(value, `--kelo-${name}`).toMatch(/^var\(--kelo-[a-z0-9-]+\)$/);
    }
  });
});

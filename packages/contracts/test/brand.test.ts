import { describe, expect, it } from "vitest";
import {
  assertContrastAA,
  assertTenantBrandContrastAA,
  contrastRatio,
  relativeLuminance,
  validateTenantBrandTokens,
} from "../src/index.js";

const validBrand = {
  action: "#3E5A74",
  actionFg: "#FFFFFF",
  surfaceApp: "#F5F6F6",
  surfaceCard: "#FCFCFC",
  textPrimary: "#10161B",
  textSecondary: "#40494F",
  displayFont: "'Familjen Grotesk', sans-serif",
};

describe("validateTenantBrandTokens (plan-ux §5 member-theme intake)", () => {
  it("accepts the validated subset (action, surfaces, type; logo optional)", () => {
    expect(validateTenantBrandTokens.parse(validBrand)).toEqual(validBrand);
    expect(
      validateTenantBrandTokens.parse({
        ...validBrand,
        logo: { square: "/brand/mark.svg", horizontal: "/brand/lockup.svg" },
      }).logo,
    ).toEqual({ square: "/brand/mark.svg", horizontal: "/brand/lockup.svg" });
  });

  it("rejects arbitrary CSS — non-hex colors and unknown keys", () => {
    expect(
      validateTenantBrandTokens.safeParse({ ...validBrand, action: "var(--anything)" }).success,
    ).toBe(false);
    expect(
      validateTenantBrandTokens.safeParse({ ...validBrand, action: "rgb(62,90,116)" }).success,
    ).toBe(false);
    expect(
      validateTenantBrandTokens.safeParse({ ...validBrand, customCss: "body { color: red }" })
        .success,
    ).toBe(false);
  });

  it("rejects a missing required token", () => {
    const noAction: Record<string, unknown> = { ...validBrand };
    delete noAction["action"];
    expect(validateTenantBrandTokens.safeParse(noAction).success).toBe(false);
  });
});

describe("WCAG AA contrast helpers", () => {
  it("computes relative luminance at the anchors", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 6);
  });

  it("computes the contrast ratio (black/white = 21:1, order-independent)", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 0);
    expect(contrastRatio("#FFF", "#000")).toBeCloseTo(21, 0);
  });

  it("passes AA pairs and rejects sub-AA pairs (reject, never warn)", () => {
    expect(assertContrastAA("#FFFFFF", "#3E5A74")).toBeGreaterThanOrEqual(4.5);
    expect(() => assertContrastAA("#97A0A4", "#FCFCFC")).toThrow(/WCAG AA contrast failure/);
  });

  it("assertTenantBrandContrastAA rejects a brand whose action pair fails AA", () => {
    expect(() => assertTenantBrandContrastAA(validateTenantBrandTokens.parse(validBrand))).not.toThrow();
    const washedOut = validateTenantBrandTokens.parse({ ...validBrand, action: "#EDF1F4" });
    expect(() => assertTenantBrandContrastAA(washedOut)).toThrow(/WCAG AA contrast failure/);
  });
});

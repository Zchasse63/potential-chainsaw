import { z } from "zod";

/**
 * Tenant brand token intake (plan-ux-final §5 member-theme; plan-member-app
 * §6.3). The ONLY tokens a tenant may set on the member surface are a
 * validated subset — logo tokens, action color, surfaces, type — never
 * arbitrary tenant CSS. Every text/bg pair must pass WCAG 2.2 AA at intake;
 * sub-AA values are rejected, not warned. packages/ui/brands/*.css files are
 * validated against this schema in CI (packages/ui/test/brands.test.ts); the
 * later tenant-intake path validates the same subset from tenants.settings.
 */

const hexColor = z
  .string()
  .regex(/^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, "expected #RGB or #RRGGBB");

export const validateTenantBrandTokens = z
  .object({
    /** Primary action color (member-theme: tenant-action). */
    action: hexColor,
    /** Text on the action color — AA-checked against `action`. */
    actionFg: hexColor,
    /** Page background. */
    surfaceApp: hexColor,
    /** Card background. */
    surfaceCard: hexColor,
    /** AA-checked against both surfaces. */
    textPrimary: hexColor,
    /** AA-checked against both surfaces. */
    textSecondary: hexColor,
    /** One display face (licensed by tenant); UI + mono faces stay Kelo system. */
    displayFont: z.string().min(1),
    /** Asset slot (square + horizontal lockup). Absent = text-lockup fallback. */
    logo: z
      .object({ square: z.string().min(1), horizontal: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export type TenantBrandTokens = z.infer<typeof validateTenantBrandTokens>;

/** WCAG 2.2 minimum contrast for normal text (SC 1.4.3). */
export const WCAG_AA_NORMAL_TEXT = 4.5;

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9A-Fa-f]{6}$/.test(h)) {
    throw new Error(`expected #RGB or #RRGGBB, got: ${hex}`);
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG 2.x relative luminance of an sRGB hex color (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const linear = (channel: number): number => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * WCAG contrast ratio (1–21). Luminance-based, so it is hue-independent —
 * the same check protects color-vision-deficient users; the reserved-hue
 * collision rule (member-theme: tenant-action vs danger/success/AI) is a
 * separate intake check that lands with tenant intake.
 */
export function contrastRatio(foreground: string, background: string): number {
  const lf = relativeLuminance(foreground);
  const lb = relativeLuminance(background);
  const lighter = Math.max(lf, lb);
  const darker = Math.min(lf, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Assert WCAG AA contrast; returns the ratio, throws below `minRatio`
 * (default 4.5:1 — normal text). Intake rejects, never warns.
 */
export function assertContrastAA(
  foreground: string,
  background: string,
  minRatio: number = WCAG_AA_NORMAL_TEXT,
): number {
  const ratio = contrastRatio(foreground, background);
  if (ratio < minRatio) {
    throw new Error(
      `WCAG AA contrast failure: ${foreground} on ${background} is ${ratio.toFixed(2)}:1 (< ${minRatio}:1)`,
    );
  }
  return ratio;
}

/**
 * The full AA matrix a tenant brand must pass (member-theme): action text on
 * action, action on the app surface, and both text tokens on both surfaces.
 */
export function assertTenantBrandContrastAA(brand: TenantBrandTokens): void {
  assertContrastAA(brand.actionFg, brand.action);
  assertContrastAA(brand.action, brand.surfaceApp);
  assertContrastAA(brand.textPrimary, brand.surfaceApp);
  assertContrastAA(brand.textPrimary, brand.surfaceCard);
  assertContrastAA(brand.textSecondary, brand.surfaceApp);
  assertContrastAA(brand.textSecondary, brand.surfaceCard);
}

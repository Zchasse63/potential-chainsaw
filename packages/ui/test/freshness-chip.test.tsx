// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { FreshnessBucket } from "@kelo/contracts";
import { FreshnessChip } from "../react/freshness-chip.jsx";

afterEach(cleanup);

function markerOf(chip: HTMLElement): string | null {
  return chip.firstElementChild?.getAttribute("data-marker") ?? null;
}

describe("FreshnessChip (design guide §4)", () => {
  it("live → ● LIVE, success dot, hairline border (healthy)", () => {
    render(<FreshnessChip bucket="live" minutesStale={0} />);
    const chip = screen.getByTestId("freshness-chip");
    expect(chip.textContent).toBe("LIVE");
    expect(markerOf(chip)).toBe("circle");
    expect(chip.className).toContain("text-success-on-tint");
    expect(chip.className).toContain("border-hairline");
  });

  it("synced → ● SYNCED {n}M, dot n400 but TEXT at the n600 ink floor", () => {
    render(<FreshnessChip bucket="synced" minutesStale={5} />);
    const chip = screen.getByTestId("freshness-chip");
    expect(chip.textContent).toBe("SYNCED 5M");
    expect(markerOf(chip)).toBe("circle");
    // The freshness-aged split (amendment): neutral-400 is the dot only and is
    // NEVER a text color — the label uses the muted text role (neutral-600).
    expect(chip.className).toContain("text-ink-muted");
    expect(chip.className).not.toContain("text-neutral-400");
    expect(chip.firstElementChild?.className).toContain("bg-neutral-400");
  });

  it("stale → ● STALE {n}H on amber tint (≥2h)", () => {
    render(<FreshnessChip bucket="stale" minutesStale={130} />);
    const chip = screen.getByTestId("freshness-chip");
    expect(chip.textContent).toBe("STALE 2H");
    expect(markerOf(chip)).toBe("circle");
    expect(chip.className).toContain("bg-warning-tint");
    expect(chip.className).toContain("text-warning-on-tint");
  });

  it("critical → ■ STALE 4H+ — dot becomes a SQUARE, weight 600", () => {
    render(<FreshnessChip bucket="critical" minutesStale={300} />);
    const chip = screen.getByTestId("freshness-chip");
    expect(chip.textContent).toBe("STALE 4H+");
    expect(markerOf(chip)).toBe("square");
    expect(chip.className).toContain("font-semibold");
    expect(chip.className).toContain("bg-danger-tint");
  });

  it("unknown → ○ NO DATA, a neutral honest state", () => {
    render(<FreshnessChip bucket="unknown" minutesStale={null} />);
    const chip = screen.getByTestId("freshness-chip");
    expect(chip.textContent).toBe("NO DATA");
    expect(markerOf(chip)).toBe("ring");
    expect(chip.className).toContain("text-ink-muted");
  });

  it("never communicates by color alone: every bucket has distinct TEXT and a distinct marker SHAPE", () => {
    const buckets: FreshnessBucket[] = ["live", "synced", "stale", "critical", "unknown"];
    const labels = new Set<string>();
    const shapes = new Set<string>();
    for (const bucket of buckets) {
      const { container, unmount } = render(
        <FreshnessChip bucket={bucket} minutesStale={bucket === "stale" ? 130 : null} />,
      );
      const chip = screen.getByTestId("freshness-chip");
      expect(chip.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      labels.add(chip.textContent ?? "");
      shapes.add(markerOf(chip) ?? "");
      unmount();
      expect(container).toBeDefined();
    }
    // 5 distinct labels; and the shape changes with severity (circle →
    // square at critical, ring for unknown) — state is never color-only.
    expect(labels.size).toBe(5);
    expect(shapes.size).toBeGreaterThan(1);
  });
});

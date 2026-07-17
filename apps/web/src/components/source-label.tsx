/**
 * SourceLabel — provenance in plain language (design guide §4):
 *   native   → "Live in Kelo", plain text on a plain surface.
 *   imported → "Imported from Glofox" on the imported-data MATERIAL: birch
 *              hatch background, dashed birch-400 border, VIA GLOFOX tag.
 * Phase 0 renders native (the /health envelope is meta.source "native"); the
 * imported variant ships now because phase 1 import surfaces depend on it.
 */
export function SourceLabel({ source }: { source: "native" | "glofox" }) {
  if (source === "glofox") {
    return (
      <span className="inline-flex items-center gap-2 rounded-2 border border-dashed border-birch-400 bg-hatch px-2 py-1">
        <span className="text-chrome text-birch-text">Imported from Glofox</span>
        <span className="border-l border-birch-400 pl-2 font-mono text-micro uppercase tracking-wide text-birch-text">
          Via Glofox
        </span>
      </span>
    );
  }
  return <span className="text-chrome text-ink-muted">Live in Kelo</span>;
}

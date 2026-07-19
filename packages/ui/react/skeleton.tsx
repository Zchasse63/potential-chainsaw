/**
 * Static skeleton block (tokens.css v1.1: static, NO shimmer — the reduced-
 * motion fix bans shimmer outright). Compose these to match the final layout
 * geometry exactly (design guide §6: "skeletons match final layout").
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={`rounded-2 bg-skeleton-base ${className ?? ""}`} />;
}

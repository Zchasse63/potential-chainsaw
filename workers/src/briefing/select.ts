import type { Candidate } from "./types.js";

/** A score below one is too weak to manufacture urgency around. */
export const BRIEFING_IMPACT_FLOOR = 1;

/**
 * Deterministically choose at most three items. Data-health is mandatory when
 * present, ties resolve by stable id, and a category can occupy at most two
 * slots so a three-card briefing is never a monoculture.
 */
export function selectCandidates(
  candidates: readonly Candidate[],
  impactFloor = BRIEFING_IMPACT_FLOOR,
): Candidate[] {
  const eligible = [...candidates]
    .filter((candidate) => candidate.impact_score >= impactFloor)
    .sort(
      (left, right) =>
        right.impact_score - left.impact_score || left.id.localeCompare(right.id),
    );
  if (eligible.length === 0) return [];

  const selected: Candidate[] = [];
  const categoryCounts = new Map<string, number>();
  const health = eligible.find((candidate) => candidate.category === "data_health");
  if (health !== undefined) {
    selected.push(health);
    categoryCounts.set(health.category, 1);
  }

  // First pass maximizes distinct categories before a second item from any
  // category is allowed.
  for (const candidate of eligible) {
    if (selected.length === 3) break;
    if (selected.some((item) => item.id === candidate.id)) continue;
    const count = categoryCounts.get(candidate.category) ?? 0;
    if (count > 0) continue;
    selected.push(candidate);
    categoryCounts.set(candidate.category, count + 1);
  }

  // If fewer than three categories are available, fill up to three while
  // retaining the hard cap of two items from one category.
  for (const candidate of eligible) {
    if (selected.length === 3) break;
    if (selected.some((item) => item.id === candidate.id)) continue;
    const count = categoryCounts.get(candidate.category) ?? 0;
    if (count >= 2) continue;
    selected.push(candidate);
    categoryCounts.set(candidate.category, count + 1);
  }

  return selected.sort(
    (left, right) => right.impact_score - left.impact_score || left.id.localeCompare(right.id),
  );
}

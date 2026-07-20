import { describe, expect, it } from "vitest";
import { validateHonesty } from "../../src/briefing/synthesize.js";
import type { Candidate, SynthesisOutput } from "../../src/briefing/types.js";

/**
 * WS-9 — the briefing HONESTY FENCE (validateHonesty) had ZERO coverage. It is
 * the anti-hallucination gate: every digit sequence a model writes into an
 * insight must already occur in THAT candidate's numeric facts / dated evidence,
 * every candidate must be returned exactly once, and — the case the audit named
 * — a candidate's ID (a UUID/slug with digits) must NOT authorize a prose
 * number. These pin all four failure modes plus the happy path.
 */

function candidate(id: string, facts: Record<string, number>, evidence: Record<string, unknown> = {}): Candidate {
  return { id, category: "retention", headline_facts: facts, impact_score: 1, evidence };
}
function output(insights: SynthesisOutput["insights"]): SynthesisOutput {
  return { insights };
}
const insight = (id: string, headline: string, why = "reason", action = "act") => ({ id, headline, why, action });

describe("validateHonesty — the briefing anti-hallucination fence", () => {
  it("accepts an output whose digits all occur in the candidate's facts", () => {
    const cands = [candidate("c1", { at_risk: 42 })];
    expect(() => validateHonesty(output([insight("c1", "42 members are at risk")]), cands)).not.toThrow();
  });

  it("rejects a prose number that does NOT occur in the candidate's facts", () => {
    const cands = [candidate("c1", { at_risk: 42 })];
    expect(() => validateHonesty(output([insight("c1", "revenue grew 99 percent")]), cands)).toThrow(
      /unsupported digit sequence/,
    );
  });

  it("rejects when not every selected candidate is returned (length mismatch)", () => {
    const cands = [candidate("c1", { n: 3 }), candidate("c2", { n: 4 })];
    expect(() => validateHonesty(output([insight("c1", "3 things")]), cands)).toThrow(
      /every selected candidate/,
    );
  });

  it("rejects an unknown candidate id", () => {
    const cands = [candidate("c1", { n: 3 })];
    expect(() => validateHonesty(output([insight("ghost", "3 things")]), cands)).toThrow(
      /unknown or duplicate/,
    );
  });

  it("rejects a duplicate candidate id", () => {
    const cands = [candidate("c1", { n: 3 }), candidate("c2", { n: 4 })];
    expect(() =>
      validateHonesty(output([insight("c1", "3 things"), insight("c1", "3 more")]), cands),
    ).toThrow(/unknown or duplicate/);
  });

  it("a candidate ID's OWN digits do NOT authorize a prose number (the audit's case)", () => {
    // The id carries "2026"; the facts carry only "7". A model reusing the id's
    // digits in prose must still be refused — ids are not numeric facts.
    const cands = [candidate("cand-2026-abc", { visits: 7 })];
    expect(() => validateHonesty(output([insight("cand-2026-abc", "up 2026 this year")]), cands)).toThrow(
      /unsupported digit sequence/,
    );
    // The genuine fact digit (7) is still allowed.
    expect(() => validateHonesty(output([insight("cand-2026-abc", "7 visits")]), cands)).not.toThrow();
  });
});

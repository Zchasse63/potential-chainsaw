import { z } from "zod";

export const briefingCategorySchema = z.enum([
  "revenue",
  "payments",
  "retention",
  "conversion",
  "data_health",
]);
export type BriefingCategory = z.infer<typeof briefingCategorySchema>;

export const candidateSchema = z.object({
  id: z.string().min(1),
  category: briefingCategorySchema,
  headline_facts: z.record(z.number().finite()),
  impact_score: z.number().finite().nonnegative(),
  evidence: z.record(z.unknown()),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const metricDefinitionInputSchema = z.object({
  key: z.string().min(1),
  version: z.number().int().positive(),
  definition: z.string(),
});
export type MetricDefinitionInput = z.infer<typeof metricDefinitionInputSchema>;

export const synthesisOutputSchema = z.object({
  insights: z
    .array(
      z.object({
        id: z.string().min(1),
        headline: z.string().min(1).max(90),
        why: z.string().min(1).max(200),
        action: z.string().min(1).max(90),
      }).strict(),
    )
    .max(3),
}).strict();
export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;

export interface DeterministicOutput {
  insights: Array<{
    id: string;
    category: BriefingCategory;
    headline_facts: Record<string, number>;
    evidence: Record<string, unknown>;
  }>;
  message?: "no urgent actions today";
}

export function deterministicOutput(candidates: readonly Candidate[]): DeterministicOutput {
  return {
    insights: candidates.map(({ id, category, headline_facts, evidence }) => ({
      id,
      category,
      headline_facts,
      evidence,
    })),
    ...(candidates.length === 0 ? { message: "no urgent actions today" as const } : {}),
  };
}

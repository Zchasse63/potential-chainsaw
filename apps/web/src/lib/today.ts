import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchEnvelope, postEnvelope } from "./api.js";

export type BriefingStatus = "generated" | "fallback" | "refused";

export interface BriefingArtifact {
  id: string;
  generated_for: string;
  status: BriefingStatus;
  prompt_version: number | null;
  model: string | null;
  input: unknown;
  input_hash: string;
  output: unknown | null;
  cost_usd: number | null;
  error: string | null;
  created_at: string;
}

export interface BriefingResponse {
  artifact: BriefingArtifact;
}

export interface MetricDefinitionRef {
  key: string;
  version: number;
}

export interface KpiMetric<T = unknown> {
  value: T;
  definition: MetricDefinitionRef;
}

export interface KpiReport {
  member_count: KpiMetric<number>;
  mrr: KpiMetric<{ mrr: number; contributing_members: number; excluded_partner: number }>;
  collected_30d: KpiMetric<{
    gross: number;
    refunds: number;
    net: number;
    txn_count: number;
  }>;
  failed_payments: KpiMetric<{ failed_count: number; failed_sum: number; people: number }>;
  credit_liability: KpiMetric<{
    outstanding_credits: number;
    est_liability: number;
    approximate: boolean;
  }>;
  attendance_30d: KpiMetric<{
    attended: number;
    no_show: number;
    late_cancel: number;
    attendance_rate: number;
    no_show_rate: number;
  }>;
}

export type KpiKey = keyof KpiReport;

export interface MetricDefinition {
  id: string;
  key: string;
  version: number;
  definition: string;
  notes: string | null;
  effective_from: string;
  created_at: string;
}

export interface DefinitionsResponse {
  definitions: MetricDefinition[];
}

export type FocusCategory = "payment_risk" | "at_risk" | "credits_expiring" | "hooked";

export interface FocusQueueItem {
  item_key: string;
  category: FocusCategory;
  person_id: string;
  facts: Record<string, unknown>;
}

export interface FocusQueueResponse {
  items: FocusQueueItem[];
}

export interface FeedbackInput {
  artifact_id: string;
  item_ref: string;
  verdict: "up" | "down";
}

export interface FocusDismissInput {
  item_key: string;
  action: "dismissed" | "snoozed";
  reason?: string;
  snooze_until?: string;
}

export interface MutationCallbacks {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

export interface FeedbackMutationHandle {
  mutate: (input: FeedbackInput, callbacks?: MutationCallbacks) => void;
}

export interface FocusMutationHandle {
  mutate: (input: FocusDismissInput, callbacks?: MutationCallbacks) => void;
}

export function useBriefingQuery(accessToken: string | undefined) {
  return useQuery({
    queryKey: ["briefing", "today"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/briefing", accessToken as string),
    retry: false,
  });
}

export function useYesterdayBriefingQuery(accessToken: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["briefing", "yesterday"],
    enabled: accessToken !== undefined && enabled,
    queryFn: () => fetchEnvelope("/briefing?fallback=yesterday", accessToken as string),
    retry: false,
  });
}

export function useKpiQuery(accessToken: string | undefined) {
  return useQuery({
    queryKey: ["reports", "kpis"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/reports/kpis", accessToken as string),
    retry: 1,
    refetchInterval: 60_000,
  });
}

export function useDefinitionsQuery(accessToken: string | undefined) {
  return useQuery({
    queryKey: ["reports", "definitions"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/reports/definitions", accessToken as string),
    retry: 1,
    staleTime: 30 * 60_000,
  });
}

export function useFocusQueueQuery(accessToken: string | undefined) {
  return useQuery({
    queryKey: ["focus-queue"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/focus-queue", accessToken as string),
    retry: 1,
    refetchInterval: 60_000,
  });
}

export function useBriefingFeedbackMutation(
  accessToken: string | undefined,
): FeedbackMutationHandle {
  const mutation = useMutation({
    mutationFn: (input: FeedbackInput) =>
      postEnvelope("/briefing/feedback", accessToken as string, input),
  });
  return {
    mutate: (input, callbacks) => {
      mutation.mutate(input, {
        onSuccess: () => callbacks?.onSuccess?.(),
        onError: (error) => callbacks?.onError?.(error),
      });
    },
  };
}

export function useFocusDismissMutation(accessToken: string | undefined): FocusMutationHandle {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: FocusDismissInput) =>
      postEnvelope("/focus-queue/dismiss", accessToken as string, input),
  });
  return {
    mutate: (input, callbacks) => {
      mutation.mutate(input, {
        onSuccess: () => {
          callbacks?.onSuccess?.();
          void queryClient.invalidateQueries({ queryKey: ["focus-queue"] });
        },
        onError: (error) => callbacks?.onError?.(error),
      });
    },
  };
}

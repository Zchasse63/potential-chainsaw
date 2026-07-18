import { useMutation, useQuery } from "@tanstack/react-query";
import { fetchEnvelope, postEnvelope } from "./api.js";

export interface AskCatalogEntry {
  key: string;
  version: number;
  title: string;
  description: string;
  params_schema: Record<string, unknown>;
  metric_keys: string[];
}

export interface AskCatalogResponse { catalog: AskCatalogEntry[] }

export interface AskAnswer {
  narration: string | null;
  note?: string;
  rows: Array<Record<string, unknown>>;
  citation: { catalog_key: string; version: number; metric_keys: string[] } | null;
}

export interface AskResponse {
  miss: boolean;
  answer: AskAnswer;
  catalog?: AskCatalogEntry[];
}

export interface AskMutationHandle {
  mutate: (
    question: string,
    callbacks: { onSuccess: (data: unknown) => void; onError: (error: unknown) => void },
  ) => void;
  pending: boolean;
}

export interface HeatmapSession {
  session_id: string;
  name: string | null;
  time_start: string;
  booked: number;
  capacity: number;
}

export interface HeatmapCell {
  dow: number;
  daypart: string;
  sessions: number;
  booked: number;
  capacity: number;
  fill: number;
  underlying_sessions: HeatmapSession[];
}

export interface HeatmapResponse {
  metric: "30-day fill";
  approximation: string;
  from: string;
  to: string;
  cells: HeatmapCell[];
}

export interface BriefingArchiveArtifact {
  id: string;
  generated_for: string;
  status: "generated" | "fallback" | "refused";
  output: unknown | null;
}
export interface BriefingArchiveResponse { artifacts: BriefingArchiveArtifact[] }

export function useAskCatalogQuery(accessToken: string | undefined) {
  return useQuery({
    queryKey: ["ask", "catalog"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/ask/catalog", accessToken as string),
    staleTime: 30 * 60_000,
  });
}

export function useAskMutation(accessToken: string | undefined): AskMutationHandle {
  const mutation = useMutation({
    mutationFn: (question: string) => postEnvelope("/ask", accessToken as string, { question }),
  });
  return {
    pending: mutation.isPending,
    mutate: (question, callbacks) => mutation.mutate(question, callbacks),
  };
}

function dateShift(days: number): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + days, 12));
  return date.toISOString().slice(0, 10);
}

export function useScheduleHeatmapQuery(accessToken: string | undefined) {
  const from = dateShift(-29);
  const to = dateShift(0);
  return useQuery({
    queryKey: ["schedule", "heatmap", from, to],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope(`/schedule/heatmap?from=${from}&to=${to}`, accessToken as string),
    retry: 1,
  });
}

export function useBriefingArchiveQuery(accessToken: string | undefined) {
  return useQuery({
    queryKey: ["briefing", "archive"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/briefing/archive?limit=30", accessToken as string),
    retry: 1,
  });
}

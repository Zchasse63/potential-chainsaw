import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchEnvelope, patchEnvelope, postEnvelope } from "./api.js";

/**
 * Scheduling authoring data layer — the web mirror of
 * apps/api/src/routes/scheduling-authoring.ts (migration 0027). Types echo the
 * Zod row schemas in apps/api/src/data-scheduling.ts; the pure time helpers
 * reproduce the server's DST-safe wall-time resolution so the authoring form
 * can PREVIEW the resolved absolute instant without a round-trip (no network in
 * a preview — plan-ux honesty rule: show the real resolution, DST traps and
 * all). Every mutation goes through post/patchEnvelope, so each carries an
 * Idempotency-Key and there is NO optimistic UI: the grid reflects a change
 * only after the confirmed envelope invalidates the overview query.
 */

export type ResourceKind = "room" | "equipment" | "trainer_slot";
export type ReadinessState = "ready" | "turnover" | "maintenance" | "closed";
export type SessionStatus = "draft" | "published" | "cancelled";

export const RESOURCE_KINDS: ResourceKind[] = ["room", "equipment", "trainer_slot"];
export const READINESS_STATES: ReadinessState[] = ["ready", "turnover", "maintenance", "closed"];

export interface ResourceRow {
  id: string;
  name: string;
  kind: ResourceKind;
  capacity: number;
  active: boolean;
  created_at: string;
}

export interface ReadinessRow {
  id: string;
  resource_id: string;
  state: ReadinessState;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_at: string;
}

export interface OfferingTemplateRow {
  id: string;
  name: string;
  duration_minutes: number;
  default_capacity: number | null;
  kelo_type: string | null;
  description: string | null;
  active: boolean;
  created_at: string;
}

export interface ScheduleRuleRow {
  id: string;
  offering_template_id: string;
  resource_id: string;
  rrule: string;
  local_start_time: string;
  timezone: string;
  start_date: string;
  end_date: string | null;
  active: boolean;
  created_at: string;
}

export interface ScheduledSessionRow {
  id: string;
  offering_template_id: string;
  resource_id: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  status: SessionStatus;
  schedule_rule_id: string | null;
  created_by: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /scheduling/overview — the single envelope that feeds the Authoring tab. */
export interface SchedulingOverview {
  timezone: string;
  from: string;
  to: string;
  resources: ResourceRow[];
  readiness: ReadinessRow[];
  offering_templates: OfferingTemplateRow[];
  schedule_rules: ScheduleRuleRow[];
  sessions: ScheduledSessionRow[];
}

export interface MutationCallbacks {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

/** A minimal, injectable mutation handle (mirrors lib/today.ts handles). */
export interface Mutator<I> {
  mutate: (input: I, callbacks?: MutationCallbacks) => void;
  pending: boolean;
}

export interface CreateResourceInput {
  name: string;
  kind: ResourceKind;
  capacity: number;
}
export interface UpdateResourceInput {
  id: string;
  name?: string;
  kind?: ResourceKind;
  capacity?: number;
  active?: boolean;
}
export interface CreateTemplateInput {
  name: string;
  duration_minutes: number;
  default_capacity?: number | null;
}
export interface UpdateTemplateInput {
  id: string;
  name?: string;
  duration_minutes?: number;
  default_capacity?: number | null;
  active?: boolean;
}
export interface SetReadinessInput {
  resource_id: string;
  state: ReadinessState;
  effective_from: string;
  note?: string | null;
}
export interface CreateSessionInput {
  offering_template_id: string;
  resource_id: string;
  local_date: string;
  local_start_time: string;
  capacity?: number;
}
export interface UpdateSessionInput {
  id: string;
  offering_template_id?: string;
  resource_id?: string;
  local_date?: string;
  local_start_time?: string;
  capacity?: number;
}
export interface PublishInput {
  session_ids: string[];
}

export interface SchedulingActions {
  createResource: Mutator<CreateResourceInput>;
  updateResource: Mutator<UpdateResourceInput>;
  createTemplate: Mutator<CreateTemplateInput>;
  updateTemplate: Mutator<UpdateTemplateInput>;
  setReadiness: Mutator<SetReadinessInput>;
  createSession: Mutator<CreateSessionInput>;
  updateSession: Mutator<UpdateSessionInput>;
  publish: Mutator<PublishInput>;
}

const OVERVIEW_KEY = ["scheduling", "overview"] as const;

/**
 * A generous fixed window (device-local, roughly three weeks around now) sent
 * as the overview's `from`/`to`. It only needs to comfortably contain the
 * current studio-local week; the grid derives its seven day columns from the
 * studio timezone in the response, so this window's exact edges never show.
 */
export function overviewWindow(now: Date = new Date()): { from: string; to: string } {
  const from = new Date(now);
  from.setDate(now.getDate() - 10);
  from.setHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setDate(now.getDate() + 18);
  to.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function useSchedulingOverviewQuery(accessToken: string | undefined, enabled: boolean) {
  const { from, to } = overviewWindow();
  return useQuery({
    queryKey: [...OVERVIEW_KEY, from, to],
    enabled: accessToken !== undefined && enabled,
    queryFn: () =>
      fetchEnvelope(
        `/scheduling/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        accessToken as string,
      ),
    retry: 1,
  });
}

function useSchedulingMutator<I>(fn: (input: I) => Promise<unknown>): Mutator<I> {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
  });
  return {
    pending: mutation.isPending,
    mutate: (input, callbacks) =>
      mutation.mutate(input, {
        onSuccess: () => callbacks?.onSuccess?.(),
        onError: (error) => callbacks?.onError?.(error),
      }),
  };
}

/** Wires the eight authoring mutations; each invalidates the overview on ack. */
export function useSchedulingActions(accessToken: string | undefined): SchedulingActions {
  const token = accessToken as string;
  return {
    createResource: useSchedulingMutator<CreateResourceInput>((input) =>
      postEnvelope("/scheduling/resources", token, input),
    ),
    updateResource: useSchedulingMutator<UpdateResourceInput>(({ id, ...patch }) =>
      patchEnvelope(`/scheduling/resources/${encodeURIComponent(id)}`, token, patch),
    ),
    createTemplate: useSchedulingMutator<CreateTemplateInput>((input) =>
      postEnvelope("/scheduling/offering-templates", token, input),
    ),
    updateTemplate: useSchedulingMutator<UpdateTemplateInput>(({ id, ...patch }) =>
      patchEnvelope(`/scheduling/offering-templates/${encodeURIComponent(id)}`, token, patch),
    ),
    setReadiness: useSchedulingMutator<SetReadinessInput>((input) =>
      postEnvelope("/scheduling/readiness", token, input),
    ),
    createSession: useSchedulingMutator<CreateSessionInput>((input) =>
      postEnvelope("/scheduling/sessions", token, input),
    ),
    // POST alias for the draft-session edit (carries the Idempotency-Key).
    updateSession: useSchedulingMutator<UpdateSessionInput>(({ id, ...patch }) =>
      postEnvelope(`/scheduling/sessions/${encodeURIComponent(id)}`, token, patch),
    ),
    publish: useSchedulingMutator<PublishInput>((input) =>
      postEnvelope("/scheduling/publish", token, input),
    ),
  };
}

/** owner/manager may author; front_desk and trainer may not (matches requireRole). */
export function useCanAuthor(accessToken: string | undefined): {
  ready: boolean;
  canAuthor: boolean;
} {
  const query = useQuery({
    queryKey: ["auth", "me"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/auth/me", accessToken as string),
    retry: false,
  });
  if (query.status !== "success") return { ready: false, canAuthor: false };
  const tenants = (query.data as { data?: { tenants?: { role?: string }[] } }).data?.tenants ?? [];
  return {
    ready: true,
    canAuthor: tenants.some((tenant) => tenant.role === "owner" || tenant.role === "manager"),
  };
}

// -- Pure DST-safe wall-time helpers (no network; mirror of the server's
//    localWallTimeToInstant round-trip guard in apps/api/src/data-scheduling.ts) --

const WALL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function zoneParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const p = zoneParts(new Date(utcMs), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

export type ResolvedWallTime =
  | { ok: true; instant: Date }
  | { ok: false; reason: "invalid" | "nonexistent" };

/**
 * Resolve a local (wall) date+time in a timezone to the absolute instant, using
 * the same two-pass Intl offset refinement + round-trip guard as the server. A
 * nonexistent spring-forward wall time is reported honestly, never silently
 * shifted to a different displayed hour.
 */
export function resolveWallTime(
  localDate: string,
  localTime: string,
  timeZone: string,
): ResolvedWallTime {
  const dateMatch = WALL_DATE.exec(localDate);
  const timeMatch = WALL_TIME.exec(localTime);
  if (dateMatch === null || timeMatch === null || !isValidTimeZone(timeZone)) {
    return { ok: false, reason: "invalid" };
  }
  const [, year, month, day] = dateMatch;
  const [, hour, minute] = timeMatch;
  const wallAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  const firstOffset = zoneOffsetMs(wallAsUtc, timeZone);
  const secondOffset = zoneOffsetMs(wallAsUtc - firstOffset, timeZone);
  const instant = new Date(wallAsUtc - secondOffset);
  const rt = zoneParts(instant, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  const roundTripDate = `${rt.year}-${pad(rt.month)}-${pad(rt.day)}`;
  const roundTripTime = `${pad(rt.hour)}:${pad(rt.minute)}`;
  if (roundTripDate !== localDate || roundTripTime !== localTime) {
    return { ok: false, reason: "nonexistent" };
  }
  return { ok: true, instant };
}

/** The studio-local calendar date (YYYY-MM-DD) an instant falls on. */
export function studioDate(instant: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(typeof instant === "string" ? new Date(instant) : instant);
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}`;
}

/** Clock time (e.g. "6:00 AM") of an instant in the studio timezone. */
export function studioClock(instant: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(typeof instant === "string" ? new Date(instant) : instant);
}

/** Full studio-local label with weekday, date and short zone name. */
export function studioDateTime(instant: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(typeof instant === "string" ? new Date(instant) : instant);
}

/** 0=Sun … 6=Sat for a YYYY-MM-DD calendar date (tz-independent). */
export function weekdayOfDate(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

export function addLocalDays(dateStr: string, amount: number): string {
  const base = new Date(`${dateStr}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + amount);
  return base.toISOString().slice(0, 10);
}

/** Monday (ISO week start) of the week containing the given date. */
export function startOfWeek(dateStr: string): string {
  const daysFromMonday = (weekdayOfDate(dateStr) + 6) % 7;
  return addLocalDays(dateStr, -daysFromMonday);
}

/** The seven Mon–Sun calendar dates of the studio week containing `today`. */
export function weekColumns(today: string): string[] {
  const monday = startOfWeek(today);
  return Array.from({ length: 7 }, (_, index) => addLocalDays(monday, index));
}

/** Human weekday+date label (e.g. "Mon Jul 21") for a YYYY-MM-DD date. */
export function humanWeekday(dateStr: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${dateStr}T12:00:00Z`));
}

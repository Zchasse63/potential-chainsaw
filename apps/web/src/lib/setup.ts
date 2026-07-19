import { fetchEnvelope, postEnvelope } from "./api.js";
import { inspectEnvelope } from "./envelope.js";

/**
 * The typed SETUP / launch-readiness client (Phase 7 · unit 7.1c). It consumes
 * two API contracts:
 *   GET  /readiness       — the UX §G five-stage checklist, every gate computed
 *                           from REAL data server-side (never self-report).
 *   POST /readiness/ack   — acknowledge a SOFT warn gate with an audit note.
 *                           Acknowledge ≠ resolve (UX §F): the gate stays warn.
 *   GET  /authority       — the 8-domain authority matrix (glofox | kelo).
 *   POST /authority/flip  — OWNER ONLY + step-up grant: re-home a domain.
 * The screen is presentational and never imports this module directly — the
 * route composes these calls into the injected handlers.
 */

// -- readiness (mirrors apps/api/src/data-readiness.ts) ------------------------

export type GateStatus = "pass" | "fail" | "warn";

export type GateKey =
  | "reconciliation_green"
  | "payment_verified"
  | "active_waiver"
  | "resources_configured"
  | "plans_configured"
  | "roles_assigned"
  | "delivery_tested"
  | "native_booking_exercised";

export type StageKey =
  | "studio_team"
  | "rooms_services"
  | "plans_prices_tax"
  | "import_reconciliation"
  | "payments_waivers_launch";

export interface GateEvidence {
  counts: Record<string, number>;
  /** ISO of the newest input that produced the gate result, or null. */
  as_of: string | null;
  detail: string | null;
}

/** The latest acknowledgment attached to a gate (an audit_events note). */
export interface GateAck {
  at: string;
  note: string;
}

export interface ReadinessGate {
  key: GateKey;
  /** A HARD gate blocks launch on 'fail'. Only SOFT (non-hard) warn gates are
   *  acknowledgeable — the ack endpoint 422s hard gates. */
  hard: boolean;
  status: GateStatus;
  evidence: GateEvidence;
  acknowledged: GateAck | null;
}

export interface ReadinessStage {
  key: StageKey;
  label: string;
  gate_keys: GateKey[];
  /** Server-derived (never recompute client-side): true when no gate in the
   *  stage is blocking. */
  complete: boolean;
}

/** GET /readiness payload. */
export interface ReadinessReport {
  gates: ReadinessGate[];
  stages: ReadinessStage[];
}

/** Display labels for the gate keys (presentation only — no policy here). */
export const GATE_LABELS: Record<GateKey, string> = {
  roles_assigned: "Roles assigned",
  resources_configured: "Resources configured",
  native_booking_exercised: "Native booking exercised",
  plans_configured: "Plans configured",
  reconciliation_green: "Reconciliation green",
  payment_verified: "Payment verified",
  active_waiver: "Active waiver",
  delivery_tested: "Delivery tested",
};

// -- authority matrix (mirrors apps/api/src/data-authority.ts) -----------------

export const AUTHORITY_DOMAINS = [
  "people",
  "bookings",
  "schedule",
  "memberships",
  "payments",
  "comms",
  "waivers",
  "retail",
] as const;
export type AuthorityDomain = (typeof AUTHORITY_DOMAINS)[number];

export type Authority = "glofox" | "kelo";

export interface AuthorityMatrixRow {
  domain: AuthorityDomain;
  authority: Authority;
  flipped_at: string | null;
  reason: string | null;
}

/** GET /authority payload. */
export interface AuthorityMatrix {
  matrix: AuthorityMatrixRow[];
}

export interface FlipInput {
  domain: AuthorityDomain;
  authority: Authority;
  reason: string;
  evidenceUrl?: string;
}

/** The 201 body the flip POST returns — the server-CONFIRMED ledger entry. */
export interface FlipAccepted {
  id: string;
  domain: AuthorityDomain;
  authority: Authority;
}

/** The step-up context the flip route's grant must carry (matches the server's
 *  AUTHORITY_FLIP_STEP_UP_CONTEXT). A refund grant cannot flip. */
export const AUTHORITY_FLIP_STEP_UP_CONTEXT = "authority_flip";

const STEP_UP_GRANT_HEADER = "X-Step-Up-Grant";

// -- reads (envelope returned raw; DataBoundary owns provenance-or-nothing) ----

/** GET /readiness (owner/manager). Gates + stages in the freshness envelope. */
export async function fetchReadiness(accessToken: string): Promise<unknown> {
  return fetchEnvelope("/readiness", accessToken);
}

/** GET /authority (owner/manager). The full 8-domain matrix in the envelope. */
export async function fetchAuthority(accessToken: string): Promise<unknown> {
  return fetchEnvelope("/authority", accessToken);
}

// -- mutations ----------------------------------------------------------------

/**
 * POST /readiness/ack (owner only). Writes an append-only audit note for a
 * SOFT gate currently in 'warn' — the server 422s hard gates
 * (gate_not_acknowledgeable) and non-warn gates (gate_not_in_warn_state).
 * Acknowledge ≠ resolve: the response confirms the note; the gate's computed
 * status is unchanged. `idempotencyKey` is ONE key per ack intent.
 */
export async function acknowledgeGate(
  accessToken: string,
  gateKey: GateKey,
  note: string,
  idempotencyKey: string,
): Promise<GateAck> {
  const response = await postEnvelope(
    "/readiness/ack",
    accessToken,
    { gate_key: gateKey, note },
    undefined,
    idempotencyKey,
  );
  const inspection = inspectEnvelope<{ gate_key: GateKey; acknowledged: GateAck }>(response);
  if (!inspection.ok) {
    throw new Error("The acknowledgement response was missing its provenance record; nothing is shown.");
  }
  return inspection.data.acknowledged;
}

/**
 * POST /authority/flip (owner ONLY + step-up). The grantToken rides the
 * X-Step-Up-Grant header exactly like the refund ceremony; the server
 * RE-VERIFIES it (scoped to the 'authority_flip' context). `idempotencyKey`
 * is ONE key per flip intent, reused across retries so a timeout-after-commit
 * + retry appends exactly one ledger row. Returns the server-confirmed flip —
 * the caller re-reads the matrix rather than flipping anything optimistically.
 */
export async function flipAuthority(
  accessToken: string,
  input: FlipInput,
  stepUpGrant: string,
  idempotencyKey: string,
): Promise<FlipAccepted> {
  const response = await postEnvelope(
    "/authority/flip",
    accessToken,
    {
      domain: input.domain,
      authority: input.authority,
      reason: input.reason,
      evidence_url: input.evidenceUrl ?? null,
    },
    { [STEP_UP_GRANT_HEADER]: stepUpGrant },
    idempotencyKey,
  );
  const inspection = inspectEnvelope<{
    flip: { id: string; domain: AuthorityDomain; authority: Authority };
  }>(response);
  if (!inspection.ok) {
    throw new Error("The flip response was missing its provenance record; nothing is shown.");
  }
  return inspection.data.flip;
}

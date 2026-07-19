export type Channel = "email" | "sms";
export type MessageKind = "transactional" | "transactional_quiet" | "marketing";
export type ConsentStatus = "granted" | "revoked" | "imported_granted" | "imported_unknown";
export type SuppressionReason =
  "stop_reply" | "unsub_link" | "hard_bounce" | "complaint" | "manual";

export interface PolicyPerson {
  /** Latest evidence per channel, normally loaded through current_consent(). */
  consents: Partial<Record<Channel, ConsentStatus | null>>;
  /** True for a Glofox-imported person. Imported evidence is not native opt-in. */
  imported: boolean;
}

export interface CanSendInput {
  channel: Channel;
  person: PolicyPerson;
  suppressed: boolean;
  /** Needed because hard bounces block transactional email; other email opt-outs block marketing. */
  suppressionReason?: SuppressionReason;
  kind: MessageKind;
  now: Date;
  timezone: string;
  quietStart?: string;
  quietEnd?: string;
  /** tenants.settings.imported_consent_optin; conservative owner-D2 default is false. */
  importedConsentOptIn?: boolean;
}

export type SendPolicyResult =
  { allowed: true } | { allowed: false; reason: "suppressed" | "no_consent" | "quiet_hours" };

function parseClock(value: string, label: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) throw new Error(`${label} must be HH:mm`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`${label} must be a valid 24-hour time`);
  return hour * 60 + minute;
}

function studioMinute(now: Date, timezone: string): number {
  if (Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`could not resolve local time for timezone ${timezone}`);
  }
  return hour * 60 + minute;
}

export function isQuietHours(
  now: Date,
  timezone: string,
  quietStart = "21:00",
  quietEnd = "09:00",
): boolean {
  const start = parseClock(quietStart, "quietStart");
  const end = parseClock(quietEnd, "quietEnd");
  const local = studioMinute(now, timezone);
  if (start === end) return false;
  return start < end ? local >= start && local < end : local >= start || local < end;
}

/**
 * The next instant a quiet-hours-blocked message becomes sendable, in the
 * STUDIO timezone. Returns `now` unchanged when now is already outside quiet
 * hours; otherwise the first minute at/after quietEnd (the window's close),
 * handling a window that wraps midnight (the default 21:00→09:00).
 *
 * Used to DEFER a dunning comms job's run_at instead of enqueuing it at now()
 * only to have the send processor terminally skip it as quiet_hours (F5 — the
 * reminder would otherwise be lost). The send-time policy re-check stays
 * authoritative: a suppression added meanwhile still blocks at send time.
 *
 * Wall-clock minutes are added as real minutes (the offset is treated as
 * constant across the sub-day window); no Math.random, `now` is injected.
 */
export function nextAllowedSendAt(
  now: Date,
  timezone: string,
  quietStart = "21:00",
  quietEnd = "09:00",
): Date {
  if (!isQuietHours(now, timezone, quietStart, quietEnd)) return now;
  const end = parseClock(quietEnd, "quietEnd");
  const local = studioMinute(now, timezone);
  const minutesUntilEnd = local < end ? end - local : 1440 - local + end;
  return new Date(now.getTime() + minutesUntilEnd * 60_000);
}

/**
 * Final send-time policy.
 *
 * Suppression:
 * - SMS STOP/manual suppressions block every SMS, including transactional.
 * - Email suppressions block marketing. Transactional email remains available
 *   for operational receipts/booking notices except after a hard bounce.
 *
 * Consent:
 * - marketing requires native `granted`; imported_granted is accepted only
 *   when tenants.settings.imported_consent_optin is explicitly true.
 * - transactional and transactional_quiet are consent-exempt.
 *
 * Quiet hours:
 * - marketing and transactional_quiet (dunning-class) are blocked in the
 *   studio timezone; transactional operational messages are exempt.
 */
export function canSend(input: CanSendInput): SendPolicyResult {
  if (
    input.suppressed &&
    (input.channel === "sms" ||
      input.kind === "marketing" ||
      input.suppressionReason === "hard_bounce")
  ) {
    return { allowed: false, reason: "suppressed" };
  }

  if (input.kind === "marketing") {
    const consent = input.person.consents[input.channel];
    const hasConsent =
      consent === "granted" ||
      (input.person.imported &&
        consent === "imported_granted" &&
        input.importedConsentOptIn === true);
    if (!hasConsent) return { allowed: false, reason: "no_consent" };
  }

  if (
    input.kind !== "transactional" &&
    isQuietHours(input.now, input.timezone, input.quietStart ?? "21:00", input.quietEnd ?? "09:00")
  ) {
    return { allowed: false, reason: "quiet_hours" };
  }

  return { allowed: true };
}

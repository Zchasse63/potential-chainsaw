import { describe, expect, it } from "vitest";
import {
  canSend,
  type CanSendInput,
  type ConsentStatus,
  type MessageKind,
  type SuppressionReason,
} from "../src/index.js";

const DAY = new Date("2026-07-18T14:00:00.000Z"); // 10:00 America/New_York
const NIGHT = new Date("2026-07-19T02:00:00.000Z"); // 22:00 America/New_York

function decision(
  options: Partial<CanSendInput> & {
    kind: MessageKind;
    consent?: ConsentStatus | null;
    suppressionReason?: SuppressionReason;
  },
): string {
  const channel = options.channel ?? "email";
  const consent = options.consent === undefined ? "granted" : options.consent;
  const input: CanSendInput = {
    channel,
    person: options.person ?? {
      consents: { [channel]: consent },
      imported: false,
    },
    suppressed: options.suppressed ?? false,
    suppressionReason: options.suppressionReason,
    kind: options.kind,
    now: options.now ?? DAY,
    timezone: options.timezone ?? "America/New_York",
    quietStart: options.quietStart,
    quietEnd: options.quietEnd,
    importedConsentOptIn: options.importedConsentOptIn,
  };
  const result = canSend(input);
  return result.allowed ? "allowed" : result.reason;
}

describe("canSend policy matrix", () => {
  const cases: Array<{
    name: string;
    kind: MessageKind;
    channel?: "email" | "sms";
    consent?: ConsentStatus | null;
    imported?: boolean;
    importedOptIn?: boolean;
    suppressed?: boolean;
    suppressionReason?: SuppressionReason;
    now?: Date;
    expected: string;
  }> = [
    // Ordinary transactional: consent + quiet-hours exempt.
    {
      name: "transactional revoked at night",
      kind: "transactional",
      consent: "revoked",
      now: NIGHT,
      expected: "allowed",
    },
    {
      name: "transactional SMS STOP",
      kind: "transactional",
      channel: "sms",
      suppressed: true,
      suppressionReason: "stop_reply",
      expected: "suppressed",
    },
    {
      name: "transactional email unsubscribe",
      kind: "transactional",
      suppressed: true,
      suppressionReason: "unsub_link",
      expected: "allowed",
    },
    {
      name: "transactional email hard bounce",
      kind: "transactional",
      suppressed: true,
      suppressionReason: "hard_bounce",
      expected: "suppressed",
    },

    // Dunning-class transactional_quiet: consent exempt, quiet-hours enforced.
    {
      name: "dunning revoked in daytime",
      kind: "transactional_quiet",
      consent: "revoked",
      expected: "allowed",
    },
    {
      name: "dunning revoked at night",
      kind: "transactional_quiet",
      consent: "revoked",
      now: NIGHT,
      expected: "quiet_hours",
    },
    {
      name: "dunning SMS STOP",
      kind: "transactional_quiet",
      channel: "sms",
      suppressed: true,
      suppressionReason: "stop_reply",
      expected: "suppressed",
    },
    {
      name: "dunning email unsubscribe",
      kind: "transactional_quiet",
      suppressed: true,
      suppressionReason: "unsub_link",
      expected: "allowed",
    },
    {
      name: "dunning email hard bounce",
      kind: "transactional_quiet",
      suppressed: true,
      suppressionReason: "hard_bounce",
      expected: "suppressed",
    },

    // Marketing: consent + all address suppressions + quiet-hours enforced.
    {
      name: "marketing granted daytime",
      kind: "marketing",
      consent: "granted",
      expected: "allowed",
    },
    {
      name: "marketing granted at night",
      kind: "marketing",
      consent: "granted",
      now: NIGHT,
      expected: "quiet_hours",
    },
    { name: "marketing revoked", kind: "marketing", consent: "revoked", expected: "no_consent" },
    {
      name: "marketing unknown",
      kind: "marketing",
      consent: "imported_unknown",
      expected: "no_consent",
    },
    {
      name: "imported granted defaults false",
      kind: "marketing",
      consent: "imported_granted",
      imported: true,
      expected: "no_consent",
    },
    {
      name: "imported granted explicit tenant opt-in",
      kind: "marketing",
      consent: "imported_granted",
      imported: true,
      importedOptIn: true,
      expected: "allowed",
    },
    {
      name: "marketing email unsubscribe",
      kind: "marketing",
      suppressed: true,
      suppressionReason: "unsub_link",
      expected: "suppressed",
    },
    {
      name: "marketing SMS manual suppression",
      kind: "marketing",
      channel: "sms",
      suppressed: true,
      suppressionReason: "manual",
      expected: "suppressed",
    },
  ];

  it.each(cases)("$name", (entry) => {
    expect(
      decision({
        kind: entry.kind,
        channel: entry.channel,
        consent: entry.consent,
        person: {
          consents: { [entry.channel ?? "email"]: entry.consent ?? "granted" },
          imported: entry.imported ?? false,
        },
        importedConsentOptIn: entry.importedOptIn,
        suppressed: entry.suppressed,
        suppressionReason: entry.suppressionReason,
        now: entry.now,
      }),
    ).toBe(entry.expected);
  });

  it("uses inclusive 21:00 and exclusive 09:00 boundaries in studio-local time", () => {
    expect(decision({ kind: "marketing", now: new Date("2026-07-19T01:00:00Z") })).toBe(
      "quiet_hours",
    );
    expect(decision({ kind: "marketing", now: new Date("2026-07-19T12:59:00Z") })).toBe(
      "quiet_hours",
    );
    expect(decision({ kind: "marketing", now: new Date("2026-07-19T13:00:00Z") })).toBe("allowed");
  });
});

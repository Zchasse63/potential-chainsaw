import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  classifyGlofoxEvent,
  envelope,
  errorResponseSchema,
  glofoxUnixTimestamp,
  operationAcceptedSchema,
} from "../src/index.js";

describe("glofoxUnixTimestamp (mixed int/string by endpoint generation — README §8)", () => {
  it("accepts an integer (unix seconds) and transforms to Date", () => {
    const parsed = glofoxUnixTimestamp.parse(1699999999);
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.getTime()).toBe(1699999999 * 1000);
  });

  it('accepts a numeric string ("1699999999") and transforms to the same Date', () => {
    const parsed = glofoxUnixTimestamp.parse("1699999999");
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.getTime()).toBe(1699999999 * 1000);
  });

  it("rejects non-numeric strings and non-integer numbers", () => {
    expect(glofoxUnixTimestamp.safeParse("not-a-date").success).toBe(false);
    expect(glofoxUnixTimestamp.safeParse("2026-07-17").success).toBe(false);
    expect(glofoxUnixTimestamp.safeParse(1699999999.5).success).toBe(false);
  });
});

describe("classifyGlofoxEvent (unknown values quarantine — invariant #8)", () => {
  it("classifies every value observed live in the 30-day window", () => {
    expect(classifyGlofoxEvent("subscription_payment")).toBe("subscription_payment");
    expect(classifyGlofoxEvent("invoice_payment")).toBe("invoice_payment");
    expect(classifyGlofoxEvent("book_class")).toBe("book_class");
  });

  it("returns 'unknown' for anything else — never guesses", () => {
    expect(classifyGlofoxEvent("weird")).toBe("unknown");
    expect(classifyGlofoxEvent("")).toBe("unknown");
    expect(classifyGlofoxEvent(undefined)).toBe("unknown");
    expect(classifyGlofoxEvent(null)).toBe("unknown");
    expect(classifyGlofoxEvent(42)).toBe("unknown");
  });
});

describe("envelope() (invariant #3: every response carries provenance)", () => {
  const personSchema = envelope(z.object({ id: z.string() }));
  const validMeta = {
    as_of: "2026-07-17T19:00:00Z",
    source: "glofox",
    stale: false,
    definition_version: null,
    correlation_id: "corr-123",
  } as const;

  it("validates a well-formed { data, meta } response", () => {
    const parsed = personSchema.parse({ data: { id: "abc" }, meta: validMeta });
    expect(parsed.data.id).toBe("abc");
    expect(parsed.meta.source).toBe("glofox");
    expect(parsed.meta.definition_version).toBeNull();
  });

  it("rejects a response missing meta", () => {
    expect(personSchema.safeParse({ data: { id: "abc" } }).success).toBe(false);
  });

  it("rejects meta missing correlation_id or with a bad as_of", () => {
    const noCorrelation = {
      as_of: validMeta.as_of,
      source: validMeta.source,
      stale: validMeta.stale,
      definition_version: validMeta.definition_version,
    };
    expect(personSchema.safeParse({ data: { id: "abc" }, meta: noCorrelation }).success).toBe(
      false,
    );
    expect(
      personSchema.safeParse({
        data: { id: "abc" },
        meta: { ...validMeta, as_of: "yesterday" },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown source", () => {
    expect(
      personSchema.safeParse({
        data: { id: "abc" },
        meta: { ...validMeta, source: "somewhere" },
      }).success,
    ).toBe(false);
  });
});

describe("errorResponseSchema (errors are NEVER a 200 success — plan-final §3)", () => {
  it("parses a structured error body", () => {
    const parsed = errorResponseSchema.parse({
      error: { code: "VALIDATION", message: "bad input", correlation_id: "corr-123" },
    });
    expect(parsed.error.code).toBe("VALIDATION");
    expect(parsed.error.details).toBeUndefined();
  });

  it("keeps optional details when present", () => {
    const parsed = errorResponseSchema.parse({
      error: {
        code: "CONFLICT",
        message: "version mismatch",
        correlation_id: "corr-123",
        details: { expected: 3, got: 2 },
      },
    });
    expect(parsed.error.details).toEqual({ expected: 3, got: 2 });
  });
});

describe("operationAcceptedSchema (202 scaffold — plan-final §3)", () => {
  it("parses { operation_id }", () => {
    expect(operationAcceptedSchema.parse({ operation_id: "op_1" }).operation_id).toBe("op_1");
  });
});

import { describe, expect, it } from "vitest";
import { assertWorkerSecret } from "../src/worker-auth.js";

describe("assertWorkerSecret (threat model §6)", () => {
  it("throws when the provided secret is missing", () => {
    expect(() => assertWorkerSecret(undefined, "s3cret")).toThrow();
    expect(() => assertWorkerSecret("", "s3cret")).toThrow();
  });

  it("throws when the expected secret is not configured", () => {
    expect(() => assertWorkerSecret("s3cret", undefined)).toThrow();
    expect(() => assertWorkerSecret("s3cret", "")).toThrow();
  });

  it("throws on a mismatched secret", () => {
    expect(() => assertWorkerSecret("wrong", "s3cret")).toThrow(/invalid worker secret/);
  });

  it("throws on a length-mismatched secret", () => {
    expect(() => assertWorkerSecret("s3cret-but-longer", "s3cret")).toThrow();
  });

  it("passes when both secrets match", () => {
    expect(() => assertWorkerSecret("s3cret", "s3cret")).not.toThrow();
  });
});

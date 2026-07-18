import { describe, expect, it, vi } from "vitest";
import { createCommsSendProcessor } from "../../src/comms/send.js";
import type { JobRow, Queryable } from "../../src/processors.js";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function job(): JobRow {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    tenant_id: TENANT,
    kind: "comms.send",
    payload: { comms_log_id: LOG },
    priority: 100,
    run_after: "2026-07-18T10:00:00Z",
    status: "running",
    attempts: 1,
    max_attempts: 5,
    lease_until: "2026-07-18T10:05:00Z",
    locked_by: "worker-1",
    last_error: null,
    idempotency_key: null,
    created_at: "2026-07-18T10:00:00Z",
    updated_at: "2026-07-18T10:00:00Z",
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LOG,
    tenant_id: TENANT,
    person_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    channel: "email",
    status: "queued",
    template_key: "retention",
    subject: "Come back",
    body_preview: "We miss you",
    to_address: "person@example.com",
    campaign_key: "winback-1",
    person_source: "native",
    consent_status: "granted",
    suppression_reason: null,
    tenant_settings: {},
    timezone: "America/New_York",
    ...overrides,
  };
}

function poolWith(sendRow: Record<string, unknown>) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const pool: Queryable = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.trimStart().startsWith("select")) return { rows: [sendRow] };
      return { rows: [] };
    },
  };
  return { pool, calls };
}

describe("comms.send", () => {
  it("re-checks fresh consent and skips when it was revoked after enqueue", async () => {
    const emailAdapter = { send: vi.fn(async () => ({ providerMessageId: "email_never" })) };
    const fake = poolWith(row({ consent_status: "revoked" }));
    const processor = createCommsSendProcessor({
      emailAdapter,
      now: () => new Date("2026-07-18T14:00:00Z"),
    });

    await processor(job(), { pool: fake.pool, workerId: "worker-1" });

    expect(emailAdapter.send).not.toHaveBeenCalled();
    const update = fake.calls.find((call) => call.text.trimStart().startsWith("update"));
    expect(update?.values?.slice(0, 2)).toEqual(["skipped_no_consent", "no_consent"]);
  });

  it("is an idempotent no-op when a reclaimed row is no longer queued", async () => {
    const emailAdapter = { send: vi.fn(async () => ({ providerMessageId: "email_never" })) };
    const fake = poolWith(row({ status: "sent" }));
    const processor = createCommsSendProcessor({ emailAdapter });

    await processor(job(), { pool: fake.pool, workerId: "worker-1" });

    expect(emailAdapter.send).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps the pipeline exercisable in provider dry-run mode", async () => {
    const fake = poolWith(row({ campaign_key: null }));
    const processor = createCommsSendProcessor({ env: {} });

    await processor(job(), { pool: fake.pool, workerId: "worker-1" });

    const update = fake.calls.find((call) => call.text.trimStart().startsWith("update"));
    expect(update?.values?.[0]).toBe("dry_run");
    expect(update?.values?.[2]).toBe("dry_run");
    expect(String(update?.values?.[3])).toMatch(/^dry-run-/);
  });
});

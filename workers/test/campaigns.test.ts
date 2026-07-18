import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CanSendInput } from "@kelo/comms";
import {
  plannedStatus,
  resolveMergeFields,
} from "../src/campaigns/enqueuer.js";
import { draftCampaignCopy } from "../src/campaigns/draft.js";
import {
  CAMPAIGNS_LIFECYCLE_KIND,
  evaluateLifecycle,
} from "../src/campaigns/lifecycle.js";
import {
  CAMPAIGNS_ATTRIBUTE_KIND,
  attributeCampaigns,
} from "../src/campaigns/attribution.js";
import type { Queryable } from "../src/processors.js";
import { processors } from "../src/processors.js";

const MIGRATION = readFileSync(
  new URL("../../supabase/migrations/20260718200100_0024_campaigns.sql", import.meta.url),
  "utf8",
);

const basePolicy: CanSendInput = {
  channel: "email",
  person: { consents: { email: "granted" }, imported: false },
  suppressed: false,
  kind: "marketing",
  now: new Date("2026-07-18T16:00:00.000Z"),
  timezone: "America/New_York",
};

describe("campaign plan policy parity", () => {
  it("classifies address, consent, suppression, quiet hours, and eligibility", () => {
    expect(plannedStatus(null, basePolicy)).toBe("skip_no_address");
    expect(
      plannedStatus("person@example.com", {
        ...basePolicy,
        person: { consents: { email: "revoked" }, imported: false },
      }),
    ).toBe("skip_no_consent");
    expect(
      plannedStatus("person@example.com", {
        ...basePolicy,
        suppressed: true,
        suppressionReason: "unsub_link",
      }),
    ).toBe("skip_suppressed");
    expect(
      plannedStatus("person@example.com", {
        ...basePolicy,
        now: new Date("2026-07-19T02:00:00.000Z"),
      }),
    ).toBe("skip_quiet_hours");
    expect(plannedStatus("person@example.com", basePolicy)).toBe("eligible");
  });

  it("keeps the SQL preview non-enqueuing and the approval RPC role-gated/idempotent", () => {
    const planBody = MIGRATION.slice(
      MIGRATION.indexOf("create or replace function app.build_campaign_plan"),
      MIGRATION.indexOf("create or replace function app.approve_campaign"),
    );
    expect(planBody).not.toContain("insert into public.comms_log");
    expect(planBody).not.toContain("app.enqueue_job");
    expect(MIGRATION).toContain("array['owner', 'manager']");
    expect(MIGRATION).toContain("and cs.comms_log_id is null");
    expect(MIGRATION).toContain("'comms.send:' || v_log_id::text");
    expect(MIGRATION).toContain("approved_by = p_actor, approved_at = now()");
    expect(MIGRATION).toContain("campaign approval and send transitions require app.approve_campaign()");
  });

  it("resolves only the documented server-side merge fields", () => {
    expect(
      resolveMergeFields("Hi {{first_name}} from {{studio_name}}", {
        firstName: "Maria",
        studioName: "Kelo",
      }),
    ).toBe("Hi Maria from Kelo");
    expect(() =>
      resolveMergeFields("{{email}}", { firstName: "Maria", studioName: "Kelo" }),
    ).toThrow(/allowlist/);
  });
});

describe("de-identified AI draft helper", () => {
  it("sends only segment/count/intent/brand facts and falls back without network", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const serialized = String(init?.body);
      expect(serialized).not.toContain("Maria");
      expect(serialized).not.toContain("maria@example.com");
      expect(serialized).not.toContain("+1555");
      expect(serialized).toContain("recipient_count");
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                subject: "A note from {{studio_name}}",
                body: "Hi {{first_name}}, we would be glad to see you at {{studio_name}}.",
              }),
            },
          ],
        }),
        { status: 200 },
      );
    });
    const generated = await draftCampaignCopy(
      {
        segmentKey: "at_risk",
        recipientCount: 3,
        templateIntent: "Welcome a return without urgency.",
        brandFacts: { studioName: "Kelo", toneAdjectives: ["plain", "warm"] },
        channel: "email",
        kind: "marketing",
      },
      { subject: "Fallback", body: "Fallback body" },
      { fetchImpl: fetchImpl as typeof fetch, env: { ANTHROPIC_API_KEY: "test-key" } },
    );
    expect(generated.source).toBe("ai");
    expect(fetchImpl).toHaveBeenCalledOnce();

    const noNetwork = vi.fn();
    await expect(
      draftCampaignCopy(
        {
          segmentKey: "new",
          recipientCount: 2,
          templateIntent: "Welcome",
          brandFacts: { studioName: "Kelo" },
          channel: "email",
          kind: "marketing",
        },
        { subject: "Welcome", body: "Hello" },
        { fetchImpl: noNetwork as typeof fetch, env: {} },
      ),
    ).resolves.toEqual({ subject: "Welcome", body: "Hello", source: "template_fallback" });
    expect(noNetwork).not.toHaveBeenCalled();
  });
});

describe("lifecycle proposals and attribution", () => {
  it("registers both campaign processors", () => {
    expect(processors[CAMPAIGNS_LIFECYCLE_KIND]).toBeTypeOf("function");
    expect(processors[CAMPAIGNS_ATTRIBUTE_KIND]).toBeTypeOf("function");
  });

  it("day-dedupes, applies the 7-day cooldown, and never approves or enqueues", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: Queryable = {
      query: async (text, values) => {
        calls.push({ text, values });
        if (text.includes("from public.message_templates")) {
          return {
            rows: [
              {
                template_key: "at_risk_winback_email",
                segment_key: "at_risk",
                channel: "email",
                kind: "marketing",
                subject: "Hello {{first_name}}",
                body: "A note from {{studio_name}}",
              },
            ],
          };
        }
        if (text.includes("select t.name, t.settings")) {
          return { rows: [{ name: "Kelo", settings: {} }] };
        }
        if (text.includes("recipient_count")) return { rows: [{ recipient_count: 4 }] };
        if (text.includes("insert into public.campaigns")) return { rows: [{ id: "campaign-1" }] };
        if (text.includes("app.build_campaign_plan")) return { rows: [{ planned: 4 }] };
        return { rows: [] };
      },
    };
    await expect(
      evaluateLifecycle(pool, "00000000-0000-4000-8000-0000000000aa", {
        now: new Date("2026-07-18T12:00:00.000Z"),
        draft: { env: {} },
      }),
    ).resolves.toEqual(["campaign-1"]);
    const sql = calls.map((call) => call.text).join("\n");
    expect(sql).toContain("(c.created_at at time zone $12)::date = $11::date");
    expect(sql).toContain("delete from public.campaign_sends");
    expect(sql).toContain("cl.created_at >= $2::timestamptz - ($3::text || ' days')::interval");
    expect(calls.find((call) => call.text.includes("delete from public.campaign_sends"))?.values?.[2]).toBe(7);
    expect(sql).not.toContain("app.approve_campaign");
    expect(sql).not.toContain("insert into public.comms_log");
  });

  it("matches events after sent messages inside the window and upserts idempotently", async () => {
    let attributionRun = 0;
    const calls: string[] = [];
    const pool: Queryable = {
      query: async (text) => {
        calls.push(text);
        if (text.includes("with person_refs")) {
          attributionRun += 1;
          return { rows: [{ attributed: attributionRun === 1 ? 1 : 0 }] };
        }
        return { rows: [] };
      },
    };
    await expect(attributeCampaigns(pool, "00000000-0000-4000-8000-0000000000aa", 7)).resolves.toBe(1);
    await expect(attributeCampaigns(pool, "00000000-0000-4000-8000-0000000000aa", 7)).resolves.toBe(0);
    expect(calls[0]).toContain("coalesce(gb.created_at, gb.time_start) >= cl.updated_at");
    expect(calls[0]).toContain("on conflict (campaign_send_id, event_type, event_ref) do nothing");
  });
});

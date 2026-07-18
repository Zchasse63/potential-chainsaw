import { describe, expect, it } from "vitest";
import {
  glofoxMemberSchema,
  glofoxMembersResponseSchema,
  type GlofoxMember,
} from "@kelo/contracts";
import { MAPPER_VERSION, mapMember, partitionPersonRows } from "../../src/mappers/person.js";
import { PERSON_MAPPER_VERSION } from "../../src/index.js";
import { loadSample } from "../helpers.js";

/**
 * mapMember against the PINNED SAMPLE (docs/glofox/samples/members.get.limit2.json)
 * — parsed through the contracts schema, then mapped. NO network, ever.
 */

const TENANT = "00000000-0000-0000-0000-0000000000aa";

function sampleMembers(): GlofoxMember[] {
  return glofoxMembersResponseSchema.parse(loadSample("members.get.limit2.json")).data;
}

/** Minimal schema-valid member for synthetic cases (overridable). */
function minimalMemberRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "synthetic-member-1",
    branch_id: "branch-1",
    namespace: "ns",
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@example.test",
    active: true,
    type: "member",
    membership: {
      type: "payg",
      start_date: 1784174400,
      user_membership_id: "um-1",
      status: "ACTIVE",
    },
    created: 1784236566,
    modified: 1784236568,
    ...overrides,
  };
}

describe("mapMember — pinned members sample", () => {
  it("member 1 → one person row + one glofox external-ref row, nothing quarantined", () => {
    const result = mapMember(sampleMembers()[0]!, { tenantId: TENANT });
    expect(result.quarantine).toHaveLength(0);

    const { person, externalRefs } = partitionPersonRows(result);
    expect(person).toHaveLength(1);
    expect(externalRefs).toHaveLength(1);

    const row = person[0]!;
    expect(row.tenant_id).toBe(TENANT);
    expect(row.external_ref).toBe("6a594a166bd76c06090d89e9");
    expect(row.first_name).toBe("<REDACTED:2fdba0d2>");
    expect(row.last_name).toBe("<REDACTED:f7f3a0a7>");
    expect(row.email).toBe("<REDACTED:700ed2fe>");
    expect(row.phone).toBe("<REDACTED:1ab2cdd6>");
    expect(row.source).toBe("glofox");
    expect(row.active).toBe(true);

    // Consent is TRI-STATE evidence: false is a real value, not null.
    expect(row.consent_email).toBe(false);
    expect(row.consent_sms).toBe(false);
    expect(row.consent_push).toBe(true);

    // Glofox `created` → source_created_at ("first seen"); date_quality is
    // 'unverified' ALWAYS at import — created may be a migration date (§5).
    expect(row.source_created_at).toEqual(new Date(1784236566 * 1000));
    expect(row.date_quality).toBe("unverified");

    // Nothing derived at import: cohort anchor + native pipeline stay NULL,
    // and the Glofox lead flag ("everyone is a lead") is never imported.
    expect(row.first_activity_at).toBeNull();
    expect(row.cohort_anchor_basis).toBeNull();
    expect(row.lead_status).toBeNull();
    expect(row.next_action).toBeNull();
    expect(row.pipeline_owner).toBeNull();

    expect(externalRefs[0]).toEqual({
      tenant_id: TENANT,
      system: "glofox",
      external_ref: "6a594a166bd76c06090d89e9",
    });
  });

  it("member 2 → same shape (consent tri-state, unverified date quality)", () => {
    const result = mapMember(sampleMembers()[1]!, { tenantId: TENANT });
    expect(result.quarantine).toHaveLength(0);
    const { person, externalRefs } = partitionPersonRows(result);
    expect(person).toHaveLength(1);
    expect(externalRefs).toHaveLength(1);

    const row = person[0]!;
    expect(row.external_ref).toBe("6a58e82e2ea59d87f000e45f");
    expect(row.consent_email).toBe(false);
    expect(row.consent_sms).toBe(false);
    expect(row.consent_push).toBe(true);
    expect(row.source_created_at).toEqual(new Date(1784211502 * 1000));
    expect(row.date_quality).toBe("unverified");
    expect(externalRefs[0]!.external_ref).toBe("6a58e82e2ea59d87f000e45f");
  });
});

describe("mapMember — synthetic edge cases", () => {
  it("absent consent object → consent_* all NULL (tri-state: unknown)", () => {
    const member = glofoxMemberSchema.parse(minimalMemberRaw());
    const { person } = partitionPersonRows(mapMember(member, { tenantId: TENANT }));
    expect(person[0]!.consent_email).toBeNull();
    expect(person[0]!.consent_sms).toBeNull();
    expect(person[0]!.consent_push).toBeNull();
  });

  it("empty-string email → NULL — never imports ''", () => {
    const member = glofoxMemberSchema.parse(minimalMemberRaw({ email: "" }));
    const { person } = partitionPersonRows(mapMember(member, { tenantId: TENANT }));
    expect(person[0]!.email).toBeNull();
  });

  it("absent phone → NULL", () => {
    const member = glofoxMemberSchema.parse(minimalMemberRaw());
    const { person } = partitionPersonRows(mapMember(member, { tenantId: TENANT }));
    expect(person[0]!.phone).toBeNull();
  });

  it("preserves a raw phone for the generated phone_e164 column", () => {
    const member = glofoxMemberSchema.parse(minimalMemberRaw({ phone: "813-555-1234" }));
    const { person } = partitionPersonRows(mapMember(member, { tenantId: TENANT }));

    expect(person[0]!.phone).toBe("813-555-1234");
    expect(person[0]).not.toHaveProperty("phone_e164");
  });

  it("active:false mirrors the soft-delete (never purges)", () => {
    const member = glofoxMemberSchema.parse(minimalMemberRaw({ active: false }));
    const { person } = partitionPersonRows(mapMember(member, { tenantId: TENANT }));
    expect(person[0]!.active).toBe(false);
  });

  it("carries membership-record fields without classifying them", () => {
    const member = glofoxMemberSchema.parse(
      minimalMemberRaw({
        membership: {
          type: "time_classes",
          status: "ACTIVE",
          user_membership_id: "um-1",
          start_date: 1784174400,
        },
      }),
    );
    const { person } = partitionPersonRows(mapMember(member, { tenantId: TENANT }));

    expect(person[0]).toMatchObject({
      membership_type: "time_classes",
      membership_status: "ACTIVE",
      user_membership_id: "um-1",
      membership_started_at: new Date(1784174400 * 1000),
    });
  });

  it("absent membership object → all membership evidence NULL", () => {
    const parsed = glofoxMemberSchema.parse(minimalMemberRaw());
    const member = { ...parsed, membership: undefined } as unknown as GlofoxMember;
    const { person } = partitionPersonRows(mapMember(member, { tenantId: TENANT }));

    expect(person[0]).toMatchObject({
      membership_type: null,
      membership_status: null,
      user_membership_id: null,
      membership_started_at: null,
    });
  });

  it("blank membership strings → NULL", () => {
    const member = glofoxMemberSchema.parse(
      minimalMemberRaw({
        membership: {
          type: "  ",
          status: "",
          user_membership_id: "\t",
          start_date: 1784174400,
        },
      }),
    );
    const { person } = partitionPersonRows(mapMember(member, { tenantId: TENANT }));

    expect(person[0]!.membership_type).toBeNull();
    expect(person[0]!.membership_status).toBeNull();
    expect(person[0]!.user_membership_id).toBeNull();
    expect(person[0]!.membership_started_at).toEqual(new Date(1784174400 * 1000));
  });

  it("missing/empty _id → quarantine ('missing external id'), no rows", () => {
    // Empty string survives schema parsing (z.string()) and is still junk.
    const emptyId = glofoxMemberSchema.parse(minimalMemberRaw({ _id: "" }));
    const a = mapMember(emptyId, { tenantId: TENANT });
    expect(a.rows).toHaveLength(0);
    expect(a.quarantine).toHaveLength(1);
    expect(a.quarantine[0]).toMatchObject({
      entity: "members",
      external_ref: null,
      reason: "missing external id",
    });

    // Truly absent _id (pre-parse junk that reached the mapper defensively).
    const missing = { ...emptyId, _id: undefined } as unknown as GlofoxMember;
    const b = mapMember(missing, { tenantId: TENANT });
    expect(b.rows).toHaveLength(0);
    expect(b.quarantine).toHaveLength(1);
    expect(b.quarantine[0]!.reason).toBe("missing external id");
  });

  it("MAPPER_VERSION is exported (= 2) via the module and the package barrel", () => {
    expect(MAPPER_VERSION).toBe(2);
    expect(PERSON_MAPPER_VERSION).toBe(MAPPER_VERSION);
  });
});

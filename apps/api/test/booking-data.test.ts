import { describe, expect, it } from "vitest";
import type { KeloSupabaseClient } from "@kelo/db";
import {
  acceptWaitlistOffer,
  checkIn,
  declineWaitlistOffer,
  fetchRoster,
  fetchWaitlistPosition,
  joinWaitlist,
} from "../src/data-booking.js";
import { ApiError } from "../src/errors.js";

/**
 * Phase 6 · unit 6.2 — the booking desk data layer maps the definer RPCs onto
 * typed results and the raised SQLSTATEs onto the ApiError contract. The RPC
 * SEMANTICS (FIFO promotion, offer expiry, the check-in window) are proven
 * against a live DB by rls_attack.sql block 33; here we prove the boundary
 * shaping + error mapping with a fake client (no network).
 */

interface RpcResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/** A client whose rpc() returns a scripted result for the next call. */
function rpcClient(result: RpcResult): KeloSupabaseClient {
  return { rpc: async () => result } as unknown as KeloSupabaseClient;
}

/** A client whose from(table) returns a scripted row list for the roster read. */
function selectClient(byTable: Record<string, unknown[]>): KeloSupabaseClient {
  const builder = (rows: unknown[]) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order"]) b[m] = () => b;
    (b as { then: unknown }).then = (resolve: (r: RpcResult) => unknown) =>
      resolve({ data: rows, error: null });
    return b;
  };
  return { from: (table: string) => builder(byTable[table] ?? []) } as unknown as KeloSupabaseClient;
}

const TENANT = "11111111-1111-1111-1111-111111111111";
const SESSION = "22222222-2222-2222-2222-222222222222";
const PERSON = "33333333-3333-3333-3333-333333333333";
const ACTOR = "44444444-4444-4444-4444-444444444444";
const ENTRY = "55555555-5555-5555-5555-555555555555";
const BOOKING = "66666666-6666-6666-6666-666666666666";

describe("joinWaitlist — FIFO position surfacing", () => {
  it("returns the bare int position the RPC assigns", async () => {
    const result = await joinWaitlist(rpcClient({ data: 4, error: null }), {
      tenantId: TENANT,
      actorId: ACTOR,
      sessionId: SESSION,
      personId: PERSON,
      idempotencyKey: "wl-1",
    });
    expect(result).toEqual({ position: 4 });
  });

  it("maps 22023 (open session / not full) to a 422 booking_invalid", async () => {
    await expect(
      joinWaitlist(rpcClient({ data: null, error: { code: "22023", message: "session is not full" } }), {
        tenantId: TENANT,
        actorId: ACTOR,
        sessionId: SESSION,
        personId: PERSON,
        idempotencyKey: "wl-1",
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("maps 42501 (role/actor refusal) to a 403", async () => {
    await expect(
      joinWaitlist(rpcClient({ data: null, error: { code: "42501", message: "role required" } }), {
        tenantId: TENANT,
        actorId: ACTOR,
        sessionId: SESSION,
        personId: PERSON,
        idempotencyKey: "wl-1",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("acceptWaitlistOffer — books through app.book_session", () => {
  it("returns the booking id the RPC yields", async () => {
    const result = await acceptWaitlistOffer(rpcClient({ data: BOOKING, error: null }), {
      tenantId: TENANT,
      actorId: ACTOR,
      entryId: ENTRY,
      idempotencyKey: "ac-1",
      via: "desk",
    });
    expect(result).toEqual({ booking_id: BOOKING });
  });

  it("surfaces P0002 (entry/session absent) as a 404", async () => {
    await expect(
      acceptWaitlistOffer(rpcClient({ data: null, error: { code: "P0002", message: "not found" } }), {
        tenantId: TENANT,
        actorId: ACTOR,
        entryId: ENTRY,
        idempotencyKey: "ac-1",
        via: "desk",
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("declineWaitlistOffer", () => {
  it("resolves (void) on success", async () => {
    await expect(
      declineWaitlistOffer(rpcClient({ data: null, error: null }), {
        tenantId: TENANT,
        actorId: ACTOR,
        entryId: ENTRY,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("checkIn — the arrival-window RPC", () => {
  it("returns the checked_in status literal", async () => {
    const result = await checkIn(rpcClient({ data: "checked_in", error: null }), {
      tenantId: TENANT,
      actorId: ACTOR,
      bookingId: BOOKING,
      now: "2026-07-19T10:00:00.000Z",
    });
    expect(result).toEqual({ status: "checked_in" });
  });

  it("maps a 22023 window refusal to a 422", async () => {
    await expect(
      checkIn(rpcClient({ data: null, error: { code: "22023", message: "outside the arrival window" } }), {
        tenantId: TENANT,
        actorId: ACTOR,
        bookingId: BOOKING,
        now: "2026-07-19T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("fetchWaitlistPosition", () => {
  it("returns the first row or null", async () => {
    const row = { position: 1, total_waiting: 2, offer_expires_at: null, status: "waiting" };
    const result = await fetchWaitlistPosition(rpcClient({ data: [row], error: null }), TENANT, SESSION, PERSON);
    expect(result).toEqual(row);
    const none = await fetchWaitlistPosition(rpcClient({ data: [], error: null }), TENANT, SESSION, PERSON);
    expect(none).toBeNull();
  });
});

describe("fetchRoster — bookings + waitlist under RLS", () => {
  it("shapes both lists with resolved names", async () => {
    const roster = await fetchRoster(
      selectClient({
        bookings: [
          { id: BOOKING, person_id: PERSON, status: "booked", checked_in_at: null, people: { first_name: "Ada" } },
        ],
        waitlist_entries: [
          { id: ENTRY, person_id: PERSON, position: 1, status: "waiting", offer_expires_at: null, people: null },
        ],
      }),
      TENANT,
      SESSION,
    );
    expect(roster.bookings).toHaveLength(1);
    expect(roster.bookings[0]!.people?.first_name).toBe("Ada");
    expect(roster.waitlist).toHaveLength(1);
    expect(roster.waitlist[0]!.position).toBe(1);
  });
});

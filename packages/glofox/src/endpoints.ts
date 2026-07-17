import {
  glofoxAnalyticsReportRequestSchema,
  glofoxBookingsResponseSchema,
  glofoxBranchSchema,
  glofoxCreditsResponseSchema,
  glofoxEventsResponseSchema,
  glofoxMemberSchema,
  glofoxMembersResponseSchema,
  glofoxMembershipsResponseSchema,
  glofoxTransactionsReportSchema,
  type GlofoxAnalyticsReportRequestBuilder,
  type GlofoxBookingStatus,
  type GlofoxBookingsResponse,
  type GlofoxBranch,
  type GlofoxCreditsResponse,
  type GlofoxEventsResponse,
  type GlofoxMember,
  type GlofoxMembersResponse,
  type GlofoxMembershipsResponse,
  type GlofoxTransactionsReport,
} from "@kelo/contracts";
import type { GlofoxFetchCore } from "./client.js";
import type { GlofoxConfig } from "./config.js";

/**
 * Typed endpoint wrappers (docs/glofox/README.md §2/§4). Each wrapper owns ITS
 * pagination + envelope style and parses with the @kelo/contracts schema at the
 * boundary — wrappers return the Zod-PARSED result (timestamps already Dates);
 * an unknown/malformed payload propagates the ZodError (callers quarantine;
 * the client never silently strips a failed parse).
 */

/** Glofox declares `limit` max 100 where declared (README §2). */
const MAX_LIMIT = 100;

export interface PageParams {
  /** 1-indexed. */
  readonly page?: number;
  /** Max 100 (README §2). */
  readonly limit?: number;
}

function assertPageParams({ page, limit }: PageParams): void {
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
    throw new RangeError(`Glofox page must be a 1-indexed integer, got ${page}`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
    throw new RangeError(`Glofox limit must be an integer in 1..${MAX_LIMIT}, got ${limit}`);
  }
}

/** Watermark params travel as integer unix SECONDS (README §1); callers pass Dates. */
const toUnixSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);
/** The Analytics report wants unix seconds as STRINGS (README §4). */
const toUnixSecondsString = (d: Date): string => String(toUnixSeconds(d));

export interface MembersListParams extends PageParams {
  /** The API's literal `active` vocabulary (README §4). */
  readonly activeFilter?: "true" | "false" | "any";
  /** Incremental-sync watermarks (`utc_modified_start_date`/`_end_date`). */
  readonly utcModifiedStartDate?: Date;
  readonly utcModifiedEndDate?: Date;
}

export interface BookingsListParams extends PageParams {
  /** The incremental-sync watermark (`modified_start_date`). */
  readonly modifiedStartDate?: Date;
  readonly status?: GlofoxBookingStatus;
  readonly eventType?: "events" | "courses" | "facilities" | "users" | "appointments";
}

export interface TransactionsReportWindow {
  readonly start: Date;
  readonly end: Date;
}

export interface GlofoxEndpoints {
  readonly members: {
    /** GET /2.0/members — Style A envelope. */
    readonly list: (params?: MembersListParams) => Promise<GlofoxMembersResponse>;
    /** Follows `has_more` page-by-page from page 1; yields each parsed page. */
    readonly listAllPages: (
      params?: MembersListParams,
    ) => AsyncGenerator<GlofoxMembersResponse, void, undefined>;
    /** GET /2.0/members/{userId} — a bare member object (no envelope). */
    readonly get: (userId: string) => Promise<GlofoxMember>;
  };
  readonly memberships: {
    /** GET /2.0/memberships — Style A envelope (the plan catalog). */
    readonly list: (params?: PageParams) => Promise<GlofoxMembershipsResponse>;
  };
  readonly credits: {
    /**
     * GET /2.0/credits?user_id= — PER-USER ONLY: there is no branch-wide
     * credits list, so the credits import is O(members) requests and must run
     * as its own chunked job inside the 10 req/s budget (README §7.3).
     */
    readonly forUser: (userId: string, params?: PageParams) => Promise<GlofoxCreditsResponse>;
  };
  readonly bookings: {
    /** GET /2.2/branches/{branchId}/bookings — Style B envelope. */
    readonly list: (params?: BookingsListParams) => Promise<GlofoxBookingsResponse>;
    /** Pages via `meta.totalCount` math (Style B has no `has_more`). */
    readonly listAllPages: (
      params?: BookingsListParams,
    ) => AsyncGenerator<GlofoxBookingsResponse, void, undefined>;
  };
  readonly events: {
    /** GET /2.0/branches/{branchId}/events — Style A envelope. */
    readonly list: (params?: PageParams) => Promise<GlofoxEventsResponse>;
  };
  readonly branch: {
    /** GET /2.0/branches/{branchId} — bare branch object (timezone, currency). */
    readonly get: () => Promise<GlofoxBranch>;
  };
  /**
   * POST /Analytics/report — Style C envelope, windowed-only (NO pagination:
   * the full window is returned, so callers keep windows small — README §7.1).
   */
  readonly transactionsReport: (
    window: TransactionsReportWindow,
  ) => Promise<GlofoxTransactionsReport>;
}

/**
 * TRAP 2 guard (README §3): the only way to build an Analytics report request.
 * The contract input type's `namespace` is non-optional, so omitting it fails
 * to compile; the schema parse re-checks at the runtime boundary.
 */
export const buildAnalyticsReportRequest: GlofoxAnalyticsReportRequestBuilder = (input) =>
  glofoxAnalyticsReportRequestSchema.parse(input);

export function createEndpoints(
  glofoxFetch: GlofoxFetchCore,
  config: GlofoxConfig,
): GlofoxEndpoints {
  const membersList = async (params: MembersListParams = {}): Promise<GlofoxMembersResponse> => {
    assertPageParams(params);
    const body = await glofoxFetch("/2.0/members", {
      query: {
        active: params.activeFilter,
        utc_modified_start_date:
          params.utcModifiedStartDate && toUnixSeconds(params.utcModifiedStartDate),
        utc_modified_end_date:
          params.utcModifiedEndDate && toUnixSeconds(params.utcModifiedEndDate),
        page: params.page,
        limit: params.limit,
      },
    });
    return glofoxMembersResponseSchema.parse(body);
  };

  const bookingsList = async (params: BookingsListParams = {}): Promise<GlofoxBookingsResponse> => {
    assertPageParams(params);
    const body = await glofoxFetch(
      `/2.2/branches/${encodeURIComponent(config.branchId)}/bookings`,
      {
        query: {
          modified_start_date: params.modifiedStartDate && toUnixSeconds(params.modifiedStartDate),
          status: params.status,
          event_type: params.eventType,
          page: params.page,
          limit: params.limit,
        },
      },
    );
    return glofoxBookingsResponseSchema.parse(body);
  };

  return {
    members: {
      list: membersList,
      listAllPages: async function* (params = {}) {
        let page = params.page ?? 1;
        for (;;) {
          const res = await membersList({ ...params, page });
          yield res;
          // The empty-data guard stops a buggy has_more-forever vendor response.
          if (!res.has_more || res.data.length === 0) return;
          page += 1;
        }
      },
      get: async (userId) =>
        glofoxMemberSchema.parse(await glofoxFetch(`/2.0/members/${encodeURIComponent(userId)}`)),
    },
    memberships: {
      list: async (params = {}) => {
        assertPageParams(params);
        const body = await glofoxFetch("/2.0/memberships", {
          query: { page: params.page, limit: params.limit },
        });
        return glofoxMembershipsResponseSchema.parse(body);
      },
    },
    credits: {
      forUser: async (userId, params = {}) => {
        assertPageParams(params);
        const body = await glofoxFetch("/2.0/credits", {
          query: { user_id: userId, page: params.page, limit: params.limit },
        });
        return glofoxCreditsResponseSchema.parse(body);
      },
    },
    bookings: {
      list: bookingsList,
      listAllPages: async function* (params = {}) {
        const startPage = params.page ?? 1;
        let page = startPage;
        for (;;) {
          const res = await bookingsList({ ...params, page });
          yield res;
          const lastPage = Math.max(startPage, Math.ceil(res.meta.totalCount / res.meta.limit));
          if (page >= lastPage || res.data.length === 0) return;
          page += 1;
        }
      },
    },
    events: {
      list: async (params = {}) => {
        assertPageParams(params);
        const body = await glofoxFetch(
          `/2.0/branches/${encodeURIComponent(config.branchId)}/events`,
          { query: { page: params.page, limit: params.limit } },
        );
        return glofoxEventsResponseSchema.parse(body);
      },
    },
    branch: {
      get: async () =>
        glofoxBranchSchema.parse(
          await glofoxFetch(`/2.0/branches/${encodeURIComponent(config.branchId)}`),
        ),
    },
    transactionsReport: async ({ start, end }) => {
      const body = buildAnalyticsReportRequest({
        branch_id: config.branchId,
        // TRAP 2 — REQUIRED: without it the report is 200 + zero rows (README §3).
        namespace: config.namespace,
        start: toUnixSecondsString(start),
        end: toUnixSecondsString(end),
        model: "TransactionsList",
      });
      // Style C: no `success` field (trap-1 detection does not apply), no
      // pagination. An EMPTY details array is a legitimate response shape —
      // the zero-row tripwire lives in the sync layer (phase 1.4), not here.
      return glofoxTransactionsReportSchema.parse(
        await glofoxFetch("/Analytics/report", { method: "POST", body }),
      );
    },
  };
}

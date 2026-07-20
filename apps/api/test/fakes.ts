import type { KeloSupabaseClient } from "@kelo/db";

/**
 * Test fakes for the user-scoped Supabase client — no network, no DB.
 *
 * The fake mirrors the PostgREST fluent builder: every chained method call is
 * recorded and returns the same builder; AWAITING the builder resolves the
 * result produced by the per-table handler (which receives that table's
 * recorded calls, so it can answer differently for select vs update, etc.).
 */

export interface RecordedCall {
  table: string;
  method: string;
  args: unknown[];
}

export interface FakeResult {
  data: unknown;
  error?: { message: string; code?: string } | null;
}

export type TableHandler = (tableCalls: RecordedCall[]) => FakeResult;
export type RpcHandler = (params: Record<string, unknown>) => FakeResult;

export interface FakeUserClient {
  client: KeloSupabaseClient;
  calls: RecordedCall[];
}

export interface FakeAdminUser {
  id: string;
  email?: string;
}

export function fakeUserClient(
  handlers: Record<string, TableHandler>,
  rpcHandlers: Record<string, RpcHandler> = {},
  adminUsers?: FakeAdminUser[],
): FakeUserClient {
  const calls: RecordedCall[] = [];

  const client: Record<string, unknown> = {
    from(table: string) {
      const tableCalls: RecordedCall[] = [];
      const builder: Record<string, unknown> = {};
      const proxy = new Proxy(builder, {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (value: FakeResult) => void) => {
              const handler = handlers[table];
              const result = handler !== undefined ? handler(tableCalls) : { data: null };
              resolve({ data: result.data, error: result.error ?? null });
            };
          }
          return (...args: unknown[]) => {
            const call = { table, method: String(prop), args };
            calls.push(call);
            tableCalls.push(call);
            return proxy;
          };
        },
      });
      return proxy;
    },
    rpc(name: string, params: Record<string, unknown> = {}) {
      calls.push({ table: name, method: "rpc", args: [params] });
      const handler = rpcHandlers[name];
      const result = handler !== undefined ? handler(params) : { data: null };
      return Promise.resolve({ data: result.data, error: result.error ?? null });
    },
  };

  // The GoTrue admin surface (auth.users is not PostgREST-reachable) — only
  // present when a test provides users, mirroring the service-role-only
  // listUsers the member staff-email hygiene check consumes.
  if (adminUsers !== undefined) {
    client["auth"] = {
      admin: {
        listUsers: () => Promise.resolve({ data: { users: adminUsers }, error: null }),
      },
    };
  }

  return { client: client as unknown as KeloSupabaseClient, calls };
}

/** Stable test ids. */
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

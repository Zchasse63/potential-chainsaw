import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RPC_COMMAND_CONTRACT } from "../../src/billing/outbox.js";

/**
 * THE F2 DRIFT TRIPWIRE. Migration 0034's RPCs (app.create_payment_intent /
 * app.create_refund) are the CANONICAL emitters of stripe_commands rows — the
 * SQL is applied to production and immutable. The outbox's dispatch() consumes
 * that contract via RPC_COMMAND_CONTRACT. This test parses the migration's
 * actual SQL text and binds the two sides together, so a renamed kind literal
 * or payload key on EITHER side fails the suite instead of dead-lettering
 * every real charge in production (the original F2 failure mode).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "../../../supabase/migrations/20260718300100_0034_payment_rpcs.sql");

function migrationSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

/** Extract the payload keys of the jsonb_build_object(...) that follows the
 * given kind literal in the migration SQL. The RPCs write
 * `values (..., '<kind>', <key>, jsonb_build_object('k1', v1, 'k2', v2, ...))`
 * so the FIRST jsonb_build_object after the kind literal is its payload. */
function payloadKeysAfterKind(sql: string, kind: string): string[] {
  const kindAt = sql.indexOf(`'${kind}'`);
  expect(kindAt, `kind literal '${kind}' present in 0034`).toBeGreaterThan(-1);
  const objAt = sql.indexOf("jsonb_build_object(", kindAt);
  expect(objAt, `jsonb_build_object after '${kind}'`).toBeGreaterThan(-1);
  // Scan to the matching close paren of jsonb_build_object(.
  let depth = 0;
  let end = -1;
  for (let i = objAt + "jsonb_build_object".length; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, "matched close paren").toBeGreaterThan(-1);
  const body = sql.slice(objAt, end);
  // jsonb_build_object alternates 'key', value — keys are the quoted literals
  // at even argument positions; in the RPC SQL every quoted literal inside the
  // call IS a key (values are columns/params, never string literals).
  const keys = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
  return keys;
}

describe("F2 drift tripwire — outbox contract is bound to migration 0034's SQL", () => {
  it("the migration emits exactly the kinds the outbox consumes", () => {
    const sql = migrationSql();
    for (const kind of Object.keys(RPC_COMMAND_CONTRACT)) {
      expect(sql, `0034 emits kind '${kind}'`).toContain(`'${kind}'`);
    }
  });

  it.each(Object.entries(RPC_COMMAND_CONTRACT))(
    "the %s payload keys in 0034 match RPC_COMMAND_CONTRACT",
    (kind, expectedKeys) => {
      const keys = payloadKeysAfterKind(migrationSql(), kind);
      // Every contract key must appear in the SQL payload, and the SQL must not
      // carry a key the contract (and therefore dispatch()) doesn't know.
      expect(keys.sort()).toEqual([...expectedKeys].sort());
    },
  );

  it("dispatch() is source-bound to the contract kinds + money-critical keys", () => {
    const source = readFileSync(join(HERE, "../../src/billing/outbox.ts"), "utf8");
    // The kind literals must be dispatch case labels (a renamed case = drift).
    for (const kind of Object.keys(RPC_COMMAND_CONTRACT)) {
      expect(source, `dispatch has a case for "${kind}"`).toContain(`case "${kind}"`);
    }
    // The money-critical payload keys must be read verbatim. ('reason' is
    // emitted by the RPC for the audit trail but deliberately not consumed by
    // dispatch — Stripe receives the refund without it.)
    for (const key of ["amount_cents", "currency", "customer_id", "payment_id"]) {
      expect(source, `dispatch reads payload key "${key}"`).toContain(`p["${key}"]`);
    }
  });
});

# @kelo/contracts

Zod schemas — **the single source of truth for shapes** in Kelo (CLAUDE.md). Nothing
anywhere else declares a payload shape twice: API request/response bodies, Glofox
payloads, and webhook bodies are all defined here and imported.

## Response envelope

Every API response is an envelope (`src/envelope.ts`):

```ts
{ data: T, meta: { as_of, source, stale, definition_version, correlation_id } }
```

- `as_of` — ISO datetime of the newest input; combined reports inherit the **oldest**
  input's freshness.
- `source` — `"native" | "glofox" | "stripe" | "mixed"`.
- `stale` — stale data is labeled stale, never silently mixed with fresh.
- Use `envelope(schema)` to build the Zod schema for a given `data` shape.

Errors use `errorResponseSchema` (`{ error: { code, message, correlation_id, details? } }`)
with a non-2xx status — **errors are never represented as a 200 success** (that is
Glofox's own trap; Kelo does not repeat it).

Mutation conventions (`src/mutations.ts`): `Idempotency-Key` on every mutation,
`If-Match` on updates, `202` + `{ operation_id }` for long-running work.

## Glofox contract convention

`src/glofox/` holds one file per consumed endpoint. Rules (docs/glofox/README.md):

1. **Every schema cites its sample.** Each file starts with
   `// sample: docs/glofox/samples/<file>` pointing at the pinned, PII-redacted,
   live-verified JSON it was derived from. Never guess a Glofox shape.
2. **Every pinned sample has a contract test.** `test/samples.test.ts` parses each
   `docs/glofox/samples/*.json` through its schema — a phase-0 gate. Glofox drift
   fails CI here first.
3. **Parse at the boundary.** `glofoxUnixTimestamp` accepts int **or** numeric-string
   unix seconds (mixed by endpoint generation) and transforms to `Date`.
4. **Three envelope styles** (`glofox/envelopes.ts`): A = `{object,page,limit,has_more,
total_count,data}` (2.0 lists), B = `{data,success,meta:{totalCount,page,limit}}`
   (2.2 bookings), C = bare analytics report (no data/success/pagination).
5. **Traps are encoded, not remembered** (`glofox/client-contract.ts`, type-level only):
   `glofoxFetch` must throw when `success !== true`; the Analytics report request
   builder makes `namespace` **required** (without it Glofox returns 200 + zero rows).
6. **Unknown `glofox_event` values quarantine.** Classify with
   `classifyGlofoxEvent` (`glofox/primitives.ts`) — anything outside
   `subscription_payment | invoice_payment | book_class` comes back `'unknown'` and
   must be quarantined, never guessed (invariant #8).

## Layout

- `src/envelope.ts` — response envelope + error shape
- `src/mutations.ts` — mutation header names + 202 shape (scaffold)
- `src/glofox/primitives.ts` — unix-timestamp boundary parser, `glofoxEvent` classifier
- `src/glofox/envelopes.ts` — the three Glofox envelope styles
- `src/glofox/{members,memberships,credits,bookings,analytics,branch,events}.ts` — per-endpoint schemas
- `src/glofox/client-contract.ts` — type-level shared-client contract (no network)
- `test/` — pinned-sample contract tests + primitive tests (vitest)

// NO `@vitest-environment jsdom` docblock ON PURPOSE: this file runs in the
// repo's DEFAULT node environment, where `navigator` and `window` do not
// exist — exactly the condition of a real TanStack Start server render. It is
// the gate the unit tests + `vite build` both miss: build never executes SSR,
// and jsdom component tests have `navigator.onLine === true`.
//
// Before the SSR-safety fix, DataBoundary's useOnlineStatus read
// `navigator.onLine` in a useState initializer, so renderToString threw a
// ReferenceError here (Node 20 has no global `navigator`) — the member site's
// SSR handler would 500 on every request. This test fails before the fix and
// passes after; it also asserts the server never paints the false "offline"
// banner (the Node ≥21 failure mode) into the public HTML.
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataBoundary } from "../react/index.js";
import type { BoundaryQuery } from "../react/index.js";

const VALID_META = {
  as_of: "2026-07-17T12:00:00.000Z",
  source: "native" as const,
  stale: false,
  definition_version: null,
  correlation_id: "corr-ssr-1",
};

// Deterministically reproduce a pure no-DOM SSR runtime (Node ≤20 / a strict
// SSR sandbox) regardless of the local Node — Node ≥21 leaks a global
// `navigator` object, which would MASK the ReferenceError this guards against.
// Deleting both globals is exactly the environment the member site's Netlify
// SSR function runs in; a naive `navigator.onLine` initializer throws here.
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  // @ts-expect-error — intentionally removing the DOM globals for this file.
  delete globalThis.navigator;
  // @ts-expect-error — intentionally removing the DOM globals for this file.
  delete globalThis.window;
});
afterEach(() => {
  if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
});

describe("DataBoundary — server render (no navigator/window)", () => {
  it("renders on the server without throwing, and never paints the offline banner", () => {
    const query: BoundaryQuery = {
      status: "success",
      data: { data: { hello: "world" }, meta: VALID_META },
      refetch: vi.fn(),
    };

    let html = "";
    expect(() => {
      html = renderToString(
        <DataBoundary
          name="member-schedule"
          query={query}
          skeleton={<div>loading</div>}
          errorConsequence="Nothing changed."
        >
          {(data) => <div>ready:{(data as { hello: string }).hello}</div>}
        </DataBoundary>,
      );
    }).not.toThrow();

    // The happy path renders the children — not an error/empty/offline surface.
    // (renderToString splits adjacent text nodes with `<!-- -->` markers, so
    // assert the pieces rather than the concatenation.)
    expect(html).toContain("ready:");
    expect(html).toContain("world");
    // A server render is definitionally online; the false "offline" banner must
    // NOT reach the public HTML (it would hydration-mismatch + mislead).
    expect(html).not.toContain("offline");
  });
});

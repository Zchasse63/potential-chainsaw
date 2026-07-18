// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AppShell } from "../src/components/app-shell.jsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => <a href={to} className={className}>{children}</a>,
  useRouterState: () => "/ask",
}));
vi.mock("../src/auth/auth-context.js", () => ({
  useAuth: () => ({ accessToken: "token", userEmail: "owner@example.com", client: { auth: { signOut: vi.fn() } } }),
}));
vi.mock("../src/lib/health.js", () => ({ useHealthQuery: () => ({ status: "pending" }) }));

afterEach(cleanup);

describe("AppShell", () => {
  it("adds Ask between Today and Import review in the primary rail", () => {
    render(<AppShell><p>content</p></AppShell>);
    const links = screen.getByRole("navigation", { name: "Primary" }).querySelectorAll("a");
    expect([...links].map((link) => link.textContent?.trim())).toEqual(["Today", "Ask", "Import review", "Health"]);
    expect(screen.getByRole("link", { name: "Ask" }).getAttribute("href")).toBe("/ask");
  });
});

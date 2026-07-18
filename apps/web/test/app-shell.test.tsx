// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AppShell } from "../src/components/app-shell.jsx";

const access = vi.hoisted(() => ({ role: "manager" }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useRouterState: () => "/ask",
}));
vi.mock("../src/auth/auth-context.js", () => ({
  useAuth: () => ({
    accessToken: "token",
    userEmail: "owner@example.com",
    client: { auth: { signOut: vi.fn() } },
  }),
}));
vi.mock("../src/lib/health.js", () => ({ useHealthQuery: () => ({ status: "pending" }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    status: "success",
    data: { data: { tenants: [{ role: access.role }] } },
  }),
}));

afterEach(cleanup);

describe("AppShell", () => {
  it("shows Staff in the owner/manager rail", () => {
    access.role = "manager";
    render(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );
    const links = screen.getByRole("navigation", { name: "Primary" }).querySelectorAll("a");
    expect([...links].map((link) => link.textContent?.trim())).toEqual([
      "Today",
      "Marketing",
      "Ask",
      "Import review",
      "Health",
      "◎Staff",
    ]);
    expect(screen.getByRole("link", { name: "Marketing" }).getAttribute("href")).toBe("/marketing");
    expect(screen.getByRole("link", { name: "Ask" }).getAttribute("href")).toBe("/ask");
    expect(screen.getByRole("link", { name: "Staff" }).getAttribute("href")).toBe("/staff");
  });

  it("removes Staff from front-desk and trainer navigation", () => {
    access.role = "front_desk";
    render(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );
    expect(screen.queryByRole("link", { name: "Staff" })).toBeNull();
  });
});

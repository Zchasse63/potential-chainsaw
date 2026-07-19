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
  it("shows Staff and Waivers in the owner/manager rail", () => {
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
      "◔Book",
      "Retail",
      "◧Point of sale",
      "$Payments",
      "◎Staff",
      "§Waivers",
    ]);
    expect(screen.getByRole("link", { name: "Marketing" }).getAttribute("href")).toBe("/marketing");
    expect(screen.getByRole("link", { name: "Ask" }).getAttribute("href")).toBe("/ask");
    expect(screen.getByRole("link", { name: "Retail" }).getAttribute("href")).toBe("/retail");
    expect(screen.getByRole("link", { name: "Point of sale" }).getAttribute("href")).toBe("/pos");
    expect(screen.getByRole("link", { name: "Payments" }).getAttribute("href")).toBe("/payments");
    expect(screen.getByRole("link", { name: "Staff" }).getAttribute("href")).toBe("/staff");
    expect(screen.getByRole("link", { name: "Waivers" }).getAttribute("href")).toBe("/waivers");
  });

  it("gives front-desk the POS till but not Payments, Staff, Retail, or Waivers", () => {
    access.role = "front_desk";
    render(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );
    // Front-desk takes cash at the POS but never sees the money surface.
    expect(screen.getByRole("link", { name: "Point of sale" }).getAttribute("href")).toBe("/pos");
    expect(screen.queryByRole("link", { name: "Payments" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Staff" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Retail" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Waivers" })).toBeNull();
  });
});

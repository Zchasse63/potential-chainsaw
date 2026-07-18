// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApprovalCeremony, type ApprovalDetail } from "../src/components/approval-ceremony.jsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const detail: ApprovalDetail = {
  campaign: {
    id: "campaign-1",
    name: "At risk",
    channel: "email",
    status: "pending_approval",
    draft_subject: "Hello Maria",
    draft_body: "We would be glad to see you.",
    draft_source: "ai",
  },
  breakdown: {
    eligible: 2,
    skip_no_consent: 1,
    skip_suppressed: 1,
    skip_quiet_hours: 1,
    skip_no_address: 0,
  },
  sends: [
    { id: "1", person_id: "p1", planned_status: "eligible", person: { first_name: "Maria", last_name: "R", email: "m@example.com", phone: null } },
    { id: "2", person_id: "p2", planned_status: "eligible", person: { first_name: "Alex", last_name: "S", email: "a@example.com", phone: null } },
    { id: "3", person_id: "p3", planned_status: "skip_no_consent", person: { first_name: "No", last_name: "Consent", email: "n@example.com", phone: null } },
    { id: "4", person_id: "p4", planned_status: "skip_suppressed", person: { first_name: "Opted", last_name: "Out", email: "o@example.com", phone: null } },
    { id: "5", person_id: "p5", planned_status: "skip_quiet_hours", person: { first_name: "Quiet", last_name: "Hours", email: "q@example.com", phone: null } },
  ],
  resolved_sample: { subject: "Hello Maria", body: "We would be glad to see you.", person_id: "p1" },
};

describe("ApprovalCeremony", () => {
  it("renders policy exclusions and never sends merely by rendering", () => {
    const approve = vi.fn(async () => undefined);
    render(<ApprovalCeremony detail={detail} onApprove={approve} />);
    expect(screen.getByText("1 No marketing consent")).toBeDefined();
    expect(screen.getByText("1 Suppressed or opted out")).toBeDefined();
    expect(screen.getByText("1 Studio quiet hours")).toBeDefined();
    expect(screen.getByText("Draft · Kelo Intelligence")).toBeDefined();
    expect(screen.getByRole("button", { name: "Approve & send to 2 recipients" })).toBeDefined();
    expect(approve).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before invoking approval", async () => {
    const approve = vi.fn(async () => undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ApprovalCeremony detail={detail} onApprove={approve} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & send to 2 recipients" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(approve).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Approve & send to 2 recipients" }));
    await waitFor(() => expect(approve).toHaveBeenCalledOnce());
  });
});

import { describe, expect, it } from "vitest";
import { mapResendEvent, mapTwilioEvent } from "../src/index.js";

describe("provider status mapping", () => {
  it("maps hard bounces to bounced plus address suppression", () => {
    expect(
      mapResendEvent({
        type: "email.bounced",
        data: { email_id: "email_1", to: ["A@Example.com"] },
      }),
    ).toMatchObject({
      kind: "status",
      status: "bounced",
      suppressionReason: "hard_bounce",
      suppressionAddress: "a@example.com",
    });
  });

  it("maps inbound STOP to an immediate stop action", () => {
    expect(
      mapTwilioEvent({
        MessageSid: "SM1",
        From: "+12125550123",
        To: "+12125550999",
        Body: "stop",
        OptOutType: "STOP",
      }),
    ).toMatchObject({ kind: "stop", from: "+12125550123" });
  });
});

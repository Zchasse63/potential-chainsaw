import type { SuppressionReason } from "./policy.js";

export type CommsStatus = "sent" | "delivered" | "bounced" | "failed" | "suppressed";

export interface ProviderStatusAction {
  providerMessageId: string;
  status: CommsStatus;
  detail?: string;
  suppressionReason?: SuppressionReason;
  suppressionAddress?: string;
}

export interface TwilioStopAction {
  kind: "stop";
  eventId: string;
  from: string;
  to: string;
  body: string;
  providerMessageId: string;
}

export type ProviderAction =
  | ({ kind: "status" } & ProviderStatusAction)
  | TwilioStopAction
  | { kind: "ignored"; eventId?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstAddress(value: unknown): string | undefined {
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].toLowerCase();
  return undefined;
}

export function mapResendEvent(payload: unknown): ProviderAction {
  const event = record(payload);
  const type = event?.["type"];
  const data = record(event?.["data"]);
  const providerMessageId = data?.["email_id"];
  if (typeof type !== "string" || typeof providerMessageId !== "string") {
    return { kind: "ignored" };
  }
  const address = firstAddress(data?.["to"]);
  switch (type) {
    case "email.sent":
      return { kind: "status", providerMessageId, status: "sent" };
    case "email.delivered":
      return { kind: "status", providerMessageId, status: "delivered" };
    case "email.bounced":
      return {
        kind: "status",
        providerMessageId,
        status: "bounced",
        detail: typeof data?.["bounce"] === "object" ? JSON.stringify(data["bounce"]) : undefined,
        suppressionReason: "hard_bounce",
        suppressionAddress: address,
      };
    case "email.complained":
      return {
        kind: "status",
        providerMessageId,
        status: "suppressed",
        detail: "recipient complaint",
        suppressionReason: "complaint",
        suppressionAddress: address,
      };
    case "email.failed":
      return { kind: "status", providerMessageId, status: "failed" };
    case "email.suppressed":
      return { kind: "status", providerMessageId, status: "suppressed" };
    default:
      return { kind: "ignored" };
  }
}

export function mapTwilioEvent(params: TwilioParamsLike): ProviderAction {
  const providerMessageId = params["MessageSid"] ?? params["SmsSid"];
  const optOutType = params["OptOutType"]?.toUpperCase();
  const body = params["Body"] ?? "";
  const isStop = optOutType === "STOP" || body.trim().toUpperCase() === "STOP";
  if (isStop && typeof providerMessageId === "string") {
    const from = params["From"];
    const to = params["To"];
    if (typeof from === "string" && typeof to === "string") {
      return {
        kind: "stop",
        eventId: providerMessageId,
        from,
        to,
        body,
        providerMessageId,
      };
    }
  }

  const status = params["MessageStatus"] ?? params["SmsStatus"];
  if (typeof providerMessageId !== "string" || typeof status !== "string") {
    return { kind: "ignored", eventId: providerMessageId };
  }
  switch (status.toLowerCase()) {
    case "sent":
      return { kind: "status", providerMessageId, status: "sent" };
    case "delivered":
      return { kind: "status", providerMessageId, status: "delivered" };
    case "failed":
    case "undelivered":
      return {
        kind: "status",
        providerMessageId,
        status: "failed",
        detail: params["ErrorCode"],
      };
    default:
      return { kind: "ignored", eventId: providerMessageId };
  }
}

export type TwilioParamsLike = Record<string, string | undefined>;

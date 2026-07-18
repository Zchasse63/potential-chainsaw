import {
  dryRunId,
  providerError,
  type Env,
  type FetchImpl,
  type MessageAdapter,
  type SendResult,
} from "./types.js";

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  messagingServiceSid?: string;
  fetchImpl?: FetchImpl;
}

export function twilioConfigFromEnv(env: Env): TwilioConfig {
  return {
    accountSid: env["TWILIO_ACCOUNT_SID"],
    authToken: env["TWILIO_AUTH_TOKEN"],
    messagingServiceSid: env["TWILIO_MESSAGING_SERVICE_SID"],
  };
}

function assertUsNumber(to: string): void {
  if (!/^\+1[2-9]\d{9}$/.test(to)) {
    throw new Error("Twilio SMS is US-only; to must be a +1 E.164 number");
  }
}

export class TwilioAdapter implements MessageAdapter {
  readonly #config: TwilioConfig;

  constructor(config: TwilioConfig) {
    this.#config = config;
  }

  async send(message: { to: string; body: string }): Promise<SendResult> {
    assertUsNumber(message.to);
    const values = [
      this.#config.accountSid,
      this.#config.authToken,
      this.#config.messagingServiceSid,
    ];
    if (values.every((value) => value === undefined || value === "")) {
      return { providerMessageId: dryRunId(), dryRun: true };
    }
    if (values.some((value) => value === undefined || value === "")) {
      throw new Error(
        "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID must be configured together",
      );
    }

    const accountSid = this.#config.accountSid as string;
    const authToken = this.#config.authToken as string;
    const messagingServiceSid = this.#config.messagingServiceSid as string;
    const form = new URLSearchParams({
      To: message.to,
      Body: message.body,
      MessagingServiceSid: messagingServiceSid,
    });
    const fetchImpl = this.#config.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: form.toString(),
      },
    );
    if (!response.ok) throw await providerError(response, "Twilio");
    const payload = (await response.json()) as { sid?: unknown };
    if (typeof payload.sid !== "string" || payload.sid === "") {
      throw new Error("Twilio send response did not include a sid");
    }
    return { providerMessageId: payload.sid };
  }
}

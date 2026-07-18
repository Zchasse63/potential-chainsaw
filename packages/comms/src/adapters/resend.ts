import {
  dryRunId,
  providerError,
  type Env,
  type FetchImpl,
  type MessageAdapter,
  type SendResult,
} from "./types.js";

export interface ResendConfig {
  apiKey?: string;
  from?: string;
  fetchImpl?: FetchImpl;
}

export function resendConfigFromEnv(env: Env): ResendConfig {
  return { apiKey: env["RESEND_API_KEY"], from: env["RESEND_FROM"] };
}

export class ResendAdapter implements MessageAdapter {
  readonly #config: ResendConfig;

  constructor(config: ResendConfig) {
    this.#config = config;
  }

  async send(message: { to: string; subject?: string; body: string }): Promise<SendResult> {
    if (this.#config.apiKey === undefined || this.#config.apiKey === "") {
      return { providerMessageId: dryRunId(), dryRun: true };
    }
    if (this.#config.from === undefined || this.#config.from === "") {
      throw new Error("RESEND_FROM is required when RESEND_API_KEY is configured");
    }
    if (message.subject === undefined || message.subject === "") {
      throw new Error("Resend email requires a subject");
    }

    const fetchImpl = this.#config.fetchImpl ?? fetch;
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.#config.from,
        to: [message.to],
        subject: message.subject,
        text: message.body,
      }),
    });
    if (!response.ok) throw await providerError(response, "Resend");
    const payload = (await response.json()) as { id?: unknown };
    if (typeof payload.id !== "string" || payload.id === "") {
      throw new Error("Resend send response did not include an id");
    }
    return { providerMessageId: payload.id };
  }
}

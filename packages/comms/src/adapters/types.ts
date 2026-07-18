export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SendResult {
  providerMessageId: string;
  dryRun?: boolean;
}

export interface MessageAdapter {
  send(message: { to: string; subject?: string; body: string }): Promise<SendResult>;
}

export type Env = Record<string, string | undefined>;

export function dryRunId(): string {
  return `dry-run-${crypto.randomUUID()}`;
}

export async function providerError(response: Response, provider: string): Promise<Error> {
  const body = (await response.text()).slice(0, 500);
  return new Error(`${provider} send failed (${response.status}): ${body || response.statusText}`);
}

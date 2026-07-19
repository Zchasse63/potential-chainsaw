/**
 * The client-side structured API error (plan-final §3): thrown by fetch
 * clients when a request fails — network-level (status 0) or a non-2xx —
 * carrying the errorResponseSchema code/message/correlation id so the UI can
 * render the reference. Lives in contracts (Wave 8.1b) because the shape is
 * the contract's; env-dependent API clients stay in each app and import this.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | undefined;

  constructor(status: number, code: string, message: string, correlationId: string | undefined) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

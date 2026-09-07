export type ConnectionErrorCode =
  "Timeout" | "Cancelled" | "Transport" | "NotConnected" | "Backpressure";

export class ConnectionError extends Error {
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

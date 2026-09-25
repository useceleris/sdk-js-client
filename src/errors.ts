export class ConfigurationError extends Error {
  readonly code = "Configuration";

  constructor(message = "Invalid client command.") {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class ProtocolError extends Error {
  readonly code = "ProtocolError";

  constructor(
    message: string,
    readonly field: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export type ConnectionErrorCode =
  | "Timeout"
  | "Cancelled"
  | "Transport"
  | "NotConnected"
  | "Backpressure"
  | "OperationInProgress"
  | "DeliveryUnknown";

export class ConnectionError extends Error {
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

// The server's own error names, one per RealtimeError variant (ERR-01).
export type ServerErrorCode =
  | "ParserError"
  | "SendError"
  | "PermissionDeniedError"
  | "RateLimitError"
  | "MessageSizeLimitError";

// An error frame from the server: its name and its message, both exactly as
// sent. The code stays open to names a newer server may add, so an error this
// version does not know still reaches the consumer instead of vanishing.
export class ServerError extends Error {
  constructor(
    readonly code: ServerErrorCode | (string & {}),
    message: string,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

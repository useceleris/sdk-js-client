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
  | "DeliveryUnknown"
  | "Permission";

export class ConnectionError extends Error {
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

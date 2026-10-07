export class ConfigurationError extends Error {
  readonly code = "Configuration";

  constructor(message = "Invalid client command.") {
    super(message);
    this.name = "ConfigurationError";
  } // end constructor
} // end class ConfigurationError

export class ProtocolError extends Error {
  readonly code = "ProtocolError";

  constructor(
    message: string,
    readonly field: string,
    readonly offset: number,
  ) {
    // The field is a name this package chose and the offset a byte position,
    // so neither repeats what the server sent.
    super(`${message} Field: ${field}, byte offset ${offset}.`);
    this.name = "ProtocolError";
  } // end constructor
} // end class ProtocolError

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
  } // end constructor
} // end class ConnectionError

// The server's own error types, one per RealtimeError variant (ERR-01).
export type ServerErrorType =
  | "ParserError"
  | "SendError"
  | "PermissionDeniedError"
  | "RateLimitError"
  | "MessageSizeLimitError"
  | "InternalError";

// Whatever an error's type and sub type define it to carry, such as the
// segment a denial refers to. Recursive, so it needs a name.
export type ServerErrorResource =
  null | string | number | bigint | readonly ServerErrorResource[];

// An error frame from the server, every field exactly as sent. The type stays
// open to types a newer server may add, so an error this version does not
// know still reaches the consumer instead of vanishing.
export class ServerError extends Error {
  constructor(
    readonly type: ServerErrorType | (string & {}),
    // The command the error answers, e.g. "PRES_LIST"; null when none.
    readonly subType: string | null,
    message: string,
    readonly resource: ServerErrorResource,
  ) {
    super(message);
    this.name = "ServerError";
  } // end constructor
} // end class ServerError

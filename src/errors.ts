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

import { ProtocolError, type ServerErrorResource } from "./errors";
import type { PresenceConnection, ServerMessage } from "./messages";
import {
  MAXIMUM_COMMAND_NAME_BYTES,
  MAXIMUM_DEPTH,
  MAXIMUM_ERROR_NAME_BYTES,
  MAXIMUM_FRAGMENTS,
  MAXIMUM_INTEGER32,
  MAXIMUM_INTEGER32_LINE_BYTES,
  MAXIMUM_INTEGER64,
  MAXIMUM_INTEGER64_LINE_BYTES,
  MINIMUM_INTEGER32,
  MINIMUM_INTEGER64,
  STRICT_TEXT_DECODER,
} from "./constants";

export class MessageDecoder {
  private offset = 0;
  private fragments = 0;

  constructor(private readonly bytes: Uint8Array) {}

  decode(): ServerMessage {
    const message = this.readMessage(0, true);

    if (this.offset !== this.bytes.length) {
      throw new ProtocolError(
        "Trailing data after server message.",
        "message",
        this.offset,
      );
    }

    return message;
  } // end method decode

  private readMarker(field: string): number {
    const fieldStartOffset = this.offset;
    this.fragments++;
    const marker = this.bytes[this.offset++];

    if (this.fragments > MAXIMUM_FRAGMENTS) {
      throw new ProtocolError(
        "Fragment limit exceeded.",
        field,
        fieldStartOffset,
      );
    }

    if (marker === undefined) {
      throw new ProtocolError("Missing field marker.", field, fieldStartOffset);
    }

    return marker;
  } // end method readMarker

  private readLine(
    field: string,
    fieldStartOffset: number,
    maximumLength = this.bytes.length,
  ): Uint8Array {
    const lineStart = this.offset;

    while (this.offset < this.bytes.length) {
      if (this.bytes[this.offset++] === "\n".charCodeAt(0)) {
        let contentEnd = this.offset - 1;

        if (this.bytes[contentEnd - 1] === "\r".charCodeAt(0)) {
          contentEnd -= 1;
        }

        if (contentEnd - lineStart > maximumLength) {
          throw new ProtocolError(
            "Line exceeds byte limit.",
            field,
            fieldStartOffset,
          );
        }

        return this.bytes.subarray(lineStart, contentEnd);
      }

      if (this.offset - lineStart > maximumLength + 1) {
        throw new ProtocolError(
          "Line exceeds byte limit.",
          field,
          fieldStartOffset,
        );
      }
    }

    throw new ProtocolError("Unterminated line.", field, fieldStartOffset);
  } // end method readLine

  private readText(
    bytes: Uint8Array,
    field: string,
    fieldStartOffset: number,
  ): string {
    try {
      return STRICT_TEXT_DECODER.decode(bytes);
    } catch {
      throw new ProtocolError("Invalid UTF-8 text.", field, fieldStartOffset);
    }
  } // end method readText

  // The decimal grammar every numeric field shares. The range defaults to
  // signed 64-bit, which also bounds bulk and array lengths.
  private readDecimal(
    field: string,
    fieldStartOffset: number,
    maximumLineBytes = MAXIMUM_INTEGER64_LINE_BYTES,
    minimum = MINIMUM_INTEGER64,
    maximum = MAXIMUM_INTEGER64,
  ): bigint {
    const text = this.readText(
      this.readLine(field, fieldStartOffset, maximumLineBytes),
      field,
      fieldStartOffset,
    );
    let value: bigint;

    try {
      value = BigInt(text);
    } catch {
      throw new ProtocolError("Invalid integer.", field, fieldStartOffset);
    }

    const digits = text.startsWith("-") ? text.slice(1) : text;

    if (digits.length === 0 || /[^0-9]/.test(digits)) {
      throw new ProtocolError(
        "Expected decimal digits.",
        field,
        fieldStartOffset,
      );
    }

    if (value < minimum || value > maximum) {
      throw new ProtocolError("Integer out of range.", field, fieldStartOffset);
    }

    return value;
  } // end method readDecimal

  private readInteger64(field: string): bigint {
    const fieldStartOffset = this.offset;

    if (this.readMarker(field) !== ":".charCodeAt(0)) {
      throw new ProtocolError(
        "Expected Integer64 marker.",
        field,
        fieldStartOffset,
      );
    }

    return this.readDecimal(field, fieldStartOffset);
  } // end method readInteger64

  private readInteger32(field: string): number {
    const fieldStartOffset = this.offset;

    if (this.readMarker(field) !== ";".charCodeAt(0)) {
      throw new ProtocolError(
        "Expected Integer32 marker.",
        field,
        fieldStartOffset,
      );
    }

    return this.readInteger32Digits(field, fieldStartOffset);
  } // end method readInteger32

  // A 32-bit value is exact as a number, so it leaves the decoder as one.
  private readInteger32Digits(field: string, fieldStartOffset: number): number {
    return Number(
      this.readDecimal(
        field,
        fieldStartOffset,
        MAXIMUM_INTEGER32_LINE_BYTES,
        BigInt(MINIMUM_INTEGER32),
        BigInt(MAXIMUM_INTEGER32),
      ),
    );
  } // end method readInteger32Digits

  private readBytes(field: string): Uint8Array | null {
    const fieldStartOffset = this.offset;

    switch (this.readMarker(field)) {
      case "+".charCodeAt(0):
        return this.readLine(field, fieldStartOffset);
      case "$".charCodeAt(0):
        return this.readBulkBytes(field, fieldStartOffset);
      default:
        throw new ProtocolError(
          "Expected simple or bulk byte marker.",
          field,
          fieldStartOffset,
        );
    }
  } // end method readBytes

  private readBulkBytes(
    field: string,
    fieldStartOffset: number,
  ): Uint8Array | null {
    const length = this.readDecimal(field, fieldStartOffset);

    if (length === -1n) {
      return null;
    }

    if (length < 0n) {
      throw new ProtocolError(
        "Invalid bulk byte length.",
        field,
        fieldStartOffset,
      );
    }

    if (length > BigInt(this.bytes.length - this.offset)) {
      throw new ProtocolError(
        "Bulk payload exceeds remaining message bytes.",
        field,
        fieldStartOffset,
      );
    }

    const end = this.offset + Number(length);
    const result = this.bytes.subarray(this.offset, end);

    this.offset = end;

    if (this.bytes[this.offset] === "\r".charCodeAt(0)) {
      this.offset += 1;
    }

    if (this.bytes[this.offset++] !== "\n".charCodeAt(0)) {
      throw new ProtocolError(
        "Missing bulk byte terminator.",
        field,
        fieldStartOffset,
      );
    }

    return result;
  } // end method readBulkBytes

  private readIdentifier(field: string): string {
    const fieldStartOffset = this.offset;
    const text = this.readNullableIdentifier(field);

    if (text === null) {
      throw new ProtocolError(
        "Identifier cannot be null.",
        field,
        fieldStartOffset,
      );
    }

    return text;
  } // end method readIdentifier

  private readNullableIdentifier(field: string): string | null {
    const fieldStartOffset = this.offset;
    const bytes = this.readBytes(field);

    if (bytes === null) return null;

    const text = this.readText(bytes, field, fieldStartOffset);

    if (text.length === 0 || /[\r\n]/.test(text)) {
      throw new ProtocolError(
        "Identifier must be nonempty and CR/LF-free.",
        field,
        fieldStartOffset,
      );
    }

    return text;
  } // end method readNullableIdentifier

  private readPayload(field = "payload"): Uint8Array {
    const fieldStartOffset = this.offset;
    const payload = this.readBytes(field);

    if (payload === null) {
      throw new ProtocolError(
        "Payload cannot be null.",
        field,
        fieldStartOffset,
      );
    }

    return new Uint8Array(payload);
  } // end method readPayload

  private readArrayLength(
    depth: number,
    field: string,
    markerAlreadyRead = false,
  ): number {
    const fieldStartOffset = markerAlreadyRead ? this.offset - 1 : this.offset;

    if (depth >= MAXIMUM_DEPTH) {
      throw new ProtocolError(
        "Array nesting limit exceeded.",
        field,
        fieldStartOffset,
      );
    }

    if (!markerAlreadyRead && this.readMarker(field) !== "*".charCodeAt(0)) {
      throw new ProtocolError(
        "Expected array marker.",
        field,
        fieldStartOffset,
      );
    }

    const length = this.readDecimal(field, fieldStartOffset);

    if (length < 0n) {
      throw new ProtocolError(
        "Array length cannot be negative.",
        field,
        fieldStartOffset,
      );
    }

    if (length > BigInt(MAXIMUM_FRAGMENTS - this.fragments)) {
      throw new ProtocolError(
        "Array length exceeds fragment budget.",
        field,
        fieldStartOffset,
      );
    }

    return Number(length);
  } // end method readArrayLength

  private readConnections(depth: number): PresenceConnection[] {
    const length = this.readArrayLength(depth, "connections");
    const connections: PresenceConnection[] = [];

    for (let index = 0; index < length; index += 1) {
      const fieldStartOffset = this.offset;

      if (this.readArrayLength(depth + 1, "connection") !== 3) {
        throw new ProtocolError(
          "Presence connection must contain three fields.",
          "connection",
          fieldStartOffset,
        );
      }

      connections.push({
        tokenReference: this.readIdentifier("tokenReference"),
        connectionId: this.readIdentifier("connectionId"),
        timestamp: this.readInteger64("timestamp"),
      });
    }

    return connections;
  } // end method readConnections

  private readMessage(depth: number, tail: boolean): ServerMessage {
    const fieldStartOffset = this.offset;

    switch (this.readMarker("message")) {
      case "*".charCodeAt(0):
        return this.readMessageArray(depth, tail);
      case "-".charCodeAt(0):
        return this.readErrorMessage(depth);
      case "@".charCodeAt(0):
        return this.readCommandMessage(depth, tail);
      default:
        throw new ProtocolError(
          "Unexpected server message marker.",
          "message",
          fieldStartOffset,
        );
    }
  } // end method readMessage

  private readMessageArray(depth: number, tail: boolean): ServerMessage {
    const length = this.readArrayLength(depth, "messages", true);
    const messages: ServerMessage[] = [];

    for (let index = 0; index < length; index += 1) {
      messages.push(this.readMessage(depth + 1, tail && index === length - 1));
    }

    return { command: "ARRAY", messages };
  } // end method readMessageArray

  private readErrorMessage(depth: number): ServerMessage {
    const fieldStartOffset = this.offset - 1;

    if (
      this.readText(
        this.readLine("error", fieldStartOffset, 3),
        "error",
        fieldStartOffset,
      ) !== "Err"
    ) {
      throw new ProtocolError(
        "Invalid error header.",
        "error",
        fieldStartOffset,
      );
    }

    // Every field is self-delimiting, so an error may sit anywhere in a batch.
    return {
      command: "ERROR",
      type: this.readErrorType(),
      subType: this.readErrorSubType(),
      message: this.readPayload("errorMessage"),
      resource: this.readResource(depth),
    };
  } // end method readErrorMessage

  private readErrorType(): string {
    const fieldStartOffset = this.offset;

    if (this.readMarker("errorType") !== "+".charCodeAt(0)) {
      throw new ProtocolError(
        "Expected simple string marker.",
        "errorType",
        fieldStartOffset,
      );
    }

    return this.readErrorName("errorType", fieldStartOffset);
  } // end method readErrorType

  private readErrorSubType(): string | null {
    const fieldStartOffset = this.offset;

    switch (this.readMarker("errorSubType")) {
      case "+".charCodeAt(0):
        return this.readErrorName("errorSubType", fieldStartOffset);
      case "$".charCodeAt(0):
        if (this.readDecimal("errorSubType", fieldStartOffset) === -1n) {
          return null;
        }

        throw new ProtocolError(
          "Sub type must be a simple string or null.",
          "errorSubType",
          fieldStartOffset,
        );
      default:
        throw new ProtocolError(
          "Sub type must be a simple string or null.",
          "errorSubType",
          fieldStartOffset,
        );
    }
  } // end method readErrorSubType

  // Error types and sub types are names such as PermissionDeniedError and
  // PRES_LIST: bounded, and restricted to letters, digits and underscores.
  private readErrorName(field: string, fieldStartOffset: number): string {
    const name = this.readText(
      this.readLine(field, fieldStartOffset, MAXIMUM_ERROR_NAME_BYTES),
      field,
      fieldStartOffset,
    );

    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      throw new ProtocolError("Invalid error name.", field, fieldStartOffset);
    }

    return name;
  } // end method readErrorName

  // Any single fragment the error's type and sub type define: null, a string,
  // an Integer64 (bigint), an Integer32 (number), or an array of these.
  private readResource(depth: number): ServerErrorResource {
    const fieldStartOffset = this.offset;

    switch (this.readMarker("resource")) {
      case "+".charCodeAt(0):
        return this.readText(
          this.readLine("resource", fieldStartOffset),
          "resource",
          fieldStartOffset,
        );
      case "$".charCodeAt(0): {
        const bytes = this.readBulkBytes("resource", fieldStartOffset);

        return bytes === null
          ? null
          : this.readText(bytes, "resource", fieldStartOffset);
      }
      case ":".charCodeAt(0):
        return this.readDecimal("resource", fieldStartOffset);
      case ";".charCodeAt(0):
        return this.readInteger32Digits("resource", fieldStartOffset);
      case "*".charCodeAt(0): {
        const length = this.readArrayLength(depth + 1, "resource", true);
        const items: ServerErrorResource[] = [];

        for (let index = 0; index < length; index += 1) {
          items.push(this.readResource(depth + 1));
        }

        return items;
      }
      default:
        throw new ProtocolError(
          "Unexpected resource marker.",
          "resource",
          fieldStartOffset,
        );
    }
  } // end method readResource

  private readCommandMessage(depth: number, tail: boolean): ServerMessage {
    const fieldStartOffset = this.offset - 1;
    const command = this.readText(
      this.readLine("command", fieldStartOffset, MAXIMUM_COMMAND_NAME_BYTES),
      "command",
      fieldStartOffset,
    );

    switch (command) {
      case "MSG":
        return this.readPeerMessage();
      case "SERVER_MSG":
        return this.readServerNotice();
      case "PRES_NOTIFY":
        return this.readPresenceNotification();
      case "PRES_LIST_RESPONSE":
        return this.readPresenceResponse(depth);
      default:
        return this.skipUnknownCommand(depth, tail, fieldStartOffset);
    }
  } // end method readCommandMessage

  private skipUnknownCommand(
    depth: number,
    tail: boolean,
    fieldStartOffset: number,
  ): ServerMessage {
    // A command this version does not know carries an unknown number of
    // fields, so its end is only knowable when it runs to the end of the
    // transport message. Newer servers may add commands; skipping them keeps this client
    // working instead of killing its connection (DECODE-01).
    if (depth !== 0 && !tail) {
      throw new ProtocolError(
        "Unknown command inside array has ambiguous boundaries.",
        "command",
        fieldStartOffset,
      );
    }

    this.offset = this.bytes.length;

    return { command: "IGNORED" };
  } // end method skipUnknownCommand

  private readPeerMessage(): ServerMessage {
    return {
      command: "MSG",
      tokenReference: this.readIdentifier("tokenReference"),
      segmentId: this.readIdentifier("segmentId"),
      messageId: this.readNullableIdentifier("messageId"),
      timestamp: this.readInteger64("timestamp"),
      payload: this.readPayload(),
    };
  } // end method readPeerMessage

  private readServerNotice(): ServerMessage {
    return {
      command: "SERVER_MSG",
      timestamp: this.readInteger64("timestamp"),
      payload: this.readPayload(),
    };
  } // end method readServerNotice

  private readPresenceNotification(): ServerMessage {
    const segmentId = this.readIdentifier("segmentId");
    const tokenReference = this.readIdentifier("tokenReference");
    const connectionId = this.readIdentifier("connectionId");
    const eventOffset = this.offset;
    const event = this.readInteger32("event");

    // A join/leave flag, not metadata: narrowed here rather than passed
    // through raw, and any other value is not a flag this client knows.
    if (event !== 0 && event !== 1) {
      throw new ProtocolError(
        "Presence event must be 0 or 1.",
        "event",
        eventOffset,
      );
    }

    return {
      command: "PRES_NOTIFY",
      segmentId,
      tokenReference,
      connectionId,
      joined: event === 1,
      timestamp: this.readInteger64("timestamp"),
    };
  } // end method readPresenceNotification

  private readPresenceResponse(depth: number): ServerMessage {
    return {
      command: "PRES_LIST_RESPONSE",
      segmentId: this.readIdentifier("segmentId"),
      requestId: this.readIdentifier("requestId"),
      total: this.readInteger32("total"),
      perPage: this.readInteger32("perPage"),
      currentPage: this.readInteger32("currentPage"),
      from: this.readInteger32("from"),
      to: this.readInteger32("to"),
      connections: this.readConnections(depth),
    };
  } // end method readPresenceResponse
} // end class MessageDecoder

// Test seam: production decodes through the connection's message callback
// (which applies the same byte bound); the codec suites and fixtures use
// this wrapper. It is deliberately not part of the package entrypoint.
export function decodeServerMessage(bytes: Uint8Array): ServerMessage {
  if (!(bytes instanceof Uint8Array)) {
    throw new ProtocolError("Expected byte buffer.", "message", 0);
  }

  return new MessageDecoder(bytes).decode();
} // end function decodeServerMessage

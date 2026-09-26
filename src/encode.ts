import type { z } from "zod";
import { clientCommandSchema, type ClientCommand } from "./commands";
import { ConfigurationError } from "./errors";
import { MAXIMUM_COMMAND_BYTES, TEXT_ENCODER } from "./constants";

type ValidatedClientCommand = z.output<typeof clientCommandSchema>;

export function encodeClientCommand(command: ClientCommand): Uint8Array {
  const parsedCommand = clientCommandSchema.safeParse(command);

  if (!parsedCommand.success) {
    throw new ConfigurationError();
  }

  return new CommandEncoder().encode(parsedCommand.data);
}

class CommandEncoder {
  private readonly parts: Uint8Array[] = [];
  private byteLength = 0;

  encode(command: ValidatedClientCommand): Uint8Array {
    switch (command.command) {
      case "PUB":
        this.writePublishCommand(command);
        break;
      case "PRES_LIST":
        this.writePresenceListCommand(command);
        break;
      case "SUB":
      case "UNSUB":
      case "PRES_SUB":
      case "PRES_UNSUB":
        this.writeSegmentCommand(command);
        break;
      default: {
        throw new ConfigurationError();
      }
    }

    return this.assembleCommand();
  }

  private writePublishCommand(
    command: Extract<ValidatedClientCommand, { command: "PUB" }>,
  ): void {
    this.appendText("@PUB\n");
    this.appendBulk(command.segmentId);
    if (command.messageId === undefined) {
      this.appendText("$-1\n");
    } else {
      this.appendBulk(command.messageId);
    }

    this.appendBulk(command.payload);
  }

  private writePresenceListCommand(
    command: Extract<ValidatedClientCommand, { command: "PRES_LIST" }>,
  ): void {
    this.appendText("@PRES_LIST\n");
    this.appendBulk(command.segmentId);
    this.appendText(`;${command.page}\n;${command.perPage}\n`);
    this.appendBulk(command.requestId);
  }

  private writeSegmentCommand(
    command: Extract<
      ValidatedClientCommand,
      { command: "SUB" | "UNSUB" | "PRES_SUB" | "PRES_UNSUB" }
    >,
  ): void {
    this.appendText(`@${command.command}\n`);
    this.appendBulk(command.segmentId);
  }

  private append(bytes: Uint8Array): void {
    this.byteLength += bytes.byteLength;
    if (this.byteLength > MAXIMUM_COMMAND_BYTES) {
      throw new ConfigurationError("Encoded command exceeds 2 MiB.");
    }

    this.parts.push(bytes);
  }

  private appendText(text: string): void {
    // UTF-8 cannot be shorter than the UTF-16 code-unit count.
    if (text.length > MAXIMUM_COMMAND_BYTES) {
      throw new ConfigurationError("Encoded command exceeds 2 MiB.");
    }

    this.append(TEXT_ENCODER.encode(text));
  }

  private appendBulk(value: string | Uint8Array): void {
    if (value.length > MAXIMUM_COMMAND_BYTES) {
      throw new ConfigurationError("Encoded command exceeds 2 MiB.");
    }

    const bytes =
      typeof value === "string" ? TEXT_ENCODER.encode(value) : value;
    this.appendText(`$${bytes.byteLength}\n`);
    this.append(bytes);
    this.appendText("\n");
  }

  private assembleCommand(): Uint8Array {
    const encodedCommand = new Uint8Array(this.byteLength);
    let offset = 0;

    for (const part of this.parts) {
      encodedCommand.set(part, offset);
      offset += part.byteLength;
    }

    return encodedCommand;
  }
}

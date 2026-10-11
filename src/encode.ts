import type { z } from "zod";
import { clientCommandSchema, type ClientCommand } from "./commands";
import { ConfigurationError } from "./errors";
import { describeParseError } from "./parse-error";
import { MAXIMUM_COMMAND_BYTES, TEXT_ENCODER } from "./constants";

type ValidatedClientCommand = z.output<typeof clientCommandSchema>;

export function encodeClientCommand(command: ClientCommand): Uint8Array {
  const parsedCommand = clientCommandSchema.safeParse(command);

  if (!parsedCommand.success) {
    throw new ConfigurationError(
      describeParseError("command", parsedCommand.error),
    );
  }

  return new CommandEncoder().encode(parsedCommand.data);
} // end function encodeClientCommand

// One frame for the commands: a single command as it is, several in a `*N`
// array.
export function encodeBatch(commands: readonly Uint8Array[]): Uint8Array {
  if (commands.length === 1) return commands[0]!;

  const header = TEXT_ENCODER.encode(`*${commands.length}\n`);
  const frame = new Uint8Array(
    commands.reduce(
      (total, command) => total + command.byteLength,
      header.byteLength,
    ),
  );

  frame.set(header);

  let offset = header.byteLength;

  for (const command of commands) {
    frame.set(command, offset);
    offset += command.byteLength;
  }

  return frame;
} // end function encodeBatch

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
        throw new ConfigurationError(
          "Invalid command. Unsupported command type.",
        );
      }
    }

    return this.assembleCommand();
  } // end method encode

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
  } // end method writePublishCommand

  private writePresenceListCommand(
    command: Extract<ValidatedClientCommand, { command: "PRES_LIST" }>,
  ): void {
    this.appendText("@PRES_LIST\n");
    this.appendBulk(command.segmentId);
    this.appendText(`;${command.page}\n;${command.perPage}\n`);
    this.appendBulk(command.requestId);
  } // end method writePresenceListCommand

  private writeSegmentCommand(
    command: Extract<
      ValidatedClientCommand,
      { command: "SUB" | "UNSUB" | "PRES_SUB" | "PRES_UNSUB" }
    >,
  ): void {
    this.appendText(`@${command.command}\n`);
    this.appendBulk(command.segmentId);
  } // end method writeSegmentCommand

  private append(bytes: Uint8Array): void {
    this.byteLength += bytes.byteLength;
    if (this.byteLength > MAXIMUM_COMMAND_BYTES) {
      throw new ConfigurationError(
        "Encoded command exceeds 2 MiB. That is the most the server accepts on any plan; send a smaller payload.",
      );
    }

    this.parts.push(bytes);
  } // end method append

  private appendText(text: string): void {
    // UTF-8 cannot be shorter than the UTF-16 code-unit count.
    if (text.length > MAXIMUM_COMMAND_BYTES) {
      throw new ConfigurationError(
        "Encoded command exceeds 2 MiB. That is the most the server accepts on any plan; send a smaller payload.",
      );
    }

    this.append(TEXT_ENCODER.encode(text));
  } // end method appendText

  private appendBulk(value: string | Uint8Array): void {
    if (value.length > MAXIMUM_COMMAND_BYTES) {
      throw new ConfigurationError(
        "Encoded command exceeds 2 MiB. That is the most the server accepts on any plan; send a smaller payload.",
      );
    }

    const bytes =
      typeof value === "string" ? TEXT_ENCODER.encode(value) : value;
    this.appendText(`$${bytes.byteLength}\n`);
    this.append(bytes);
    this.appendText("\n");
  } // end method appendBulk

  private assembleCommand(): Uint8Array {
    const encodedCommand = new Uint8Array(this.byteLength);
    let offset = 0;

    for (const part of this.parts) {
      encodedCommand.set(part, offset);
      offset += part.byteLength;
    }

    return encodedCommand;
  } // end method assembleCommand
} // end class CommandEncoder

import { expectTypeOf, test } from "vitest";
import type { ClientCommand } from "../../src/commands";
import { decodeServerMessage } from "../../src/decode";
import { encodeClientCommand } from "../../src/encode";
import type { ServerMessage } from "../../src/messages";

test("codec contracts keep byte buffers and bigint values runtime-neutral", () => {
  expectTypeOf<
    ReturnType<typeof encodeClientCommand>
  >().toEqualTypeOf<Uint8Array>();
  expectTypeOf<
    ReturnType<typeof decodeServerMessage>
  >().toEqualTypeOf<ServerMessage>();
  expectTypeOf<
    Extract<ClientCommand, { command: "PUB" }>["payload"]
  >().toEqualTypeOf<Uint8Array>();
  expectTypeOf<
    Extract<ServerMessage, { command: "MSG" }>["timestamp"]
  >().toEqualTypeOf<bigint>();
});

// Compiled by tooling typecheck; never executed or exported by the package.
function verifyReadonlyOutput(message: ServerMessage): void {
  if (message.command === "ARRAY") {
    // @ts-expect-error Response collections cannot be extended through their type.
    message.messages.push(message);
  } else if (message.command === "MSG") {
    // @ts-expect-error Timestamp properties are readonly.
    message.timestamp = 0n;
  }
}
void verifyReadonlyOutput;

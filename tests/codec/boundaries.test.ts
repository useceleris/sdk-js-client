import { expect, it } from "vitest";
import { decodeServerMessage } from "../../src/decode";
import { utf8 } from "../fixtures/codec-vectors";

it.each(["\n", "\r\n"])(
  "accepts maximum-length numeric and error-name headers with %j",
  (newline) => {
    expect(
      decodeServerMessage(
        utf8(
          `@SERVER_MSG${newline}:00000000000000000001${newline}$0${newline}${newline}`,
        ),
      ),
    ).toHaveProperty("timestamp", 1n);
    expect(
      decodeServerMessage(
        utf8(`-Err${newline}${"A".repeat(64)}${newline}message`),
      ),
    ).toHaveProperty("name", "A".repeat(64));
  },
);

it.each([
  { header: "0".repeat(20), reason: "Unterminated line." },
  { header: "0".repeat(21), reason: "Unterminated line." },
  { header: "0".repeat(22), reason: "Line exceeds byte limit." },
  { header: "0".repeat(21) + "\n", reason: "Line exceeds byte limit." },
  { header: "0".repeat(21) + "\r\n", reason: "Line exceeds byte limit." },
])("preserves bounded-header failure %#", ({ header, reason }) => {
  expect(() => decodeServerMessage(utf8(`@SERVER_MSG\n:${header}`))).toThrow(
    expect.objectContaining({
      message: reason,
      field: "timestamp",
      offset: 12,
    }),
  );
});

it("copies binary payloads containing newline/marker bytes", () => {
  const payload = new Uint8Array(65536);
  const pattern = utf8("\n\r@$*:+-");
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = pattern[index % pattern.length]!;
  }
  const header = utf8("@SERVER_MSG\n:1\n$65536\n");
  const bytes = new Uint8Array(header.length + payload.length + 1);
  bytes.set(header);
  bytes.set(payload, header.length);
  bytes[bytes.length - 1] = "\n".charCodeAt(0);

  const message = decodeServerMessage(bytes);
  expect(message).toMatchObject({ command: "SERVER_MSG", payload });
  bytes.fill(0);
  expect(message).toHaveProperty("payload", payload);
});

it("rejects a long malformed header without searching the rest of the message", () => {
  const bytes = utf8("@SERVER_MSG\n:" + "0".repeat(65536) + "\n");
  expect(() => decodeServerMessage(bytes)).toThrow(
    expect.objectContaining({
      message: "Line exceeds byte limit.",
      field: "timestamp",
      offset: 12,
    }),
  );
});

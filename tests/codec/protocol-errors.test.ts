import { expect, it } from "vitest";
import { decodeServerMessage } from "../../src/decode";
import { ProtocolError } from "../../src/errors";
import { utf8 } from "../fixtures/codec-vectors";

it.each([
  { wire: "", message: "Missing field marker.", field: "message", offset: 0 },
  {
    wire: "?",
    message: "Unexpected server message marker.",
    field: "message",
    offset: 0,
  },
  {
    wire: "*0\n!",
    message: "Trailing data after server message.",
    field: "message",
    offset: 3,
  },
  {
    wire: "*2\n@UNKNOWN\n@SERVER_MSG\n:1\n$0\n\n",
    message: "Unknown command inside array has ambiguous boundaries.",
    field: "command",
    offset: 3,
  },
  {
    wire: "@SERVER_MSG\n:abc\n",
    message: "Invalid integer.",
    field: "timestamp",
    offset: 12,
  },
  {
    wire: "@SERVER_MSG\n:+1\n",
    message: "Expected decimal digits.",
    field: "timestamp",
    offset: 12,
  },
  {
    wire: "@SERVER_MSG\n:9223372036854775808\n",
    message: "Integer exceeds signed-64 range.",
    field: "timestamp",
    offset: 12,
  },
  {
    wire: "@SERVER_MSG\n:000000000000000000000\n",
    message: "Line exceeds byte limit.",
    field: "timestamp",
    offset: 12,
  },
  {
    wire: "@SERVER_MSG\n:1",
    message: "Unterminated line.",
    field: "timestamp",
    offset: 12,
  },
  {
    wire: "@SERVER_MSG\n+1\n",
    message: "Expected integer marker.",
    field: "timestamp",
    offset: 12,
  },
  {
    wire: "@SERVER_MSG\n:1\n$9\nx\n",
    message: "Bulk payload exceeds remaining message bytes.",
    field: "payload",
    offset: 15,
  },
  {
    wire: "@SERVER_MSG\n:1\n$1\nx!",
    message: "Missing bulk byte terminator.",
    field: "payload",
    offset: 15,
  },
  {
    wire: "@SERVER_MSG\n:1\n$-2\n",
    message: "Invalid bulk byte length.",
    field: "payload",
    offset: 15,
  },
  {
    wire: "@SERVER_MSG\n:1\n$-1\n",
    message: "Payload cannot be null.",
    field: "payload",
    offset: 15,
  },
  {
    wire: "@SERVER_MSG\n:1\n*0\n",
    message: "Expected simple or bulk byte marker.",
    field: "payload",
    offset: 15,
  },
  {
    wire: "@MSG\n+u\n+\n",
    message: "Identifier must be nonempty and CR/LF-free.",
    field: "segmentId",
    offset: 8,
  },
  {
    wire: "@MSG\n$-1\n",
    message: "Identifier cannot be null.",
    field: "tokenReference",
    offset: 5,
  },
  {
    wire: "*-1\n",
    message: "Array length cannot be negative.",
    field: "messages",
    offset: 0,
  },
  {
    wire: "*4096\n",
    message: "Array length exceeds fragment budget.",
    field: "messages",
    offset: 0,
  },
  {
    // A tail-position error is valid (C8, D-002); a non-final one is not.
    wire: "*2\n-Err\nParserError\nsecret\n@SERVER_MSG\n:1\n$0\n\n",
    message: "Error inside array has ambiguous boundaries.",
    field: "error",
    offset: 3,
  },
  {
    wire: "-Bad\n",
    message: "Invalid error header.",
    field: "error",
    offset: 0,
  },
  {
    wire: "-Err\nBad Name\nsecret",
    message: "Invalid error name.",
    field: "errorName",
    offset: 5,
  },
])("reports $field at byte $offset: $message", ({ wire, ...expected }) => {
  expect(() => decodeServerMessage(utf8(wire))).toThrow(
    expect.objectContaining({ code: "ProtocolError", ...expected }),
  );
});

it.each([
  "",
  " ",
  "0x10",
  "0o10",
  "0b10",
  "+1",
  "1 ",
  "\t1",
  "1\r\r",
  "--1",
  "1.5",
  "1e2",
])("rejects non-protocol numeric text %j", (text) => {
  expect(() =>
    decodeServerMessage(utf8(`@SERVER_MSG\n:${text}\n$0\n\n`)),
  ).toThrow(ProtocolError);
});

it.each(["0001", "-0", "-0001"])(
  "preserves accepted decimal spelling %s",
  (text) => {
    expect(
      decodeServerMessage(utf8(`@SERVER_MSG\n:${text}\n$0\n\n`)),
    ).toHaveProperty("timestamp", BigInt(text));
  },
);

it("reports the field start for invalid UTF-8 without retaining input", () => {
  const bytes = new Uint8Array([
    ...utf8("@MSG\n+"),
    255,
    ...utf8("synthetic-secret\n"),
  ]);
  let failure: unknown;
  try {
    decodeServerMessage(bytes);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: "ProtocolError",
    message: "Invalid UTF-8 text.",
    field: "tokenReference",
    offset: 5,
  });
  expect(failure).not.toHaveProperty("cause");
  expect(String(failure)).not.toContain("synthetic-secret");
  expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
});

it("reports message and array resource limits at their start", () => {
  expect(() => decodeServerMessage(new Uint8Array(1048577))).toThrow(
    expect.objectContaining({
      message: "Message exceeds byte limit.",
      field: "message",
      offset: 0,
    }),
  );
  expect(() => decodeServerMessage(utf8("*1\n".repeat(32) + "*0\n"))).toThrow(
    expect.objectContaining({
      message: "Array nesting limit exceeded.",
      field: "messages",
      offset: 96,
    }),
  );
});

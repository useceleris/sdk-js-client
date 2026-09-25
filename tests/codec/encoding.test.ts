import { describe, expect, it } from "vitest";
import { encodeClientCommand } from "../../src/encode";
import { ConfigurationError } from "../../src/errors";
import type { ClientCommand } from "../../src/commands";
import {
  encodingVectors,
  invalidIdentifierVectors,
  utf8,
} from "../fixtures/codec-vectors";

describe("command encoding", () => {
  it.each(encodingVectors)("$name", ({ command, expected }) => {
    expect(encodeClientCommand(command)).toEqual(expected);
  });

  it.each([
    undefined,
    null,
    {},
    { command: "NODE_PUB", segmentId: "s" },
    ...["", "a\n", "a\r", 1, null].map((segmentId) => ({
      command: "SUB",
      segmentId,
    })),
    { command: "PUB", segmentId: "s", payload: null },
    { command: "PUB", segmentId: "s", payload: [], messageId: "m" },
    { command: "PUB", segmentId: "s", payload: utf8("x"), messageId: "" },
    { command: "PUB", segmentId: "s", payload: utf8("x"), messageId: null },
  ])("rejects invalid command %#", (command) => {
    expect(() => encodeClientCommand(command as ClientCommand)).toThrow(
      ConfigurationError,
    );
  });

  it.each([0, -1, 2147483648, 1.5, NaN, Infinity, 1n, "1", null, undefined])(
    "rejects page %s",
    (page) => {
      expect(() =>
        encodeClientCommand({
          command: "PRES_LIST",
          segmentId: "s",
          page,
          perPage: 1,
        } as ClientCommand),
      ).toThrow(ConfigurationError);
    },
  );

  it.each([0, -1, 101, 1.5, NaN, Infinity, 1n, "1", null, undefined])(
    "rejects perPage %s",
    (perPage) => {
      expect(() =>
        encodeClientCommand({
          command: "PRES_LIST",
          segmentId: "s",
          page: 1,
          perPage,
        } as ClientCommand),
      ).toThrow(ConfigurationError);
    },
  );

  it("copies bytes, strips extras, and leaves inputs untouched", () => {
    const command = {
      command: "PUB" as const,
      segmentId: "s",
      payload: utf8("x"),
      extra: "ignored",
    };
    const original = { ...command, payload: new Uint8Array(command.payload) };
    const result = encodeClientCommand(command);
    expect(command).toEqual(original);
    command.payload[0] = 0;
    command.segmentId = "changed";
    expect(result).toEqual(utf8("@PUB\n$1\ns\n$-1\n$1\nx\n"));
  });

  it("counts complete encoded overhead at the exact limit", () => {
    // 2 MiB is the whole encoded command, not the payload: "@PUB\n",
    // "$1\ns\n", "$-1\n", "$2097128\n" and the closing LF are 24 bytes.
    const limit = 2 * 1024 * 1024;
    const command = {
      command: "PUB" as const,
      segmentId: "s",
      payload: new Uint8Array(limit - 24),
    };

    expect(encodeClientCommand(command)).toHaveLength(limit);
    expect(() =>
      encodeClientCommand({ ...command, payload: new Uint8Array(limit - 23) }),
    ).toThrow(ConfigurationError);

    // Characters at the limit, but each one is two UTF-8 bytes.
    expect(() =>
      encodeClientCommand({ command: "SUB", segmentId: "é".repeat(limit) }),
    ).toThrow(ConfigurationError);
  });

  it("returns a safe fixed error", () => {
    let failure: unknown;
    try {
      encodeClientCommand({
        command: "SECRET",
        segmentId: "synthetic-secret",
      } as unknown as ClientCommand);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(failure).toMatchObject({
      code: "Configuration",
      message: "Invalid client command.",
    });
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
  });
});

describe("identifier encoding isolation", () => {
  it.each(invalidIdentifierVectors)(
    "rejects ill-formed identifier %#",
    (identifier) => {
      const commands: ClientCommand[] = [
        { command: "SUB", segmentId: identifier },
        { command: "UNSUB", segmentId: identifier },
        { command: "PRES_SUB", segmentId: identifier },
        { command: "PRES_UNSUB", segmentId: identifier },
        { command: "PRES_LIST", segmentId: identifier, page: 1, perPage: 1 },
        { command: "PUB", segmentId: identifier, payload: new Uint8Array() },
        {
          command: "PUB",
          segmentId: "s",
          messageId: identifier,
          payload: new Uint8Array(),
        },
      ];
      for (const command of commands) {
        expect(() => encodeClientCommand(command)).toThrow(ConfigurationError);
      }
    },
  );

  it("encodes only the supplied payload view", () => {
    const storage = new Uint8Array([99, 0, 255, 99]);
    const encoded = encodeClientCommand({
      command: "PUB",
      segmentId: "s",
      payload: storage.subarray(1, 3),
    });
    storage.fill(42);
    expect(encoded).toEqual(
      new Uint8Array([...utf8("@PUB\n$1\ns\n$-1\n$2\n"), 0, 255, 10]),
    );
  });
});

it("isolates valid encoding from a previous oversized command", () => {
  expect(() =>
    encodeClientCommand({
      command: "PUB",
      segmentId: "s",
      payload: new Uint8Array(2 * 1024 * 1024 - 23),
    }),
  ).toThrow("Encoded command exceeds 2 MiB.");

  expect(encodeClientCommand({ command: "SUB", segmentId: "chat" })).toEqual(
    utf8("@SUB\n$4\nchat\n"),
  );
});

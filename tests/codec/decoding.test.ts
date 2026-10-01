import { describe, expect, it } from "vitest";
import { decodeServerMessage } from "../../src/decode";
import { ProtocolError } from "../../src/errors";
import {
  decodingVectors,
  malformedVectors,
  utf8,
} from "../fixtures/codec-vectors";

describe("server decoding", () => {
  it.each(decodingVectors)("$name", ({ bytes, expected }) => {
    expect(decodeServerMessage(bytes)).toEqual(expected);
  });
  it.each(malformedVectors)("rejects malformed message %#", (bytes) => {
    expect(() => decodeServerMessage(bytes)).toThrow(ProtocolError);
  });
  it("rejects every truncation of a fixed peer message", () => {
    const bytes = decodingVectors[0]!.bytes;
    for (let length = 0; length < bytes.length; length += 1) {
      expect(() => decodeServerMessage(bytes.subarray(0, length))).toThrow(
        ProtocolError,
      );
    }
  });
  it("bounds nesting and counts fields as fragments", () => {
    expect(
      decodeServerMessage(utf8("*1\n".repeat(31) + "*0\n")),
    ).toHaveProperty("command", "ARRAY");
    expect(() => decodeServerMessage(utf8("*1\n".repeat(32) + "*0\n"))).toThrow(
      ProtocolError,
    );
    expect(
      decodeServerMessage(utf8("*4095\n" + "*0\n".repeat(4095))),
    ).toHaveProperty("command", "ARRAY");
    expect(() =>
      decodeServerMessage(
        utf8("*1366\n" + "@SERVER_MSG\n:1\n$0\n\n".repeat(1366)),
      ),
    ).toThrow(ProtocolError);
  });
  it("decodes messages larger than 1 MiB (LIMIT-01)", () => {
    // A prime-plan delivery: a full 1024 KiB payload plus its framing.
    const payloadLength = 1024 * 1024;
    const header = utf8(`@MSG\n+user\n+chat\n+msg_1\n:1\n$${payloadLength}\n`);
    const bytes = new Uint8Array(header.length + payloadLength + 1);

    bytes.set(header);
    bytes[bytes.length - 1] = "\n".charCodeAt(0);

    const message = decodeServerMessage(bytes);

    expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
    expect(message).toMatchObject({ command: "MSG", segmentId: "chat" });
  });
  it("owns payload copies independently of inputs and siblings", () => {
    const bytes = utf8("*2\n@SERVER_MSG\n:1\n$1\nx\n@SERVER_MSG\n:1\n$1\nx\n");
    const original = new Uint8Array(bytes);
    const result = decodeServerMessage(bytes);
    expect(bytes).toEqual(original);
    bytes.fill(0);
    if (result.command !== "ARRAY") {
      throw new Error("Expected array");
    }
    const first = result.messages[0]!;
    const second = result.messages[1]!;
    if (first.command !== "SERVER_MSG" || second.command !== "SERVER_MSG") {
      throw new Error("Expected notices");
    }
    expect(first.payload).toEqual(utf8("x"));
    first.payload[0] = 0;
    expect(second.payload).toEqual(utf8("x"));
  });
  it("rejects non-byte input with a safe error", () => {
    expect(() => decodeServerMessage(null as unknown as Uint8Array)).toThrow(
      ProtocolError,
    );
    let failure: unknown;
    try {
      decodeServerMessage(utf8("synthetic-secret"));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "ProtocolError",
      message:
        "Unexpected server message marker. Field: message, byte offset 0.",
      field: "message",
      offset: 0,
    });
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
  });
  it("handles bounded deterministic mutated inputs without native exceptions", () => {
    let seed = 0xce1e;
    for (let attempt = 0; attempt < 512; attempt += 1) {
      const bytes = new Uint8Array(
        decodingVectors[attempt % decodingVectors.length]!.bytes,
      );
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      bytes[seed % bytes.length] = seed & 255;
      try {
        decodeServerMessage(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
      }
    }
  });
});

it("decodes only the supplied frame view and owns returned bytes", () => {
  const frame = utf8("@SERVER_MSG\n:1\n$1\nx\n");
  const storage = new Uint8Array([255, ...frame, 255]);
  const result = decodeServerMessage(storage.subarray(1, storage.length - 1));
  storage.fill(0);
  expect(result).toEqual({
    command: "SERVER_MSG",
    timestamp: 1n,
    payload: utf8("x"),
  });
});

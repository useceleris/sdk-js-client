import { describe, expect, it } from "vitest";
import {
  createPayloadCodec,
  jsonPayload,
  readJson,
  readText,
  textPayload,
} from "../../src/payload";
import { ConfigurationError } from "../../src/errors";

const utf8 = (value: string) => new TextEncoder().encode(value);

describe("text payloads", () => {
  it.each(["", "hello", "héllo 안녕 🛰️"])(
    "round-trips %j byte-identically",
    (value) => {
      const payload = textPayload(value);
      expect(Array.from(payload)).toEqual(Array.from(utf8(value)));
      expect(readText(payload)).toBe(value);
    },
  );

  it("rejects payloads that are not valid UTF-8", () => {
    // A lone continuation byte cannot start a sequence.
    expect(() => readText(new Uint8Array([0x80]))).toThrow(
      expect.objectContaining({
        code: "Configuration",
        message: "Payload is not valid UTF-8.",
      }),
    );
  });
});

describe("json payloads", () => {
  it("round-trips values through the wire encoding", () => {
    const value = { id: 7, text: "héllo", nested: { ok: true }, list: [1, 2] };
    const payload = jsonPayload(value);

    expect(readText(payload)).toBe(JSON.stringify(value));
    expect(readJson<typeof value>(payload)).toEqual(value);
  });

  it.each([
    ["undefined", undefined],
    ["a function", () => undefined],
    ["a bigint", 1n],
  ])("rejects %s as not serializable", (_label, value) => {
    expect(() => jsonPayload(value)).toThrow(
      expect.objectContaining({
        code: "Configuration",
        message: "Value is not JSON-serializable.",
      }),
    );
  });

  it("rejects circular structures without leaking the input", () => {
    const circular: Record<string, unknown> = { secret: "synthetic-marker" };
    circular.self = circular;

    let error: unknown;
    try {
      jsonPayload(circular);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).cause).toBeUndefined();
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error as object)),
    ).not.toContain("synthetic-marker");
  });

  it("rejects payloads that are not valid JSON", () => {
    expect(() => readJson(utf8("{ not json"))).toThrow(
      expect.objectContaining({
        code: "Configuration",
        message: "Payload is not valid JSON.",
      }),
    );
  });
});

describe("payload codecs", () => {
  const codec = createPayloadCodec<{ body: string }>({
    encode: (value) => utf8(value.body),
    decode: (bytes) => ({ body: new TextDecoder().decode(bytes) }),
  });

  it("round-trips through the supplied encoder", () => {
    const payload = codec.encodePayload({ body: "hello" });

    expect(Array.from(payload)).toEqual(Array.from(utf8("hello")));
    expect(codec.readPayload(payload)).toEqual({ body: "hello" });
  });

  it("propagates the caller's own failures unchanged", () => {
    const failure = new Error("synthetic-decoder-failure");
    const failing = createPayloadCodec<string>({
      encode: () => new Uint8Array(),
      decode: () => {
        throw failure;
      },
    });

    expect(() => failing.readPayload(new Uint8Array())).toThrow(failure);
  });

  it.each([
    ["an empty object", {}],
    ["a missing decode", { encode: () => new Uint8Array() }],
    ["a non-function encode", { encode: 1, decode: () => undefined }],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(() =>
      createPayloadCodec(
        value as unknown as Parameters<typeof createPayloadCodec>[0],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "Configuration",
        message: "Codec must provide encode and decode functions.",
      }),
    );
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_LANGUAGE, SDK_VERSION } from "../../src/constants";
import { encodeClientCommand } from "../../src/encode";
import { generateMessageId, messageIdPrefix } from "../../src/message-id";

const packageVersion = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

describe("generated message ids (RESEND-01)", () => {
  it("name the SDK and its version, then 32 lowercase hex digits", () => {
    const identifier = generateMessageId();
    const prefix = messageIdPrefix("js", SDK_VERSION);

    expect(identifier.startsWith(prefix)).toBe(true);
    expect(identifier.slice(prefix.length)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("hold only letters, digits, dots and underscores", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generateMessageId()).toMatch(/^[A-Za-z0-9._]+$/);
    }
  });

  it("are different on every call", () => {
    const identifiers = new Set(
      Array.from({ length: 1_000 }, () => generateMessageId()),
    );

    expect(identifiers.size).toBe(1_000);
  });

  it("use the version that package.json declares", () => {
    expect(SDK_LANGUAGE).toBe("js");
    expect(SDK_VERSION).toBe(packageVersion);
  });

  it("turn every other character of the version into an underscore", () => {
    expect(messageIdPrefix("js", "1.2.0-beta.1")).toBe(
      "msg__js_v1.2.0_beta.1__",
    );

    expect(messageIdPrefix("js", "1.2.0+build/7")).toBe(
      "msg__js_v1.2.0_build_7__",
    );

    expect(messageIdPrefix("js", "1.1.0")).toBe("msg__js_v1.1.0__");
  });

  // Client commands write identifiers as bulk strings: "$", the length, LF,
  // the bytes, LF. The server reads them without a scan for the end.
  it("are sent as bulk strings", () => {
    const identifier = generateMessageId();

    const frame = encodeClientCommand({
      command: "PUB",
      segmentId: "chat",
      messageId: identifier,
      payload: new TextEncoder().encode("hi"),
    });

    expect(new TextDecoder().decode(frame)).toBe(
      `@PUB\n$4\nchat\n$${identifier.length}\n${identifier}\n$2\nhi\n`,
    );
  });
});

import { expect, it } from "vitest";
import { validateBaseUrl, createCredentialUrl } from "../../src/connection-url";
import { connectionConfigurationSchema } from "../../src/credentials";

it.each([
  "ws://example.test",
  "https://example.test",
  "wss://user:pass@example.test",
  "wss://example.test?",
  "wss://example.test#",
  "not a url",
])("rejects unsafe URL %s", (url) => {
  expect(() => validateBaseUrl(url, true)).toThrow("Invalid connection URL.");
});

it.each(["localhost", "127.0.0.1", "127.1.2.3", "[::1]"])(
  "requires explicit opt-in for %s",
  (host) => {
    expect(() => validateBaseUrl(`ws://${host}`, false)).toThrow();
    expect(validateBaseUrl(`ws://${host}`, true).protocol).toBe("ws:");
  },
);

it.each(["localhost.evil.test", "128.0.0.1", "0.0.0.0", "[::]"])(
  "rejects non-loopback %s",
  (host) => {
    expect(() => validateBaseUrl(`ws://${host}`, true)).toThrow();
  },
);

it.each(["", "x:y", "a\n", "é", "x".repeat(256)])(
  "rejects invalid channel %#",
  (channelReference) => {
    expect(
      connectionConfigurationSchema.safeParse({
        baseUrl: "wss://example.test",
        channelReference,
      }).success,
    ).toBe(false);
  },
);

it.each([
  "wss://example.test",
  "wss://example.test/",
  "wss://example.test/prefix///",
])("preserves path and opaque query values %s", (base) => {
  const original = validateBaseUrl(base, false);
  const result = new URL(
    createCredentialUrl(original, "a".repeat(255), {
      payload: "+/%=&識",
      signature: "%2B",
    }),
  );
  expect(result.pathname).toBe(
    `${original.pathname.replace(/\/+$/, "")}/channel/${"a".repeat(255)}`,
  );
  expect(result.searchParams.get("payload")).toBe("+/%=&識");
  expect(result.searchParams.get("signature")).toBe("%2B");
  expect(original.search).toBe("");
});

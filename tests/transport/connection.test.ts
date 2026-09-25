import { describe, expect, it, vi } from "vitest";
import { openConnection } from "../../src/connection";
import type {
  CredentialProvider,
  CredentialRequest,
} from "../../src/credential-types";
import { ConfigurationError, ProtocolError } from "../../src/errors";
import { utf8 } from "../fixtures/codec-vectors";
import { sockets, useTestWebSockets } from "../helpers/websocket";

const credentials = { payload: "a+/=&%識", signature: "sig+/=" };
const configuration = {
  baseUrl: "wss://example.test/prefix/",
  channelReference: "room-1",
};

function setup() {
  const credentialProvider = vi.fn<CredentialProvider>(async () => credentials);
  const onMessage = vi.fn();
  const onClose = vi.fn();
  const onError = vi.fn();
  return { credentialProvider, onMessage, onClose, onError };
}

async function flushCredentials(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

useTestWebSockets();

describe("connection attempt", () => {
  it("awaits open and passes fresh initial credentials", async () => {
    const options = setup();
    let resolved = false;
    const pending = openConnection(configuration, options).then((handle) => {
      resolved = true;
      return handle;
    });

    await flushCredentials();
    expect(resolved).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.binaryType).toBe("arraybuffer");
    expect(options.credentialProvider).toHaveBeenCalledWith({
      channelReference: "room-1",
      reason: "initial",
      signal: expect.any(AbortSignal),
    });

    const url = new URL(sockets[0]!.url);
    expect(url.pathname).toBe("/prefix/channel/room-1");
    expect(url.searchParams.get("payload")).toBe(credentials.payload);
    expect(url.searchParams.get("signature")).toBe(credentials.signature);

    sockets[0]!.open();
    await pending;
    expect(resolved).toBe(true);

    const second = openConnection(configuration, options);
    await flushCredentials();
    sockets[1]!.open();
    await second;
    expect(options.credentialProvider).toHaveBeenCalledTimes(2);
  });

  it("passes complete reconnect context", async () => {
    const options = setup();
    const recovery = {
      reason: "reconnect" as const,
      disconnectedAt: 1_000,
      replayLookbackMs: 9_500,
    };
    const pending = openConnection({ ...configuration, recovery }, options);
    await flushCredentials();
    sockets[0]!.open();
    await pending;
    expect(options.credentialProvider).toHaveBeenCalledWith({
      channelReference: "room-1",
      ...recovery,
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    null,
    {},
    { payload: "", signature: "x" },
    { payload: "\ud800", signature: "x" },
  ])("rejects invalid credentials %#", async (value) => {
    const options = setup();
    options.credentialProvider.mockResolvedValue(value as typeof credentials);
    await expect(openConnection(configuration, options)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    expect(sockets).toHaveLength(0);
  });

  it.each([false, true])(
    "sanitizes provider failure (async=%s)",
    async (asynchronous) => {
      const options = setup();
      options.credentialProvider.mockImplementation(() => {
        const error = Object.assign(
          new ConfigurationError("synthetic-secret"),
          {
            cause: new Error("synthetic-cause"),
          },
        );
        if (asynchronous) return Promise.reject(error);
        throw error;
      });
      const error = await openConnection(configuration, options).catch(
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({
        code: "Transport",
        message: "Credential acquisition failed.",
      });
      expect(String(error)).not.toContain("synthetic-secret");
      expect(JSON.stringify(error)).not.toContain("synthetic");
      expect(error).not.toHaveProperty("cause");
    },
  );

  it("rejects unavailable WebSocket before requesting credentials", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const options = setup();
    await expect(openConnection(configuration, options)).rejects.toMatchObject({
      code: "Configuration",
    });
    expect(options.credentialProvider).not.toHaveBeenCalled();
  });

  it.each(["error", "close"])(
    "rejects %s before open and ignores later events",
    async (event) => {
      const options = setup();
      const pending = openConnection(configuration, options);
      await flushCredentials();
      if (event === "error") sockets[0]!.fail();
      else sockets[0]!.disconnect();
      await expect(pending).rejects.toMatchObject({ code: "Transport" });
      sockets[0]!.open();
    },
  );

  it("converts WebSocket construction failure safely", async () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("synthetic-secret");
        }
      },
    );
    const error = await openConnection(configuration, setup()).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: "Transport" });
    expect(String(error)).not.toContain("synthetic-secret");
  });

  it.each(["cancel", "timeout"])(
    "suppresses late credentials after %s",
    async (reason) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let request!: CredentialRequest;
      let resolveCredentials!: (value: typeof credentials) => void;
      const options = setup();
      options.credentialProvider.mockImplementation(
        (value: CredentialRequest) =>
          new Promise<typeof credentials>((resolve) => {
            request = value;
            resolveCredentials = resolve;
          }),
      );
      const pending = openConnection(configuration, {
        ...options,
        signal: controller.signal,
      });
      const expectedCode = reason === "cancel" ? "Cancelled" : "Timeout";
      const rejection = expect(pending).rejects.toMatchObject({
        code: expectedCode,
      });

      if (reason === "cancel") controller.abort("synthetic-secret");
      else await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      expect(request.signal.aborted).toBe(true);

      resolveCredentials(credentials);
      await flushCredentials();
      expect(sockets).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses one deadline for credentials and handshake", async () => {
    vi.useFakeTimers();
    const options = setup();
    options.credentialProvider.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(credentials), 10_000),
        ),
    );
    const pending = openConnection(configuration, options);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "Timeout",
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors a custom timeoutMs for the shared deadline", async () => {
    vi.useFakeTimers();
    const options = setup();
    options.credentialProvider.mockImplementation(
      () => new Promise(() => undefined),
    );
    const pending = openConnection(configuration, {
      ...options,
      timeoutMs: 5_000,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "Timeout",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pre-cancellation skips provider execution", async () => {
    const controller = new AbortController();
    controller.abort("synthetic-secret");
    const options = setup();
    await expect(
      openConnection(configuration, {
        ...options,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "Cancelled" });
    expect(options.credentialProvider).not.toHaveBeenCalled();
  });

  it("cancels during handshake and removes deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = openConnection(configuration, {
      ...setup(),
      signal: controller.signal,
    });
    await flushCredentials();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "Cancelled" });
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
    sockets[0]!.open();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("imports without creating WebSocket or timer", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    sockets.length = 0;
    await import("../../src/connection");
    expect(sockets).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("open connection", () => {
  async function connect(options = setup()) {
    const pending = openConnection(configuration, options);
    await flushCredentials();
    const socket = sockets.at(-1)!;
    socket.open();
    return { handle: await pending, options, socket };
  }

  it("decodes binary messages in arrival order", async () => {
    vi.useFakeTimers();
    const { options, socket } = await connect();
    expect(vi.getTimerCount()).toBe(0);
    socket.receive(utf8("@SERVER_MSG\n:1\n$1\na\n").buffer);
    socket.receive(utf8("@SERVER_MSG\n:2\n$1\nb\n").buffer);
    expect(options.onMessage.mock.calls).toEqual([
      [{ command: "SERVER_MSG", timestamp: 1n, payload: utf8("a") }],
      [{ command: "SERVER_MSG", timestamp: 2n, payload: utf8("b") }],
    ]);
  });

  it.each(["text", new Blob(), new Uint8Array([1])])(
    "drops unsupported message data without closing %#",
    async (data) => {
      const { options, socket } = await connect();
      socket.receive(data);
      expect(options.onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "ProtocolError", field: "message" }),
      );
      // DECODE-01: the frame is dropped, the connection is not.
      expect(socket.close).not.toHaveBeenCalled();
    },
  );

  it("keeps delivering messages after an undecodable frame", async () => {
    const { options, socket } = await connect();

    socket.receive(utf8("not a frame").buffer);
    socket.receive(utf8("@SERVER_MSG\n:1\n$2\nhi\n").buffer);

    expect(options.onError).toHaveBeenCalledTimes(1);
    expect(options.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: "SERVER_MSG" }),
    );
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("reports malformed binary messages", async () => {
    const options = setup();
    const { socket } = await connect(options);

    socket.receive(utf8("invalid").buffer);

    expect(options.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ProtocolError" }),
    );
  });

  it("delivers a received message of any size (LIMIT-01)", async () => {
    // The platform has already buffered it by now, so the SDK processes what
    // arrived rather than measuring and discarding it.
    const options = setup();
    const { socket } = await connect(options);
    const payloadLength = 1024 * 1024;
    const header = utf8(`@SERVER_MSG\n:1\n$${payloadLength}\n`);
    const bytes = new Uint8Array(header.length + payloadLength + 1);

    bytes.set(header);
    bytes[bytes.length - 1] = "\n".charCodeAt(0);
    socket.receive(bytes.buffer);

    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: "SERVER_MSG" }),
    );
  });

  it.each([
    new Error("synthetic-secret"),
    Object.assign(new ProtocolError("synthetic-secret", "synthetic-field", 9), {
      cause: new Error("synthetic-cause"),
    }),
  ])("contains message and error callback failures %#", async (failure) => {
    const options = setup();
    options.onMessage.mockImplementation(() => {
      throw failure;
    });
    options.onError.mockImplementation(() => {
      throw new Error("another-secret");
    });
    const { socket } = await connect(options);
    expect(() =>
      socket.receive(utf8("@SERVER_MSG\n:1\n$0\n\n").buffer),
    ).not.toThrow();
    expect(options.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "Transport",
        message: "Message callback failed.",
      }),
    );
    expect(socket.close).toHaveBeenCalledTimes(1);
    const error = options.onError.mock.calls[0]![0];
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("field");
    expect(JSON.stringify(error)).not.toContain("synthetic");
  });

  it("sends copied bytes within exact limits", async () => {
    const { handle, socket } = await connect();
    const storage = new Uint8Array([9, 1, 2, 9]);
    handle.send(storage.subarray(1, 3));
    storage.fill(0);
    expect(socket.send).toHaveBeenCalledWith(new Uint8Array([1, 2]));

    // The command bound is the server's 2 MiB transport ceiling, and the
    // buffer bound equals it, so a maximum command fits an empty buffer.
    handle.send(new Uint8Array(2 * 1024 * 1024));
    expect(() => handle.send(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow(
      "Invalid outgoing command.",
    );

    socket.bufferedAmount = 2 * 1024 * 1024 - 1;
    handle.send(new Uint8Array(1));
    expect(() => handle.send(new Uint8Array(2))).toThrow(
      "WebSocket buffer is full.",
    );
  });

  it("sanitizes invalid buffering and native send failures", async () => {
    const { handle, socket } = await connect();
    socket.bufferedAmount = Number.NaN;
    expect(() => handle.send(new Uint8Array())).toThrow(
      "Invalid WebSocket buffering state.",
    );
    socket.bufferedAmount = 0;
    socket.send.mockImplementation(() => {
      throw new Error("synthetic-secret");
    });
    let sendFailure: unknown;
    try {
      handle.send(new Uint8Array());
    } catch (error) {
      sendFailure = error;
    }
    expect(sendFailure).toMatchObject({
      code: "DeliveryUnknown",
      message: "WebSocket send failed.",
    });
  });

  it("closes once and reports the native close after explicit close", async () => {
    const { handle, options, socket } = await connect();
    handle.close();
    handle.close();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(options.onClose).toHaveBeenCalledTimes(1);
    socket.disconnect();
    expect(options.onClose).toHaveBeenCalledTimes(1);
    expect(() => handle.send(new Uint8Array())).toThrow(
      "Connection is not open.",
    );
  });

  it("reports unexpected close once and contains callback failure", async () => {
    const options = setup();
    options.onClose.mockImplementation(() => {
      throw new Error("synthetic-secret");
    });
    const { handle, socket } = await connect(options);
    expect(() => socket.disconnect()).not.toThrow();
    expect(options.onClose).toHaveBeenCalledTimes(1);
    socket.disconnect();
    expect(options.onClose).toHaveBeenCalledTimes(1);
    expect(() => handle.send(new Uint8Array())).toThrow(
      "Connection is not open.",
    );
  });
});

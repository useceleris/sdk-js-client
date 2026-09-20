import { describe, expect, it, vi } from "vitest";
import { createClient, Client } from "../../src/client";
import { ConfigurationError } from "../../src/errors";
import {
  createTestChannel,
  flushMicrotasks,
  testCredentials,
} from "../helpers/channel";
import { sockets, useTestWebSockets } from "../helpers/websocket";

useTestWebSockets();

async function connectChannel(setup = createTestChannel()) {
  const pending = setup.channel.connect();
  await flushMicrotasks();
  sockets.at(-1)!.open();
  await pending;

  return setup;
}

describe("channel lifecycle", () => {
  it("moves idle to connecting to connected and resolves on open", async () => {
    const { channel } = createTestChannel();
    const states: string[] = [];
    channel.events().onStateChange((state) => states.push(state));

    expect(channel.state).toBe("idle");
    const pending = channel.connect();
    expect(channel.state).toBe("connecting");
    await flushMicrotasks();
    expect(channel.state).toBe("connecting");
    sockets[0]!.open();
    await pending;
    expect(channel.state).toBe("connected");
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("rejects concurrent connect with OperationInProgress", async () => {
    const { channel } = createTestChannel();
    const pending = channel.connect();
    await expect(channel.connect()).rejects.toMatchObject({
      code: "OperationInProgress",
    });
    await flushMicrotasks();
    sockets[0]!.open();
    await pending;
    await expect(channel.connect()).rejects.toMatchObject({
      code: "OperationInProgress",
    });
    expect(channel.state).toBe("connected");
  });

  it("rejects connect after close with NotConnected", async () => {
    const { channel } = createTestChannel();
    await channel.close();
    await expect(channel.connect()).rejects.toMatchObject({
      code: "NotConnected",
    });
    expect(channel.state).toBe("closed");
  });

  it("fails initial connect without dispatching onError", async () => {
    const { channel, credentialProvider } = createTestChannel();
    const errors: unknown[] = [];
    channel.events().onError((error) => errors.push(error));
    credentialProvider.mockRejectedValue(new Error("synthetic-secret"));

    await expect(channel.connect()).rejects.toMatchObject({
      code: "Transport",
    });
    expect(channel.state).toBe("failed");
    expect(errors).toEqual([]);
  });

  it("permits explicit restart from failed", async () => {
    const { channel, credentialProvider } = createTestChannel();
    credentialProvider.mockRejectedValueOnce(new Error("failure"));
    await expect(channel.connect()).rejects.toMatchObject({
      code: "Transport",
    });
    expect(channel.state).toBe("failed");

    const pending = channel.connect();
    await flushMicrotasks();
    sockets[0]!.open();
    await pending;
    expect(channel.state).toBe("connected");
  });

  it("maps caller cancellation to Cancelled and failed", async () => {
    const { channel, credentialProvider } = createTestChannel();
    let capturedSignal: AbortSignal | undefined;
    credentialProvider.mockImplementation(
      (request) =>
        new Promise(() => {
          capturedSignal = request.signal;
        }),
    );
    const controller = new AbortController();
    const pending = channel.connect({ signal: controller.signal });
    await flushMicrotasks();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "Cancelled" });
    expect(channel.state).toBe("failed");
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("honors connectTimeoutMs for the attempt deadline", async () => {
    vi.useFakeTimers();
    const { channel, credentialProvider } = createTestChannel({
      connectTimeoutMs: 5_000,
    });
    credentialProvider.mockImplementation(() => new Promise(() => undefined));
    const pending = channel.connect();
    const rejection = expect(pending).rejects.toMatchObject({
      code: "Timeout",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(channel.state).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes initial credential requests without outage fields", async () => {
    const { credentialProvider } = await connectChannel();
    expect(credentialProvider).toHaveBeenCalledWith({
      channelReference: "room-1",
      reason: "initial",
      signal: expect.any(AbortSignal),
    });
    expect(credentialProvider).toHaveBeenCalledTimes(1);
  });

  it("returns the same handler from events()", () => {
    const { channel } = createTestChannel();
    expect(channel.events()).toBe(channel.events());
  });

  it("dispatches state listeners in registration order with working disposal", () => {
    const { channel } = createTestChannel();
    const order: string[] = [];
    const disposeFirst = channel.events().onStateChange(() => {
      order.push("first");
    });
    channel.events().onStateChange(() => order.push("second"));

    void channel.connect().catch(() => undefined);
    expect(order).toEqual(["first", "second"]);

    disposeFirst();
    disposeFirst();
    void channel.close();
    expect(order).toEqual(["first", "second", "second", "second"]);
  });

  it("skips a listener disposed mid-dispatch and supports duplicate registration", () => {
    const { channel } = createTestChannel();
    const order: string[] = [];
    let disposeSecond: () => void = () => undefined;
    channel.events().onStateChange(() => {
      order.push("first");
      disposeSecond();
    });
    disposeSecond = channel.events().onStateChange(() => order.push("second"));
    const shared = (): number => order.push("shared");
    channel.events().onStateChange(shared);
    const disposeDuplicate = channel.events().onStateChange(shared);

    void channel.connect().catch(() => undefined);
    expect(order).toEqual(["first", "shared", "shared"]);

    disposeDuplicate();
    order.length = 0;
    void channel.close();
    expect(order).toEqual(["first", "shared", "first", "shared"]);
  });

  it("contains throwing listeners and reports once through onError", () => {
    const { channel } = createTestChannel();
    const errors: unknown[] = [];
    const order: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel.events().onError(() => {
      throw new Error("error-listener-secret");
    });
    channel.events().onStateChange(() => {
      throw new Error("listener-secret");
    });
    channel.events().onStateChange(() => order.push("after"));

    void channel.connect().catch(() => undefined);

    expect(order).toEqual(["after"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "Transport",
      message: "Listener callback failed.",
    });
    expect(JSON.stringify(errors[0])).not.toContain("secret");
    expect(channel.state).toBe("connecting");
    void channel.close();
  });

  it("creates a fresh channel per call and validates references eagerly", () => {
    const client = createClient({
      baseUrl: "wss://example.test",
      credentialProvider: async () => testCredentials,
    });
    expect(client.channel("room-1")).not.toBe(client.channel("room-1"));
    expect(() => client.channel("bad ref!")).toThrow(ConfigurationError);
    expect(() => client.channel("")).toThrow(ConfigurationError);
    expect(sockets).toHaveLength(0);
  });

  it("validates client options eagerly", () => {
    const credentialProvider = async () => testCredentials;
    expect(() => createClient({ baseUrl: "", credentialProvider })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      createClient({ baseUrl: "https://example.test", credentialProvider }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createClient({
        baseUrl: "wss://example.test",
        credentialProvider: undefined as never,
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createClient({
        baseUrl: "wss://example.test",
        credentialProvider,
        connectTimeoutMs: 0.5,
      }),
    ).toThrow(ConfigurationError);
    expect(
      createClient({ baseUrl: "wss://example.test", credentialProvider }),
    ).toBeInstanceOf(Client);
  });

  it("imports without creating WebSocket or timer", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    sockets.length = 0;
    await import("../../src/channel");
    await import("../../src/client");
    expect(sockets).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

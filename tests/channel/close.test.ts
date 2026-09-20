import { describe, expect, it, vi } from "vitest";
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

describe("channel close", () => {
  it("is idempotent and returns the same promise", async () => {
    const { channel } = createTestChannel();
    const states: string[] = [];
    channel.events().onStateChange((state) => states.push(state));

    const first = channel.close();
    const second = channel.close();
    expect(second).toBe(first);
    await first;
    expect(channel.state).toBe("closed");
    expect(states).toEqual(["closing", "closed"]);
    await channel.close();
  });

  it("closes a connected channel on the native close event", async () => {
    const { channel } = await connectChannel();
    vi.useFakeTimers();
    const states: string[] = [];
    channel.events().onStateChange((state) => states.push(state));

    await channel.close();
    expect(states).toEqual(["closing", "closed"]);
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the five-second budget when native close never arrives", async () => {
    const { channel } = await connectChannel();
    vi.useFakeTimers();
    sockets[0]!.close.mockImplementation(() => undefined);

    const pending = channel.close();
    expect(channel.state).toBe("closing");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(channel.state).toBe("closing");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(channel.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a pending attempt and suppresses late credentials", async () => {
    vi.useFakeTimers();
    const { channel, credentialProvider } = createTestChannel();
    let capturedSignal: AbortSignal | undefined;
    let resolveCredentials:
      ((value: typeof testCredentials) => void) | undefined;
    credentialProvider.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          capturedSignal = request.signal;
          resolveCredentials = resolve;
        }),
    );

    const pending = channel.connect();
    await flushMicrotasks();
    const rejection = expect(pending).rejects.toMatchObject({
      code: "Cancelled",
    });
    await channel.close();
    await rejection;
    expect(capturedSignal?.aborted).toBe(true);
    expect(channel.state).toBe("closed");

    resolveCredentials?.(testCredentials);
    await flushMicrotasks();
    expect(sockets).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the retry timer when closed while reconnecting", async () => {
    const { channel } = await connectChannel();
    vi.useFakeTimers();
    sockets[0]!.disconnect();
    expect(channel.state).toBe("reconnecting");
    expect(vi.getTimerCount()).toBe(1);

    await channel.close();
    expect(channel.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores stale socket events after close", async () => {
    const { channel } = await connectChannel();
    vi.useFakeTimers();
    const states: string[] = [];
    const errors: unknown[] = [];
    channel.events().onStateChange((state) => states.push(state));
    channel.events().onError((error) => errors.push(error));

    await channel.close();
    states.length = 0;

    sockets[0]!.open();
    sockets[0]!.fail();
    sockets[0]!.disconnect();
    sockets[0]!.receive("text");
    expect(states).toEqual([]);
    expect(errors).toEqual([]);
    expect(channel.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes from every non-terminal state", async () => {
    vi.useFakeTimers();
    const idle = createTestChannel();
    await idle.channel.close();
    expect(idle.channel.state).toBe("closed");

    const failed = createTestChannel();
    failed.credentialProvider.mockRejectedValueOnce(new Error("failure"));
    await expect(failed.channel.connect()).rejects.toMatchObject({
      code: "Transport",
    });
    await failed.channel.close();
    expect(failed.channel.state).toBe("closed");

    const connected = await connectChannel();
    await connected.channel.close();
    expect(connected.channel.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });
});

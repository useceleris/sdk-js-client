import { describe, expect, it, vi } from "vitest";
import { utf8 } from "../fixtures/codec-vectors";
import {
  createClientChannel,
  createTestChannel,
  flushMicrotasks,
  testCredentials,
} from "../helpers/channel";
import {
  sockets,
  TestWebSocket,
  useTestWebSockets,
} from "../helpers/websocket";

useTestWebSockets();

async function connectChannel(setup = createTestChannel()) {
  const pending = setup.channel.connect();
  await flushMicrotasks();
  sockets.at(-1)!.open();
  await pending;

  return setup;
} // end function connectChannel

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

  it("rejects a publish while closing and writes nothing", async () => {
    const { channel } = await connectChannel();
    vi.useFakeTimers();
    sockets[0]!.close.mockImplementation(() => undefined);

    const closing = channel.close();
    expect(channel.state).toBe("closing");
    await expect(
      channel.defaultSegment().publish({ payload: utf8("x") }),
    ).rejects.toMatchObject({
      code: "NotConnected",
      message: "Channel is not connected; it is closing.",
    });
    expect(sockets[0]!.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
  });

  it("rejects publishes still queued at close with Cancelled", async () => {
    const { channel } = await connectChannel();
    vi.useFakeTimers();
    sockets[0]!.bufferedAmount = 2 * 1024 * 1024; // the writer has no room

    const lobby = channel.defaultSegment();
    const queued = [
      lobby.publish({ payload: utf8("one") }),
      lobby.publish({ payload: utf8("two") }),
    ];
    await channel.close();

    for (const publish of queued) {
      await expect(publish).rejects.toMatchObject({
        code: "Cancelled",
        message: "Channel closed before the publish was sent.",
      });
    }

    expect(sockets[0]!.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer or open socket after 50 connect and close cycles", async () => {
    vi.useFakeTimers();

    for (let cycle = 0; cycle < 50; cycle += 1) {
      const { channel } = createClientChannel();
      const pending = channel.connect();
      await flushMicrotasks();

      // Alternate between closing a connected channel and closing mid-handshake.
      if (cycle % 2 === 0) {
        sockets.at(-1)!.open();
        await pending;
        await channel.close();
      } else {
        const cancelled = expect(pending).rejects.toMatchObject({
          code: "Cancelled",
        });
        await channel.close();
        await cancelled;
      }

      expect(channel.state).toBe("closed");
    }

    expect(sockets).toHaveLength(50);
    expect(
      sockets.every((socket) => socket.readyState === TestWebSocket.CLOSED),
    ).toBe(true);
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

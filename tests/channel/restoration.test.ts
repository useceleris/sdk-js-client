import { describe, expect, it, vi } from "vitest";
import { utf8 } from "../fixtures/codec-vectors";
import { createTestChannel, flushMicrotasks } from "../helpers/channel";
import { sockets, useTestWebSockets } from "../helpers/websocket";

useTestWebSockets();

async function establish(setup = createTestChannel()) {
  vi.useFakeTimers();
  const pending = setup.channel.connect();
  await flushMicrotasks();
  sockets.at(-1)!.open();
  await pending;

  return setup;
}

async function reconnect(): Promise<void> {
  sockets.at(-1)!.disconnect();
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks();
  sockets.at(-1)!.open();
  await flushMicrotasks();
}

function messageFrame(
  segmentId: string,
  messageId: string,
  body: string,
): ArrayBufferLike {
  return utf8(
    `@MSG\n$4\nuser\n$${utf8(segmentId).length}\n${segmentId}\n` +
      `$${utf8(messageId).length}\n${messageId}\n:1\n$${utf8(body).length}\n${body}\n`,
  ).buffer;
}

function framesOn(socket: (typeof sockets)[number]): string[] {
  return socket.send.mock.calls.map(([bytes]) =>
    new TextDecoder().decode(bytes as Uint8Array),
  );
}

describe("recovery restoration", () => {
  it("restores current intent in messages-then-presence registration order", async () => {
    const setup = await establish();
    setup.channel.segment("beta").subscribe();
    setup.channel.segment("alpha").subscribe();
    const cancelledMessages = setup.channel.segment("gone").subscribe();
    setup.channel.defaultSegment().subscribePresence();
    setup.channel.segment("alpha").subscribePresence();
    const cancelledPresence = setup.channel
      .segment("brief")
      .subscribePresence();

    await setup.channel.segment("beta").publish({ payload: utf8("x") });
    sockets.at(-1)!.disconnect();
    cancelledMessages.cancel();
    cancelledPresence.cancel();

    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    const reconnectSocket = sockets.at(-1)!;
    reconnectSocket.open();
    await flushMicrotasks();

    expect(setup.channel.state).toBe("connected");
    // Interests only, messages before presence, registration order,
    // cancelled intent excluded, no publish resend.
    expect(framesOn(reconnectSocket)).toEqual([
      "@SUB\n$4\nbeta\n",
      "@SUB\n$5\nalpha\n",
      "@PRES_SUB\n$7\ndefault\n",
      "@PRES_SUB\n$5\nalpha\n",
    ]);
  });

  it("sends restoration frames before the connected state and recovery event", async () => {
    const setup = await establish();
    setup.channel.segment("chat").subscribe();
    const log: string[] = [];
    setup.channel.events().onStateChange((state) => {
      log.push(
        `state:${state} frames:${sockets.at(-1)!.send.mock.calls.length}`,
      );
    });
    setup.channel.events().onRecovery((event) => {
      log.push(`recovery:${event.retryIndex}`);
    });

    await reconnect();

    expect(log).toEqual([
      // At "reconnecting" the latest socket is still the old one, carrying
      // only the original SUB; at "connected" the reconnect socket already
      // carries its restoration SUB — before the recovery event fires.
      "state:reconnecting frames:1",
      "state:connected frames:1",
      "recovery:0",
    ]);
  });

  it("keeps the default segment delivering without restoring it", async () => {
    const setup = await establish();
    const delivered: string[] = [];
    setup.channel.defaultSegment().subscribe();
    setup.channel.segment("chat").subscribe();
    setup.channel
      .defaultSegment()
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));

    await reconnect();
    const reconnectSocket = sockets.at(-1)!;

    // The server auto-joins "default" on the new connection, so restoring it
    // would be a redundant SUB; a named segment must be rejoined explicitly.
    expect(framesOn(reconnectSocket)).toEqual(["@SUB\n$4\nchat\n"]);

    // Membership is what matters: the listener still receives.
    reconnectSocket.receive(messageFrame("default", "id-1", "a"));

    expect(delivered).toEqual(["id-1"]);
  });

  it("absorbs replayed duplicates across reconnect while new ids flow", async () => {
    const setup = await establish();
    const delivered: string[] = [];
    setup.channel.segment("chat").subscribe();
    setup.channel
      .segment("chat")
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "a"));
    sockets.at(-1)!.receive(messageFrame("chat", "id-2", "b"));

    await reconnect();

    // Replay overlap redelivers old ids; the window absorbs them.
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "a"));
    sockets.at(-1)!.receive(messageFrame("chat", "id-2", "b"));
    sockets.at(-1)!.receive(messageFrame("chat", "id-3", "c"));

    expect(delivered).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("restores more than 64 subscriptions on reconnect as the writer drains", async () => {
    const setup = await establish();
    for (let index = 0; index < 65; index += 1) {
      setup.channel.segment(`segment-${index}`).subscribe();
    }
    const errors: unknown[] = [];
    setup.channel.events().onError((error) => errors.push(error));

    sockets.at(-1)!.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    const reconnectSocket = sockets.at(-1)!;
    reconnectSocket.send.mockImplementation(() => {
      reconnectSocket.bufferedAmount += 1;
    });
    reconnectSocket.open();
    await flushMicrotasks();

    expect(setup.channel.state).toBe("connected");
    expect(reconnectSocket.send).toHaveBeenCalledTimes(64);

    reconnectSocket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);

    expect(reconnectSocket.send).toHaveBeenCalledTimes(65);
    expect(errors).toEqual([]);
  });

  it("restores intent again on a second recovery without duplicates", async () => {
    const setup = await establish();
    setup.channel.segment("chat").subscribe();
    setup.channel.segment("chat").subscribePresence();

    await reconnect();
    const firstRecoverySocket = sockets.at(-1)!;
    await reconnect();
    const secondRecoverySocket = sockets.at(-1)!;

    const expected = ["@SUB\n$4\nchat\n", "@PRES_SUB\n$4\nchat\n"];
    expect(framesOn(firstRecoverySocket)).toEqual(expected);
    expect(framesOn(secondRecoverySocket)).toEqual(expected);
    expect(setup.channel.state).toBe("connected");
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../src/errors";
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

function presenceResponseFrame(options: {
  segmentId?: string;
  total?: number;
  perPage?: number;
  currentPage?: number;
  from?: number;
  to?: number;
  connections?: readonly [string, string, number][];
}): ArrayBufferLike {
  const {
    segmentId = "chat",
    total = 1,
    perPage = 25,
    currentPage = 1,
    from = 1,
    to = 1,
    connections = [["user", "connection-1", 123]],
  } = options;
  const entries = connections
    .map(
      ([tokenReference, connectionId, timestamp]) =>
        `*3\n+${tokenReference}\n+${connectionId}\n:${timestamp}\n`,
    )
    .join("");

  return utf8(
    `@PRES_LIST_RESPONSE\n+${segmentId}\n:${total}\n:${perPage}\n` +
      `:${currentPage}\n:${from}\n:${to}\n*${connections.length}\n${entries}`,
  ).buffer;
}

function sentFrames(): string[] {
  return sockets
    .at(-1)!
    .send.mock.calls.map(([bytes]) =>
      new TextDecoder().decode(bytes as Uint8Array),
    );
}

describe("presence interests", () => {
  it("shares one ref-count across instances and emits golden bytes", async () => {
    const { channel } = await establish();
    const first = channel.segment("chat").subscribePresence();
    const second = channel.segment("chat").subscribePresence();
    expect(sentFrames()).toEqual(["@PRES_SUB\n$4\nchat\n"]);

    first.cancel();
    first.cancel();
    expect(sentFrames()).toEqual(["@PRES_SUB\n$4\nchat\n"]);

    second.cancel();
    expect(sentFrames()).toEqual([
      "@PRES_SUB\n$4\nchat\n",
      "@PRES_UNSUB\n$4\nchat\n",
    ]);
  });

  it("sends presence commands for the default segment too", async () => {
    const { channel } = await establish();
    const watching = channel.segment().subscribePresence();
    watching.cancel();
    expect(sentFrames()).toEqual([
      "@PRES_SUB\n$7\ndefault\n",
      "@PRES_UNSUB\n$7\ndefault\n",
    ]);
  });

  it("suppresses message UNSUB while a presence interest is held", async () => {
    const { channel } = await establish();
    const messages = channel.segment("chat").subscribe();
    const presence = channel.segment("chat").subscribePresence();

    messages.cancel();
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n", "@PRES_SUB\n$4\nchat\n"]);

    presence.cancel();
    expect(sentFrames()).toEqual([
      "@SUB\n$4\nchat\n",
      "@PRES_SUB\n$4\nchat\n",
      "@PRES_UNSUB\n$4\nchat\n",
    ]);
  });

  it("sends UNSUB on message cancel once presence is released first", async () => {
    const { channel } = await establish();
    const messages = channel.segment("chat").subscribe();
    const presence = channel.segment("chat").subscribePresence();

    presence.cancel();
    messages.cancel();
    expect(sentFrames()).toEqual([
      "@SUB\n$4\nchat\n",
      "@PRES_SUB\n$4\nchat\n",
      "@PRES_UNSUB\n$4\nchat\n",
      "@UNSUB\n$4\nchat\n",
    ]);
  });

  it("flushes messages first then presence in registration order", async () => {
    const setup = createTestChannel();
    setup.channel.segment().subscribePresence();
    setup.channel.segment("beta").subscribe();
    setup.channel.segment("alpha").subscribePresence();
    const dropped = setup.channel.segment("gone").subscribePresence();
    dropped.cancel();

    await establish(setup);
    expect(sentFrames()).toEqual([
      "@SUB\n$4\nbeta\n",
      "@PRES_SUB\n$7\ndefault\n",
      "@PRES_SUB\n$5\nalpha\n",
    ]);
  });

  it("rejects presence interest on a closed channel", async () => {
    const { channel } = createTestChannel();
    await channel.close();
    expect(() => channel.segment("chat").subscribePresence()).toThrow(
      "Channel is closed.",
    );
  });

  it("fails terminally when a presence interest write hits the writer bound", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    channel.events().onError((error) => errors.push(error));
    const socket = sockets.at(-1)!;
    socket.send.mockImplementation(() => {
      socket.bufferedAmount += 1;
    });
    for (let index = 0; index < 64; index += 1) {
      await channel.segment().publish({ payload: utf8("x") });
    }

    channel.segment("chat").subscribePresence();
    expect(channel.state).toBe("failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "Backpressure" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("presence queries", () => {
  it("resolves a matching response with raw bigint metadata", async () => {
    const { channel } = await establish();
    const pending = channel.segment("chat").presenceList({
      page: 1,
      perPage: 25,
    });
    expect(sentFrames()).toEqual(["@PRES_LIST\n$4\nchat\n:1\n:25\n"]);

    sockets.at(-1)!.receive(
      presenceResponseFrame({
        connections: [
          ["user", "connection-1", 123],
          ["user", "connection-2", 456],
        ],
        total: 2,
        to: 2,
      }),
    );
    await expect(pending).resolves.toEqual({
      segmentId: "chat",
      total: 2n,
      perPage: 25n,
      currentPage: 1n,
      from: 1n,
      to: 2n,
      connections: [
        {
          tokenReference: "user",
          connectionId: "connection-1",
          timestamp: 123n,
        },
        {
          tokenReference: "user",
          connectionId: "connection-2",
          timestamp: 456n,
        },
      ],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves past-last-page metadata with from greater than to", async () => {
    const { channel } = await establish();
    const pending = channel.segment("chat").presenceList({
      page: 2,
      perPage: 25,
    });
    sockets.at(-1)!.receive(
      presenceResponseFrame({
        currentPage: 2,
        from: 26,
        to: 1,
        connections: [],
      }),
    );
    await expect(pending).resolves.toMatchObject({
      from: 26n,
      to: 1n,
      connections: [],
    });
  });

  it("rejects overlap with OperationInProgress while the first resolves", async () => {
    const { channel } = await establish();
    const first = channel
      .segment("chat")
      .presenceList({ page: 1, perPage: 25 });
    await expect(
      channel.segment("other").presenceList({ page: 1, perPage: 25 }),
    ).rejects.toMatchObject({ code: "OperationInProgress" });

    sockets.at(-1)!.receive(presenceResponseFrame({}));
    await expect(first).resolves.toMatchObject({ segmentId: "chat" });
  });

  it.each([
    { page: 0, perPage: 25 },
    { page: 2_147_483_648, perPage: 25 },
    { page: 1.5, perPage: 25 },
    { page: 1, perPage: 0 },
    { page: 1, perPage: 101 },
  ])("rejects out-of-range bounds %#", async (options) => {
    const { channel } = await establish();
    await expect(
      channel.segment("chat").presenceList(options),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(sockets.at(-1)!.send).not.toHaveBeenCalled();

    const recovered = channel
      .segment("chat")
      .presenceList({ page: 1, perPage: 25 });
    sockets.at(-1)!.receive(presenceResponseFrame({}));
    await expect(recovered).resolves.toMatchObject({ segmentId: "chat" });
  });

  it("rejects queries while not connected", async () => {
    const idle = createTestChannel();
    await expect(
      idle.channel.segment("chat").presenceList({ page: 1, perPage: 25 }),
    ).rejects.toMatchObject({ code: "NotConnected" });

    const setup = await establish();
    sockets.at(-1)!.disconnect();
    await expect(
      setup.channel.segment("chat").presenceList({ page: 1, perPage: 25 }),
    ).rejects.toMatchObject({ code: "NotConnected" });
  });

  it("releases the slot on a pre-aborted signal without sending", async () => {
    const { channel } = await establish();
    const controller = new AbortController();
    controller.abort();
    await expect(
      channel
        .segment("chat")
        .presenceList({ page: 1, perPage: 25, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "Cancelled" });
    expect(sockets.at(-1)!.send).not.toHaveBeenCalled();

    const next = channel.segment("chat").presenceList({ page: 1, perPage: 25 });
    sockets.at(-1)!.receive(presenceResponseFrame({}));
    await expect(next).resolves.toMatchObject({ segmentId: "chat" });
  });

  it("times out, retires the connection, and recovers", async () => {
    const setup = await establish();
    setup.channel.segment("chat").subscribe();
    const states: string[] = [];
    setup.channel.events().onStateChange((state) => states.push(state));

    const pending = setup.channel
      .segment("chat")
      .presenceList({ page: 1, perPage: 25 });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "Timeout",
    });
    const retiredSocket = sockets.at(-1)!;

    await vi.advanceTimersByTimeAsync(9_999);
    expect(states).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(states[0]).toBe("reconnecting");
    expect(retiredSocket.close).toHaveBeenCalled();

    // A zero-delay timer scheduled inside a timer callback needs a nonzero
    // advance under fake timers.
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    sockets.at(-1)!.open();
    await flushMicrotasks();
    expect(setup.channel.state).toBe("connected");
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);

    const next = setup.channel
      .segment("chat")
      .presenceList({ page: 1, perPage: 25 });
    sockets.at(-1)!.receive(presenceResponseFrame({}));
    await expect(next).resolves.toMatchObject({ segmentId: "chat" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors a custom presenceQueryTimeoutMs", async () => {
    const setup = await establish(
      createTestChannel({ presenceQueryTimeoutMs: 2_000 }),
    );
    const pending = setup.channel
      .segment("chat")
      .presenceList({ page: 1, perPage: 25 });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "Timeout",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
  });

  it("retires the connection on abort after send", async () => {
    const { channel } = await establish();
    const controller = new AbortController();
    const pending = channel
      .segment("chat")
      .presenceList({ page: 1, perPage: 25, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "Cancelled",
    });

    controller.abort();
    await rejection;
    expect(channel.state).toBe("reconnecting");
    expect(vi.getTimerCount()).toBe(1); // only the retry timer remains
  });

  it("ignores unsolicited, mismatched, and late responses", async () => {
    const { channel } = await establish();
    sockets.at(-1)!.receive(presenceResponseFrame({}));
    expect(channel.state).toBe("connected");

    const pending = channel.segment("chat").presenceList({
      page: 2,
      perPage: 50,
    });
    sockets.at(-1)!.receive(presenceResponseFrame({ segmentId: "other" }));
    sockets.at(-1)!.receive(presenceResponseFrame({ currentPage: 1 }));
    sockets
      .at(-1)!
      .receive(presenceResponseFrame({ currentPage: 2, perPage: 25 }));

    sockets
      .at(-1)!
      .receive(presenceResponseFrame({ currentPage: 2, perPage: 50 }));
    await expect(pending).resolves.toMatchObject({ currentPage: 2n });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects the pending query on connection loss and on close", async () => {
    const lost = await establish();
    const lostQuery = lost.channel
      .segment("chat")
      .presenceList({ page: 1, perPage: 25 });
    const lostRejection = expect(lostQuery).rejects.toMatchObject({
      code: "Transport",
      message: "Connection lost during presence query.",
    });
    sockets.at(-1)!.disconnect();
    await lostRejection;
    await lost.channel.close();

    const closed = await establish();
    const closedQuery = closed.channel
      .segment("chat")
      .presenceList({ page: 1, perPage: 25 });
    const closedRejection = expect(closedQuery).rejects.toMatchObject({
      code: "Cancelled",
      message: "Channel closed.",
    });
    await closed.channel.close();
    await closedRejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects the query publish-like on send failure and stays connected", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    socket.send.mockImplementationOnce(() => {
      throw new Error("synthetic-secret");
    });
    await expect(
      channel.segment("chat").presenceList({ page: 1, perPage: 25 }),
    ).rejects.toMatchObject({ code: "DeliveryUnknown" });
    expect(channel.state).toBe("connected");

    const next = channel.segment("chat").presenceList({ page: 1, perPage: 25 });
    socket.receive(presenceResponseFrame({}));
    await expect(next).resolves.toMatchObject({ segmentId: "chat" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("notices", () => {
  it("delivers raw server notices in order with working disposal", async () => {
    const { channel } = await establish();
    const seen: unknown[] = [];
    const stopFirst = channel.events().onNotice((notice) => {
      seen.push(["first", notice.timestamp, notice.payload]);
    });
    channel.events().onNotice((notice) => {
      seen.push(["second", notice.timestamp, notice.payload]);
    });

    sockets.at(-1)!.receive(utf8("@SERVER_MSG\n:7\n$6\njoined\n").buffer);
    expect(seen).toEqual([
      ["first", 7n, utf8("joined")],
      ["second", 7n, utf8("joined")],
    ]);

    stopFirst();
    seen.length = 0;
    sockets.at(-1)!.receive(utf8("@SERVER_MSG\n:8\n$4\nleft\n").buffer);
    expect(seen).toEqual([["second", 8n, utf8("left")]]);
  });

  it("contains throwing notice listeners", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const order: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel.events().onNotice(() => {
      throw new Error("notice-secret");
    });
    channel.events().onNotice(() => order.push("after"));

    sockets.at(-1)!.receive(utf8("@SERVER_MSG\n:1\n$0\n\n").buffer);
    expect(order).toEqual(["after"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "Listener callback failed." });
    expect(channel.state).toBe("connected");
  });
});

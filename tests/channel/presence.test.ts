import { describe, expect, it, vi } from "vitest";
import { ConfigurationError, ServerError } from "../../src/errors";
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
  requestId?: string;
  total?: number;
  perPage?: number;
  currentPage?: number;
  from?: number;
  to?: number;
  connections?: readonly [string, string, number][];
}): ArrayBufferLike {
  const {
    segmentId = "chat",
    requestId = "1",
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
    `@PRES_LIST_RESPONSE\n+${segmentId}\n$${requestId.length}\n${requestId}\n` +
      `;${total}\n;${perPage}\n` +
      `;${currentPage}\n;${from}\n;${to}\n*${connections.length}\n${entries}`,
  ).buffer;
}

// An error answering the presence query with this request id.
function presenceErrorFrame(type: string, requestId: string): ArrayBufferLike {
  return utf8(
    `-Err\n+${type}\n+PRES_LIST\n$6\nfailed\n` +
      `$${requestId.length}\n${requestId}\n`,
  ).buffer;
}

function presenceNotifyFrame(
  segmentId: string,
  tokenReference: string,
  connectionId: string,
  joined: boolean,
  timestamp = 123,
): ArrayBufferLike {
  return utf8(
    `@PRES_NOTIFY\n+${segmentId}\n+${tokenReference}\n+${connectionId}\n` +
      `;${joined ? 1 : 0}\n:${timestamp}\n`,
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
    const watching = channel.defaultSegment().subscribePresence();
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
    setup.channel.defaultSegment().subscribePresence();
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
      await channel.defaultSegment().publish({ payload: utf8("x") });
    }

    channel.segment("chat").subscribePresence();
    expect(channel.state).toBe("failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "Backpressure" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("presence queries", () => {
  it("resolves a matching response with its raw metadata", async () => {
    const { channel } = await establish();
    const pending = channel.segment("chat").presenceList({
      page: 1,
      perPage: 25,
    });
    expect(sentFrames()).toEqual(["@PRES_LIST\n$4\nchat\n;1\n;25\n$1\n1\n"]);

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
      total: 2,
      perPage: 25,
      currentPage: 1,
      from: 1,
      to: 2,
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
      from: 26,
      to: 1,
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
    sockets.at(-1)!.receive(presenceResponseFrame({ requestId: "2" }));
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

  it("times out without disturbing the connection and drops the late reply", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const states: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel.events().onStateChange((state) => states.push(state));

    const pending = channel.segment("chat").presenceList({
      page: 1,
      perPage: 25,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "Timeout",
    });

    await vi.advanceTimersByTimeAsync(9_999);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;

    // A late reply carries its own query's request id, so it cannot be mistaken for
    // the next query's (QUERY-01): the connection stays up.
    expect(states).toEqual([]);
    expect(sockets.at(-1)!.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const next = channel.segment("chat").presenceList({ page: 1, perPage: 25 });
    sockets.at(-1)!.receive(presenceResponseFrame({ requestId: "1" }));
    sockets.at(-1)!.receive(presenceErrorFrame("InternalError", "1"));
    sockets
      .at(-1)!
      .receive(presenceResponseFrame({ requestId: "2", total: 7 }));

    await expect(next).resolves.toMatchObject({ total: 7 });
    expect(errors).toEqual([]);
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

  it("frees the slot on abort after send and stays connected", async () => {
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
    expect(channel.state).toBe("connected");
    expect(vi.getTimerCount()).toBe(0);

    const next = channel.segment("chat").presenceList({ page: 1, perPage: 25 });
    sockets.at(-1)!.receive(presenceResponseFrame({ requestId: "1" }));
    sockets
      .at(-1)!
      .receive(presenceResponseFrame({ requestId: "2", total: 3 }));
    await expect(next).resolves.toMatchObject({ total: 3 });
  });

  it("matches a response by request id alone", async () => {
    const { channel } = await establish();
    sockets.at(-1)!.receive(presenceResponseFrame({ requestId: "9" }));
    expect(channel.state).toBe("connected");

    const pending = channel.segment("chat").presenceList({
      page: 2,
      perPage: 50,
    });
    sockets.at(-1)!.receive(presenceResponseFrame({ requestId: "0" }));
    sockets.at(-1)!.receive(presenceResponseFrame({ requestId: "10" }));

    // The id alone decides; the other fields are the server's to report.
    sockets
      .at(-1)!
      .receive(presenceResponseFrame({ requestId: "1", currentPage: 7 }));
    await expect(pending).resolves.toMatchObject({ currentPage: 7 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["InternalError", "PermissionDeniedError"])(
    "rejects at once on a %s naming the query",
    async (type) => {
      const { channel } = await establish();
      const errors: unknown[] = [];
      channel.events().onError((error) => errors.push(error));

      const pending = channel.segment("chat").presenceList({
        page: 1,
        perPage: 25,
      });
      sockets.at(-1)!.receive(presenceErrorFrame(type, "1"));

      const rejected = await pending.catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(ServerError);
      expect(rejected).toMatchObject({
        type,
        subType: "PRES_LIST",
        message: "failed",
        resource: "1",
      });

      // Reported once, to the caller; the connection is untouched.
      expect(errors).toEqual([]);
      expect(channel.state).toBe("connected");
      expect(vi.getTimerCount()).toBe(0);

      const next = channel
        .segment("chat")
        .presenceList({ page: 1, perPage: 25 });
      sockets.at(-1)!.receive(presenceResponseFrame({ requestId: "2" }));
      await expect(next).resolves.toMatchObject({ segmentId: "chat" });
    },
  );

  it("drops a presence query error for any other request id", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    channel.events().onError((error) => errors.push(error));

    sockets.at(-1)!.receive(presenceErrorFrame("InternalError", "1"));

    const pending = channel.segment("chat").presenceList({
      page: 1,
      perPage: 25,
    });
    sockets.at(-1)!.receive(presenceErrorFrame("InternalError", "0"));
    sockets.at(-1)!.receive(presenceResponseFrame({ requestId: "1" }));

    await expect(pending).resolves.toMatchObject({ segmentId: "chat" });
    expect(errors).toEqual([]);
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

    // The failed send may still have reached the server, so its request id
    // is spent and the next query uses a new one.
    const next = channel.segment("chat").presenceList({ page: 1, perPage: 25 });
    socket.receive(presenceResponseFrame({ requestId: "2" }));
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

  it("delivers presence notifications to their own segment only", async () => {
    const { channel } = await establish();
    const chat: unknown[] = [];
    const lobby: unknown[] = [];
    channel.segment("chat").onPresence((event) => chat.push(event));
    channel.segment("lobby").onPresence((event) => lobby.push(event));

    sockets
      .at(-1)!
      .receive(presenceNotifyFrame("chat", "user", "connection-1", true, 7));
    sockets
      .at(-1)!
      .receive(presenceNotifyFrame("chat", "user", "connection-1", false, 9));

    expect(lobby).toEqual([]);
    expect(chat).toEqual([
      {
        segmentId: "chat",
        tokenReference: "user",
        connectionId: "connection-1",
        joined: true,
        timestamp: 7n,
      },
      {
        segmentId: "chat",
        tokenReference: "user",
        connectionId: "connection-1",
        joined: false,
        timestamp: 9n,
      },
    ]);
  });

  it("shares one presence listener set across handler instances", async () => {
    const { channel } = await establish();
    const seen: string[] = [];
    const stopFirst = channel
      .segment("chat")
      .onPresence(() => seen.push("first"));
    channel.segment("chat").onPresence(() => seen.push("second"));

    sockets
      .at(-1)!
      .receive(presenceNotifyFrame("chat", "user", "connection-1", true));
    stopFirst();
    sockets
      .at(-1)!
      .receive(presenceNotifyFrame("chat", "user", "connection-1", false));

    expect(seen).toEqual(["first", "second", "second"]);
  });

  it("ignores a notification for a segment with no listener", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    channel.events().onError((error) => errors.push(error));

    sockets
      .at(-1)!
      .receive(presenceNotifyFrame("unwatched", "user", "connection-1", true));

    expect(errors).toEqual([]);
    expect(channel.state).toBe("connected");
  });

  it("contains throwing presence listeners", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const order: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel.segment("chat").onPresence(() => {
      throw new Error("presence-secret");
    });
    channel.segment("chat").onPresence(() => order.push("after"));

    sockets
      .at(-1)!
      .receive(presenceNotifyFrame("chat", "user", "connection-1", true));

    expect(order).toEqual(["after"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "Listener callback failed." });
    expect(channel.state).toBe("connected");
  });
});

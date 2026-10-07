import { describe, expect, it, vi } from "vitest";
import { Segment } from "../../src/segment";
import { ConfigurationError, ServerError } from "../../src/errors";
import { utf8 } from "../fixtures/codec-vectors";
import {
  createTestChannel,
  flushMicrotasks,
  messageFrame,
} from "../helpers/channel";
import {
  sockets,
  useTestWebSockets,
  type TestWebSocket,
} from "../helpers/websocket";

useTestWebSockets();

async function establish(setup = createTestChannel()) {
  vi.useFakeTimers();
  const pending = setup.channel.connect();
  await flushMicrotasks();
  sockets.at(-1)!.open();
  await pending;

  return setup;
} // end function establish

// Laid out like the server's ErrorMessage.
function errorFrame(
  type: string,
  message: string,
  subType: string | null = null,
  resource = "$-1\n",
): ArrayBufferLike {
  const subTypeField = subType === null ? "$-1\n" : `+${subType}\n`;

  return utf8(
    `-Err\n+${type}\n${subTypeField}$${utf8(message).length}\n${message}\n` +
      resource,
  ).buffer;
} // end function errorFrame

function sentFrames(): string[] {
  return sockets
    .at(-1)!
    .send.mock.calls.map(([bytes]) =>
      new TextDecoder().decode(bytes as Uint8Array),
    );
} // end function sentFrames

// Runs the scheduled reconnect attempt: test retry delays are zero, which fake
// timers run one millisecond later.
async function startReconnectAttempt(): Promise<TestWebSocket> {
  const socketCount = sockets.length;
  await vi.advanceTimersByTimeAsync(1);
  await flushMicrotasks();
  expect(sockets).toHaveLength(socketCount + 1);

  return sockets.at(-1)!;
} // end function startReconnectAttempt

async function reconnect(): Promise<void> {
  (await startReconnectAttempt()).open();
  await flushMicrotasks();
} // end function reconnect

// Every send then fails with Backpressure, so publishes wait in the queue.
function fillWriter(socket: TestWebSocket): void {
  socket.bufferedAmount = 2 * 1024 * 1024;
} // end function fillWriter

function publishFrame(segmentId: string, messageId: string, body: string) {
  return `@PUB\n$${segmentId.length}\n${segmentId}\n$${messageId.length}\n${messageId}\n$${body.length}\n${body}\n`;
} // end function publishFrame

// Tracks whether a promise has settled without awaiting it.
function track(promise: Promise<void>): { settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );

  return state;
} // end function track

describe("segment proxies", () => {
  it("creates side-effect-free stateless proxies", async () => {
    const { channel } = await establish();
    const first = channel.segment("chat");
    const second = channel.segment("chat");

    expect(first).toBeInstanceOf(Segment);
    expect(first).not.toBe(second);
    expect(first.segmentId).toBe("chat");
    expect(channel.defaultSegment().segmentId).toBe("default");
    expect(sockets.at(-1)!.send).not.toHaveBeenCalled();
  });

  // undefined stands in for an untyped caller that omits the id.
  it.each(["", "bad\nid", "bad\rid", "\ud800", undefined])(
    "rejects invalid segment identifiers %#",
    async (identifier) => {
      const { channel } = createTestChannel();
      expect(() => channel.segment(identifier as string)).toThrow(
        ConfigurationError,
      );
    },
  );

  it("shares one interest count across instances of a segment", async () => {
    const { channel } = await establish();
    const first = channel.segment("chat").subscribe();
    const second = channel.segment("chat").subscribe();
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);

    first.cancel();
    first.cancel();
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);

    second.cancel();
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n", "@UNSUB\n$4\nchat\n"]);
  });

  it("multiplexes segments over one socket; another channel opens another", async () => {
    const { channel } = await establish();
    channel.segment("alpha").subscribe();
    channel.segment("beta").subscribe();
    await channel.segment("gamma").publish({ payload: utf8("x") });
    expect(sockets).toHaveLength(1);
    expect(sentFrames()).toHaveLength(3);

    await establish(createTestChannel({ channelReference: "room-2" }));
    expect(sockets).toHaveLength(2);
  });

  it("never sends SUB or UNSUB for the default segment", async () => {
    const { channel } = await establish();
    const membership = channel.defaultSegment().subscribe();
    membership.cancel();
    expect(sockets.at(-1)!.send).not.toHaveBeenCalled();
  });
});

describe("publish", () => {
  it("resolves on local acceptance with exact bytes and a generated id", async () => {
    const { channel } = await establish();
    await channel.defaultSegment().publish({ payload: utf8("hi") });
    await channel
      .segment("chat")
      .publish({ payload: utf8("yo"), messageId: "m-1" });

    expect(sentFrames()).toEqual([
      "@PUB\n$7\ndefault\n$11\ngenerated-1\n$2\nhi\n",
      "@PUB\n$4\nchat\n$3\nm-1\n$2\nyo\n",
    ]);
  });

  it("rejects a publish before the first connect, during it, after failed and after close", async () => {
    vi.useFakeTimers();
    const setup = createTestChannel({ maximumReconnectAttempts: 1 });
    const segment = setup.channel.segment("chat");
    const notConnected = (state: string) => ({
      code: "NotConnected",
      message: `Channel is not connected; it is ${state}.`,
    });

    await expect(segment.publish({ payload: utf8("x") })).rejects.toMatchObject(
      notConnected("idle"),
    );

    const connecting = setup.channel.connect();
    await expect(segment.publish({ payload: utf8("x") })).rejects.toMatchObject(
      notConnected("connecting"),
    );

    await flushMicrotasks();
    sockets.at(-1)!.open();
    await connecting;
    sockets.at(-1)!.disconnect();
    (await startReconnectAttempt()).fail();
    await flushMicrotasks();
    expect(setup.channel.state).toBe("failed");
    await expect(segment.publish({ payload: utf8("x") })).rejects.toMatchObject(
      notConnected("failed"),
    );

    await setup.channel.close();
    await expect(segment.publish({ payload: utf8("x") })).rejects.toMatchObject(
      notConnected("closed"),
    );

    for (const socket of sockets) expect(socket.send).not.toHaveBeenCalled();
  });

  it("rejects a pre-aborted signal and invalid options before writing", async () => {
    const { channel } = await establish();
    const controller = new AbortController();
    controller.abort();
    await expect(
      channel
        .defaultSegment()
        .publish({ payload: utf8("x"), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "Cancelled" });

    await expect(
      channel.defaultSegment().publish({ payload: utf8("x"), messageId: "" }),
    ).rejects.toBeInstanceOf(ConfigurationError);

    await expect(
      channel
        .defaultSegment()
        .publish({ payload: new Uint8Array(2 * 1024 * 1024) }),
    ).rejects.toThrow("Encoded command exceeds 2 MiB.");
    expect(sockets.at(-1)!.send).not.toHaveBeenCalled();

    await channel.defaultSegment().publish({ payload: new Uint8Array(0) });
    expect(sentFrames()).toEqual([
      "@PUB\n$7\ndefault\n$11\ngenerated-2\n$0\n\n",
    ]);
  });

  it("queues publishes behind a full writer and sends them once it drains", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    socket.send.mockImplementation(() => {
      socket.bufferedAmount += 1;
    });

    const lobby = channel.defaultSegment();

    for (let index = 0; index < 64; index += 1) {
      await lobby.publish({ payload: utf8("x") });
    }

    const queued = Array.from({ length: 64 }, () =>
      lobby.publish({ payload: utf8("x") }),
    );
    await expect(lobby.publish({ payload: utf8("x") })).rejects.toMatchObject({
      code: "Backpressure",
      message:
        "The publish queue is full (size 64). Retry once some publishes have gone out.",
    });
    expect(socket.send).toHaveBeenCalledTimes(64);

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(queued);

    expect(socket.send).toHaveBeenCalledTimes(128);
    expect(channel.state).toBe("connected");
  });

  it("maps a native send failure to DeliveryUnknown and stays connected", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    channel.events().onError((error) => errors.push(error));
    sockets.at(-1)!.send.mockImplementation(() => {
      throw new Error("synthetic-secret");
    });

    await expect(
      channel.defaultSegment().publish({ payload: utf8("x") }),
    ).rejects.toMatchObject({ code: "DeliveryUnknown" });
    expect(channel.state).toBe("connected");
    expect(errors).toEqual([]);
  });
});

describe("subscriptions and flush", () => {
  it("flushes registered interests on connect in registration order", async () => {
    const setup = createTestChannel();
    setup.channel.segment("beta").subscribe();
    setup.channel.segment("alpha").subscribe();
    setup.channel.defaultSegment().subscribe();

    await establish(setup);
    expect(sentFrames()).toEqual(["@SUB\n$4\nbeta\n", "@SUB\n$5\nalpha\n"]);
  });

  it("reflushes interests after reconnect and skips cancelled ones", async () => {
    const setup = await establish();
    setup.channel.segment("chat").subscribe();
    const dropped = setup.channel.segment("gone").subscribe();

    sockets.at(-1)!.disconnect();
    dropped.cancel(); // disconnected: no UNSUB, absent from the next flush
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    sockets.at(-1)!.open();
    await flushMicrotasks();

    expect(setup.channel.state).toBe("connected");
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
  });

  it("sends a subscription queued behind a full writer ahead of publishes", async () => {
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

    const queuedPublish = channel
      .segment("lobby")
      .publish({ payload: utf8("y") });
    channel.segment("chat").subscribe();
    expect(socket.send).toHaveBeenCalledTimes(64);

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await queuedPublish;

    expect(sentFrames().slice(64)).toEqual([
      "@SUB\n$4\nchat\n",
      "@PUB\n$5\nlobby\n$12\ngenerated-65\n$1\ny\n",
    ]);
    expect(channel.state).toBe("connected");
    expect(errors).toEqual([]);
  });

  it("restores more than 64 subscriptions on connect as the writer drains", async () => {
    const setup = createTestChannel();

    for (let index = 0; index < 65; index += 1) {
      setup.channel.segment(`segment-${index}`).subscribe();
    }

    vi.useFakeTimers();
    const pending = setup.channel.connect();
    await flushMicrotasks();
    const socket = sockets.at(-1)!;
    socket.send.mockImplementation(() => {
      socket.bufferedAmount += 1;
    });
    socket.open();
    await pending;

    expect(setup.channel.state).toBe("connected");
    expect(socket.send).toHaveBeenCalledTimes(64);

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);

    expect(socket.send).toHaveBeenCalledTimes(65);
    expect(sentFrames().at(-1)).toBe("@SUB\n$10\nsegment-64\n");
  });

  it("carries nothing from a failed connect into the next one", async () => {
    const setup = createTestChannel();
    const subscription = setup.channel.segment("chat").subscribe();

    vi.useFakeTimers();
    const failed = setup.channel.connect();
    const rejection = expect(failed).rejects.toMatchObject({
      code: "Transport",
    });
    await flushMicrotasks();
    sockets.at(-1)!.send.mockImplementation(() => {
      throw new Error("synthetic-secret");
    });
    sockets.at(-1)!.open();
    await rejection;
    expect(setup.channel.state).toBe("failed");

    subscription.cancel();
    const retried = setup.channel.connect();
    await flushMicrotasks();
    sockets.at(-1)!.open();
    await retried;
    setup.channel.segment("lobby").subscribe();

    expect(sentFrames()).toEqual(["@SUB\n$5\nlobby\n"]);
  });

  it("puts nothing on the wire for a listener alone", async () => {
    const { channel } = await establish();
    channel.segment("chat").onMessage(() => undefined);
    channel.events().onMessage(() => undefined);

    expect(sockets.at(-1)!.send).not.toHaveBeenCalled();
  });

  it("rejects subscribe on a closed channel", async () => {
    const { channel } = createTestChannel();
    await channel.close();
    expect(() => channel.segment("chat").subscribe()).toThrow(
      "Channel is closed; create a new one with client.channel().",
    );
  });
});

describe("delivery and dedup", () => {
  it("routes messages to their segment's listeners only", async () => {
    const { channel } = await establish();
    const chatMessages: string[] = [];
    const lobbyMessages: string[] = [];
    channel
      .segment("chat")
      .onMessage((_payload, metadata) => chatMessages.push(metadata.messageId));

    channel
      .defaultSegment()
      .onMessage((_payload, metadata) =>
        lobbyMessages.push(metadata.messageId),
      );

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "hi"));
    sockets.at(-1)!.receive(messageFrame("default", "id-2", "yo"));
    sockets.at(-1)!.receive(messageFrame("other", "id-3", "no"));

    expect(chatMessages).toEqual(["id-1"]);
    expect(lobbyMessages).toEqual(["id-2"]);
  });

  it("delivers to every listener across proxy instances and preserves fields", async () => {
    const { channel } = await establish();
    const seen: unknown[] = [];
    channel
      .segment("chat")
      .onMessage((payload, metadata) => seen.push({ payload, ...metadata }));

    channel
      .segment("chat")
      .onMessage((payload, metadata) => seen.push({ payload, ...metadata }));

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "hi"));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      tokenReference: "user",
      segmentId: "chat",
      messageId: "id-1",
      timestamp: 1n,
      payload: utf8("hi"),
    });
  });

  it("deduplicates by id, recording ids even without listeners", async () => {
    const { channel } = await establish();
    const delivered: string[] = [];

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "hi"));
    channel
      .segment("chat")
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "hi"));
    sockets.at(-1)!.receive(messageFrame("chat", "id-2", "hi"));
    sockets.at(-1)!.receive(messageFrame("chat", "id-2", "hi"));

    expect(delivered).toEqual(["id-2"]);
  });

  it("keeps the window across reconnect and clears it on a fresh connect", async () => {
    const setup = await establish();
    const delivered: string[] = [];
    setup.channel
      .segment("chat")
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));
    setup.channel.segment("chat").subscribe();

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));
    sockets.at(-1)!.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    sockets.at(-1)!.open();
    await flushMicrotasks();
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));
    expect(delivered).toEqual(["id-1"]);

    await setup.channel.close();
    const fresh = await establish();
    const redelivered: string[] = [];
    fresh.channel
      .segment("chat")
      .onMessage((_payload, metadata) => redelivered.push(metadata.messageId));
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));
    expect(redelivered).toEqual(["id-1"]);
  });

  it("drops a null-id message without dropping the connection (REV-01)", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const delivered: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel
      .segment("chat")
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));

    sockets.at(-1)!.receive(messageFrame("chat", null, "x"));

    expect(delivered).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "ProtocolError",
      message:
        "Server message is missing its identifier. Field: messageId, byte offset 0.",
    });
    // The message is undeliverable because it cannot be deduplicated, but
    // that is one frame's problem, not the connection's (DECODE-01).
    expect(channel.state).toBe("connected");
    expect(sockets.at(-1)!.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips an internal node command without reporting it", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const delivered: string[] = [];
    const states: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel.events().onStateChange((state) => states.push(state));
    channel
      .segment("chat")
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));

    sockets.at(-1)!.receive(utf8("@NODE_PUB\n+node-1\n$4\nbody\n").buffer);
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));

    expect(errors).toEqual([]);
    expect(states).toEqual([]);
    expect(delivered).toEqual(["id-1"]);
  });

  it("ignores server notices and reports error frames while staying connected", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const delivered: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel
      .segment("chat")
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));

    // The server greets every connect with untagged prose notices.
    sockets
      .at(-1)!
      .receive(
        utf8('@SERVER_MSG\n:1\n$29\nSuccessfully connected to "x"\n').buffer,
      );
    sockets.at(-1)!.receive(errorFrame("RateLimitError", "slow down"));
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));

    // The server's own fields reach the consumer (ERR-01).
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ServerError);
    expect(errors[0]).toMatchObject({
      type: "RateLimitError",
      subType: null,
      message: "slow down",
      resource: null,
    });
    expect(channel.state).toBe("connected");
    expect(delivered).toEqual(["id-1"]);
  });

  it("reports a permission denial with the command and segment it names", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const delivered: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel
      .segment("chat")
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));

    // A denied publish resolves locally; the error arrives afterwards.
    await channel.segment("chat").publish({ payload: utf8("x") });
    sockets
      .at(-1)!
      .receive(
        errorFrame("PermissionDeniedError", "denied", "PUB", "$4\nchat\n"),
      );
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "PermissionDeniedError",
      subType: "PUB",
      message: "denied",
      resource: "chat",
    });
    expect(channel.state).toBe("connected");
    expect(delivered).toEqual(["id-1"]);
  });

  it.each([
    "ParserError",
    "SendError",
    "PermissionDeniedError",
    "RateLimitError",
    "MessageSizeLimitError",
    "InternalError",
    // A type a newer server adds still reaches the consumer.
    "SomeFutureError",
  ])("surfaces a %s frame with every field", async (type) => {
    const { channel } = await establish();
    const errors: unknown[] = [];

    channel.events().onError((error) => errors.push(error));
    sockets
      .at(-1)!
      .receive(errorFrame(type, "what happened", "SUB", "*2\n+a\n:7\n"));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ServerError);
    expect(errors[0]).toMatchObject({
      type,
      subType: "SUB",
      message: "what happened",
      resource: ["a", 7n],
    });
    expect(channel.state).toBe("connected");
  });

  it("surfaces the server's message-size rejection exactly as sent", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const message =
      "Message size limit exceeded; payload size = 65537 bytes; size limit = 64 KB";

    channel.events().onError((error) => errors.push(error));
    sockets.at(-1)!.receive(errorFrame("MessageSizeLimitError", message));

    expect(errors[0]).toMatchObject({ type: "MessageSizeLimitError", message });
  });

  it("never throws while delivering a malformed server message", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const frame = new Uint8Array([
      ...utf8("-Err\n+SendError\n$-1\n$6\nbad "),
      0xff,
      0xfe,
      ...utf8("\n$-1\n"),
    ]);

    channel.events().onError((error) => errors.push(error));
    sockets.at(-1)!.receive(frame.buffer);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "SendError" });
    expect((errors[0] as Error).message.startsWith("bad ")).toBe(true);
    expect(channel.state).toBe("connected");
  });

  it("contains throwing listeners and honors mid-dispatch disposal", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const order: string[] = [];
    channel.events().onError((error) => errors.push(error));
    let disposeSecond: () => void = () => undefined;
    channel.segment("chat").onMessage(() => {
      order.push("first");
      disposeSecond();
      throw new Error("listener-secret");
    });

    disposeSecond = channel
      .segment("chat")
      .onMessage(() => order.push("second"));
    channel.segment("chat").onMessage(() => order.push("third"));

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));

    expect(order).toEqual(["first", "third"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message:
        "A listener callback threw; the channel caught the error and kept running.",
    });
    expect(channel.state).toBe("connected");
  });

  it("fans out nested arrays preserving arrival order", async () => {
    const { channel } = await establish();
    const delivered: string[] = [];
    channel
      .segment("chat")
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));

    const first = "@MSG\n$4\nuser\n$4\nchat\n$4\nal-1\n:1\n$1\na\n";
    const second = "@MSG\n$4\nuser\n$4\nchat\n$4\nal-2\n:2\n$1\nb\n";
    sockets.at(-1)!.receive(utf8(`*2\n${first}${second}`).buffer);

    expect(delivered).toEqual(["al-1", "al-2"]);
  });
});

describe("channel-wide delivery", () => {
  it("receives every segment's deliveries, with or without segment listeners", async () => {
    const { channel } = await establish();
    const seen: string[] = [];
    channel
      .events()
      .onMessage((payload, metadata) =>
        seen.push(`${metadata.segmentId}:${new TextDecoder().decode(payload)}`),
      );
    channel.segment("chat").onMessage(() => undefined);

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "hi"));
    sockets.at(-1)!.receive(messageFrame("default", "id-2", "yo"));
    sockets.at(-1)!.receive(messageFrame("joined-by-publish", "id-3", "ok"));

    expect(seen).toEqual(["chat:hi", "default:yo", "joined-by-publish:ok"]);
  });

  it("runs after the segment's listeners in the same dispatch", async () => {
    const { channel } = await establish();
    const order: string[] = [];
    channel.events().onMessage(() => order.push("channel"));
    channel.segment("chat").onMessage(() => order.push("segment"));

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));

    expect(order).toEqual(["segment", "channel"]);
  });

  it("sees a duplicate once and never a delivery without an id", async () => {
    const { channel } = await establish();
    const delivered: string[] = [];
    channel
      .events()
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));
    sockets.at(-1)!.receive(messageFrame("other", "id-1", "x"));
    sockets.at(-1)!.receive(messageFrame("chat", null, "x"));

    expect(delivered).toEqual(["id-1"]);
  });

  it("contains a throwing listener and stops after disposal", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const delivered: string[] = [];
    channel.events().onError((error) => errors.push(error));
    const stopThrowing = channel.events().onMessage(() => {
      throw new Error("listener-secret");
    });
    const stopRecording = channel
      .events()
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));
    stopThrowing();
    stopRecording();
    sockets.at(-1)!.receive(messageFrame("chat", "id-2", "x"));

    expect(delivered).toEqual(["id-1"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message:
        "A listener callback threw; the channel caught the error and kept running.",
    });
    expect(channel.state).toBe("connected");
  });

  it("removes only its own channel listener", async () => {
    const { channel } = await establish();
    const delivered: string[] = [];
    const removeChannelListener = channel
      .events()
      .onMessage(() => delivered.push("removed"));
    channel.events().onMessage(() => delivered.push("channel"));
    channel.segment("chat").onMessage(() => delivered.push("segment"));
    channel.segment("chat").subscribe();

    removeChannelListener();
    removeChannelListener();
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));

    expect(delivered).toEqual(["segment", "channel"]);
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
  });

  // The server decides what arrives; the SDK never gates on subscriptions.
  it("delivers whatever the subscription state", async () => {
    const { channel } = await establish();
    const delivered: string[] = [];
    channel
      .segment("chat")
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));
    channel.segment("chat").subscribe().cancel();

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));

    expect(delivered).toEqual(["id-1"]);
  });
});

describe("listener re-entry", () => {
  it("publishes from inside a message listener", async () => {
    const { channel } = await establish();
    const seen: string[] = [];
    let published: Promise<void> | undefined;
    channel.segment("chat").onMessage(() => {
      published = channel
        .segment("chat")
        .publish({ payload: utf8("reply"), messageId: "reply-1" });
    });

    channel.events().onMessage((_payload, metadata) => {
      seen.push(metadata.messageId);
    });

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "hi"));
    await published;

    expect(seen).toEqual(["id-1"]);
    expect(sentFrames()).toEqual(["@PUB\n$4\nchat\n$7\nreply-1\n$5\nreply\n"]);
  });

  it("subscribes and cancels from inside a message listener", async () => {
    const { channel } = await establish();
    const held = channel.segment("old").subscribe();
    channel.events().onMessage(() => {
      held.cancel();
      channel.segment("new").subscribe();
    });

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "hi"));

    expect(sentFrames()).toEqual([
      "@SUB\n$3\nold\n",
      "@UNSUB\n$3\nold\n",
      "@SUB\n$3\nnew\n",
    ]);
  });

  it("closes from inside a message listener without throwing", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const seen: string[] = [];
    let closing: Promise<void> | undefined;
    channel.events().onError((error) => errors.push(error));
    channel.segment("chat").onMessage(() => {
      closing = channel.close();
    });

    channel.events().onMessage((_payload, metadata) => {
      seen.push(metadata.messageId);
    });

    expect(() =>
      sockets.at(-1)!.receive(messageFrame("chat", "id-1", "hi")),
    ).not.toThrow();
    await closing;
    sockets.at(-1)!.receive(messageFrame("chat", "id-2", "hi"));

    expect(channel.state).toBe("closed");
    expect(seen).toEqual(["id-1"]);
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("rate-limit recovery", () => {
  const rateLimitFrame = (): ArrayBufferLike =>
    errorFrame("RateLimitError", "Rate limit exceeded");

  it("pauses, then resends recent subscriptions before recent publishes", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    channel.events().onError((error) => errors.push(error));
    const chat = channel.segment("chat");
    const lobby = channel.segment("lobby");
    chat.subscribe();
    chat.subscribePresence();
    await lobby.publish({ payload: utf8("a") });
    const socket = sockets.at(-1)!;
    socket.send.mockClear();

    socket.receive(rateLimitFrame());
    const queued = lobby.publish({ payload: utf8("b") });
    await vi.advanceTimersByTimeAsync(999);

    expect(errors).toEqual([
      expect.objectContaining({ type: "RateLimitError" }),
    ]);
    expect(socket.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await queued;

    expect(sentFrames()).toEqual([
      "@SUB\n$4\nchat\n",
      "@PRES_SUB\n$4\nchat\n",
      "@PUB\n$5\nlobby\n$11\ngenerated-1\n$1\na\n",
      "@PUB\n$5\nlobby\n$11\ngenerated-2\n$1\nb\n",
    ]);
  });

  it("resends a command sent exactly 2 000 ms before the limit, not one sent 2 001 ms before", async () => {
    const { channel, clocks } = await establish();
    const socket = sockets.at(-1)!;
    const chat = channel.segment("chat");
    await chat.publish({ payload: utf8("old") });
    clocks.monotonic += 1;
    await chat.publish({ payload: utf8("edge") });
    clocks.monotonic += 2_000;
    socket.send.mockClear();

    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sentFrames()).toEqual([
      "@PUB\n$4\nchat\n$11\ngenerated-2\n$4\nedge\n",
    ]);
  });

  it("resends a publish byte for byte with its original id, and only once", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    await channel
      .segment("chat")
      .publish({ payload: utf8("x"), messageId: "original-id" });

    const [original] = socket.send.mock.calls[0]!;
    socket.send.mockClear();

    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(1_000);

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls[0]![0]).toEqual(original);

    socket.send.mockClear();
    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(31_000);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("sends one command with the final state for a subscription toggled while paused", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    socket.receive(rateLimitFrame());

    channel.segment("chat").subscribe().cancel();
    channel.segment("chat").subscribe();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
  });

  it("backs off on consecutive rate limits and starts over after a quiet window", async () => {
    const { channel, clocks } = await establish();
    clocks.randomValue = 1;
    const socket = sockets.at(-1)!;
    channel.segment("chat").subscribe();

    // 1 000 ms plus the reconnect delay for the streak index, which is capped
    // at 30 000 ms. The seventh limit is the first to reach the cap.
    for (const pauseMs of [1_500, 2_000, 3_000, 5_000, 9_000, 17_000, 31_000]) {
      socket.send.mockClear();
      socket.receive(rateLimitFrame());
      await vi.advanceTimersByTimeAsync(pauseMs - 1);
      expect(socket.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
    }

    // Past the last pause and its suspect window, the streak starts over.
    clocks.monotonic += 40_000;
    channel.segment("lobby").subscribe();
    socket.send.mockClear();
    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(1_499);
    expect(socket.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sentFrames()).toEqual(["@SUB\n$5\nlobby\n"]);
  });

  it("withdraws a queued publish when its signal aborts", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    socket.receive(rateLimitFrame());
    const controller = new AbortController();

    const pending = channel
      .segment("chat")
      .publish({ payload: utf8("x"), signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "Cancelled",
      message: "Publish cancelled by its abort signal before it was sent.",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("never sends a subscription change ahead of an earlier publish to its segment", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    socket.receive(rateLimitFrame());
    const chat = channel.segment("chat");

    const subscription = chat.subscribe();
    const published = chat.publish({ payload: utf8("x") });
    subscription.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    await published;

    // Publishing joins the segment, so the UNSUB has to follow it.
    expect(sentFrames()).toEqual([
      "@PUB\n$4\nchat\n$11\ngenerated-1\n$1\nx\n",
      "@UNSUB\n$4\nchat\n",
    ]);
  });

  // Eight limits in a row, each followed by its resend round: from here on
  // the limit is treated as a used-up quota.
  async function exhaustRateLimit(
    socket: (typeof sockets)[number],
  ): Promise<void> {
    for (let limit = 0; limit < 8; limit += 1) {
      socket.receive(rateLimitFrame());
      await vi.advanceTimersByTimeAsync(31_000);
    }
  } // end function exhaustRateLimit

  it("drops recent publishes and keeps subscriptions for the probe once eight limits in a row have passed", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    channel.segment("chat").subscribe();
    await exhaustRateLimit(socket);
    await channel.segment("lobby").publish({ payload: utf8("x") });

    socket.send.mockClear();
    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(socket.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
  });

  it("re-sends dropped subscriptions on a slow probe that doubles after each limit, up to one hour", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    channel.segment("chat").subscribe();
    await exhaustRateLimit(socket);

    const probeDelays = [
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000,
      3_600_000,
    ];

    for (const delayMs of probeDelays) {
      socket.send.mockClear();
      socket.receive(rateLimitFrame());
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(socket.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
    }
  });

  it("resends normally again once commands go a window without a limit", async () => {
    const { channel, clocks } = await establish();
    const socket = sockets.at(-1)!;
    channel.segment("chat").subscribe();
    await exhaustRateLimit(socket);
    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(60_000);

    clocks.monotonic += 3_000;
    channel.segment("lobby").subscribe();
    socket.send.mockClear();
    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sentFrames()).toEqual(["@SUB\n$5\nlobby\n"]);
  });

  it("keeps probing across a reconnect instead of starting the resends over", async () => {
    const { channel } = await establish();
    channel.segment("chat").subscribe();
    await exhaustRateLimit(sockets.at(-1)!);
    sockets.at(-1)!.receive(rateLimitFrame());

    sockets.at(-1)!.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    const restored = sockets.at(-1)!;
    restored.open();
    await flushMicrotasks();
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);

    restored.send.mockClear();
    restored.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(119_999);
    expect(restored.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
  });

  it("holds a subscription change only behind publishes queued before it", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    socket.receive(rateLimitFrame());
    const chat = channel.segment("chat");

    const first = chat.publish({ payload: utf8("1") });
    chat.subscribe();
    const second = chat.publish({ payload: utf8("2") });
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);

    expect(sentFrames()).toEqual([
      "@PUB\n$4\nchat\n$11\ngenerated-1\n$1\n1\n",
      "@SUB\n$4\nchat\n",
      "@PUB\n$4\nchat\n$11\ngenerated-2\n$1\n2\n",
    ]);
  });

  it("counts one episode when several limit frames report the same burst", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    channel.segment("chat").subscribe();

    // Eight episodes, each reported through two limit frames: still eight
    // resend rounds, not a give-up at four.
    for (let episode = 0; episode < 8; episode += 1) {
      socket.send.mockClear();
      socket.receive(rateLimitFrame());
      socket.receive(rateLimitFrame());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
    }

    socket.send.mockClear();
    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(socket.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
  });

  it("treats a late report while probing as the quota still exhausted", async () => {
    const { channel, clocks } = await establish();
    const socket = sockets.at(-1)!;
    channel.segment("chat").subscribe();
    await exhaustRateLimit(socket);
    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sentFrames().at(-1)).toBe("@SUB\n$4\nchat\n");

    // The dropped probe's report lands past the suspect window but far
    // inside the confirmation span: probing continues, doubled.
    clocks.monotonic += 2_500;
    socket.send.mockClear();
    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(119_999);
    expect(socket.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
  });

  it("ends probing when a limit arrives long after accepted traffic", async () => {
    const { channel, clocks } = await establish();
    const socket = sockets.at(-1)!;
    channel.segment("chat").subscribe();
    await exhaustRateLimit(socket);
    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(60_000);

    // The probe's frames were accepted; a limit far later is a new burst,
    // handled with normal resend rounds again.
    clocks.monotonic += 40_000;
    socket.receive(rateLimitFrame());
    channel.segment("lobby").subscribe();
    socket.send.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sentFrames()).toEqual(["@SUB\n$5\nlobby\n"]);

    socket.receive(rateLimitFrame());
    socket.send.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sentFrames()).toEqual(["@SUB\n$5\nlobby\n"]);
  });

  it("counts a sent presence query as proof the quota returned", async () => {
    const { channel, clocks } = await establish();
    const socket = sockets.at(-1)!;
    channel.segment("chat").subscribe();
    await exhaustRateLimit(socket);
    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(1_000);

    const query = channel
      .segment("chat")
      .presenceList({ page: 1, perPage: 25 });
    query.catch(() => undefined);
    clocks.monotonic += 2_500;
    socket.send.mockClear();
    channel.segment("lobby").subscribe();

    expect(sentFrames()).toEqual(["@SUB\n$5\nlobby\n", "@SUB\n$4\nchat\n"]);
  });

  it("resends at most the last 64 publishes", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    const lobby = channel.segment("lobby");

    for (let index = 1; index <= 65; index += 1) {
      await lobby.publish({ payload: utf8(`${index}`) });
    }

    socket.send.mockClear();

    socket.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(1_000);

    const expected = [];

    for (let index = 2; index <= 65; index += 1) {
      const messageId = `generated-${index}`;
      const body = `${index}`;
      expected.push(
        `@PUB\n$5\nlobby\n$${messageId.length}\n${messageId}\n$${body.length}\n${body}\n`,
      );
    }

    expect(sentFrames()).toEqual(expected);
  });

  it("rejects a presence query while sending is paused", async () => {
    const { channel } = await establish();
    sockets.at(-1)!.receive(rateLimitFrame());

    await expect(
      channel.segment("chat").presenceList({ page: 1, perPage: 25 }),
    ).rejects.toMatchObject({
      code: "Backpressure",
      message: "Sending is paused after a rate limit; try again in a moment.",
    });
  });

  it("resends subscriptions restored on reconnect when a rate limit follows", async () => {
    const { channel } = await establish();
    channel.segment("chat").subscribe();
    sockets.at(-1)!.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    const restored = sockets.at(-1)!;
    restored.open();
    await flushMicrotasks();
    restored.send.mockClear();

    restored.receive(rateLimitFrame());
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
    expect(channel.state).toBe("connected");
  });

  it("replaces the socket when a subscription write fails, then restores it", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    channel.events().onError((error) => errors.push(error));
    const failing = sockets.at(-1)!;
    failing.send.mockImplementation(() => {
      throw new Error("synthetic-secret");
    });

    channel.segment("chat").subscribe();

    expect(channel.state).toBe("reconnecting");
    expect(failing.close).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    sockets.at(-1)!.open();
    await flushMicrotasks();

    expect(channel.state).toBe("connected");
    expect(sentFrames()).toEqual(["@SUB\n$4\nchat\n"]);
    expect(errors).toEqual([]);
  });
});

describe("publishes across a reconnect", () => {
  it("queues a publish while reconnecting and sends it after the reconnect", async () => {
    const { channel } = await establish();
    sockets.at(-1)!.disconnect();
    expect(channel.state).toBe("reconnecting");

    const published = channel.segment("chat").publish({ payload: utf8("x") });
    const progress = track(published);
    await flushMicrotasks();
    expect(progress.settled).toBe(false);

    await reconnect();
    await published;
    expect(channel.state).toBe("connected");
    expect(sentFrames()).toEqual([publishFrame("chat", "generated-1", "x")]);
  });

  it("sends publishes waiting behind a full writer after the reconnect, in order", async () => {
    const { channel } = await establish();
    fillWriter(sockets.at(-1)!);
    const chat = channel.segment("chat");
    const published = ["a", "b", "c"].map((body) =>
      chat.publish({ payload: utf8(body) }),
    );

    sockets.at(-1)!.disconnect();
    await reconnect();
    await Promise.all(published);

    expect(sentFrames()).toEqual([
      publishFrame("chat", "generated-1", "a"),
      publishFrame("chat", "generated-2", "b"),
      publishFrame("chat", "generated-3", "c"),
    ]);
  });

  it("restores every subscription before any queued publish, even an earlier one to the same segment", async () => {
    const { channel } = await establish();
    channel.segment("chat").subscribe();
    channel.segment("news").subscribe();
    channel.segment("lobby").subscribePresence();

    fillWriter(sockets.at(-1)!);
    const beforeDrop = channel.segment("chat").publish({ payload: utf8("a") });
    sockets.at(-1)!.disconnect();
    const duringOutage = channel
      .segment("news")
      .publish({ payload: utf8("b") });

    await reconnect();
    await Promise.all([beforeDrop, duringOutage]);

    expect(sentFrames()).toEqual([
      "@SUB\n$4\nchat\n",
      "@SUB\n$4\nnews\n",
      "@PRES_SUB\n$5\nlobby\n",
      publishFrame("chat", "generated-1", "a"),
      publishFrame("news", "generated-2", "b"),
    ]);
  });

  it("refuses a publish while reconnecting with Backpressure when the queue is full", async () => {
    const { channel } = await establish(
      createTestChannel({ publishQueueSize: 1 }),
    );

    sockets.at(-1)!.disconnect();
    const chat = channel.segment("chat");
    const queued = chat.publish({ payload: utf8("a") });

    await expect(chat.publish({ payload: utf8("b") })).rejects.toMatchObject({
      code: "Backpressure",
      message:
        "The publish queue is full (size 1). Retry once some publishes have gone out.",
    });

    await reconnect();
    await queued;
    expect(sentFrames()).toEqual([publishFrame("chat", "generated-1", "a")]);
  });

  it("keeps the queue through a failed attempt and sends it on the next one", async () => {
    const { channel } = await establish();
    sockets.at(-1)!.disconnect();
    const published = channel.segment("chat").publish({ payload: utf8("x") });
    const progress = track(published);

    (await startReconnectAttempt()).fail();
    await flushMicrotasks();
    expect(channel.state).toBe("reconnecting");
    expect(progress.settled).toBe(false);

    await reconnect();
    await published;
    expect(sentFrames()).toEqual([publishFrame("chat", "generated-1", "x")]);
  });

  it("rejects each queued publish with the terminal error when the retries run out", async () => {
    const { channel } = await establish(
      createTestChannel({ maximumReconnectAttempts: 1 }),
    );

    const errors: unknown[] = [];
    channel.events().onError((error) => errors.push(error));
    sockets.at(-1)!.disconnect();
    const chat = channel.segment("chat");
    const outcomes = ["a", "b"].map((body) =>
      chat.publish({ payload: utf8(body) }).catch((error: unknown) => error),
    );

    (await startReconnectAttempt()).fail();
    await flushMicrotasks();

    expect(channel.state).toBe("failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "Transport" });

    for (const outcome of await Promise.all(outcomes)) {
      expect(outcome).toBe(errors[0]);
    }
  });

  it("rejects queued publishes with Cancelled when closed while reconnecting", async () => {
    const { channel } = await establish();
    sockets.at(-1)!.disconnect();
    const published = channel.segment("chat").publish({ payload: utf8("x") });

    await channel.close();

    await expect(published).rejects.toMatchObject({
      code: "Cancelled",
      message: "Channel closed before the publish was sent.",
    });
  });

  it("starts an explicit connect after failed with an empty queue", async () => {
    const { channel } = await establish(
      createTestChannel({ maximumReconnectAttempts: 1 }),
    );

    sockets.at(-1)!.disconnect();
    const published = channel
      .segment("chat")
      .publish({ payload: utf8("x") })
      .catch(() => undefined);

    (await startReconnectAttempt()).fail();
    await flushMicrotasks();
    await published;
    expect(channel.state).toBe("failed");

    const connecting = channel.connect();
    await flushMicrotasks();
    sockets.at(-1)!.open();
    await connecting;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sentFrames()).toEqual([]);
  });

  it("never resends a publish the previous socket was given", async () => {
    const { channel } = await establish();
    await channel.segment("chat").publish({ payload: utf8("x") });
    expect(sentFrames()).toEqual([publishFrame("chat", "generated-1", "x")]);

    sockets.at(-1)!.disconnect();
    await reconnect();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sentFrames()).toEqual([]);
  });

  it("withdraws a publish queued while reconnecting when its signal aborts", async () => {
    const { channel } = await establish();
    sockets.at(-1)!.disconnect();
    const controller = new AbortController();
    const published = channel
      .segment("chat")
      .publish({ payload: utf8("x"), signal: controller.signal });

    controller.abort();

    await expect(published).rejects.toMatchObject({
      code: "Cancelled",
      message: "Publish cancelled by its abort signal before it was sent.",
    });

    await reconnect();
    expect(sentFrames()).toEqual([]);
  });
});

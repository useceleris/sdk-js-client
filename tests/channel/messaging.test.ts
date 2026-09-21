import { describe, expect, it, vi } from "vitest";
import { Segment } from "../../src/segment";
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

function messageFrame(
  segmentId: string,
  messageId: string | null,
  body: string,
): ArrayBufferLike {
  const identifier =
    messageId === null ? "$-1\n" : `$${utf8(messageId).length}\n${messageId}\n`;

  return utf8(
    `@MSG\n$4\nuser\n$${utf8(segmentId).length}\n${segmentId}\n` +
      `${identifier}:1\n$${utf8(body).length}\n${body}\n`,
  ).buffer;
}

function sentFrames(): string[] {
  return sockets
    .at(-1)!
    .send.mock.calls.map(([bytes]) =>
      new TextDecoder().decode(bytes as Uint8Array),
    );
}

describe("segment proxies", () => {
  it("creates side-effect-free stateless proxies", async () => {
    const { channel } = await establish();
    const first = channel.segment("chat");
    const second = channel.segment("chat");

    expect(first).toBeInstanceOf(Segment);
    expect(first).not.toBe(second);
    expect(first.segmentId).toBe("chat");
    expect(channel.segment().segmentId).toBe("default");
    expect(sockets.at(-1)!.send).not.toHaveBeenCalled();
  });

  it.each(["", "bad\nid", "bad\rid", "\ud800"])(
    "rejects invalid segment identifiers %#",
    async (identifier) => {
      const { channel } = createTestChannel();
      expect(() => channel.segment(identifier)).toThrow(ConfigurationError);
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

  it("never sends SUB or UNSUB for the default segment", async () => {
    const { channel } = await establish();
    const membership = channel.segment().subscribe();
    membership.cancel();
    expect(sockets.at(-1)!.send).not.toHaveBeenCalled();
  });
});

describe("publish", () => {
  it("resolves on local acceptance with exact bytes and default segment", async () => {
    const { channel } = await establish();
    await channel.segment().publish({ payload: utf8("hi") });
    await channel
      .segment("chat")
      .publish({ payload: utf8("yo"), messageId: "m-1" });

    expect(sentFrames()).toEqual([
      "@PUB\n$7\ndefault\n$-1\n$2\nhi\n",
      "@PUB\n$4\nchat\n$3\nm-1\n$2\nyo\n",
    ]);
  });

  it("rejects offline publishes without queueing", async () => {
    const idle = createTestChannel();
    await expect(
      idle.channel.segment().publish({ payload: utf8("x") }),
    ).rejects.toMatchObject({ code: "NotConnected" });

    const setup = await establish();
    const segment = setup.channel.segment("chat");
    sockets.at(-1)!.disconnect();
    expect(setup.channel.state).toBe("reconnecting");
    await expect(segment.publish({ payload: utf8("x") })).rejects.toMatchObject(
      { code: "NotConnected" },
    );

    await setup.channel.close();
    await expect(segment.publish({ payload: utf8("x") })).rejects.toMatchObject(
      { code: "NotConnected" },
    );
    expect(sockets.at(-1)!.send).not.toHaveBeenCalled();
  });

  it("rejects a pre-aborted signal and invalid options before writing", async () => {
    const { channel } = await establish();
    const controller = new AbortController();
    controller.abort();
    await expect(
      channel
        .segment()
        .publish({ payload: utf8("x"), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "Cancelled" });

    await expect(
      channel.segment().publish({ payload: utf8("x"), messageId: "" }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      channel.segment().publish({ payload: new Uint8Array(131_073) }),
    ).rejects.toThrow("Encoded command exceeds 128 KiB.");
    expect(sockets.at(-1)!.send).not.toHaveBeenCalled();

    await channel.segment().publish({ payload: new Uint8Array(0) });
    expect(sentFrames()).toEqual(["@PUB\n$7\ndefault\n$-1\n$0\n\n"]);
  });

  it("bounds the writer at 64 commands with observed-drain reset", async () => {
    const { channel } = await establish();
    const socket = sockets.at(-1)!;
    socket.send.mockImplementation(() => {
      socket.bufferedAmount += 1;
    });

    const lobby = channel.segment();
    for (let index = 0; index < 64; index += 1) {
      await lobby.publish({ payload: utf8("x") });
    }
    await expect(lobby.publish({ payload: utf8("x") })).rejects.toMatchObject({
      code: "Backpressure",
      message: "Command writer is full.",
    });
    expect(channel.state).toBe("connected");
    expect(socket.send).toHaveBeenCalledTimes(64);

    socket.bufferedAmount = 0;
    await lobby.publish({ payload: utf8("x") });
    expect(socket.send).toHaveBeenCalledTimes(65);
  });

  it("maps a native send failure to DeliveryUnknown and stays connected", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    channel.events().onError((error) => errors.push(error));
    sockets.at(-1)!.send.mockImplementation(() => {
      throw new Error("synthetic-secret");
    });

    await expect(
      channel.segment().publish({ payload: utf8("x") }),
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
    setup.channel.segment().subscribe();

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

  it("fails terminally when a runtime interest write hits the writer bound", async () => {
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

    channel.segment("chat").subscribe();
    expect(channel.state).toBe("failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "Backpressure" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects initial-connect flush failure without onError", async () => {
    const setup = createTestChannel();
    const errors: unknown[] = [];
    setup.channel.events().onError((error) => errors.push(error));
    for (let index = 0; index < 65; index += 1) {
      setup.channel.segment(`segment-${index}`).subscribe();
    }

    vi.useFakeTimers();
    const pending = setup.channel.connect();
    const rejection = expect(pending).rejects.toMatchObject({
      code: "Backpressure",
    });
    await flushMicrotasks();
    const socket = sockets.at(-1)!;
    socket.send.mockImplementation(() => {
      socket.bufferedAmount += 1;
    });
    socket.open();
    await rejection;

    expect(setup.channel.state).toBe("failed");
    expect(errors).toEqual([]);
    expect(socket.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects subscribe on a closed channel", async () => {
    const { channel } = createTestChannel();
    await channel.close();
    expect(() => channel.segment("chat").subscribe()).toThrow(
      "Channel is closed.",
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
      .onMessage((message) => chatMessages.push(message.messageId));
    channel
      .segment()
      .onMessage((message) => lobbyMessages.push(message.messageId));

    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "hi"));
    sockets.at(-1)!.receive(messageFrame("default", "id-2", "yo"));
    sockets.at(-1)!.receive(messageFrame("other", "id-3", "no"));

    expect(chatMessages).toEqual(["id-1"]);
    expect(lobbyMessages).toEqual(["id-2"]);
  });

  it("delivers to every listener across proxy instances and preserves fields", async () => {
    const { channel } = await establish();
    const seen: unknown[] = [];
    channel.segment("chat").onMessage((message) => seen.push(message));
    channel.segment("chat").onMessage((message) => seen.push(message));

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
      .onMessage((message) => delivered.push(message.messageId));
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "hi"));
    sockets.at(-1)!.receive(messageFrame("chat", "id-2", "hi"));
    sockets.at(-1)!.receive(messageFrame("chat", "id-2", "hi"));

    expect(delivered).toEqual(["id-2"]);
  });

  it("evicts the oldest id beyond the window size", async () => {
    const { channel } = await establish();
    const delivered: string[] = [];
    channel
      .segment("chat")
      .onMessage((message) => delivered.push(message.messageId));

    sockets.at(-1)!.receive(messageFrame("chat", "id-0", "x"));
    for (let index = 1; index <= 1024; index += 1) {
      sockets.at(-1)!.receive(messageFrame("chat", `id-${index}`, "x"));
    }
    sockets.at(-1)!.receive(messageFrame("chat", "id-0", "x"));

    expect(delivered).toHaveLength(1026);
    expect(delivered.at(-1)).toBe("id-0");
  });

  it("keeps the window across reconnect and clears it on a fresh connect", async () => {
    const setup = await establish();
    const delivered: string[] = [];
    setup.channel
      .segment("chat")
      .onMessage((message) => delivered.push(message.messageId));
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
      .onMessage((message) => redelivered.push(message.messageId));
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));
    expect(redelivered).toEqual(["id-1"]);
  });

  it("treats a null-id message as protocol corruption (REV-01 strict)", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const delivered: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel
      .segment("chat")
      .onMessage((message) => delivered.push(message.messageId));

    sockets.at(-1)!.receive(messageFrame("chat", null, "x"));

    expect(delivered).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "ProtocolError",
      message: "Server message is missing its identifier.",
    });
    expect(channel.state).toBe("failed");
    expect(sockets.at(-1)!.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores server notices and reports error frames while staying connected", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const delivered: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel
      .segment("chat")
      .onMessage((message) => delivered.push(message.messageId));

    // The server greets every connect with untagged prose notices.
    sockets
      .at(-1)!
      .receive(
        utf8('@SERVER_MSG\n:1\n$29\nSuccessfully connected to "x"\n').buffer,
      );
    sockets.at(-1)!.receive(utf8("-Err\nRateLimitError\nslow down").buffer);
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "Transport",
      message: "Server reported an error.",
    });
    expect(JSON.stringify(errors[0])).not.toContain("slow down");
    expect(channel.state).toBe("connected");
    expect(delivered).toEqual(["id-1"]);
  });

  it("maps permission-denied error frames to the Permission code", async () => {
    const { channel } = await establish();
    const errors: unknown[] = [];
    const delivered: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel
      .segment("chat")
      .onMessage((message) => delivered.push(message.messageId));

    // A denied publish resolves locally; the error arrives uncorrelated.
    await channel.segment("chat").publish({ payload: utf8("x") });
    sockets.at(-1)!.receive(utf8("-Err\nPermissionDeniedError\ndenied").buffer);
    sockets.at(-1)!.receive(messageFrame("chat", "id-1", "x"));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "Permission",
      message: "Server denied permission.",
    });
    expect(JSON.stringify(errors[0])).not.toContain("denied");
    expect(channel.state).toBe("connected");
    expect(delivered).toEqual(["id-1"]);
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
    expect(errors[0]).toMatchObject({ message: "Listener callback failed." });
    expect(channel.state).toBe("connected");
  });

  it("fans out nested arrays preserving arrival order", async () => {
    const { channel } = await establish();
    const delivered: string[] = [];
    channel
      .segment("chat")
      .onMessage((message) => delivered.push(message.messageId));

    const first = "@MSG\n$4\nuser\n$4\nchat\n$4\nal-1\n:1\n$1\na\n";
    const second = "@MSG\n$4\nuser\n$4\nchat\n$4\nal-2\n:2\n$1\nb\n";
    sockets.at(-1)!.receive(utf8(`*2\n${first}${second}`).buffer);

    expect(delivered).toEqual(["al-1", "al-2"]);
  });
});

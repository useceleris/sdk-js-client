import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../../src/channel";
import { createClient, type ClientOptions } from "../../src/client";
import { utf8 } from "../fixtures/codec-vectors";
import {
  createClientChannel,
  flushMicrotasks,
  messageFrame,
  testCredentials,
} from "../helpers/channel";
import {
  sockets,
  useTestWebSockets,
  TestWebSocket,
} from "../helpers/websocket";

// Every option goes through createClient, so the tests cover the plumbing
// from the public options to the channel, not just the channel itself.
useTestWebSockets();

beforeEach(() => {
  vi.useFakeTimers();
  // Retries start at once, so each reconnect attempt begins at a known time.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const credentialProvider = async () => testCredentials;

const NUMBER_OPTIONS = [
  "connectTimeoutMs",
  "reconnectTimeoutMs",
  "presenceQueryTimeoutMs",
  "publishQueueSize",
  "deduplicationWindowSize",
  "maximumReconnectAttempts",
] as const;

const TIMEOUT_OPTIONS = [
  "connectTimeoutMs",
  "reconnectTimeoutMs",
  "presenceQueryTimeoutMs",
] as const;

const WRITER_FULL_BYTES = 2 * 1024 * 1024;

// The error createClient throws for these options, or undefined.
function refusal(options: Record<string, unknown>): unknown {
  try {
    createClient({ credentialProvider, ...options });
  } catch (error) {
    return error;
  }

  return undefined;
} // end function refusal

function expectRefused(options: Record<string, unknown>, message: string) {
  expect(refusal(options)).toMatchObject({ code: "Configuration", message });
} // end function expectRefused

async function connectOpen(channel: Channel): Promise<void> {
  const pending = channel.connect();
  await flushMicrotasks();
  sockets.at(-1)!.open();
  await pending;
} // end function connectOpen

// The first connect attempt is pending at timeoutMs − 1 and fails at timeoutMs.
async function expectConnectTimeoutAt(channel: Channel, timeoutMs: number) {
  const rejection = expect(channel.connect()).rejects.toMatchObject({
    code: "Timeout",
    message: `Connection attempt timed out after ${timeoutMs} ms.`,
  });

  await vi.advanceTimersByTimeAsync(timeoutMs - 1);
  expect(channel.state).toBe("connecting");

  await vi.advanceTimersByTimeAsync(1);
  await rejection;
  expect(channel.state).toBe("failed");
} // end function expectConnectTimeoutAt

// Drops the socket; the reconnect attempt is pending at timeoutMs − 1 and is
// abandoned at timeoutMs, when a retry follows.
async function expectReconnectTimeoutAt(channel: Channel, timeoutMs: number) {
  sockets.at(-1)!.disconnect();
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks();
  const attempt = sockets.at(-1)!;
  const socketCount = sockets.length;

  await vi.advanceTimersByTimeAsync(timeoutMs - 1);
  expect(attempt.close).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(socketCount);

  await vi.advanceTimersByTimeAsync(1);
  expect(attempt.close).toHaveBeenCalledTimes(1);

  // Fake timers run a zero-delay retry one millisecond later.
  await vi.advanceTimersByTimeAsync(1);
  await flushMicrotasks();
  expect(sockets).toHaveLength(socketCount + 1);
  expect(channel.state).toBe("reconnecting");
} // end function expectReconnectTimeoutAt

function sentFrames(socket: TestWebSocket): string[] {
  return socket.send.mock.calls.map(([bytes]) =>
    new TextDecoder().decode(bytes as Uint8Array),
  );
} // end function sentFrames

describe("client option validation", () => {
  it.each(NUMBER_OPTIONS)(
    "refuses a zero, negative, fractional or non-number %s",
    (option) => {
      const refusals: readonly [unknown, string][] = [
        [0, "Too small: expected number to be >=1"],
        [-1, "Too small: expected number to be >=1"],
        [1.5, "Invalid input: expected int, received number"],
        ["5", "Invalid input: expected number, received string"],
        [true, "Invalid input: expected number, received boolean"],
        [null, "Invalid input: expected number, received null"],
      ];

      for (const [value, rule] of refusals) {
        expectRefused(
          { [option]: value },
          `Invalid client options. ${option}: ${rule}.`,
        );
      }
    },
  );

  it.each(TIMEOUT_OPTIONS)("accepts %s from 1 ms to 15 minutes", (option) => {
    expect(refusal({ [option]: 1 })).toBeUndefined();
    expect(refusal({ [option]: 900_000 })).toBeUndefined();
    expectRefused(
      { [option]: 900_001 },
      `Invalid client options. ${option}: Too big: expected number to be <=900000.`,
    );
  });

  it("accepts maximumReconnectAttempts from 1 to 100", () => {
    expect(refusal({ maximumReconnectAttempts: 1 })).toBeUndefined();
    expect(refusal({ maximumReconnectAttempts: 100 })).toBeUndefined();
    expectRefused(
      { maximumReconnectAttempts: 101 },
      "Invalid client options. maximumReconnectAttempts: Too big: expected number to be <=100.",
    );
  });

  it("refuses a missing or uncallable credentialProvider", () => {
    const message =
      "Invalid client options. credentialProvider: Must be a function.";

    for (const provider of [undefined, "provider", {}]) {
      expectRefused({ credentialProvider: provider }, message);
    }

    expect(() => createClient(undefined as never)).toThrow(message);
  });

  it("refuses a baseUrl that is not a non-empty string", () => {
    expectRefused(
      { baseUrl: 1 },
      "Invalid client options. baseUrl: Invalid input: expected string, received number.",
    );

    expectRefused(
      { baseUrl: null },
      "Invalid client options. baseUrl: Invalid input: expected string, received null.",
    );

    expectRefused(
      { baseUrl: "" },
      "Invalid client options. baseUrl: Too small: expected string to have >=1 characters.",
    );
  });

  it("refuses an allowInsecureLoopback that is not a boolean", () => {
    for (const [value, received] of [
      ["true", "string"],
      [1, "number"],
      [null, "null"],
    ] as const) {
      expectRefused(
        { allowInsecureLoopback: value },
        `Invalid client options. allowInsecureLoopback: Invalid input: expected boolean, received ${received}.`,
      );
    }
  });

  it("accepts ws:// only for a loopback host with allowInsecureLoopback", async () => {
    const message =
      "Invalid connection URL. baseUrl must use wss://, or ws:// for a loopback host when allowInsecureLoopback is true.";

    expectRefused({ baseUrl: "ws://localhost:8080" }, message);
    expectRefused(
      { baseUrl: "ws://localhost:8080", allowInsecureLoopback: false },
      message,
    );

    expectRefused(
      { baseUrl: "ws://example.test", allowInsecureLoopback: true },
      message,
    );

    const { channel } = createClientChannel({
      baseUrl: "ws://localhost:8080",
      allowInsecureLoopback: true,
    });
    await connectOpen(channel);
    expect(sockets.at(-1)!.url).toMatch(
      /^ws:\/\/localhost:8080\/channel\/room-1\?/,
    );
  });
});

describe("connect and reconnect timeouts", () => {
  it.each([
    ["the defaults", {}, 15_000, 15_000],
    [
      "a custom connect timeout and no reconnect timeout",
      { connectTimeoutMs: 4_000 },
      4_000,
      4_000,
    ],
    [
      "equal timeouts",
      { connectTimeoutMs: 5_000, reconnectTimeoutMs: 5_000 },
      5_000,
      5_000,
    ],
    [
      "a longer reconnect timeout",
      { connectTimeoutMs: 2_000, reconnectTimeoutMs: 7_000 },
      2_000,
      7_000,
    ],
    [
      "a shorter reconnect timeout",
      { connectTimeoutMs: 7_000, reconnectTimeoutMs: 2_000 },
      7_000,
      2_000,
    ],
    [
      "the largest timeouts",
      { connectTimeoutMs: 900_000, reconnectTimeoutMs: 900_000 },
      900_000,
      900_000,
    ],
  ] as const)(
    "times out connect and reconnect attempts with %s",
    async (_description, options, connectTimeoutMs, reconnectTimeoutMs) => {
      const { channel } = createClientChannel(options);

      await expectConnectTimeoutAt(channel, connectTimeoutMs);
      await connectOpen(channel);
      await expectReconnectTimeoutAt(channel, reconnectTimeoutMs);

      await channel.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reports the reconnect timeout once the retries run out", async () => {
    const { channel } = createClientChannel({
      connectTimeoutMs: 7_000,
      reconnectTimeoutMs: 2_000,
    });
    const errors: unknown[] = [];
    channel.events().onError((error) => errors.push(error));
    await connectOpen(channel);

    sockets.at(-1)!.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await vi.advanceTimersByTimeAsync(2_001);
    }

    await flushMicrotasks();
    expect(channel.state).toBe("failed");
    expect(errors).toEqual([
      expect.objectContaining({
        code: "Timeout",
        message: "Connection attempt timed out after 2000 ms.",
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("presence query timeout", () => {
  it.each([
    ["the default", {}, 10_000],
    ["a custom", { presenceQueryTimeoutMs: 2_000 }, 2_000],
    ["the largest", { presenceQueryTimeoutMs: 900_000 }, 900_000],
  ] as const)(
    "rejects at %s timeout and keeps the connection",
    async (_description, options, timeoutMs) => {
      const { channel } = createClientChannel(options);
      await connectOpen(channel);
      let settled = false;
      const outcome = channel
        .segment("chat")
        .presenceList({ page: 1, perPage: 25 })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({
        code: "Timeout",
        message: `Presence query timed out after ${timeoutMs} ms.`,
      });
      expect(channel.state).toBe("connected");
      expect(sockets.at(-1)!.close).not.toHaveBeenCalled();
    },
  );
});

describe("publish queue size", () => {
  it("queues one publish behind a full writer and rejects the next", async () => {
    const { channel } = createClientChannel({ publishQueueSize: 1 });
    await connectOpen(channel);
    const socket = sockets.at(-1)!;
    socket.bufferedAmount = WRITER_FULL_BYTES;

    const lobby = channel.defaultSegment();
    const first = lobby.publish({ payload: utf8("one"), messageId: "first" });
    await expect(lobby.publish({ payload: utf8("two") })).rejects.toMatchObject(
      {
        code: "Backpressure",
        message:
          "The publish queue is full (size 1). Retry once some publishes have gone out.",
      },
    );
    expect(socket.send).not.toHaveBeenCalled();

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await first;
    expect(sentFrames(socket)).toEqual([
      "@PUB\n$7\ndefault\n$5\nfirst\n$3\none\n",
    ]);
  });

  it("queues 64 publishes by default and rejects the 65th", async () => {
    const { channel } = createClientChannel();
    await connectOpen(channel);
    const socket = sockets.at(-1)!;
    socket.bufferedAmount = WRITER_FULL_BYTES;

    const lobby = channel.defaultSegment();
    const queued = Array.from({ length: 64 }, () =>
      lobby.publish({ payload: utf8("x") }),
    );
    await expect(lobby.publish({ payload: utf8("x") })).rejects.toMatchObject({
      code: "Backpressure",
      message:
        "The publish queue is full (size 64). Retry once some publishes have gone out.",
    });

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(queued);
    expect(socket.send).toHaveBeenCalledTimes(64);
  });

  it("sends many queued publishes in the order they were made", async () => {
    const { channel } = createClientChannel({ publishQueueSize: 500 });
    await connectOpen(channel);
    const socket = sockets.at(-1)!;
    socket.bufferedAmount = WRITER_FULL_BYTES;

    const lobby = channel.defaultSegment();
    const identifiers = Array.from({ length: 500 }, (_, index) => `m-${index}`);
    const queued = identifiers.map((messageId) =>
      lobby.publish({ payload: utf8("x"), messageId }),
    );

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(queued);
    expect(sentFrames(socket)).toEqual(
      identifiers.map(
        (messageId) =>
          `@PUB\n$7\ndefault\n$${messageId.length}\n${messageId}\n$1\nx\n`,
      ),
    );
  });
});

describe("deduplication window size", () => {
  async function connectRecording(options: Partial<ClientOptions> = {}) {
    const { channel } = createClientChannel(options);
    await connectOpen(channel);
    const delivered: string[] = [];
    channel
      .events()
      .onMessage((_payload, metadata) => delivered.push(metadata.messageId));

    const receive = (messageId: string): void =>
      sockets.at(-1)!.receive(messageFrame("chat", messageId, "x"));

    return { delivered, receive };
  } // end function connectRecording

  it("drops a repeat within a window of one and delivers it once evicted", async () => {
    const { delivered, receive } = await connectRecording({
      deduplicationWindowSize: 1,
    });

    for (const messageId of ["A", "A", "B", "A"]) receive(messageId);

    expect(delivered).toEqual(["A", "B", "A"]);
  });

  it("remembers 1024 ids by default", async () => {
    const { delivered, receive } = await connectRecording();

    for (let index = 0; index < 1024; index += 1) receive(`id-${index}`);

    receive("id-0");
    expect(delivered).toHaveLength(1024);

    // id-1024 evicts id-0, so id-0 is delivered again.
    receive("id-1024");
    receive("id-0");
    expect(delivered.slice(-2)).toEqual(["id-1024", "id-0"]);
  });
});

describe("maximum reconnect attempts", () => {
  // Connects through the public constructor and drops the socket, so the
  // first reconnect attempt is scheduled.
  async function connectAndDrop(options: Partial<ClientOptions> = {}) {
    const { channel, credentialProvider } = createClientChannel(options);
    const errors: unknown[] = [];
    const states: string[] = [];
    channel.events().onError((error) => errors.push(error));
    channel.events().onStateChange((state) => states.push(state));
    await connectOpen(channel);
    sockets.at(-1)!.disconnect();

    const reconnectRequests = () =>
      credentialProvider.mock.calls.filter(
        ([request]) => request.reason === "reconnect",
      ).length;

    return { channel, errors, states, reconnectRequests };
  } // end function connectAndDrop

  // Runs the scheduled attempt: with Math.random mocked to 0 every retry
  // delay is zero, which fake timers run one millisecond later.
  async function startScheduledAttempt(): Promise<void> {
    const socketCount = sockets.length;
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(sockets).toHaveLength(socketCount + 1);
  } // end function startScheduledAttempt

  async function failScheduledAttempts(count: number): Promise<void> {
    for (let attempt = 0; attempt < count; attempt += 1) {
      await startScheduledAttempt();
      sockets.at(-1)!.fail();
      await flushMicrotasks();
    }
  } // end function failScheduledAttempts

  async function succeedScheduledAttempt(): Promise<void> {
    await startScheduledAttempt();
    sockets.at(-1)!.open();
    await flushMicrotasks();
  } // end function succeedScheduledAttempt

  function expectFailedOnce(setup: {
    channel: Channel;
    errors: unknown[];
    states: string[];
  }): void {
    expect(setup.channel.state).toBe("failed");
    expect(setup.errors).toHaveLength(1);
    expect(setup.errors[0]).toMatchObject({ code: "Transport" });
    expect(setup.states.slice(-2)).toEqual(["reconnecting", "failed"]);
    expect(vi.getTimerCount()).toBe(0);
  } // end function expectFailedOnce

  it("fails on the first failed attempt with a maximum of 1", async () => {
    const setup = await connectAndDrop({ maximumReconnectAttempts: 1 });

    await failScheduledAttempts(1);

    expectFailedOnce(setup);
    expect(setup.reconnectRequests()).toBe(1);
  });

  it("fails after exactly 3 failed attempts with a maximum of 3", async () => {
    const setup = await connectAndDrop({ maximumReconnectAttempts: 3 });

    await failScheduledAttempts(2);
    expect(setup.channel.state).toBe("reconnecting");
    expect(vi.getTimerCount()).toBe(1);

    await failScheduledAttempts(1);
    expectFailedOnce(setup);
    expect(setup.reconnectRequests()).toBe(3);
  });

  it("fails after 10 failed attempts by default", async () => {
    const setup = await connectAndDrop();

    await failScheduledAttempts(9);
    expect(setup.channel.state).toBe("reconnecting");

    await failScheduledAttempts(1);
    expectFailedOnce(setup);
    expect(setup.reconnectRequests()).toBe(10);
  });

  it("keeps reconnecting past 10 failed attempts with a maximum of 100", async () => {
    const setup = await connectAndDrop({ maximumReconnectAttempts: 100 });

    await failScheduledAttempts(10);
    expect(setup.channel.state).toBe("reconnecting");
    expect(setup.errors).toHaveLength(0);

    await startScheduledAttempt();
    expect(setup.reconnectRequests()).toBe(11);
    await setup.channel.close();
  });

  it("keeps spent attempts for an outage within sixty seconds of recovery", async () => {
    const setup = await connectAndDrop({ maximumReconnectAttempts: 2 });

    await failScheduledAttempts(1);
    await succeedScheduledAttempt();
    expect(setup.channel.state).toBe("connected");

    await vi.advanceTimersByTimeAsync(59_000);
    sockets.at(-1)!.disconnect();
    await failScheduledAttempts(1);

    expectFailedOnce(setup);
    expect(setup.reconnectRequests()).toBe(3);
  });

  it("allows the full maximum again after sixty seconds connected", async () => {
    const setup = await connectAndDrop({ maximumReconnectAttempts: 2 });

    await failScheduledAttempts(1);
    await succeedScheduledAttempt();
    expect(setup.channel.state).toBe("connected");

    await vi.advanceTimersByTimeAsync(60_000);
    sockets.at(-1)!.disconnect();
    await failScheduledAttempts(1);
    expect(setup.channel.state).toBe("reconnecting");

    await failScheduledAttempts(1);
    expectFailedOnce(setup);
    expect(setup.reconnectRequests()).toBe(4);
  });
});

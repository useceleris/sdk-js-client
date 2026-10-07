import { describe, expect, it, vi } from "vitest";
import { createClient } from "../../src/client";
import { ConfigurationError } from "../../src/errors";
import {
  createTestChannel,
  flushMicrotasks,
  testCredentials,
} from "../helpers/channel";
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

async function expectAttemptAfter(delayMs: number): Promise<void> {
  const socketCount = sockets.length;
  if (delayMs > 0) {
    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(sockets).toHaveLength(socketCount);
    await vi.advanceTimersByTimeAsync(1);
  } else {
    await vi.advanceTimersByTimeAsync(0);
  }
  await flushMicrotasks();
  expect(sockets).toHaveLength(socketCount + 1);
}

async function failAttemptAfter(delayMs: number): Promise<void> {
  await expectAttemptAfter(delayMs);
  sockets.at(-1)!.fail();
  await flushMicrotasks();
}

async function succeedAttemptAfter(delayMs: number): Promise<void> {
  await expectAttemptAfter(delayMs);
  sockets.at(-1)!.open();
  await flushMicrotasks();
}

describe("channel reconnect", () => {
  it("bounds jittered delays per retry index and fails after ten retries", async () => {
    const setup = await establish();
    setup.clocks.randomValue = 0.5;
    const errors: unknown[] = [];
    const states: string[] = [];
    setup.channel.events().onError((error) => errors.push(error));
    setup.channel.events().onStateChange((state) => states.push(state));

    sockets[0]!.disconnect();
    expect(setup.channel.state).toBe("reconnecting");

    const expectedDelays = [
      250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000,
    ];
    for (const delay of expectedDelays) await failAttemptAfter(delay);

    expect(setup.channel.state).toBe("failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "Transport" });
    expect(states).toEqual(["reconnecting", "failed"]);
    const reconnectRequests = setup.credentialProvider.mock.calls.filter(
      ([request]) => request.reason === "reconnect",
    );
    expect(reconnectRequests).toHaveLength(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the retry budget only after sixty seconds connected", async () => {
    const setup = await establish();
    setup.clocks.randomValue = 0.5;

    sockets.at(-1)!.disconnect();
    for (const delay of [250, 500, 1_000]) await failAttemptAfter(delay);
    await succeedAttemptAfter(2_000);
    expect(setup.channel.state).toBe("connected");

    setup.clocks.monotonic += 1_000;
    sockets.at(-1)!.disconnect();
    await succeedAttemptAfter(2_000);
    expect(setup.channel.state).toBe("connected");

    setup.clocks.monotonic += 60_000;
    sockets.at(-1)!.disconnect();
    await succeedAttemptAfter(250);
    expect(setup.channel.state).toBe("connected");
    await setup.channel.close();
  });

  it("emits recovery after the connected state change with the attempt index", async () => {
    const setup = await establish();
    const log: unknown[] = [];
    setup.channel.events().onStateChange((state) => log.push(`state:${state}`));
    setup.channel.events().onRecovery((event) => log.push({ recovery: event }));

    sockets.at(-1)!.disconnect();
    await failAttemptAfter(0);
    await failAttemptAfter(0);
    await succeedAttemptAfter(0);

    expect(log).toEqual([
      "state:reconnecting",
      "state:connected",
      {
        recovery: {
          retryIndex: 2,
          possibleGaps: true,
          possibleDuplicates: true,
        },
      },
    ]);
    await setup.channel.close();
  });

  it("requests fresh reconnect credentials with preserved outage and growing capped lookback", async () => {
    const setup = await establish();
    setup.clocks.monotonic = 5_000;
    setup.clocks.wall = 1_700_000_100_000;

    sockets.at(-1)!.disconnect();
    await failAttemptAfter(0);

    setup.clocks.monotonic = 6_500;
    setup.clocks.wall = 999; // wall-clock change must not affect elapsed time
    await failAttemptAfter(0);

    setup.clocks.monotonic = 5_000 + 5_000_000_000;
    await failAttemptAfter(0);

    const reconnectRequests = setup.credentialProvider.mock.calls
      .map(([request]) => request)
      .filter((request) => request.reason === "reconnect");
    expect(reconnectRequests).toHaveLength(3);
    for (const request of reconnectRequests) {
      expect(request.disconnectedAt).toBe(1_700_000_100_000);
      expect(request.signal).toBeInstanceOf(AbortSignal);
    }
    expect(
      reconnectRequests.map((request) => request.replayLookbackMs),
    ).toEqual([5_000, 6_500, 4_294_967_295]);
    await setup.channel.close();
  });

  it("fails immediately on deterministic reconnect errors", async () => {
    const setup = await establish();
    const errors: unknown[] = [];
    setup.channel.events().onError((error) => errors.push(error));
    setup.credentialProvider.mockResolvedValueOnce(
      {} as typeof testCredentials,
    );

    sockets.at(-1)!.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(setup.channel.state).toBe("failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ConfigurationError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays connected through protocol corruption on a connected socket", async () => {
    const setup = await establish();
    const errors: unknown[] = [];
    setup.channel.events().onError((error) => errors.push(error));

    sockets.at(-1)!.receive("text");

    // DECODE-01: the bad frame is dropped and reported; there is nothing to
    // retry because the connection was never lost.
    expect(setup.channel.state).toBe("connected");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ name: "ProtocolError" });
    expect(sockets.at(-1)!.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enters reconnecting exactly once for a transport error with trailing close", async () => {
    const setup = await establish();
    const states: string[] = [];
    setup.channel.events().onStateChange((state) => states.push(state));

    sockets.at(-1)!.fail();

    expect(states).toEqual(["reconnecting"]);
    expect(setup.channel.state).toBe("reconnecting");
    expect(vi.getTimerCount()).toBe(1);
    await setup.channel.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies reconnectTimeoutMs to reconnect attempts only", async () => {
    vi.useFakeTimers();
    const setup = createTestChannel({
      connectTimeoutMs: 15_000,
      reconnectTimeoutMs: 3_000,
    });
    setup.credentialProvider.mockImplementation(
      () => new Promise(() => undefined),
    );

    const pending = setup.channel.connect();
    const rejection = expect(pending).rejects.toMatchObject({
      code: "Timeout",
      message: "Connection attempt timed out after 15000 ms.",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(setup.channel.state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection;
    expect(setup.channel.state).toBe("failed");

    setup.credentialProvider.mockResolvedValue(testCredentials);
    await establish(setup);
    expect(setup.channel.state).toBe("connected");

    const errors: unknown[] = [];
    setup.channel.events().onError((error) => errors.push(error));
    setup.credentialProvider.mockImplementation(
      () => new Promise(() => undefined),
    );
    sockets.at(-1)!.disconnect();
    expect(setup.channel.state).toBe("reconnecting");

    const reconnectCredentialCalls = (): number =>
      setup.credentialProvider.mock.calls.filter(
        ([request]) => request.reason === "reconnect",
      ).length;

    // The first attempt starts on the zero-jitter retry and holds through
    // the full reconnect deadline before timing out and retrying.
    await vi.advanceTimersByTimeAsync(0);
    expect(reconnectCredentialCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(reconnectCredentialCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(reconnectCredentialCalls()).toBe(2);

    for (let attempt = 2; attempt <= 10; attempt += 1)
      await vi.advanceTimersByTimeAsync(3_001);

    await flushMicrotasks();
    expect(reconnectCredentialCalls()).toBe(10);
    expect(setup.channel.state).toBe("failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "Timeout",
      message: "Connection attempt timed out after 3000 ms.",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults the reconnect attempt deadline to connectTimeoutMs", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const credentialProvider = vi.fn(async () => testCredentials);
    const channel = createClient({
      baseUrl: "wss://example.test",
      credentialProvider,
      connectTimeoutMs: 5_000,
    }).channel("room-1");

    const pending = channel.connect();
    await flushMicrotasks();
    sockets.at(-1)!.open();
    await pending;

    credentialProvider.mockImplementation(() => new Promise(() => undefined));
    sockets.at(-1)!.disconnect();
    expect(channel.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(credentialProvider).toHaveBeenCalledTimes(2);

    // The attempt holds for the full connect deadline, then times out and
    // the immediate (zero-jitter) retry asks for credentials again.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(credentialProvider).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(credentialProvider).toHaveBeenCalledTimes(3);

    await channel.close();
    randomSpy.mockRestore();
  });

  it("stops reconnecting when closed mid-attempt", async () => {
    const setup = await establish();
    const states: string[] = [];

    sockets.at(-1)!.disconnect();
    await expectAttemptAfter(0);
    setup.channel.events().onStateChange((state) => states.push(state));

    await setup.channel.close();
    expect(states).toEqual(["closing", "closed"]);

    sockets.at(-1)!.open();
    await flushMicrotasks();
    expect(setup.channel.state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });
});

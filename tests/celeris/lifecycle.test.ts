import { afterEach, describe, expect, it } from "vitest";
import {
  createClient,
  type Channel,
  type ChannelError,
  type ChannelState,
  type ClientOptions,
  type CredentialRequest,
  type RecoveryEvent,
} from "../../src/index";
import { signCredentials } from "./helpers/credentials";
import {
  startDroppingProxy,
  type DroppingProxy,
} from "./helpers/dropping-proxy";
import {
  clientId,
  connectedChannel,
  nextMessage,
  signingSecret,
  uniqueChannelReference,
  waitFor,
  websocketUrl,
} from "./helpers/environment";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);
const settle = (ms = 1_500) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const opened: Channel[] = [];
let proxy: DroppingProxy | undefined;

afterEach(async () => {
  await Promise.all(opened.splice(0).map((channel) => channel.close()));
  await proxy?.close();
  proxy = undefined;
});

// A channel behind a fresh dropping proxy; the provider records requests.
async function proxiedChannel(
  label: string,
  options: Partial<ClientOptions> = {},
) {
  const activeProxy = await startDroppingProxy(websocketUrl());
  proxy = activeProxy;
  const requests: CredentialRequest[] = [];
  const channel = createClient({
    baseUrl: activeProxy.url,
    allowInsecureLoopback: true,
    credentialProvider: async (request) => {
      requests.push(request);

      return signCredentials(clientId(), signingSecret());
    },
    ...options,
  }).channel(uniqueChannelReference(label));
  opened.push(channel);
  const states: ChannelState[] = [];
  channel.events().onStateChange((state) => states.push(state));
  const errors: ChannelError[] = [];
  channel.events().onError((error) => errors.push(error));

  return { proxy: activeProxy, channel, requests, states, errors };
} // end function proxiedChannel

const untilState = (
  channel: Channel,
  state: ChannelState,
  timeoutMs: number,
) =>
  channel.state === state
    ? Promise.resolve(state)
    : waitFor<ChannelState>(
        (deliver) => channel.events().onStateChange(deliver),
        (current) => current === state,
        timeoutMs,
        `the ${state} state`,
      );

describe("celeris lifecycle", () => {
  it("fails a connect at its connect timeout when the server never answers", async () => {
    const setup = await proxiedChannel("lifecycle-timeout", {
      connectTimeoutMs: 2_000,
    });
    setup.proxy.setBlackhole(true);

    const started = Date.now();
    await expect(setup.channel.connect()).rejects.toMatchObject({
      code: "Timeout",
      message: "Connection attempt timed out after 2000 ms.",
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(4_000);
    expect(setup.channel.state).toBe("failed");
    expect(setup.states).toEqual(["connecting", "failed"]);
    // One failure, one report: the caller only (LIFE-02).
    expect(setup.errors).toEqual([]);
  });

  it("times out at a 1 ms connect timeout against the real server", async () => {
    const channel = createClient({
      baseUrl: websocketUrl(),
      allowInsecureLoopback: true,
      connectTimeoutMs: 1,
      credentialProvider: async () =>
        signCredentials(clientId(), signingSecret()),
    }).channel(uniqueChannelReference("lifecycle-1ms"));
    opened.push(channel);

    await expect(channel.connect()).rejects.toMatchObject({ code: "Timeout" });
    expect(channel.state).toBe("failed");
  });

  it("cancels a connect from its abort signal", async () => {
    const setup = await proxiedChannel("lifecycle-abort");
    setup.proxy.setBlackhole(true);
    const controller = new AbortController();

    const pending = setup.channel.connect({ signal: controller.signal });
    await settle(500);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "Cancelled" });
    expect(setup.channel.state).toBe("failed");
  });

  it("closes a channel that is still connecting", async () => {
    const setup = await proxiedChannel("lifecycle-close-connecting");
    setup.proxy.setBlackhole(true);

    const pending = setup.channel.connect();
    const rejected = expect(pending).rejects.toMatchObject({
      code: "Cancelled",
    });
    await settle(500);
    await setup.channel.close();
    await rejected;

    expect(setup.channel.state).toBe("closed");
    await expect(setup.channel.connect()).rejects.toMatchObject({
      code: "NotConnected",
    });
  });

  it("closes a channel that is reconnecting and stops its retries", async () => {
    const setup = await proxiedChannel("lifecycle-close-reconnecting");
    await setup.channel.connect();
    setup.proxy.setRefusing(true);
    setup.proxy.dropAll();
    await untilState(setup.channel, "reconnecting", 5_000);
    await settle(1_000);

    await setup.channel.close();
    const requestsAtClose = setup.requests.length;
    setup.proxy.setRefusing(false);
    await settle(5_000);

    expect(setup.channel.state).toBe("closed");
    expect(setup.requests.length).toBe(requestsAtClose);
  });

  it("rejects a publish queued while reconnecting with the terminal error, and refuses one after failed", async () => {
    const setup = await proxiedChannel("lifecycle-publish-reconnecting", {
      maximumReconnectAttempts: 2,
    });

    await setup.channel.connect();
    setup.proxy.setRefusing(true);
    setup.proxy.dropAll();
    await untilState(setup.channel, "reconnecting", 5_000);

    const queued = setup.channel
      .segment("chat")
      .publish({ payload: utf8("x") })
      .catch((error: unknown) => error);

    await untilState(setup.channel, "failed", 60_000);

    expect(setup.errors).toHaveLength(1);
    expect(setup.errors[0]).toMatchObject({ code: "Transport" });
    expect(await queued).toBe(setup.errors[0]);
    await expect(
      setup.channel.segment("chat").publish({ payload: utf8("y") }),
    ).rejects.toMatchObject({
      code: "NotConnected",
      message: "Channel is not connected; it is failed.",
    });
  }, 90_000);

  it("restarts from failed with an explicit connect and sends held subscriptions", async () => {
    const setup = await proxiedChannel("lifecycle-restart");
    const chat: string[] = [];
    setup.channel
      .segment("chat")
      .onMessage((payload) => chat.push(text(payload)));
    setup.channel.segment("chat").subscribe();
    setup.proxy.setRefusing(true);
    await expect(setup.channel.connect()).rejects.toMatchObject({
      code: "Transport",
    });
    expect(setup.channel.state).toBe("failed");

    setup.proxy.setRefusing(false);
    await setup.channel.connect();
    const publisher = await connectedChannel(
      setup.requests[0]!.channelReference,
    );
    opened.push(publisher);
    await settle();
    const arrived = nextMessage(
      setup.channel.segment("chat"),
      (message) => text(message.payload) === "after-restart",
      "the delivery after the restart",
    );
    await publisher.segment("chat").publish({ payload: utf8("after-restart") });
    await arrived;

    expect(setup.requests.map((request) => request.reason)).toEqual([
      "initial",
      "initial",
    ]);
    expect(chat).toEqual(["after-restart"]);
  });

  it("fails after ten failed reconnect attempts and reports it", async () => {
    const setup = await proxiedChannel("lifecycle-exhaustion");
    await setup.channel.connect();
    setup.proxy.setRefusing(true);
    setup.proxy.dropAll();

    await untilState(setup.channel, "failed", 200_000);

    const reconnects = setup.requests.filter(
      (request) => request.reason === "reconnect",
    );
    expect(reconnects).toHaveLength(10);
    expect(setup.errors).toHaveLength(1);
    expect(setup.errors[0]).toMatchObject({ code: "Transport" });
    expect(setup.states.slice(-2)).toEqual(["reconnecting", "failed"]);
  }, 240_000);

  it("fails after the configured maximum of 2 reconnect attempts", async () => {
    const setup = await proxiedChannel("lifecycle-maximum", {
      maximumReconnectAttempts: 2,
    });

    await setup.channel.connect();
    setup.proxy.setRefusing(true);
    setup.proxy.dropAll();

    await untilState(setup.channel, "failed", 60_000);

    const reconnects = setup.requests.filter(
      (request) => request.reason === "reconnect",
    );

    expect(reconnects).toHaveLength(2);
    expect(setup.errors).toHaveLength(1);
    expect(setup.errors[0]).toMatchObject({ code: "Transport" });
    expect(setup.states.slice(-2)).toEqual(["reconnecting", "failed"]);
  }, 90_000);

  it("resets the retry budget after sixty seconds connected", async () => {
    const setup = await proxiedChannel("lifecycle-budget");
    const recoveries: RecoveryEvent[] = [];
    setup.channel.events().onRecovery((event) => recoveries.push(event));
    await setup.channel.connect();

    // A first outage uses at least two failed attempts before it recovers.
    setup.proxy.setRefusing(true);
    setup.proxy.dropAll();
    await waitFor<number>(
      (deliver) => {
        const timer = setInterval(() => deliver(setup.requests.length), 100);
        return () => clearInterval(timer);
      },
      (count) => count >= 3,
      20_000,
      "two failed reconnect attempts",
    );
    setup.proxy.setRefusing(false);
    await untilState(setup.channel, "connected", 30_000);
    expect(recoveries.at(-1)!.retryIndex).toBeGreaterThanOrEqual(2);

    // After sixty seconds connected, the next outage starts a new budget.
    await settle(61_000);
    setup.proxy.dropAll();
    await waitFor<RecoveryEvent>(
      (deliver) => setup.channel.events().onRecovery(deliver),
      () => true,
      30_000,
      "the second recovery",
    );

    expect(recoveries.at(-1)!.retryIndex).toBe(0);
  }, 150_000);

  it("keeps an idle connection open past the server's 60-second heartbeat", async () => {
    const reference = uniqueChannelReference("lifecycle-idle");
    const publisher = await connectedChannel(reference);
    opened.push(publisher);
    const receiver = await connectedChannel(reference);
    opened.push(receiver);
    const states: ChannelState[] = [];
    receiver.events().onStateChange((state) => states.push(state));
    receiver.segment("chat").subscribe();

    // The runtime answers the server's pings; nothing else is sent.
    await settle(95_000);
    const arrived = nextMessage(
      receiver.segment("chat"),
      (message) => text(message.payload) === "still-here",
      "the delivery after the idle period",
    );
    await publisher.segment("chat").publish({ payload: utf8("still-here") });
    await arrived;

    expect(states).toEqual([]);
    expect(receiver.state).toBe("connected");
  }, 150_000);
});

import { afterEach, describe, expect, it } from "vitest";
import {
  createClient,
  type Channel,
  type ClientOptions,
} from "../../src/index";
import { signCredentials, type SigningPayload } from "./helpers/credentials";
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

// A connected channel whose client has these non-default options.
async function openWith(
  reference: string,
  options: Partial<ClientOptions>,
  payload: SigningPayload = {},
): Promise<Channel> {
  const channel = createClient({
    baseUrl: websocketUrl(),
    allowInsecureLoopback: true,
    credentialProvider: async () =>
      signCredentials(clientId(), signingSecret(), payload),
    ...options,
  }).channel(reference);
  opened.push(channel);
  await channel.connect();

  return channel;
} // end function openWith

describe("celeris client options at non-default values", () => {
  it("times out a presence query at a 1 ms presence timeout and stays connected", async () => {
    const reference = uniqueChannelReference("option-presence");
    const channel = await openWith(reference, { presenceQueryTimeoutMs: 1 });

    await expect(
      channel.segment("room").presenceList({ page: 1, perPage: 10 }),
    ).rejects.toMatchObject({
      code: "Timeout",
      message: "Presence query timed out after 1 ms.",
    });

    expect(channel.state).toBe("connected");
  });

  it("delivers replayed ids again beyond a deduplication window of 1", async () => {
    const reference = uniqueChannelReference("option-window");
    const publisher = await connectedChannel(reference);
    opened.push(publisher);
    const receiver = await openWith(
      reference,
      { deduplicationWindowSize: 1 },
      { replay: true },
    );
    const history: string[] = [];
    receiver
      .segment("history")
      .onMessage((payload) => history.push(text(payload)));
    const first = receiver.segment("history").subscribe();
    await settle();
    const two = nextMessage(
      receiver.segment("history"),
      (message) => text(message.payload) === "two",
      "the live delivery of two",
    );
    await publisher.segment("history").publish({ payload: utf8("one") });
    await publisher.segment("history").publish({ payload: utf8("two") });
    await two;

    // The window holds only "two". The re-join replays "one", which pushes
    // "two" out of the window, so the replayed "two" is delivered again too.
    first.cancel();
    await settle();
    receiver.segment("history").subscribe();
    await settle(4_000);

    expect(history).toEqual(["one", "two", "one", "two"]);
  });

  it("refuses the second waiting publish with a publish queue of 1", async () => {
    const activeProxy = await startDroppingProxy(websocketUrl());
    proxy = activeProxy;
    const channel = createClient({
      baseUrl: activeProxy.url,
      allowInsecureLoopback: true,
      publishQueueSize: 1,
      credentialProvider: async () =>
        signCredentials(clientId(), signingSecret()),
    }).channel(uniqueChannelReference("option-queue"));
    opened.push(channel);
    await channel.connect();

    // The proxy stops reading, so the socket buffer fills and publishes wait.
    activeProxy.stallUpstream(true);
    const payload = new Uint8Array(900 * 1024);
    const outcomes: Promise<string>[] = [];

    for (let index = 0; index < 40; index += 1) {
      outcomes.push(
        channel
          .segment("bulk")
          .publish({ payload })
          .then(
            () => "sent",
            (error: Error) => error.message,
          ),
      );
    }

    await settle(2_000);
    activeProxy.stallUpstream(false);
    const results = await Promise.all(outcomes);

    expect(results).toContain(
      "The publish queue is full (size 1). Retry once some publishes have gone out.",
    );

    expect(
      results.filter((result) => result === "sent").length,
    ).toBeGreaterThan(0);
  }, 60_000);
});

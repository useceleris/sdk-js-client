import { afterEach, describe, expect, it } from "vitest";
import {
  createClient,
  type Channel,
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
  nextPresence,
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

type Delivery = { readonly body: string; readonly messageId: string };

function received(channel: Channel, segmentId: string): Delivery[] {
  const deliveries: Delivery[] = [];
  channel.segment(segmentId).onMessage((payload, metadata) => {
    deliveries.push({ body: text(payload), messageId: metadata.messageId });
  });

  return deliveries;
} // end function received

const bodies = (deliveries: readonly Delivery[]) =>
  deliveries.map((delivery) => delivery.body);

function arrival(
  channel: Channel,
  segmentId: string,
  body: string,
  timeoutMs = 30_000,
) {
  return nextMessage(
    channel.segment(segmentId),
    (message) => text(message.payload) === body,
    `"${body}" on ${segmentId}`,
    timeoutMs,
  );
} // end function arrival

async function publish(
  publisher: Channel,
  segmentId: string,
  body: string,
): Promise<void> {
  await publisher.segment(segmentId).publish({ payload: utf8(body) });
} // end function publish

// A receiver behind the dropping proxy and a publisher that connects
// directly, so only the receiver has the outage. With replayOnReconnect, the
// credential provider signs the lookback the SDK asks for into the token:
// the canonical mapping.
async function setUp(label: string, replayOnReconnect = true) {
  const activeProxy = await startDroppingProxy(websocketUrl());
  proxy = activeProxy;
  const reference = uniqueChannelReference(label);
  const requests: CredentialRequest[] = [];
  const client = createClient({
    baseUrl: activeProxy.url,
    allowInsecureLoopback: true,
    credentialProvider: async (request) => {
      requests.push(request);

      return signCredentials(
        clientId(),
        signingSecret(),
        replayOnReconnect && request.reason === "reconnect"
          ? { replay: request.replayLookbackMs ?? 0 }
          : {},
      );
    },
  });
  const receiver = client.channel(reference);
  opened.push(receiver);
  const recoveries: RecoveryEvent[] = [];
  receiver.events().onRecovery((event) => recoveries.push(event));
  const publisher = await connectedChannel(reference);
  opened.push(publisher);

  // Cuts every connection through the proxy and refuses new ones, so a
  // message published now can reach the receiver only by replay.
  const startOutage = async () => {
    activeProxy.setRefusing(true);
    activeProxy.dropAll();
    await settle(500);
    expect(receiver.state).toBe("reconnecting");
  };

  const endOutage = async () => {
    const recovered =
      recoveries.length > 0
        ? Promise.resolve()
        : waitFor<RecoveryEvent>(
            (deliver) => receiver.events().onRecovery(deliver),
            () => true,
            45_000,
            "the recovery event",
          );
    activeProxy.setRefusing(false);
    await recovered;
  };

  return {
    receiver,
    publisher,
    requests,
    recoveries,
    startOutage,
    endOutage,
  };
} // end function setUp

describe("celeris reconnect", () => {
  // SUB-01, REC-02: an outage recovers with fresh credentials, a replay of
  // what it missed and the subscription restored; replayed duplicates are
  // dropped by the dedup window.
  it("recovers after an outage with replay and restored subscriptions", async () => {
    const setup = await setUp("reconnect");
    const { receiver, publisher } = setup;
    const chat = received(receiver, "chat");
    receiver.segment("chat").subscribe();
    await receiver.connect();
    await settle();
    const before = arrival(receiver, "chat", "before");
    await publish(publisher, "chat", "before");
    await before;

    await setup.startOutage();
    await publish(publisher, "chat", "during");
    await settle(2_000);
    const during = arrival(receiver, "chat", "during");
    await setup.endOutage();
    await during;

    expect(setup.recoveries[0]).toMatchObject({
      possibleGaps: true,
      possibleDuplicates: true,
    });
    for (const request of setup.requests.slice(1)) {
      expect(request.reason).toBe("reconnect");
      expect(request.disconnectedAt).toBeGreaterThan(0);
      expect(request.replayLookbackMs).toBeGreaterThanOrEqual(5_000);
    }

    // The subscription was restored on the new connection.
    const after = arrival(receiver, "chat", "after");
    await publish(publisher, "chat", "after");
    await after;
    await settle();

    // Replay sent "before" again; the dedup window dropped it.
    expect(bodies(chat)).toEqual(["before", "during", "after"]);
    expect(new Set(chat.map((delivery) => delivery.messageId)).size).toBe(3);
  }, 90_000);

  it("recovers every missed message on several segments, in order and one time", async () => {
    const setup = await setUp("reconnect-segments");
    const { receiver, publisher } = setup;
    const alpha = received(receiver, "alpha");
    const beta = received(receiver, "beta");
    const lobby = received(receiver, "default");
    const channelWide: string[] = [];
    receiver
      .events()
      .onMessage((payload, metadata) =>
        channelWide.push(`${metadata.segmentId}:${text(payload)}`),
      );
    receiver.segment("alpha").subscribe();
    receiver.segment("beta").subscribe();
    await receiver.connect();
    await settle();
    const a0 = arrival(receiver, "alpha", "a0");
    await publish(publisher, "alpha", "a0");
    await a0;

    await setup.startOutage();
    for (const body of ["a1", "a2", "a3"]) {
      await publish(publisher, "alpha", body);
    }

    for (const body of ["b1", "b2"]) await publish(publisher, "beta", body);
    await publish(publisher, "default", "d1");
    await settle(2_000);
    const lastAlpha = arrival(receiver, "alpha", "a3");
    const lastBeta = arrival(receiver, "beta", "b2");
    const lastLobby = arrival(receiver, "default", "d1");
    await setup.endOutage();
    await Promise.all([lastAlpha, lastBeta, lastLobby]);
    await settle();

    expect(bodies(alpha)).toEqual(["a0", "a1", "a2", "a3"]);
    expect(bodies(beta)).toEqual(["b1", "b2"]);
    expect(bodies(lobby)).toEqual(["d1"]);
    expect([...channelWide].sort()).toEqual(
      [
        "alpha:a0",
        "alpha:a1",
        "alpha:a2",
        "alpha:a3",
        "beta:b1",
        "beta:b2",
        "default:d1",
      ].sort(),
    );
  }, 90_000);

  it("loses missed messages without a replay claim but restores the subscription", async () => {
    const setup = await setUp("reconnect-no-replay", false);
    const { receiver, publisher } = setup;
    const chat = received(receiver, "chat");
    receiver.segment("chat").subscribe();
    await receiver.connect();
    await settle();
    const before = arrival(receiver, "chat", "before");
    await publish(publisher, "chat", "before");
    await before;

    await setup.startOutage();
    await publish(publisher, "chat", "missed");
    await settle(2_000);
    await setup.endOutage();
    await settle();

    const after = arrival(receiver, "chat", "after");
    await publish(publisher, "chat", "after");
    await after;
    await settle();

    // The recovery event declares the gap that this test makes.
    expect(setup.recoveries[0]).toMatchObject({ possibleGaps: true });
    expect(bodies(chat)).toEqual(["before", "after"]);
  }, 90_000);

  it("recovers every missed message after a longer outage with failed attempts", async () => {
    const setup = await setUp("reconnect-long");
    const { receiver, publisher } = setup;
    const chat = received(receiver, "chat");
    receiver.segment("chat").subscribe();
    await receiver.connect();
    await settle();

    await setup.startOutage();
    await publish(publisher, "chat", "m1");
    await settle(3_000);
    await publish(publisher, "chat", "m2");
    await settle(3_000);
    await publish(publisher, "chat", "m3");
    await settle(500);
    const last = arrival(receiver, "chat", "m3");
    await setup.endOutage();
    await last;
    await settle();

    // Retries in the first 6.5 s fail (their delays are at most 0.5, 1 and
    // 2 s), each with a fresh credential request and a longer lookback.
    const reconnects = setup.requests.filter(
      (request) => request.reason === "reconnect",
    );
    expect(reconnects.length).toBeGreaterThanOrEqual(4);
    const lookbacks = reconnects.map((request) => request.replayLookbackMs!);
    expect(lookbacks).toEqual(
      [...lookbacks].sort((left, right) => left - right),
    );
    expect(lookbacks.at(-1)).toBeGreaterThanOrEqual(11_000);
    expect(
      new Set(reconnects.map((request) => request.disconnectedAt)).size,
    ).toBe(1);
    expect(bodies(chat)).toEqual(["m1", "m2", "m3"]);
  }, 90_000);

  it("does not rejoin a segment that the connection joined only by publishing", async () => {
    const setup = await setUp("reconnect-publish-join");
    const { receiver, publisher } = setup;
    const team = received(receiver, "team");
    await receiver.connect();
    await publish(receiver, "team", "joining");
    await settle();
    const before = arrival(receiver, "team", "before");
    await publish(publisher, "team", "before");
    await before;

    await setup.startOutage();
    await setup.endOutage();
    await settle();

    await publish(publisher, "team", "after");
    const control = arrival(receiver, "default", "control");
    await publish(publisher, "default", "control");
    await control;
    await settle(2_500);

    expect(bodies(team)).toEqual(["before"]);
  }, 90_000);

  it("announces the new connection and restores its presence subscription after a reconnect", async () => {
    const setup = await setUp("reconnect-presence");
    const { receiver, publisher } = setup;
    receiver.segment("room").subscribe();
    receiver.segment("room").subscribePresence();
    publisher.segment("room").subscribePresence();
    const firstJoin = nextPresence(
      publisher.segment("room"),
      (event) => event.joined,
      "the first join",
      20_000,
    );
    await receiver.connect();
    const before = await firstJoin;

    const left = nextPresence(
      publisher.segment("room"),
      (event) => !event.joined && event.connectionId === before.connectionId,
      "the leave of the old connection",
      20_000,
    );
    await setup.startOutage();
    await left;
    const rejoined = nextPresence(
      publisher.segment("room"),
      (event) => event.joined && event.connectionId !== before.connectionId,
      "the join of the new connection",
      45_000,
    );
    await setup.endOutage();
    await rejoined;

    // The receiver's presence subscription came back with the reconnect.
    const actorJoin = nextPresence(
      receiver.segment("room"),
      (event) => event.joined && event.tokenReference === "actor",
      "the actor's join at the restored watcher",
      20_000,
    );
    const actor = await connectedChannel(setup.requests[0]!.channelReference, {
      reference: "actor",
    });
    opened.push(actor);
    actor.segment("room").subscribe();
    await actorJoin;
  }, 120_000);

  // QUEUE-01: publishes made while reconnecting wait and go out afterwards.
  it("delivers publishes made during an outage after the reconnect, in call order", async () => {
    const setup = await setUp("reconnect-queued", false);
    // The roles swap here: the channel behind the proxy publishes, and the
    // directly connected one receives.
    const publisher = setup.receiver;
    const receiver = setup.publisher;
    const chat = received(receiver, "chat");
    receiver.segment("chat").subscribe();
    await publisher.connect();
    await settle();

    await setup.startOutage();
    const published = ["q1", "q2", "q3"].map((body) =>
      publisher.segment("chat").publish({ payload: utf8(body) }),
    );

    const last = arrival(receiver, "chat", "q3", 45_000);
    await setup.endOutage();
    await Promise.all(published);
    await last;
    await settle();

    expect(bodies(chat)).toEqual(["q1", "q2", "q3"]);
  }, 90_000);

  // QUEUE-01, SUB-01: the new connection holds exactly the segments the old
  // one held when the outage began.
  it("keeps the same segments after a reconnect", async () => {
    const setup = await setUp("reconnect-segments", false);
    const { receiver, publisher: observer } = setup;
    const alpha = received(receiver, "alpha");
    const beta = received(receiver, "beta");
    const gamma = received(receiver, "gamma");
    receiver.segment("alpha").subscribe();
    receiver.segment("beta").subscribe();
    receiver.segment("alpha").subscribePresence();
    const gammaSubscription = receiver.segment("gamma").subscribe();
    observer.segment("alpha").subscribePresence();

    const firstJoin = nextPresence(
      observer.segment("alpha"),
      (event) => event.joined,
      "the receiver's first join",
      20_000,
    );

    await receiver.connect();
    const before = await firstJoin;
    gammaSubscription.cancel();
    await settle();

    const left = nextPresence(
      observer.segment("alpha"),
      (event) => !event.joined && event.connectionId === before.connectionId,
      "the leave of the old connection",
      20_000,
    );

    await setup.startOutage();
    await left;

    const rejoined = nextPresence(
      observer.segment("alpha"),
      (event) => event.joined && event.connectionId !== before.connectionId,
      "the join of the new connection",
      45_000,
    );

    await setup.endOutage();
    const after = await rejoined;
    await settle();

    // (a), (b): the new connection is a member of alpha and beta, not gamma.
    const listed = async (segmentId: string) =>
      (
        await observer
          .segment(segmentId)
          .presenceList({ page: 1, perPage: 100 })
      ).connections.map((connection) => connection.connectionId);

    expect(after.connectionId).not.toBe(before.connectionId);
    expect(await listed("alpha")).toContain(after.connectionId);
    expect(await listed("beta")).toContain(after.connectionId);
    expect(await listed("gamma")).not.toContain(after.connectionId);

    // (d): the restored presence subscription on alpha hears a new actor.
    const actorJoin = nextPresence(
      receiver.segment("alpha"),
      (event) => event.joined && event.tokenReference === "actor",
      "the actor's join at the restored watcher",
      20_000,
    );

    const actor = await connectedChannel(setup.requests[0]!.channelReference, {
      reference: "actor",
    });

    opened.push(actor);
    actor.segment("alpha").subscribe();
    await actorJoin;

    // (c): alpha and beta deliver; the default-segment control proves that
    // gamma's message had its chance and did not arrive.
    const alphaArrival = arrival(receiver, "alpha", "to-alpha");
    const betaArrival = arrival(receiver, "beta", "to-beta");
    await publish(observer, "alpha", "to-alpha");
    await publish(observer, "beta", "to-beta");
    await publish(observer, "gamma", "to-gamma");
    const control = arrival(receiver, "default", "control");
    await publish(observer, "default", "control");
    await Promise.all([alphaArrival, betaArrival, control]);
    await settle(2_500);

    expect(bodies(alpha)).toEqual(["to-alpha"]);
    expect(bodies(beta)).toEqual(["to-beta"]);
    expect(bodies(gamma)).toEqual([]);
  }, 150_000);
});

import { afterEach, describe, expect, it } from "vitest";
import type { Channel } from "../../src/index";
import type { SigningPayload } from "./helpers/credentials";
import {
  GENERATED_MESSAGE_ID,
  connectedChannel,
  nextMessage,
  qualificationClient,
  uniqueChannelReference,
  waitFor,
} from "./helpers/environment";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);
const settle = (ms = 1_500) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The server keeps at most this many messages per segment for replay.
const BACKLOG_CAPACITY = 100;

// Every channel a test opens, closed after it whether it passed or failed.
const opened: Channel[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((channel) => channel.close()));
});

async function open(
  reference: string,
  payload: SigningPayload = {},
): Promise<Channel> {
  const channel = await connectedChannel(reference, payload);
  opened.push(channel);

  return channel;
} // end function open

type Delivery = { readonly body: string; readonly messageId: string };

// Bodies and ids one segment listener receives, in arrival order.
function received(channel: Channel, segmentId: string): Delivery[] {
  const deliveries: Delivery[] = [];
  channel.segment(segmentId).onMessage((payload, metadata) => {
    deliveries.push({ body: text(payload), messageId: metadata.messageId });
  });

  return deliveries;
} // end function received

const bodies = (deliveries: readonly Delivery[]) =>
  deliveries.map((delivery) => delivery.body);

// Waits until a segment listener on the channel receives this body.
const arrival = (channel: Channel, segmentId: string, body: string) =>
  nextMessage(
    channel.segment(segmentId),
    (message) => text(message.payload) === body,
    `"${body}" on ${segmentId}`,
    25_000,
  );

async function publishAll(
  publisher: Channel,
  segmentId: string,
  messageBodies: readonly string[],
): Promise<void> {
  for (const body of messageBodies) {
    await publisher.segment(segmentId).publish({ payload: utf8(body) });
  }
} // end function publishAll

describe("celeris replay", () => {
  it("replays recent messages with identical ids", async () => {
    const reference = uniqueChannelReference("replay");
    const publisher = await open(reference);
    const liveReceiver = await open(reference);
    const live = received(liveReceiver, "history");
    liveReceiver.segment("history").subscribe();
    await settle();

    const lastLive = arrival(liveReceiver, "history", "three");
    await publishAll(publisher, "history", ["one", "two", "three"]);
    await lastLive;

    // A fresh connection with a replay claim receives the same messages
    // again, ids preserved (REV-01).
    const replayReceiver = await open(reference, { replay: 60_000 });
    const replayed = received(replayReceiver, "history");
    const lastReplayed = arrival(replayReceiver, "history", "three");
    replayReceiver.segment("history").subscribe();
    await lastReplayed;

    expect(replayed).toEqual(live);
    for (const delivery of replayed) {
      expect(delivery.messageId).toMatch(GENERATED_MESSAGE_ID);
    }
  });

  it("replays nothing to a token without a replay claim", async () => {
    const reference = uniqueChannelReference("no-replay");
    const publisher = await open(reference);
    await publishAll(publisher, "history", ["old-1", "old-2"]);
    await settle();

    const receiver = await open(reference);
    const history = received(receiver, "history");
    receiver.segment("history").subscribe();
    await settle();

    // The live message proves the join, so a replay would have arrived first.
    const live = arrival(receiver, "history", "live");
    await publishAll(publisher, "history", ["live"]);
    await live;
    await settle();

    expect(bodies(history)).toEqual(["live"]);
  });

  it("replays in publish order", async () => {
    const reference = uniqueChannelReference("replay-order");
    const publisher = await open(reference);
    const published = Array.from({ length: 10 }, (_, index) => `m${index}`);
    await publishAll(publisher, "history", published);
    await settle();

    const receiver = await open(reference, { replay: true });
    const history = received(receiver, "history");
    const last = arrival(receiver, "history", "m9");
    receiver.segment("history").subscribe();
    await last;
    await settle();

    expect(bodies(history)).toEqual(published);
  });

  it("replays at most the last 100 messages of a segment", async () => {
    const reference = uniqueChannelReference("replay-capacity");
    const publisher = await open(reference);
    const published = Array.from(
      { length: BACKLOG_CAPACITY + 5 },
      (_, index) => `m${index}`,
    );

    // Paced below the per-second publish limit, so no publish is resent.
    for (let start = 0; start < published.length; start += 10) {
      await publishAll(
        publisher,
        "history",
        published.slice(start, start + 10),
      );
      await settle(1_100);
    }

    const receiver = await open(reference, { replay: true });
    const history = received(receiver, "history");
    const last = arrival(receiver, "history", published.at(-1)!);
    receiver.segment("history").subscribe();
    await last;
    await settle();

    expect(bodies(history)).toEqual(published.slice(-BACKLOG_CAPACITY));
  }, 60_000);

  it("replays only the window of a numeric replay claim", async () => {
    const reference = uniqueChannelReference("replay-window");
    const publisher = await open(reference);
    await publishAll(publisher, "history", ["old"]);
    await settle(5_000);
    await publishAll(publisher, "history", ["recent"]);
    await settle();

    const receiver = await open(reference, { replay: 3_000 });
    const history = received(receiver, "history");
    const recent = arrival(receiver, "history", "recent");
    receiver.segment("history").subscribe();
    await recent;
    await settle(2_500);

    expect(bodies(history)).toEqual(["recent"]);
  });

  it("replays the default segment on connect", async () => {
    const reference = uniqueChannelReference("replay-default");
    const publisher = await open(reference);
    await publishAll(publisher, "default", ["d1", "d2"]);
    await settle();

    // The listener is in place before connect, when the server joins default.
    const receiver = qualificationClient({ replay: true }).channel(reference);
    opened.push(receiver);
    const lobby = received(receiver, "default");
    const last = arrival(receiver, "default", "d2");
    await receiver.connect();
    await last;

    expect(bodies(lobby)).toEqual(["d1", "d2"]);
  });

  it("replays each segment's backlog when that segment is joined", async () => {
    const reference = uniqueChannelReference("replay-per-join");
    const publisher = await open(reference);
    await publishAll(publisher, "alpha", ["a1"]);
    await publishAll(publisher, "beta", ["b1"]);
    await settle();

    const receiver = await open(reference, { replay: true });
    const alpha = received(receiver, "alpha");
    const beta = received(receiver, "beta");
    const alphaReplay = arrival(receiver, "alpha", "a1");
    receiver.segment("alpha").subscribe();
    await alphaReplay;
    await settle();
    expect(bodies(beta)).toEqual([]);

    const betaReplay = arrival(receiver, "beta", "b1");
    receiver.segment("beta").subscribe();
    await betaReplay;

    expect(bodies(alpha)).toEqual(["a1"]);
    expect(bodies(beta)).toEqual(["b1"]);
  });

  it("starts no replay with a publish, and replays on the subscription", async () => {
    const reference = uniqueChannelReference("replay-publish-no-join");
    const publisher = await open(reference);
    // A member keeps the segment, and its backlog, on the server.
    publisher.segment("history").subscribe();
    await settle();
    await publishAll(publisher, "history", ["h1"]);
    await settle();

    const receiver = await open(reference, { replay: true });
    const history = received(receiver, "history");
    await receiver.segment("history").publish({ payload: utf8("no-join") });
    await settle(2_500);
    expect(bodies(history)).toEqual([]);

    const replay = arrival(receiver, "history", "h1");
    receiver.segment("history").subscribe();
    await replay;
    await settle();

    expect(bodies(history)).toContain("h1");
  });

  it("recovers what a re-join missed and drops what it already delivered", async () => {
    const reference = uniqueChannelReference("replay-rejoin");
    const publisher = await open(reference);
    const receiver = await open(reference, { replay: true });
    const history = received(receiver, "history");
    const first = receiver.segment("history").subscribe();
    await settle();
    const one = arrival(receiver, "history", "one");
    await publishAll(publisher, "history", ["one"]);
    await one;

    first.cancel();
    await settle();
    await publishAll(publisher, "history", ["two"]);
    await settle();

    // The re-join replays "one" and "two"; the dedup window drops "one".
    const two = arrival(receiver, "history", "two");
    receiver.segment("history").subscribe();
    await two;
    const three = arrival(receiver, "history", "three");
    await publishAll(publisher, "history", ["three"]);
    await three;
    await settle();

    expect(bodies(history)).toEqual(["one", "two", "three"]);
    expect(new Set(history.map((delivery) => delivery.messageId)).size).toBe(3);
  });

  it("replays to the channel listener one time for each message", async () => {
    const reference = uniqueChannelReference("replay-channel-listener");
    const publisher = await open(reference);
    await publishAll(publisher, "history", ["h1", "h2"]);
    await settle();

    const receiver = await open(reference, { replay: true });
    const seen: string[] = [];
    receiver
      .events()
      .onMessage((payload, metadata) =>
        seen.push(`${metadata.segmentId}:${text(payload)}`),
      );
    const both = waitFor<string[]>(
      (deliver) => receiver.events().onMessage(() => deliver(seen)),
      (current) => current.length >= 2,
      25_000,
      "both replayed messages",
    );
    const membership = receiver.segment("history").subscribe();
    await both;

    // A re-join replays both again; the channel listener sees neither twice.
    membership.cancel();
    await settle();
    receiver.segment("history").subscribe();
    await settle(4_000);

    expect(seen).toEqual(["history:h1", "history:h2"]);
  });
});

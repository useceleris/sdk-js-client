import { afterEach, describe, expect, it } from "vitest";
import type { Channel } from "../../src/index";
import {
  connectedChannel,
  nextError,
  nextMessage,
  qualificationClient,
  uniqueChannelReference,
  waitFor,
} from "./helpers/environment";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);
const settle = (ms = 1_500) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Payload texts one segment listener receives.
function received(channel: Channel, segmentId: string): string[] {
  const texts: string[] = [];
  channel.segment(segmentId).onMessage((payload) => texts.push(text(payload)));

  return texts;
} // end function received

// Publishes and waits until the receiver's segment delivers that payload.
async function publishAndAwait(
  publisher: Channel,
  receiver: Channel,
  segmentId: string,
  body: string,
): Promise<void> {
  const delivered = nextMessage(
    receiver.segment(segmentId),
    (message) => text(message.payload) === body,
    `"${body}" on ${segmentId}`,
  );

  await publisher.segment(segmentId).publish({ payload: utf8(body) });
  await delivered;
} // end function publishAndAwait

// A negative check needs proof the connection was live: a control message
// on the default segment, which always delivers, then time for a stray
// delivery to land.
async function confirmQuiet(
  publisher: Channel,
  receiver: Channel,
): Promise<void> {
  await publishAndAwait(publisher, receiver, "default", "control");
  await settle(2_500);
} // end function confirmQuiet

// Every channel a test opens, closed after it whether it passed or failed.
const opened: Channel[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((channel) => channel.close()));
});

function track(channel: Channel): Channel {
  opened.push(channel);

  return channel;
} // end function track

async function pair(
  label: string,
  receiverPermission?: { read: boolean; write: boolean },
) {
  const reference = uniqueChannelReference(label);
  const publisher = track(await connectedChannel(reference));
  const receiver = track(
    await connectedChannel(
      reference,
      receiverPermission ? { tokenPermission: receiverPermission } : {},
    ),
  );

  return { reference, publisher, receiver };
} // end function pair

describe("celeris segment membership", () => {
  describe("receiving", () => {
    it("delivers nothing to a listener without a subscription", async () => {
      const { publisher, receiver } = await pair("listener-only");
      const chat = received(receiver, "chat");

      await publisher.segment("chat").publish({ payload: utf8("unheard") });
      await confirmQuiet(publisher, receiver);

      expect(chat).toEqual([]);
    });

    it("delivers after a subscription made before connecting", async () => {
      const reference = uniqueChannelReference("before-connect");
      const publisher = track(await connectedChannel(reference));
      const receiver = track(qualificationClient().channel(reference));
      const chat = received(receiver, "chat");
      receiver.segment("chat").subscribe();
      await receiver.connect();
      await settle();

      await publishAndAwait(publisher, receiver, "chat", "hello");

      expect(chat).toEqual(["hello"]);
    });

    it("delivers after a subscription made once connected", async () => {
      const { publisher, receiver } = await pair("after-connect");
      const chat = received(receiver, "chat");
      receiver.segment("chat").subscribe();
      await settle();

      await publishAndAwait(publisher, receiver, "chat", "hello");

      expect(chat).toEqual(["hello"]);
    });

    it("delivers to a listener attached after subscribing", async () => {
      const { publisher, receiver } = await pair("listener-later");
      receiver.segment("chat").subscribe();
      await settle();
      const chat = received(receiver, "chat");

      await publishAndAwait(publisher, receiver, "chat", "hello");

      expect(chat).toEqual(["hello"]);
    });
  });

  describe("leaving", () => {
    it("stops on cancel and resumes on a new subscription", async () => {
      const { publisher, receiver } = await pair("rejoin");
      const chat = received(receiver, "chat");
      const first = receiver.segment("chat").subscribe();
      await settle();
      await publishAndAwait(publisher, receiver, "chat", "one");

      first.cancel();
      await settle();
      await publisher.segment("chat").publish({ payload: utf8("two") });
      await confirmQuiet(publisher, receiver);
      expect(chat).toEqual(["one"]);

      receiver.segment("chat").subscribe();
      await settle();
      await publishAndAwait(publisher, receiver, "chat", "three");

      expect(chat).toEqual(["one", "three"]);
    });

    it("leaves only when the last handle cancels", async () => {
      const { publisher, receiver } = await pair("refcount");
      const chat = received(receiver, "chat");
      const first = receiver.segment("chat").subscribe();
      const second = receiver.segment("chat").subscribe();
      await settle();

      first.cancel();
      await settle();
      await publishAndAwait(publisher, receiver, "chat", "one");

      second.cancel();
      await settle();
      await publisher.segment("chat").publish({ payload: utf8("two") });
      await confirmQuiet(publisher, receiver);

      expect(chat).toEqual(["one"]);
    });

    it("routes each segment's messages to its own listeners only", async () => {
      const { publisher, receiver } = await pair("demux");
      const alpha = received(receiver, "alpha");
      const beta = received(receiver, "beta");
      receiver.segment("alpha").subscribe();
      const betaMembership = receiver.segment("beta").subscribe();
      await settle();

      await publishAndAwait(publisher, receiver, "alpha", "a");
      await publishAndAwait(publisher, receiver, "beta", "b");
      expect(alpha).toEqual(["a"]);
      expect(beta).toEqual(["b"]);

      betaMembership.cancel();
      await settle();
      await publisher.segment("beta").publish({ payload: utf8("late") });
      await publishAndAwait(publisher, receiver, "alpha", "still");
      await settle(2_500);

      expect(alpha).toEqual(["a", "still"]);
      expect(beta).toEqual(["b"]);
    });

    it("keeps other listeners and the subscription when one listener stops", async () => {
      const { publisher, receiver } = await pair("dispose");
      const stopped: string[] = [];
      const stopListening = receiver
        .segment("chat")
        .onMessage((payload) => stopped.push(text(payload)));
      const kept = received(receiver, "chat");
      receiver.segment("chat").subscribe();
      await settle();
      await publishAndAwait(publisher, receiver, "chat", "one");

      stopListening();
      await publishAndAwait(publisher, receiver, "chat", "two");

      expect(stopped).toEqual(["one"]);
      expect(kept).toEqual(["one", "two"]);
    });
  });

  // A publish is not a membership: only a subscription receives (SEG-01).
  describe("a publish does not join", () => {
    it("delivers nothing to a connection that only publishes, and delivers once it subscribes", async () => {
      const { publisher, receiver } = await pair("publish-no-join");
      const chat = received(receiver, "chat");
      publisher.segment("chat").subscribe();
      await settle();

      // The publish lands, which proves that it ran on the server.
      await publishAndAwait(receiver, publisher, "chat", "from-receiver");
      await publisher.segment("chat").publish({ payload: utf8("unheard") });
      await confirmQuiet(publisher, receiver);
      expect(chat).toEqual([]);

      receiver.segment("chat").subscribe();
      await settle();
      await publishAndAwait(publisher, receiver, "chat", "heard");

      expect(chat).toEqual(["heard"]);
    });

    it("gives no echo on a named segment before a subscription", async () => {
      const reference = uniqueChannelReference("publish-no-echo");
      const publisher = track(await connectedChannel(reference));
      const echoing = track(
        await connectedChannel(reference, { allowEcho: true }),
      );
      const chat = received(echoing, "chat");

      await echoing.segment("chat").publish({ payload: utf8("unheard") });
      await confirmQuiet(publisher, echoing);
      expect(chat).toEqual([]);

      echoing.segment("chat").subscribe();
      await settle();
      await publishAndAwait(echoing, echoing, "chat", "echoed");

      expect(chat).toEqual(["echoed"]);
    });

    it("does not list a connection that only publishes in the presence of the segment", async () => {
      const { publisher, receiver } = await pair("publish-no-presence");
      publisher.segment("chat").subscribe();
      await settle();

      await publishAndAwait(receiver, publisher, "chat", "from-receiver");
      await settle(3_000);

      const list = await publisher
        .segment("chat")
        .presenceList({ page: 1, perPage: 25 });

      expect(list.connections).toHaveLength(1);
    });

    // Watching presence is not membership: it neither joins nor holds.
    it("never joins or holds a segment for a presence subscription", async () => {
      const { publisher, receiver } = await pair("presence-watch");
      const chat = received(receiver, "chat");
      receiver.segment("chat").subscribePresence();
      await settle();
      await publisher.segment("chat").publish({ payload: utf8("unheard") });
      await confirmQuiet(publisher, receiver);
      expect(chat).toEqual([]);

      const messages = receiver.segment("chat").subscribe();
      await settle();
      await publishAndAwait(publisher, receiver, "chat", "one");

      messages.cancel();
      await settle();
      await publisher.segment("chat").publish({ payload: utf8("two") });
      await confirmQuiet(publisher, receiver);

      expect(chat).toEqual(["one"]);
    });
  });

  // Write access publishes and read access subscribes. The two are separate.
  describe("token permissions", () => {
    it("refuses a write-only token's subscription and still delivers its publish", async () => {
      const { publisher, receiver } = await pair("publish-write-only", {
        read: false,
        write: true,
      });
      const chat = received(receiver, "chat");
      publisher.segment("chat").subscribe();
      await settle();

      const denial = nextError(
        receiver,
        (error) =>
          "type" in error &&
          error.type === "PermissionDeniedError" &&
          error.subType === "SUB" &&
          error.resource === "chat",
        "the subscription denial",
      );
      receiver.segment("chat").subscribe();
      await denial;

      await publishAndAwait(receiver, publisher, "chat", "written");
      await publisher.segment("chat").publish({ payload: utf8("unheard") });
      await settle(2_500);

      expect(chat).toEqual([]);
      expect(receiver.state).toBe("connected");
    });

    it("refuses a read-only token's publish and delivers once subscribed", async () => {
      const { publisher, receiver } = await pair("publish-read-only", {
        read: true,
        write: false,
      });
      const chat = received(receiver, "chat");

      const denial = nextError(
        receiver,
        (error) => "type" in error && error.type === "PermissionDeniedError",
        "the publish denial",
      );
      await receiver.segment("chat").publish({ payload: utf8("refused") });
      await denial;
      await publisher.segment("chat").publish({ payload: utf8("unheard") });
      await confirmQuiet(publisher, receiver);
      expect(chat).toEqual([]);

      receiver.segment("chat").subscribe();
      await settle();
      await publishAndAwait(publisher, receiver, "chat", "heard");

      expect(chat).toEqual(["heard"]);
    });
  });

  // One channel is one WebSocket; its segments share it (SEG-01).
  describe("connections", () => {
    it("multiplexes a channel's segments over one connection", async () => {
      const { reference, publisher, receiver } = await pair("multiplex");
      receiver.segment("alpha").subscribe();
      receiver.segment("beta").subscribe();
      await settle(3_000);

      const connectionsIn = async (segmentId: string) =>
        (
          await publisher.segment(segmentId).presenceList({
            page: 1,
            perPage: 25,
          })
        ).connections.map((connection) => connection.connectionId);
      const alpha = await connectionsIn("alpha");
      expect(alpha).toHaveLength(1);
      expect(await connectionsIn("beta")).toEqual(alpha);

      const second = track(await connectedChannel(reference));
      second.segment("alpha").subscribe();
      await settle(3_000);

      const both = await connectionsIn("alpha");
      expect(both).toHaveLength(2);
      expect(new Set(both).size).toBe(2);
    });
  });

  describe("channel-wide listener", () => {
    it("removes one channel listener and leaves every other listener", async () => {
      const { publisher, receiver } = await pair("channel-listener-remove");
      const removed: string[] = [];
      const kept: string[] = [];
      const removeChannelListener = receiver
        .events()
        .onMessage((payload) => removed.push(text(payload)));
      receiver.events().onMessage((payload) => kept.push(text(payload)));
      const chat = received(receiver, "chat");
      receiver.segment("chat").subscribe();
      await settle();
      await publishAndAwait(publisher, receiver, "chat", "one");

      removeChannelListener();
      await publishAndAwait(publisher, receiver, "chat", "two");

      expect(removed).toEqual(["one"]);
      expect(kept).toEqual(["one", "two"]);
      expect(chat).toEqual(["one", "two"]);
    });

    it("catches deliveries no segment listener asked for", async () => {
      const { publisher, receiver } = await pair("channel-listener");
      const seen: string[] = [];
      receiver
        .events()
        .onMessage((payload, metadata) =>
          seen.push(`${metadata.segmentId}:${text(payload)}`),
        );
      // A subscription with no segment listener, and the default segment.
      receiver.segment("unlistened").subscribe();
      await settle();

      const both = waitFor<string[]>(
        (deliver) => receiver.events().onMessage(() => deliver(seen)),
        (current) => current.length >= 2,
        15_000,
        "both channel-wide deliveries",
      );
      await publisher.segment("unlistened").publish({ payload: utf8("x") });
      await publisher.defaultSegment().publish({ payload: utf8("y") });
      await both;

      expect([...seen].sort()).toEqual(["default:y", "unlistened:x"]);
    });
  });
});

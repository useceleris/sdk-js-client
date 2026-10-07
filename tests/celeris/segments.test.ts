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

  // Membership the server grants without a message subscription (SEG-01).
  describe("joins the server makes", () => {
    it("delivers to a segment joined by publishing", async () => {
      const { publisher, receiver } = await pair("publish-join");
      const chat = received(receiver, "chat");
      await receiver.segment("chat").publish({ payload: utf8("joining") });
      await settle();

      await publishAndAwait(publisher, receiver, "chat", "after");

      expect(chat).toEqual(["after"]);
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

    it("leaves a segment joined by publishing on the last cancel", async () => {
      const { publisher, receiver } = await pair("publish-leave");
      const chat = received(receiver, "chat");
      await receiver.segment("chat").publish({ payload: utf8("joining") });
      const membership = receiver.segment("chat").subscribe();
      await settle();

      membership.cancel();
      await settle();
      await publisher.segment("chat").publish({ payload: utf8("late") });
      await confirmQuiet(publisher, receiver);

      expect(chat).toEqual([]);
    });
  });

  // Publishing joins the segment, but read access is checked at the join:
  // only a token that can read and write receives without subscribing.
  describe("token permissions", () => {
    it("receives after publishing with a read-write token", async () => {
      const { publisher, receiver } = await pair("publish-read-write", {
        read: true,
        write: true,
      });
      const chat = received(receiver, "chat");
      await receiver.segment("chat").publish({ payload: utf8("joining") });
      await settle();

      await publishAndAwait(publisher, receiver, "chat", "after");

      expect(chat).toEqual(["after"]);
    });

    it("receives nothing after publishing with a write-only token", async () => {
      const { publisher, receiver } = await pair("publish-write-only", {
        read: false,
        write: true,
      });
      const chat = received(receiver, "chat");
      publisher.segment("chat").subscribe();
      await settle();

      // The publish lands, which proves the write-only connection is up.
      await publishAndAwait(receiver, publisher, "chat", "joining");
      await publisher.segment("chat").publish({ payload: utf8("unheard") });
      await settle(2_500);

      expect(chat).toEqual([]);
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
      await receiver.segment("joined").publish({ payload: utf8("joining") });
      await settle();

      const both = waitFor<string[]>(
        (deliver) => receiver.events().onMessage(() => deliver(seen)),
        (current) => current.length >= 2,
        15_000,
        "both channel-wide deliveries",
      );
      await publisher.segment("joined").publish({ payload: utf8("x") });
      await publisher.defaultSegment().publish({ payload: utf8("y") });
      await both;

      expect([...seen].sort()).toEqual(["default:y", "joined:x"]);
    });
  });
});

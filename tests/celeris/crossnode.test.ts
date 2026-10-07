import { describe, expect, it } from "vitest";
import {
  GENERATED_MESSAGE_ID,
  connectedChannel,
  nextMessage,
  nextPresence,
  hasPeerWebsocketUrl,
  peerWebsocketUrl,
  uniqueChannelReference,
} from "./helpers/environment";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);
const settle = (ms = 2_000) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The second connection opens through CELERIS_WS_URL_PEER, a gateway that
// routes to a different server node. Without it, the suite skips.
describe.skipIf(!hasPeerWebsocketUrl())("celeris cross-node", () => {
  it("fans out publishes across nodes", async () => {
    const reference = uniqueChannelReference("xnode");
    const primary = await connectedChannel(reference);
    const secondary = await connectedChannel(reference, {}, peerWebsocketUrl());
    secondary.segment("chat").subscribe();
    await settle();

    await primary.segment("chat").publish({ payload: utf8("across") });
    const message = await nextMessage(
      secondary.segment("chat"),
      (received) => text(received.payload) === "across",
      "cross-node delivery",
      25_000,
    );
    expect(message.messageId).toMatch(GENERATED_MESSAGE_ID);

    await primary.close();
    await secondary.close();
  });

  it("reports consistent presence across nodes", async () => {
    const reference = uniqueChannelReference("xpres");
    const primary = await connectedChannel(reference);
    const secondary = await connectedChannel(reference, {}, peerWebsocketUrl());
    primary.segment("room").subscribe();
    secondary.segment("room").subscribe();
    await settle(3_000);

    const fromPrimary = await primary
      .segment("room")
      .presenceList({ page: 1, perPage: 25 });
    const fromSecondary = await secondary
      .segment("room")
      .presenceList({ page: 1, perPage: 25 });
    expect(fromPrimary.total).toBe(fromSecondary.total);
    expect(fromPrimary.total).toBeGreaterThanOrEqual(2);

    await primary.close();
    await secondary.close();
  });

  it("delivers a presence join from another node", async () => {
    const reference = uniqueChannelReference("xpres-event");
    const watcher = await connectedChannel(reference);
    watcher.segment("room").subscribePresence();
    await settle();

    const joiner = await connectedChannel(reference, {}, peerWebsocketUrl());
    const joined = nextPresence(
      watcher.segment("room"),
      (event) => event.joined,
      "a cross-node join",
      20_000,
    );
    joiner.segment("room").subscribe();

    expect((await joined).segmentId).toBe("room");
    await joiner.close();
    await watcher.close();
  });

  it("delivers a presence leave from another node", async () => {
    const reference = uniqueChannelReference("xpres-leave");
    const watcher = await connectedChannel(reference);
    watcher.segment("room").subscribePresence();
    await settle();
    const leaver = await connectedChannel(reference, {}, peerWebsocketUrl());
    const joined = nextPresence(
      watcher.segment("room"),
      (event) => event.joined,
      "the cross-node join",
      20_000,
    );
    leaver.segment("room").subscribe();
    const join = await joined;

    const left = nextPresence(
      watcher.segment("room"),
      (event) => !event.joined && event.connectionId === join.connectionId,
      "the cross-node leave",
      20_000,
    );
    await leaver.close();
    await left;

    await watcher.close();
  });

  it("replays history published on another node", async () => {
    const reference = uniqueChannelReference("xreplay");
    const publisher = await connectedChannel(reference);

    for (const body of ["h1", "h2", "h3"]) {
      await publisher.segment("history").publish({ payload: utf8(body) });
    }

    await settle();

    const receiver = await connectedChannel(
      reference,
      { replay: true },
      peerWebsocketUrl(),
    );
    const replayed: string[] = [];
    receiver
      .segment("history")
      .onMessage((payload) => replayed.push(text(payload)));
    const last = nextMessage(
      receiver.segment("history"),
      (message) => text(message.payload) === "h3",
      "the cross-node replay",
      25_000,
    );
    receiver.segment("history").subscribe();
    await last;
    await settle();

    expect(replayed).toEqual(["h1", "h2", "h3"]);
    await publisher.close();
    await receiver.close();
  });

  it("keeps one origin's order across nodes", async () => {
    const reference = uniqueChannelReference("xorder");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference, {}, peerWebsocketUrl());
    const received: string[] = [];
    receiver
      .segment("chat")
      .onMessage((payload) => received.push(text(payload)));
    receiver.segment("chat").subscribe();
    await settle();
    const bodies = Array.from({ length: 30 }, (_, index) => `o${index}`);

    const last = nextMessage(
      receiver.segment("chat"),
      (message) => text(message.payload) === "o29",
      "the last ordered message",
      30_000,
    );

    for (let start = 0; start < bodies.length; start += 10) {
      for (const body of bodies.slice(start, start + 10)) {
        await publisher.segment("chat").publish({ payload: utf8(body) });
      }

      await settle(1_100);
    }

    await last;
    await settle();

    expect(received).toEqual(bodies);
    await publisher.close();
    await receiver.close();
  }, 60_000);
});

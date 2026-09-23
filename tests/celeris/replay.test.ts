import { describe, expect, it } from "vitest";
import {
  connectedChannel,
  nextMessage,
  uniqueChannelReference,
} from "./helpers/environment";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);
const settle = (ms = 1_500) =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("celeris replay", () => {
  it("replays recent messages with identical server-assigned ids", async () => {
    const reference = uniqueChannelReference("replay");
    const publisher = await connectedChannel(reference);
    const liveReceiver = await connectedChannel(reference);
    const liveIds: string[] = [];
    liveReceiver.segment("history").onMessage((_payload, metadata) => {
      liveIds.push(metadata.messageId);
    });
    liveReceiver.segment("history").subscribe();
    await settle();

    for (const body of ["one", "two", "three"]) {
      await publisher.segment("history").publish({ payload: utf8(body) });
    }
    await nextMessage(
      liveReceiver.segment("history"),
      () => liveIds.length >= 3,
      "the three live deliveries",
      20_000,
    );
    await liveReceiver.close();

    // A fresh connection with a replay lookback receives the same
    // messages again, ids preserved (REV-01: all server-assigned).
    const replayReceiver = await connectedChannel(reference, {
      replay: 60_000,
    });
    const replayed: { payload: Uint8Array; messageId: string }[] = [];
    replayReceiver.segment("history").onMessage((payload, metadata) => {
      replayed.push({ payload, messageId: metadata.messageId });
    });
    replayReceiver.segment("history").subscribe();

    await nextMessage(
      replayReceiver.segment("history"),
      () => replayed.length >= 3,
      "the replayed history",
      25_000,
    );

    const replayedByBody = new Map(
      replayed.map((message) => [text(message.payload), message.messageId]),
    );
    expect([...replayedByBody.keys()].sort()).toEqual(
      expect.arrayContaining(["one", "three", "two"]),
    );
    for (const [index, body] of ["one", "two", "three"].entries()) {
      expect(replayedByBody.get(body)).toBe(liveIds[index]);
      expect(replayedByBody.get(body)).toMatch(/^msg_/);
    }

    await publisher.close();
    await replayReceiver.close();
  });

  it("keeps the dedup window effective against overlapping replay on one channel", async () => {
    const reference = uniqueChannelReference("dedup");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference, { replay: 60_000 });
    const delivered: string[] = [];
    receiver.segment("history").onMessage((_payload, metadata) => {
      delivered.push(metadata.messageId);
    });
    const membership = receiver.segment("history").subscribe();
    await settle();

    await publisher.segment("history").publish({ payload: utf8("first") });
    await nextMessage(
      receiver.segment("history"),
      () => delivered.length >= 1,
      "the live delivery",
      20_000,
    );

    // Re-join the segment on the same channel: the token's replay window
    // redelivers history; the client's dedup window absorbs it.
    membership.cancel();
    await settle();
    receiver.segment("history").subscribe();
    await settle(4_000);

    expect(new Set(delivered).size).toBe(delivered.length);

    await publisher.close();
    await receiver.close();
  });
});

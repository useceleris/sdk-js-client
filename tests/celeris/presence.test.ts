import { describe, expect, it } from "vitest";
import {
  connectedChannel,
  nextMessage,
  nextNotice,
  uniqueChannelReference,
} from "./helpers/environment";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);
const settle = (ms = 1_500) =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("celeris presence", () => {
  it("delivers raw join notices to presence watchers", async () => {
    const reference = uniqueChannelReference("watch");
    const watcher = await connectedChannel(reference);
    watcher.segment("room").subscribePresence();
    await settle();

    const actor = await connectedChannel(reference);
    actor.segment("room").subscribe();

    const notice = await nextNotice(
      watcher,
      (received) => text(received.payload).includes('joined segment "room"'),
      "a raw join notice",
    );
    expect(text(notice.payload)).toContain("connection id:");

    await actor.close();
    await watcher.close();
  });

  it("pages presence snapshots with raw metadata", async () => {
    const reference = uniqueChannelReference("plist");
    const first = await connectedChannel(reference);
    const second = await connectedChannel(reference);
    first.segment("room").subscribe();
    second.segment("room").subscribe();
    await settle(2_500);

    const page = await first
      .segment("room")
      .presenceList({ page: 1, perPage: 10 });
    expect(page.segmentId).toBe("room");
    expect(page.total >= 2n).toBe(true);
    expect(page.connections.length).toBeGreaterThanOrEqual(2);
    expect(page.from).toBe(1n);
    for (const connection of page.connections) {
      expect(connection.connectionId.length).toBeGreaterThan(0);
      expect(typeof connection.timestamp).toBe("bigint");
    }

    const beyond = await first
      .segment("room")
      .presenceList({ page: 50, perPage: 10 });
    expect(beyond.connections).toEqual([]);
    expect(beyond.from > beyond.to).toBe(true);

    await first.close();
    await second.close();
  });

  it("stops notices after presence cancellation while membership persists", async () => {
    const reference = uniqueChannelReference("unwatch");
    const watcher = await connectedChannel(reference);
    const watching = watcher.segment("room").subscribePresence();
    watcher.segment("room").onMessage(() => undefined);
    await settle();

    watching.cancel();
    await settle();

    const notices: string[] = [];
    watcher.events().onNotice((notice) => notices.push(text(notice.payload)));
    const actor = await connectedChannel(reference);
    actor.segment("room").subscribe();
    await actor.segment("room").publish({ payload: utf8("still-member") });

    // Membership persisted (PRES_SUB force-joined): the message arrives
    // even though presence notices no longer do.
    await nextMessage(
      watcher.segment("room"),
      (message) => text(message.payload) === "still-member",
      "delivery proving persistent membership",
    );
    expect(notices.some((entry) => entry.includes("joined segment"))).toBe(
      false,
    );

    await actor.close();
    await watcher.close();
  });
});

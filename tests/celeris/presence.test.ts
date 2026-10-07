import { afterEach, describe, expect, it } from "vitest";
import { ServerError, type Channel, type PresenceEvent } from "../../src/index";
import type { SigningPayload } from "./helpers/credentials";
import {
  connectedChannel,
  nextMessage,
  nextPresence,
  waitFor,
  uniqueChannelReference,
} from "./helpers/environment";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);
const settle = (ms = 1_500) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

function events(channel: Channel, segmentId: string): PresenceEvent[] {
  const seen: PresenceEvent[] = [];
  channel.segment(segmentId).onPresence((event) => seen.push(event));

  return seen;
} // end function events

describe("celeris presence", () => {
  it("delivers typed join and leave notifications to presence watchers", async () => {
    const reference = uniqueChannelReference("watch");
    const watcher = await connectedChannel(reference);
    const watched = watcher.segment("room");
    watched.subscribePresence();
    await settle();

    const actor = await connectedChannel(reference);
    actor.segment("room").subscribe();

    const join = await nextPresence(
      watched,
      (event) => event.joined,
      "a typed join notification",
    );
    expect(join.segmentId).toBe("room");
    expect(join.tokenReference.length).toBeGreaterThan(0);
    expect(join.connectionId.length).toBeGreaterThan(0);
    expect(typeof join.timestamp).toBe("bigint");
    expect(join.timestamp > 0n).toBe(true);

    // The same connection leaving produces the mirror event. The waiter is
    // registered before the close, because the notification can arrive
    // while close() is still settling.
    const leaving = nextPresence(
      watched,
      (event) => !event.joined && event.connectionId === join.connectionId,
      "a typed leave notification",
    );
    await actor.close();
    const leave = await leaving;
    expect(leave.segmentId).toBe("room");
    expect(leave.tokenReference).toBe(join.tokenReference);

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
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.connections.length).toBeGreaterThanOrEqual(2);
    expect(page.from).toBe(1);
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

  it("rejects a write-only token's presence query at once, naming the query", async () => {
    const reference = uniqueChannelReference("pdeny");
    const writeOnly = await connectedChannel(reference, {
      tokenPermission: { read: false, write: true },
    });
    const errors: unknown[] = [];
    writeOnly.events().onError((error) => errors.push(error));

    // Presence needs read access. The denial names the query by its request
    // id, so the caller hears it at once instead of waiting out the deadline.
    const started = Date.now();
    const rejection = await writeOnly
      .segment("room")
      .presenceList({ page: 1, perPage: 10 })
      .catch((error: unknown) => error);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(rejection).toBeInstanceOf(ServerError);
    expect(rejection).toMatchObject({
      type: "PermissionDeniedError",
      subType: "PRES_LIST",
      resource: "1",
    });
    expect(errors).toEqual([]);
    expect(writeOnly.state).toBe("connected");

    await writeOnly.close();
  });

  it("stops notices after presence cancellation while the subscription stays", async () => {
    const reference = uniqueChannelReference("unwatch");
    const watcher = await connectedChannel(reference);
    watcher.segment("room").subscribe();
    const watching = watcher.segment("room").subscribePresence();
    await settle();

    watching.cancel();
    await settle();

    const events: unknown[] = [];
    watcher.segment("room").onPresence((event) => events.push(event));
    const actor = await connectedChannel(reference);
    actor.segment("room").subscribe();
    await actor.segment("room").publish({ payload: utf8("still-member") });

    // The message subscription keeps delivering after presence stops.
    await nextMessage(
      watcher.segment("room"),
      (message) => text(message.payload) === "still-member",
      "delivery proving the subscription stayed",
    );
    expect(events).toEqual([]);

    await actor.close();
    await watcher.close();
  });

  it("hides a connection's own join and shows it to a sibling of the same token", async () => {
    const reference = uniqueChannelReference("presence-self");
    const first = await open(reference, { reference: "alice" });
    const second = await open(reference, { reference: "alice" });
    const firstSaw = events(first, "room");
    const secondSaw = events(second, "room");
    first.segment("room").subscribePresence();
    second.segment("room").subscribePresence();
    await settle();

    const siblingJoin = nextPresence(
      second.segment("room"),
      (event) => event.joined,
      "the sibling's join",
    );
    first.segment("room").subscribe();
    const firstJoin = await siblingJoin;
    await settle();

    expect(firstJoin.tokenReference).toBe("alice");
    expect(firstSaw).toEqual([]);
    expect(secondSaw).toHaveLength(1);
  });

  it("sends a leave when a member unsubscribes and stays connected", async () => {
    const reference = uniqueChannelReference("presence-unsubscribe");
    const watcher = await open(reference);
    const actor = await open(reference, { reference: "actor" });
    watcher.segment("room").subscribePresence();
    await settle();

    const joined = nextPresence(
      watcher.segment("room"),
      (event) => event.joined && event.tokenReference === "actor",
      "the actor's join",
    );
    const membership = actor.segment("room").subscribe();
    const join = await joined;
    const left = nextPresence(
      watcher.segment("room"),
      (event) => !event.joined && event.tokenReference === "actor",
      "the actor's leave",
    );
    membership.cancel();
    const leave = await left;

    expect(leave.connectionId).toBe(join.connectionId);
    expect(actor.state).toBe("connected");
  });

  it("announces default-segment joins on connect and leaves on close, and lists every connection", async () => {
    const reference = uniqueChannelReference("presence-default");
    const watcher = await open(reference, { reference: "watcher" });
    watcher.defaultSegment().subscribePresence();
    await settle();

    const joined = nextPresence(
      watcher.defaultSegment(),
      (event) => event.joined && event.tokenReference === "late",
      "the join from connect",
    );
    const late = await connectedChannel(reference, { reference: "late" });
    const join = await joined;
    expect(join.segmentId).toBe("default");

    const page = await watcher
      .defaultSegment()
      .presenceList({ page: 1, perPage: 10 });
    expect(
      page.connections.map((connection) => connection.tokenReference).sort(),
    ).toEqual(["late", "watcher"]);

    const left = nextPresence(
      watcher.defaultSegment(),
      (event) => !event.joined && event.connectionId === join.connectionId,
      "the leave from close",
    );
    await late.close();
    await left;
  });

  it("lists each connection of one token reference with its own connection id", async () => {
    const reference = uniqueChannelReference("presence-same-reference");
    const watcher = await open(reference, { reference: "watcher" });
    const joins = events(watcher, "room");
    watcher.segment("room").subscribePresence();
    await settle();

    // One user with three tabs: three connections of one token reference.
    const tabs = [
      await open(reference, { reference: "user_1" }),
      await open(reference, { reference: "user_1" }),
      await open(reference, { reference: "user_1" }),
    ];
    const allJoined = waitFor<PresenceEvent[]>(
      (deliver) => watcher.segment("room").onPresence(() => deliver(joins)),
      (seen) => seen.filter((event) => event.joined).length >= 3,
      20_000,
      "three joins",
    );
    for (const tab of tabs) tab.segment("room").subscribe();
    await allJoined;

    const joinIds = joins.map((event) => event.connectionId);
    expect(joins.map((event) => event.tokenReference)).toEqual([
      "user_1",
      "user_1",
      "user_1",
    ]);
    expect(new Set(joinIds).size).toBe(3);

    // The largest page size, 100, lists all three.
    const page = await watcher
      .segment("room")
      .presenceList({ page: 1, perPage: 100 });
    expect(page.total).toBe(3);
    expect(
      page.connections.map((connection) => connection.tokenReference),
    ).toEqual(["user_1", "user_1", "user_1"]);

    expect(
      page.connections.map((connection) => connection.connectionId).sort(),
    ).toEqual([...joinIds].sort());

    // Closing one tab removes only that connection.
    const closedTab = tabs.shift()!;
    const left = nextPresence(
      watcher.segment("room"),
      (event) => !event.joined,
      "the leave of one tab",
    );
    await closedTab.close();
    const leave = await left;
    expect(leave.tokenReference).toBe("user_1");
    expect(joinIds).toContain(leave.connectionId);

    await settle();
    const after = await watcher
      .segment("room")
      .presenceList({ page: 1, perPage: 100 });
    expect(after.total).toBe(2);
    expect(
      after.connections.map((connection) => connection.connectionId).sort(),
    ).toEqual(joinIds.filter((id) => id !== leave.connectionId).sort());
  });

  it("pages through several full pages and past the end", async () => {
    const reference = uniqueChannelReference("presence-pages");
    const members = [
      await open(reference, { reference: "m1" }),
      await open(reference, { reference: "m2" }),
      await open(reference, { reference: "m3" }),
    ];
    for (const member of members) member.segment("room").subscribe();
    await settle(3_000);

    const pages = [];

    for (let page = 1; page <= 4; page += 1) {
      pages.push(
        await members[0]!.segment("room").presenceList({ page, perPage: 1 }),
      );
    }

    for (const [index, page] of pages.slice(0, 3).entries()) {
      expect(page).toMatchObject({
        total: 3,
        perPage: 1,
        currentPage: index + 1,
        from: index + 1,
        to: index + 1,
      });
      expect(page.connections).toHaveLength(1);
    }

    expect(pages[3]).toMatchObject({ total: 3, from: 4, to: 3 });
    expect(pages[3]!.connections).toEqual([]);
    const identifiers = pages.flatMap((page) =>
      page.connections.map((connection) => connection.connectionId),
    );
    expect(new Set(identifiers).size).toBe(3);
    expect(
      pages
        .flatMap((page) =>
          page.connections.map((connection) => connection.tokenReference),
        )
        .sort(),
    ).toEqual(["m1", "m2", "m3"]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { Channel, ChannelError } from "../../src/index";
import type { SigningPayload } from "./helpers/credentials";
import {
  connectedChannel,
  nextError,
  nextMessage,
  nextPresence,
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

function received(channel: Channel, segmentId: string): string[] {
  const bodies: string[] = [];
  channel.segment(segmentId).onMessage((payload) => bodies.push(text(payload)));

  return bodies;
} // end function received

// Waits for a permission denial that names this command and segment.
function denial(channel: Channel, subType: string, segmentId: string) {
  return nextError(
    channel,
    (error: ChannelError) =>
      "type" in error &&
      error.type === "PermissionDeniedError" &&
      error.subType === subType &&
      error.resource === segmentId,
    `a ${subType} denial for ${segmentId}`,
  );
} // end function denial

// A token that can read "readonly", write "writeonly", and nothing else: no
// other segment, and not "default" either.
const SEGMENT_PERMISSIONS: SigningPayload = {
  reference: "limited",
  tokenPermission: [
    { segment_id: "readonly", read: true, write: false },
    { segment_id: "writeonly", read: false, write: true },
  ],
};

describe("celeris per-segment permissions", () => {
  it("lets a read-only segment receive and refuses its publish", async () => {
    const reference = uniqueChannelReference("perm-read");
    const publisher = await open(reference);
    const limited = await open(reference, SEGMENT_PERMISSIONS);
    const readonly = received(limited, "readonly");
    limited.segment("readonly").subscribe();
    await settle();

    const delivered = nextMessage(
      limited.segment("readonly"),
      (message) => text(message.payload) === "hello",
      "the read-only delivery",
    );
    await publisher.segment("readonly").publish({ payload: utf8("hello") });
    await delivered;

    const refused = denial(limited, "PUB", "readonly");
    await limited.segment("readonly").publish({ payload: utf8("refused") });
    await refused;

    expect(readonly).toEqual(["hello"]);
    expect(limited.state).toBe("connected");
  });

  it("lets a write-only segment publish and refuses its subscription", async () => {
    const reference = uniqueChannelReference("perm-write");
    const reader = await open(reference);
    const limited = await open(reference, SEGMENT_PERMISSIONS);
    const writeonly = received(limited, "writeonly");
    reader.segment("writeonly").subscribe();
    const refused = denial(limited, "SUB", "writeonly");
    limited.segment("writeonly").subscribe();
    await refused;
    await settle();

    const arrived = nextMessage(
      reader.segment("writeonly"),
      (message) => text(message.payload) === "from-limited",
      "the write-only publish at the reader",
    );
    await limited
      .segment("writeonly")
      .publish({ payload: utf8("from-limited") });
    await arrived;
    await reader.segment("writeonly").publish({ payload: utf8("unheard") });
    await settle(2_500);

    expect(writeonly).toEqual([]);
    expect(limited.state).toBe("connected");
  });

  it("replays a write-only publish to a later subscriber", async () => {
    const reference = uniqueChannelReference("perm-write-replay");
    const limited = await open(reference, SEGMENT_PERMISSIONS);
    const writeonly = received(limited, "writeonly");
    // No connection is in the segment when the write-only token publishes.
    await limited.segment("writeonly").publish({ payload: utf8("kept") });
    await settle();

    const reader = await open(reference, { replay: true });
    const replayed = nextMessage(
      reader.segment("writeonly"),
      (message) => text(message.payload) === "kept",
      "the replay of the write-only publish",
    );
    reader.segment("writeonly").subscribe();
    await replayed;

    expect(writeonly).toEqual([]);
    expect(limited.state).toBe("connected");
  });

  it("refuses presence on a segment without read access", async () => {
    const reference = uniqueChannelReference("perm-presence");
    const limited = await open(reference, SEGMENT_PERMISSIONS);

    const refusedWatch = denial(limited, "PRES_SUB", "writeonly");
    limited.segment("writeonly").subscribePresence();
    await refusedWatch;

    await expect(
      limited.segment("writeonly").presenceList({ page: 1, perPage: 10 }),
    ).rejects.toMatchObject({
      type: "PermissionDeniedError",
      subType: "PRES_LIST",
    });
    const page = await limited
      .segment("readonly")
      .presenceList({ page: 1, perPage: 10 });
    expect(page.connections).toEqual([]);
  });

  it("refuses every command on a segment the token does not list", async () => {
    const reference = uniqueChannelReference("perm-unlisted");
    const limited = await open(reference, SEGMENT_PERMISSIONS);

    const refusedJoin = denial(limited, "SUB", "secret");
    limited.segment("secret").subscribe();
    await refusedJoin;
    const refusedPublish = denial(limited, "PUB", "secret");
    await limited.segment("secret").publish({ payload: utf8("x") });
    await refusedPublish;
    const refusedWatch = denial(limited, "PRES_SUB", "secret");
    limited.segment("secret").subscribePresence();
    await refusedWatch;

    expect(limited.state).toBe("connected");
  });

  it("gives an unlisted default segment no read and no write access", async () => {
    const reference = uniqueChannelReference("perm-default");
    const publisher = await open(reference);
    const limited = await open(reference, SEGMENT_PERMISSIONS);
    const lobby = received(limited, "default");
    const readonly = received(limited, "readonly");
    limited.segment("readonly").subscribe();
    await settle();

    await publisher.defaultSegment().publish({ payload: utf8("unheard") });
    const control = nextMessage(
      limited.segment("readonly"),
      (message) => text(message.payload) === "control",
      "the read-only control",
    );
    await publisher.segment("readonly").publish({ payload: utf8("control") });
    await control;
    const refused = denial(limited, "PUB", "default");
    await limited.defaultSegment().publish({ payload: utf8("refused") });
    await refused;
    await settle();

    expect(lobby).toEqual([]);
    expect(readonly).toEqual(["control"]);
  });
});

describe("celeris token reference", () => {
  it("shows the reference claim in message metadata, presence events and presence lists", async () => {
    const reference = uniqueChannelReference("token-reference");
    const watcher = await open(reference, { reference: "watcher" });
    const alice = await open(reference, { reference: "alice" });
    watcher.segment("room").subscribe();
    watcher.segment("room").subscribePresence();
    await settle();

    const joined = nextPresence(
      watcher.segment("room"),
      (event) => event.joined && event.tokenReference === "alice",
      "alice's join",
    );
    alice.segment("room").subscribe();
    await joined;

    const message = nextMessage(
      watcher.segment("room"),
      (delivery) => text(delivery.payload) === "hi",
      "alice's message",
    );
    await alice.segment("room").publish({ payload: utf8("hi") });
    expect((await message).tokenReference).toBe("alice");

    const page = await watcher
      .segment("room")
      .presenceList({ page: 1, perPage: 10 });
    expect(
      page.connections.map((connection) => connection.tokenReference).sort(),
    ).toEqual(["alice", "watcher"]);
  });
});

import { describe, expect, it } from "vitest";
import { ServerError, createClient } from "../../src/index";
import { signCredentials } from "./helpers/credentials";
import {
  GENERATED_MESSAGE_ID,
  clientId,
  connectedChannel,
  nextError,
  nextMessage,
  signingSecret,
  uniqueChannelReference,
  websocketUrl,
  type DeliveredMessage,
} from "./helpers/environment";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);

function collect(
  channel: Awaited<ReturnType<typeof connectedChannel>>,
  segmentId: string,
): DeliveredMessage[] {
  const received: DeliveredMessage[] = [];
  channel
    .segment(segmentId)
    .onMessage((payload, metadata) => received.push({ payload, ...metadata }));
  channel.segment(segmentId).subscribe();

  return received;
} // end function collect

const settle = (ms = 1_500) =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("celeris messaging", () => {
  it("delivers binary payloads with their ids and per-connection echo", async () => {
    const reference = uniqueChannelReference("msg");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    const publisherSaw = collect(publisher, "chat");
    const receiverSaw = collect(receiver, "chat");
    await settle();

    await publisher
      .segment("chat")
      .publish({ payload: utf8("hello-바이너리") });

    const message = await nextMessage(
      receiver.segment("chat"),
      () => true,
      "cross-connection delivery",
    );
    // REV-01: the id the SDK generated arrives unchanged.
    expect(message.messageId).toMatch(GENERATED_MESSAGE_ID);
    expect(message.messageId).not.toBe("");
    expect(text(message.payload)).toBe("hello-바이너리");
    expect(typeof message.timestamp).toBe("bigint");
    expect(message.timestamp > 0n).toBe(true);

    // Sibling connection of the same token receives; the publishing
    // connection itself is echo-suppressed.
    await settle();
    expect(receiverSaw.length).toBeGreaterThanOrEqual(1);
    expect(publisherSaw).toHaveLength(0);

    await publisher.close();
    await receiver.close();
  });

  it("echoes to the publisher when the token allows echo", async () => {
    const reference = uniqueChannelReference("echo");
    const channel = await connectedChannel(reference, { allowEcho: true });
    const saw = collect(channel, "chat");
    await settle();

    await channel.segment("chat").publish({ payload: utf8("self") });
    await nextMessage(
      channel.segment("chat"),
      (message) => text(message.payload) === "self",
      "an echoed publish",
    );
    expect(saw.length).toBeGreaterThanOrEqual(1);
    await channel.close();
  });

  it("delivers on the default segment without subscribing", async () => {
    const reference = uniqueChannelReference("default");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    const seen: DeliveredMessage[] = [];
    receiver
      .defaultSegment()
      .onMessage((payload, metadata) => seen.push({ payload, ...metadata }));
    await settle();

    await publisher.defaultSegment().publish({ payload: utf8("lobby") });
    await nextMessage(
      receiver.defaultSegment(),
      (message) => text(message.payload) === "lobby",
      "default-segment delivery",
    );
    expect(seen[0]!.segmentId).toBe("default");

    await publisher.close();
    await receiver.close();
  });

  it("round-trips a large binary payload", async () => {
    const reference = uniqueChannelReference("large");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    receiver.segment("bulk").subscribe();
    await settle();

    const payload = new Uint8Array(100 * 1024);

    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251;
    }

    await publisher.segment("bulk").publish({ payload });

    const message = await nextMessage(
      receiver.segment("bulk"),
      (received) => received.payload.length === payload.length,
      "large payload delivery",
      20_000,
    );
    expect(message.payload).toEqual(payload);

    await publisher.close();
    await receiver.close();
  });

  // Needs the qualification app on a plan with message_size_limit_in_kb of
  // at least 1024, which the CI seed guarantees. The cap counts the whole
  // encoded command, so the largest payload is the cap less its framing.
  it("round-trips a payload just under the 1024 KiB plan cap, larger than 1 MiB once framed", async () => {
    const reference = uniqueChannelReference("huge");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);

    receiver.segment("bulk").subscribe();
    await settle();

    const payload = new Uint8Array(1024 * 1024 - 96);

    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251;
    }

    await publisher.segment("bulk").publish({ payload });

    // Framed, this delivery is larger than 1 MiB: before LIMIT-01 the client
    // measured it on arrival and dropped it.
    const message = await nextMessage(
      receiver.segment("bulk"),
      (received) => received.payload.length === payload.length,
      "the delivery just under the cap",
      30_000,
    );

    expect(message.payload).toEqual(payload);

    await publisher.close();
    await receiver.close();
  });

  it("reports a publish over the plan cap as MessageSizeLimitError", async () => {
    const reference = uniqueChannelReference("oversize");
    const channel = await connectedChannel(reference);

    // Over every plan's cap, but under the 2 MiB transport ceiling, so it
    // passes the client's check and resolves locally before the server
    // rejects it.
    await channel
      .segment("bulk")
      .publish({ payload: new Uint8Array(1536 * 1024) });

    const rejection = await nextError(
      channel,
      (error) =>
        error instanceof ServerError && error.type === "MessageSizeLimitError",
      "the MessageSizeLimitError frame",
      20_000,
    );

    expect(rejection.message).toContain("Message size limit exceeded");
    expect(channel.state).toBe("connected");

    await channel.close();
  });

  it("reports a PermissionDeniedError for a read-only token's publish, naming the segment", async () => {
    const reference = uniqueChannelReference("perm");
    const readOnly = await connectedChannel(reference, {
      tokenPermission: { read: true, write: false },
    });
    const errors: unknown[] = [];
    readOnly.events().onError((error) => errors.push(error));

    // Publish resolves locally; the denial arrives later via onError.
    await readOnly.segment("chat").publish({ payload: utf8("denied") });
    const denial = await nextError(
      readOnly,
      (error) =>
        error instanceof ServerError && error.type === "PermissionDeniedError",
      "the PermissionDeniedError frame",
    );

    expect(denial.message.length).toBeGreaterThan(0);
    expect(denial).toMatchObject({ subType: "PUB", resource: "chat" });
    expect(readOnly.state).toBe("connected");
    await readOnly.close();
  });

  it("keeps a write-only token publishing while its subscription is refused", async () => {
    const reference = uniqueChannelReference("writeonly");
    const writeOnly = await connectedChannel(reference, {
      tokenPermission: { read: false, write: true },
    });
    const reader = await connectedChannel(reference);
    const refused = nextError(
      writeOnly,
      (error) =>
        error instanceof ServerError &&
        error.type === "PermissionDeniedError" &&
        error.subType === "SUB",
      "the subscription denial",
    );
    const writerSaw = collect(writeOnly, "chat");
    reader.segment("chat").subscribe();
    await refused;
    await settle();

    await writeOnly.segment("chat").publish({ payload: utf8("one-way") });
    await nextMessage(
      reader.segment("chat"),
      (message) => text(message.payload) === "one-way",
      "delivery to the reader",
    );
    await settle();
    expect(writerSaw).toHaveLength(0);

    await writeOnly.close();
    await reader.close();
  });

  it("recovers subscriptions the server drops under its rate limit", async () => {
    const reference = uniqueChannelReference("limit");
    // Separate token references keep separate per-connection limits.
    const subscriber = await connectedChannel(reference, {
      reference: "limit-subscriber",
    });
    const publisher = await connectedChannel(reference, {
      reference: "limit-publisher",
    });
    let rateLimited = false;
    subscriber.events().onError((error) => {
      if (error instanceof ServerError && error.type === "RateLimitError") {
        rateLimited = true;
      }
    });

    // The limiter tolerates bursts, so subscriptions go out in growing
    // batches until one trips it; some of them are then dropped, and only
    // recovery can restore them.
    const segmentIds: string[] = [];
    const delivered = new Set<string>();

    while (!rateLimited && segmentIds.length < 2_000) {
      for (let index = 0; index < 250; index += 1) {
        const segmentId = `limit-${segmentIds.length}`;
        segmentIds.push(segmentId);
        subscriber.segment(segmentId).onMessage(() => delivered.add(segmentId));
        subscriber.segment(segmentId).subscribe();
      }

      await settle(500);
    }

    expect(rateLimited, "the subscription burst must trip the limit").toBe(
      true,
    );

    // Publishes to every segment not yet delivered, round after round, until
    // each subscription has recovered. A publish the publisher's own limit
    // drops is simply published again in the next round.
    const deadline = Date.now() + 150_000;

    while (delivered.size < segmentIds.length && Date.now() < deadline) {
      await settle(3_000);
      for (const segmentId of segmentIds) {
        if (delivered.has(segmentId)) continue;
        try {
          await publisher
            .segment(segmentId)
            .publish({ payload: utf8(segmentId) });
        } catch (error) {
          // The publisher trips its own limit: sending pauses and the
          // publish queue fills. Back off and let it drain.
          if ((error as { code?: string }).code !== "Backpressure") throw error;
          await settle(2_000);
        }

        await settle(10);
      }
    }

    expect(delivered.size).toBe(segmentIds.length);

    await publisher.close();
    await subscriber.close();
  }, 180_000);

  // RESEND-01: a publish resent after a rate limit that had already been
  // delivered is dropped by the receiver's dedup window.
  it("delivers no duplicate under a publish rate limit", async () => {
    const reference = uniqueChannelReference("limit-publish");
    // Separate token references keep separate per-connection limits.
    const receiver = await connectedChannel(reference, {
      reference: "limit-receiver",
    });

    // A queue large enough for the whole burst, so that the publishes reach
    // the server instead of being refused with Backpressure in the client.
    const publisher = createClient({
      baseUrl: websocketUrl(),
      allowInsecureLoopback: true,
      publishQueueSize: 10_000,
      credentialProvider: async () =>
        signCredentials(clientId(), signingSecret(), {
          reference: "limit-publisher",
        }),
    }).channel(reference);
    await publisher.connect();

    const delivered = collect(receiver, "burst");
    await settle();

    let rateLimited = false;
    publisher.events().onError((error) => {
      if (error instanceof ServerError && error.type === "RateLimitError") {
        rateLimited = true;
      }
    });

    // Bursts that double in size until one trips the limit. The ceiling on the total keeps the test finite. A publish the
    // full queue refuses with Backpressure never went out, which is fine.
    const published = new Set<string>();
    let burstSize = 100;

    while (!rateLimited && published.size < 5_000) {
      const burst: Promise<void>[] = [];

      for (let index = 0; index < burstSize; index += 1) {
        const body = `burst-${published.size}`;
        published.add(body);
        burst.push(publisher.segment("burst").publish({ payload: utf8(body) }));
      }

      await Promise.allSettled(burst);
      burstSize *= 2;
      await settle(200);
    }

    expect(rateLimited, "the publish burst must trip the limit").toBe(true);

    await settle(3_000);
    const marker = nextMessage(
      receiver.segment("burst"),
      (message) => text(message.payload) === "marker",
      "the marker",
      30_000,
    );

    published.add("marker");
    await publisher.segment("burst").publish({ payload: utf8("marker") });
    await marker;
    await settle();

    const messageIds = delivered.map((message) => message.messageId);
    const bodies = delivered.map((message) => text(message.payload));
    expect(new Set(messageIds).size).toBe(messageIds.length);
    expect(bodies.filter((body) => !published.has(body))).toEqual([]);
    expect(bodies).toContain("marker");
    expect(receiver.state).toBe("connected");
    expect(publisher.state).toBe("connected");

    await publisher.close();
    await receiver.close();
  }, 120_000);

  it("delivers a custom message id unchanged and drops a repeat of it", async () => {
    const reference = uniqueChannelReference("custom-id");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    const received = collect(receiver, "chat");
    await settle();
    const messageId = `order-${Date.now()}`;

    await publisher
      .segment("chat")
      .publish({ payload: utf8("first"), messageId });

    await publisher
      .segment("chat")
      .publish({ payload: utf8("repeat"), messageId });
    const marker = nextMessage(
      receiver.segment("chat"),
      (message) => text(message.payload) === "marker",
      "the marker after the repeat",
    );
    await publisher.segment("chat").publish({ payload: utf8("marker") });
    await marker;

    expect(received.map((message) => text(message.payload))).toEqual([
      "first",
      "marker",
    ]);
    expect(received[0]!.messageId).toBe(messageId);

    await publisher.close();
    await receiver.close();
  });

  it("round-trips an empty payload", async () => {
    const reference = uniqueChannelReference("empty");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    receiver.segment("chat").subscribe();
    await settle();

    const arrived = nextMessage(
      receiver.segment("chat"),
      (message) => message.payload.length === 0,
      "the empty payload",
    );
    await publisher.segment("chat").publish({ payload: new Uint8Array(0) });
    const message = await arrived;

    expect(message.payload).toEqual(new Uint8Array(0));
    expect(message.messageId).toMatch(GENERATED_MESSAGE_ID);

    await publisher.close();
    await receiver.close();
  });

  // The cap counts the command's framing, so a payload of the cap itself
  // makes a command over it.
  it("refuses a full 1024 KiB payload", async () => {
    const reference = uniqueChannelReference("cap-full");
    const channel = await connectedChannel(reference);

    await channel
      .segment("bulk")
      .publish({ payload: new Uint8Array(1024 * 1024) });
    const rejection = await nextError(
      channel,
      (error) =>
        error instanceof ServerError && error.type === "MessageSizeLimitError",
      "the MessageSizeLimitError frame",
      20_000,
    );

    expect(rejection.message).toContain("size limit = 1024 KB");
    expect(channel.state).toBe("connected");

    await channel.close();
  });

  it("refuses a command over 2 MiB locally and stays connected", async () => {
    const reference = uniqueChannelReference("local-ceiling");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    const received = collect(receiver, "bulk");
    await settle();

    await expect(
      publisher
        .segment("bulk")
        .publish({ payload: new Uint8Array(2 * 1024 * 1024) }),
    ).rejects.toMatchObject({ name: "ConfigurationError" });
    const after = nextMessage(
      receiver.segment("bulk"),
      (message) => text(message.payload) === "after",
      "the publish after the refusal",
    );
    await publisher.segment("bulk").publish({ payload: utf8("after") });
    await after;

    expect(received.map((message) => text(message.payload))).toEqual(["after"]);
    expect(publisher.state).toBe("connected");

    await publisher.close();
    await receiver.close();
  });

  it("delivers a paced burst of 50 messages in publish order, one time each", async () => {
    const reference = uniqueChannelReference("burst");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    const received = collect(receiver, "chat");
    await settle();
    const bodies = Array.from({ length: 50 }, (_, index) => `b${index}`);

    const last = nextMessage(
      receiver.segment("chat"),
      (message) => text(message.payload) === "b49",
      "the last message of the burst",
      30_000,
    );

    // Paced below the per-second publish limit.
    for (let start = 0; start < bodies.length; start += 10) {
      for (const body of bodies.slice(start, start + 10)) {
        await publisher.segment("chat").publish({ payload: utf8(body) });
      }

      await settle(1_100);
    }

    await last;
    await settle();

    expect(received.map((message) => text(message.payload))).toEqual(bodies);
    expect(new Set(received.map((message) => message.messageId)).size).toBe(50);

    await publisher.close();
    await receiver.close();
  }, 60_000);

  it("refuses over-cap publishes in a burst by message id and delivers the rest in order", async () => {
    const reference = uniqueChannelReference("batch");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    const refused: ServerError[] = [];
    publisher.events().onError((error) => {
      if (error instanceof ServerError) refused.push(error);
    });
    const received = collect(receiver, "chat");
    await settle();
    const bodies = Array.from({ length: 20 }, (_, index) => `b${index}`);

    const last = nextMessage(
      receiver.segment("chat"),
      (message) => text(message.payload) === "b19",
      "the last message of the burst",
      30_000,
    );

    // The second over-cap publish waits for buffer room, so the small ones
    // wait behind it and go out packed (BATCH-01).
    const chat = publisher.segment("chat");
    const overCap = new Uint8Array(1024 * 1024 + 1);
    await Promise.all([
      chat.publish({ payload: overCap, messageId: "too-big-1" }),
      chat.publish({ payload: overCap, messageId: "too-big-2" }),
      ...bodies.map((body) => chat.publish({ payload: utf8(body) })),
    ]);

    await last;
    await settle();

    expect(received.map((message) => text(message.payload))).toEqual(bodies);
    expect(new Set(received.map((message) => message.messageId)).size).toBe(20);
    expect(
      refused.map((error) => [error.type, error.subType, error.resource]),
    ).toEqual([
      ["MessageSizeLimitError", "PUB", "too-big-1"],
      ["MessageSizeLimitError", "PUB", "too-big-2"],
    ]);

    await publisher.close();
    await receiver.close();
  }, 60_000);
});

import { describe, expect, it } from "vitest";
import { ServerError } from "../../src/index";
import {
  GENERATED_MESSAGE_ID,
  connectedChannel,
  nextError,
  nextMessage,
  uniqueChannelReference,
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
}

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

  it("demuxes segments and stops delivery after unsubscribe", async () => {
    const reference = uniqueChannelReference("segments");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    const alpha = collect(receiver, "alpha");
    const beta: DeliveredMessage[] = [];
    receiver
      .segment("beta")
      .onMessage((payload, metadata) => beta.push({ payload, ...metadata }));
    const betaMembership = receiver.segment("beta").subscribe();
    await settle();

    await publisher.segment("alpha").publish({ payload: utf8("a") });
    await publisher.segment("beta").publish({ payload: utf8("b") });
    await nextMessage(
      receiver.segment("alpha"),
      (message) => text(message.payload) === "a",
      "alpha delivery",
    );
    await settle();
    expect(alpha.every((message) => message.segmentId === "alpha")).toBe(true);
    expect(beta.every((message) => message.segmentId === "beta")).toBe(true);
    const betaCount = beta.length;

    betaMembership.cancel();
    await settle();
    await publisher.segment("beta").publish({ payload: utf8("late") });
    await settle(2_500);
    expect(beta.length).toBe(betaCount);

    await publisher.close();
    await receiver.close();
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
    for (let index = 0; index < payload.length; index += 1)
      payload[index] = index % 251;
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
  // at least 1024, which the CI seed guarantees.
  it("round-trips a full 1024 KiB payload, larger than 1 MiB once framed", async () => {
    const reference = uniqueChannelReference("huge");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);

    receiver.segment("bulk").subscribe();
    await settle();

    const payload = new Uint8Array(1024 * 1024);

    for (let index = 0; index < payload.length; index += 1)
      payload[index] = index % 251;

    await publisher.segment("bulk").publish({ payload });

    // Framed, this delivery is larger than 1 MiB: before LIMIT-01 the client
    // measured it on arrival and dropped it.
    const message = await nextMessage(
      receiver.segment("bulk"),
      (received) => received.payload.length === payload.length,
      "the 1024 KiB delivery",
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

  it("keeps a write-only token publishing while receiving nothing", async () => {
    const reference = uniqueChannelReference("writeonly");
    const writeOnly = await connectedChannel(reference, {
      tokenPermission: { read: false, write: true },
    });
    const reader = await connectedChannel(reference);
    const writerSaw = collect(writeOnly, "chat");
    reader.segment("chat").subscribe();
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
      if (error instanceof ServerError && error.type === "RateLimitError")
        rateLimited = true;
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
});

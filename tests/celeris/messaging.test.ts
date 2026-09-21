import { describe, expect, it } from "vitest";
import type { Message } from "../../src/index";
import {
  connectedChannel,
  nextError,
  nextMessage,
  uniqueChannelReference,
} from "./helpers/environment";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);

function collect(
  channel: Awaited<ReturnType<typeof connectedChannel>>,
  segmentId: string,
): Message[] {
  const received: Message[] = [];
  channel.segment(segmentId).onMessage((message) => received.push(message));
  channel.segment(segmentId).subscribe();

  return received;
}

const settle = (ms = 1_500) =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("celeris messaging", () => {
  it("delivers binary payloads with server-assigned ids and per-connection echo", async () => {
    const reference = uniqueChannelReference("msg");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    const publisherSaw = collect(publisher, "chat");
    const receiverSaw = collect(receiver, "chat");
    await settle();

    await publisher.segment("chat").publish({ payload: utf8("hello-바이너리") });

    const message = await nextMessage(
      receiver.segment("chat"),
      () => true,
      "cross-connection delivery",
    );
    // REV-01 verification: the server always assigns an id.
    expect(message.messageId).toMatch(/^msg_/);
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
    const beta: Message[] = [];
    receiver.segment("beta").onMessage((message) => beta.push(message));
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
    const seen: Message[] = [];
    receiver.segment().onMessage((message) => seen.push(message));
    await settle();

    await publisher.segment().publish({ payload: utf8("lobby") });
    await nextMessage(
      receiver.segment(),
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

  it("reports a Permission error for a read-only token's publish, uncorrelated", async () => {
    const reference = uniqueChannelReference("perm");
    const readOnly = await connectedChannel(reference, {
      tokenPermission: { read: true, write: false },
    });
    const errors: unknown[] = [];
    readOnly.events().onError((error) => errors.push(error));

    // Publish resolves locally; the denial arrives later via onError.
    await readOnly.segment("chat").publish({ payload: utf8("denied") });
    await nextError(
      readOnly,
      (error) => error.code === "Permission",
      "the Permission error frame",
    );
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
});

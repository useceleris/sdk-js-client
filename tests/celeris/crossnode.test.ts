import { describe, expect, it } from "vitest";
import {
  connectedChannel,
  nextMessage,
  uniqueChannelReference,
} from "./helpers/environment";

const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);
const settle = (ms = 2_000) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Connections are opened through the configured entrypoint, which
// distributes them across the stack's nodes; these assert fan-out and
// presence consistency between independent connections.
describe("celeris cross-node", () => {
  it("fans out publishes across nodes", async () => {
    const reference = uniqueChannelReference("xnode");
    const primary = await connectedChannel(reference);
    const secondary = await connectedChannel(reference);
    secondary.segment("chat").subscribe();
    await settle();

    await primary.segment("chat").publish({ payload: utf8("across") });
    const message = await nextMessage(
      secondary.segment("chat"),
      (received) => text(received.payload) === "across",
      "cross-node delivery",
      25_000,
    );
    expect(message.messageId).toMatch(/^msg_/);

    await primary.close();
    await secondary.close();
  });

  it("reports consistent presence across nodes", async () => {
    const reference = uniqueChannelReference("xpres");
    const primary = await connectedChannel(reference);
    const secondary = await connectedChannel(reference);
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
    expect(fromPrimary.total >= 2n).toBe(true);

    await primary.close();
    await secondary.close();
  });
});

import { describe, expect, it } from "vitest";
import { createClient } from "../../src/index";
import { signCredentials } from "./helpers/credentials";
import {
  clientId,
  connectedChannel,
  nextNotice,
  qualificationClient,
  signingSecret,
  uniqueChannelReference,
  websocketUrl,
} from "./helpers/environment";

const text = (payload: Uint8Array) => new TextDecoder().decode(payload);

describe("celeris authentication", () => {
  it("connects with valid credentials and receives the greeting notices", async () => {
    const reference = uniqueChannelReference("auth");
    const channel = qualificationClient().channel(reference);
    const notices: string[] = [];
    channel.events().onNotice((notice) => notices.push(text(notice.payload)));

    await channel.connect();
    await nextNotice(
      channel,
      () => notices.length >= 2,
      "the connect and default-subscribe greetings",
    );

    expect(
      notices.some((entry) => entry.includes("Successfully connected")),
    ).toBe(true);
    expect(notices.some((entry) => entry.includes('segment "default"'))).toBe(
      true,
    );
    await channel.close();
  });

  it("rejects an invalid signature as Transport, never an authorization label", async () => {
    const channel = createClient({
      baseUrl: websocketUrl(),
      allowInsecureLoopback: true,
      credentialProvider: async () => ({
        ...signCredentials(clientId(), "wrong-secret"),
      }),
    }).channel(uniqueChannelReference("badsig"));

    await expect(channel.connect()).rejects.toMatchObject({
      code: "Transport",
    });
    expect(channel.state).toBe("failed");
  });

  it("rejects an unknown client id", async () => {
    const channel = createClient({
      baseUrl: websocketUrl(),
      allowInsecureLoopback: true,
      credentialProvider: async () =>
        signCredentials("no-such-client", signingSecret()),
    }).channel(uniqueChannelReference("noclient"));

    await expect(channel.connect()).rejects.toMatchObject({
      code: "Transport",
    });
  });

  it("rejects expired and future timestamps; accepts inside the observed 60-minute window", async () => {
    const reference = uniqueChannelReference("window");
    const expired = qualificationClient({
      timestamp: Date.now() - 61 * 60 * 1_000,
    }).channel(reference);
    await expect(expired.connect()).rejects.toMatchObject({
      code: "Transport",
    });

    const future = qualificationClient({
      timestamp: Date.now() + 5 * 60 * 1_000,
    }).channel(reference);
    await expect(future.connect()).rejects.toMatchObject({
      code: "Transport",
    });

    // Documented intent is a 60-second window; the server accepts up to
    // 60 minutes (D-001 evidence — recorded, not relied upon).
    const stale = qualificationClient({
      timestamp: Date.now() - 59 * 60 * 1_000,
    }).channel(reference);
    await stale.connect();
    await stale.close();
  });

  it("rejects a channel outside the token's restriction", async () => {
    const channel = qualificationClient({
      channelReferences: ["some-other-channel"],
    }).channel(uniqueChannelReference("restricted"));

    await expect(channel.connect()).rejects.toMatchObject({
      code: "Transport",
    });
  });

  it("accepts a channel inside the token's restriction", async () => {
    const reference = uniqueChannelReference("allowed");
    const channel = await connectedChannel(reference, {
      channelReferences: [reference],
    });
    expect(channel.state).toBe("connected");
    await channel.close();
  });
});

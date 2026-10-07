import { describe, expect, it } from "vitest";
import { createClient, type CredentialRequest } from "../../src/index";
import { signCredentials, signRawPayload } from "./helpers/credentials";
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

  it.each([
    [
      "an empty reference",
      () => JSON.stringify({ timestamp: Date.now(), reference: "" }),
    ],
    ["a payload that is not JSON", () => "not json"],
    ["a payload without a timestamp", () => JSON.stringify({ reference: "x" })],
    [
      "a timestamp that is a string",
      () => JSON.stringify({ timestamp: "now" }),
    ],
    [
      "a timestamp 30 seconds in the future",
      () => JSON.stringify({ timestamp: Date.now() + 30_000 }),
    ],
  ])("refuses %s as Transport", async (_label, payloadText) => {
    const channel = createClient({
      baseUrl: websocketUrl(),
      allowInsecureLoopback: true,
      credentialProvider: async () =>
        signRawPayload(clientId(), signingSecret(), payloadText()),
    }).channel(uniqueChannelReference("refused-claims"));

    await expect(channel.connect()).rejects.toMatchObject({
      code: "Transport",
    });
    expect(channel.state).toBe("failed");
  });

  it("accepts an empty channel restriction, which permits every channel", async () => {
    const channel = await connectedChannel(uniqueChannelReference("any"), {
      channelReferences: [],
    });
    expect(channel.state).toBe("connected");
    await channel.close();
  });

  it("accepts a channel that is one of several in the restriction", async () => {
    const reference = uniqueChannelReference("several");
    const channel = await connectedChannel(reference, {
      channelReferences: ["some-other-channel", reference],
    });
    expect(channel.state).toBe("connected");
    await channel.close();
  });

  it("requests fresh credentials for every explicit connect", async () => {
    const requests: CredentialRequest[] = [];
    const client = createClient({
      baseUrl: websocketUrl(),
      allowInsecureLoopback: true,
      credentialProvider: async (request) => {
        requests.push(request);

        return signCredentials(clientId(), signingSecret());
      },
    });
    const reference = uniqueChannelReference("fresh");

    const first = client.channel(reference);
    await first.connect();
    await first.close();
    const second = client.channel(reference);
    await second.connect();
    await second.close();

    expect(requests.map((request) => request.reason)).toEqual([
      "initial",
      "initial",
    ]);

    expect(
      requests.every((request) => request.channelReference === reference),
    ).toBe(true);
  });
});

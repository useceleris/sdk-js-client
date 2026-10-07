import { vi } from "vitest";
import { Channel, type ChannelInternals } from "../../src/channel";
import { createClient, type ClientOptions } from "../../src/client";
import type { CredentialProvider } from "../../src/credential-types";
import { utf8 } from "../fixtures/codec-vectors";

export const testCredentials = {
  payload: "payload-1",
  signature: "signature-1",
};

export type TestClocks = {
  monotonic: number;
  wall: number;
  randomValue: number;
};

export function createTestChannel(overrides: Partial<ChannelInternals> = {}) {
  const clocks: TestClocks = {
    monotonic: 0,
    wall: 1_700_000_000_000,
    randomValue: 0,
  };
  let generatedMessageIds = 0;
  const credentialProvider = vi.fn<CredentialProvider>(
    async () => testCredentials,
  );
  const channel = new Channel({
    baseUrl: "wss://example.test/",
    channelReference: "room-1",
    allowInsecureLoopback: false,
    connectTimeoutMs: 15_000,
    reconnectTimeoutMs: 15_000,
    presenceQueryTimeoutMs: 10_000,
    publishQueueSize: 64,
    deduplicationWindowSize: 1024,
    maximumReconnectAttempts: 10,
    credentialProvider,
    clock: () => clocks.monotonic,
    wallClock: () => clocks.wall,
    random: () => clocks.randomValue,
    generateMessageId: () => `generated-${(generatedMessageIds += 1)}`,
    ...overrides,
  });

  return { channel, credentialProvider, clocks };
} // end function createTestChannel

// Built through the public constructor, so option validation, defaults and
// plumbing are all exercised. Timing comes from fake timers and Math.random.
export function createClientChannel(options: Partial<ClientOptions> = {}) {
  const credentialProvider = vi.fn<CredentialProvider>(
    async () => testCredentials,
  );
  const channel = createClient({
    baseUrl: "wss://example.test/",
    credentialProvider,
    ...options,
  }).channel("room-1");

  return { channel, credentialProvider };
} // end function createClientChannel

// A server MSG frame. A null id leaves the identifier out.
export function messageFrame(
  segmentId: string,
  messageId: string | null,
  body: string,
): ArrayBufferLike {
  const identifier =
    messageId === null ? "$-1\n" : `$${utf8(messageId).length}\n${messageId}\n`;

  return utf8(
    `@MSG\n$4\nuser\n$${utf8(segmentId).length}\n${segmentId}\n` +
      `${identifier}:1\n$${utf8(body).length}\n${body}\n`,
  ).buffer;
} // end function messageFrame

export async function flushMicrotasks(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
} // end function flushMicrotasks

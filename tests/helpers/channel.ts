import { vi } from "vitest";
import { Channel, type ChannelInternals } from "../../src/channel";
import type { CredentialProvider } from "../../src/credential-types";

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
  const credentialProvider = vi.fn<CredentialProvider>(
    async () => testCredentials,
  );
  const channel = new Channel({
    baseUrl: "wss://example.test/",
    channelReference: "room-1",
    allowInsecureLoopback: false,
    connectTimeoutMs: 15_000,
    presenceQueryTimeoutMs: 10_000,
    credentialProvider,
    clock: () => clocks.monotonic,
    wallClock: () => clocks.wall,
    random: () => clocks.randomValue,
    ...overrides,
  });

  return { channel, credentialProvider, clocks };
}

export async function flushMicrotasks(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  Channel,
  ChannelError,
  ChannelEventHandler,
  ChannelState,
  RecoveryEvent,
  Subscription,
} from "../../src/channel";
import type { ClientOptions } from "../../src/client";
import type {
  CredentialProvider,
  CredentialRequest,
  Credentials,
} from "../../src/credentials";

describe("channel type contracts", () => {
  it("keeps the public lifecycle shapes hand-written", () => {
    expectTypeOf<ChannelState>().toEqualTypeOf<
      | "idle"
      | "connecting"
      | "connected"
      | "reconnecting"
      | "failed"
      | "closing"
      | "closed"
    >();

    expectTypeOf<Channel["connect"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<Channel["close"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<Channel["state"]>().toEqualTypeOf<ChannelState>();
    expectTypeOf<
      Channel["events"]
    >().returns.toEqualTypeOf<ChannelEventHandler>();

    expectTypeOf<
      ReturnType<ChannelEventHandler["onStateChange"]>
    >().toEqualTypeOf<() => void>();
    expectTypeOf<ReturnType<ChannelEventHandler["onRecovery"]>>().toEqualTypeOf<
      () => void
    >();
    expectTypeOf<ReturnType<ChannelEventHandler["onError"]>>().toEqualTypeOf<
      () => void
    >();

    expectTypeOf<RecoveryEvent>().toEqualTypeOf<{
      readonly retryIndex: number;
      readonly possibleGaps: true;
      readonly possibleDuplicates: true;
    }>();

    expectTypeOf<Subscription>().toEqualTypeOf<{ cancel(): void }>();
  });

  it("keeps credential and option types free of schema inference", () => {
    expectTypeOf<Credentials>().toEqualTypeOf<{
      readonly payload: string;
      readonly signature: string;
    }>();

    expectTypeOf<CredentialRequest>().toEqualTypeOf<{
      readonly channelReference: string;
      readonly reason: "initial" | "reconnect";
      readonly disconnectedAt?: number;
      readonly replayLookbackMs?: number;
      readonly signal: AbortSignal;
    }>();

    expectTypeOf<CredentialProvider>().toEqualTypeOf<
      (request: CredentialRequest) => Promise<Credentials>
    >();

    expectTypeOf<ClientOptions>().toEqualTypeOf<{
      readonly baseUrl: string;
      readonly credentialProvider: CredentialProvider;
      readonly allowInsecureLoopback?: boolean;
      readonly connectTimeoutMs?: number;
      readonly presenceQueryTimeoutMs?: number;
    }>();
  });

  it("rejects mutation of readonly event fields", () => {
    expect(verifyReadonly).toBeTypeOf("function");
  });
});

function verifyReadonly(event: RecoveryEvent, error: ChannelError): void {
  // @ts-expect-error retryIndex is readonly
  event.retryIndex = 1;
  // @ts-expect-error possibleGaps is readonly
  event.possibleGaps = true;
  void error;
} // end function verifyReadonly

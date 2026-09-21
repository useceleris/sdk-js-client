import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  Channel,
  ChannelError,
  ChannelEventHandler,
  ChannelState,
  Message,
  PresenceConnection,
  PresencePage,
  RecoveryEvent,
  ServerNotice,
  Subscription,
} from "../../src/channel";
import type { Segment } from "../../src/segment";
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

  it("keeps the segment and message shapes hand-written", () => {
    expectTypeOf<Message>().toEqualTypeOf<{
      readonly tokenReference: string;
      readonly segmentId: string;
      readonly messageId: string;
      readonly timestamp: bigint;
      readonly payload: Uint8Array;
    }>();

    expectTypeOf<Channel["segment"]>().toEqualTypeOf<
      (segmentId?: string) => Segment
    >();
    expectTypeOf<Segment["segmentId"]>().toEqualTypeOf<string>();
    expectTypeOf<Segment["subscribe"]>().returns.toEqualTypeOf<Subscription>();
    expectTypeOf<ReturnType<Segment["onMessage"]>>().toEqualTypeOf<
      () => void
    >();
    expectTypeOf<Segment["publish"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<Parameters<Segment["publish"]>[0]>().toEqualTypeOf<{
      readonly payload: Uint8Array;
      readonly messageId?: string;
      readonly signal?: AbortSignal;
    }>();
  });

  it("keeps the presence shapes hand-written", () => {
    expectTypeOf<ServerNotice>().toEqualTypeOf<{
      readonly timestamp: bigint;
      readonly payload: Uint8Array;
    }>();

    expectTypeOf<PresenceConnection>().toEqualTypeOf<{
      readonly tokenReference: string;
      readonly connectionId: string;
      readonly timestamp: bigint;
    }>();

    expectTypeOf<PresencePage>().toEqualTypeOf<{
      readonly segmentId: string;
      readonly total: bigint;
      readonly perPage: bigint;
      readonly currentPage: bigint;
      readonly from: bigint;
      readonly to: bigint;
      readonly connections: readonly PresenceConnection[];
    }>();

    expectTypeOf<ReturnType<ChannelEventHandler["onNotice"]>>().toEqualTypeOf<
      () => void
    >();
    expectTypeOf<
      Segment["subscribePresence"]
    >().returns.toEqualTypeOf<Subscription>();
    expectTypeOf<Segment["presenceList"]>().returns.toEqualTypeOf<
      Promise<PresencePage>
    >();
    expectTypeOf<Parameters<Segment["presenceList"]>[0]>().toEqualTypeOf<{
      readonly page: number;
      readonly perPage: number;
      readonly signal?: AbortSignal;
    }>();
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

function verifyReadonly(
  event: RecoveryEvent,
  message: Message,
  page: PresencePage,
  notice: ServerNotice,
  error: ChannelError,
): void {
  // @ts-expect-error retryIndex is readonly
  event.retryIndex = 1;
  // @ts-expect-error possibleGaps is readonly
  event.possibleGaps = true;
  // @ts-expect-error messageId is readonly
  message.messageId = "changed";
  // @ts-expect-error payload is readonly
  message.payload = new Uint8Array();
  // @ts-expect-error total is readonly
  page.total = 0n;
  // @ts-expect-error timestamp is readonly
  notice.timestamp = 0n;
  void error;
} // end function verifyReadonly

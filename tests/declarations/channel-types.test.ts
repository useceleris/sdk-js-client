import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  Channel,
  ChannelError,
  ChannelEventHandler,
  ChannelState,
  MessageMetadata,
  MessageListener,
  PresenceConnection,
  PresencePage,
  RecoveryEvent,
  ServerNotice,
  Subscription,
} from "../../src/channel";
import type { ConnectionErrorCode } from "../../src/errors";
import type { Segment } from "../../src/segment";
import type { ClientOptions } from "../../src/client";
import type {
  CredentialProvider,
  CredentialRequest,
  Credentials,
} from "../../src/credential-types";

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
    expectTypeOf<MessageMetadata>().toEqualTypeOf<{
      readonly tokenReference: string;
      readonly segmentId: string;
      readonly messageId: string;
      readonly timestamp: bigint;
    }>();

    // MSG-01: payload first, the rest of the message beside it.
    expectTypeOf<MessageListener>().toEqualTypeOf<
      (payload: Uint8Array, metadata: MessageMetadata) => void
    >();
    expectTypeOf<
      Parameters<Segment["onMessage"]>[0]
    >().toEqualTypeOf<MessageListener>();

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

    // ENDPOINT-01: baseUrl is optional; the package knows the endpoint.
    expectTypeOf<ClientOptions>().toEqualTypeOf<{
      readonly credentialProvider: CredentialProvider;
      readonly baseUrl?: string;
      readonly allowInsecureLoopback?: boolean;
      readonly connectTimeoutMs?: number;
      readonly presenceQueryTimeoutMs?: number;
    }>();
  });

  it("pins the realized error-code union", () => {
    // Authentication stays out until a knowable source exists (DEV-02):
    // native WebSocket exposes no handshake status in any runtime.
    expectTypeOf<ConnectionErrorCode>().toEqualTypeOf<
      | "Timeout"
      | "Cancelled"
      | "Transport"
      | "NotConnected"
      | "Backpressure"
      | "OperationInProgress"
      | "DeliveryUnknown"
      | "Permission"
    >();
  });

  it("rejects mutation of readonly event fields", () => {
    expect(verifyReadonly).toBeTypeOf("function");
  });
});

function verifyReadonly(
  event: RecoveryEvent,
  metadata: MessageMetadata,
  page: PresencePage,
  notice: ServerNotice,
  error: ChannelError,
): void {
  // @ts-expect-error retryIndex is readonly
  event.retryIndex = 1;
  // @ts-expect-error possibleGaps is readonly
  event.possibleGaps = true;
  // @ts-expect-error messageId is readonly
  metadata.messageId = "changed";
  // @ts-expect-error tokenReference is readonly
  metadata.tokenReference = "changed";
  // @ts-expect-error total is readonly
  page.total = 0n;
  // @ts-expect-error timestamp is readonly
  notice.timestamp = 0n;
  void error;
} // end function verifyReadonly

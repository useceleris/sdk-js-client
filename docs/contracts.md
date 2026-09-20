# Client contracts and source baseline

C0 decisions, 2026-09-06. These are client SDK requirements unless explicitly identified as observed platform behavior. Code inspection is not executed server conformance. Sources outside this repo remain unchanged.

## Reviewed revisions

| Repository        | Revision                                   | Checkout at inspection                              |
| ----------------- | ------------------------------------------ | --------------------------------------------------- |
| celeris-realtime  | `9b67cb6634a9c24754e75df25e2cbc2df1b26f26` | Clean                                               |
| celeris-sdk-specs | `d51738c0fe6aff5fa6d2fecc0bb8efb4169bbddf` | Clean                                               |
| sdk-js-server     | `de44c3448c08d062a9c700565ba85d4e55bf7b34` | Clean                                               |
| sdk-js-client     | Unborn HEAD                                | Existing untracked STAGES.md; preserved and updated |

The [shared contract](../../../celeris-sdk-specs/docs/shared-contract.md) defines common behavior; [protocol](../../../celeris-sdk-specs/docs/protocol.md) and [conformance](../../../celeris-sdk-specs/docs/conformance.md) supply layouts and scenario IDs. The protocol document names an older realtime revision; this pass refreshes relevant claims against the revision above. The old Node-only/asynchronous Web Crypto signing wording and proposed TypeScript 5.4 check are superseded by the user's current portable, synchronous signer and latest-dependency requirements.

## Credentials and package boundary (SDK-02, SDK-10; AUTH-03–05)

C3 implements this internal contract. It supersedes the earlier positional callback:

```ts
type Credentials = {
  readonly payload: string;
  readonly signature: string;
};

type CredentialRequest = {
  readonly channelReference: string;
  readonly reason: "initial" | "reconnect";
  readonly disconnectedAt?: number;
  readonly replayLookbackMs?: number;
  readonly signal: AbortSignal;
};

type CredentialProvider = (request: CredentialRequest) => Promise<Credentials>;
```

The reviewed [server signer](../../sdk-js-server/src/signer.ts) returns a synchronous `SignedCredentials` with exactly these readonly string fields. Applications may wrap signing in an asynchronous provider; browser applications acquire credentials through their authenticated application endpoint. The provider resolves opaque strings unchanged. Provider failures use fixed safe errors with no raw cause: Timeout/Cancelled for those conditions; arbitrary provider failures become Transport. C3 does not recognize application-supplied Authentication/Permission claims from error properties. Never decode/re-serialize/sign credentials in the client. Never import server code in client fixtures or dependencies. Future server integration depends on the client's public API in S4/C3–C4.

This is recorded client-side compatibility review, not a claim of bilateral acknowledgement or changes to S0. Server-owner acknowledgement remains pending. Provider cancellation rejects acquisition and suppresses stale results using attempt identity; an uncooperative provider cannot create a late socket. The server signer itself is synchronous and has no cancellation API. Codec operations likewise remain synchronous.

## Public API surface (SDK-03–09; decided 2026-09-20)

Names for the C4–C7 public surface are now fixed. The entrypoint stays empty until C4 exports the first subset. Zod inference never crosses into public declarations: every exported type below is hand-written, and internal `ClientCommand`/`ServerMessage` shapes map onto `Message`, `ServerNotice` and `PresencePage`. Consumer usage is mirrored in [EXAMPLES.md](../EXAMPLES.md), which must change in the same commit as this section.

```ts
export function createClient(options: ClientOptions): Client;

export type ClientOptions = {
  readonly baseUrl: string;                       // wss; ws only via allowInsecureLoopback
  readonly credentialProvider: CredentialProvider;
  readonly allowInsecureLoopback?: boolean;       // default false
  readonly connectTimeoutMs?: number;             // default 15_000
  readonly presenceQueryTimeoutMs?: number;       // default 10_000
  readonly onDiagnostic?: (event: DiagnosticEvent) => void; // opt-in, off by default, safe fields only
};

export class Client {
  channel(reference: string): Channel;            // side-effect free; new handle each call
}

export type ChannelState =
  | "idle" | "connecting" | "connected"
  | "reconnecting" | "failed" | "closing" | "closed";

export class Channel {
  readonly state: ChannelState;
  connect(options?: { signal?: AbortSignal }): Promise<void>;   // OperationInProgress on concurrent
  close(): Promise<void>;                                       // idempotent, terminal, 5 s budget
  publish(options: {
    payload: Uint8Array;                          // empty valid; ≤128 KiB encoded
    segmentId?: string;                           // default segment when omitted
    messageId?: string;                           // optional; empty rejected
    signal?: AbortSignal;
  }): Promise<void>;                              // resolves on local acceptance only
  subscribe(segmentId?: string): Subscription<Message>;         // ref-counted message interest
  subscribePresence(segmentId?: string): Subscription<never>;   // interest only; notices arrive raw
  notices(): Subscription<ServerNotice>;                        // raw SERVER_MSG stream, incl. presence prose
  events(): Subscription<ChannelEvent>;                         // state changes + recovery events
  presenceList(options: {
    segmentId?: string;
    page: number;                                 // 1..2147483647, reject not clamp
    perPage: number;                              // 1..100, reject not clamp
    signal?: AbortSignal;
  }): Promise<PresencePage>;                      // serialized; one in flight per channel
}

export interface Subscription<T> extends AsyncIterable<T> {
  cancel(): void;                                 // idempotent dispose; bounded queue behind it
}

export type Message = {
  readonly tokenReference: string;
  readonly segmentId: string;
  readonly messageId: string;                     // REV-01: server always assigns ids
  readonly timestamp: bigint;
  readonly payload: Uint8Array;
};
export type ServerNotice = { readonly timestamp: bigint; readonly payload: Uint8Array };
export type PresencePage = {
  readonly segmentId: string;
  readonly total: bigint;
  readonly perPage: bigint;
  readonly currentPage: bigint;
  readonly from: bigint;                          // from > to possible; raw metadata preserved
  readonly to: bigint;
  readonly connections: readonly PresenceConnection[];
};
export type PresenceConnection = {
  readonly tokenReference: string;
  readonly connectionId: string;
  readonly timestamp: bigint;
};
export type ChannelEvent =
  | { readonly kind: "state"; readonly state: ChannelState }
  | { readonly kind: "recovery"; readonly retryIndex: number; readonly possibleGaps: true; readonly possibleDuplicates: true };

export type { Credentials, CredentialRequest, CredentialProvider }; // shapes above, exported from C4
```

There is no `"error"` event kind: operation errors reject their Promises, and a subscription failure terminates the iterator with the error (terminal iterator state per the delivery-queue contract).

**REV-01 (2026-09-20, user-reported Celeris update, spec revision pending):** the server now always assigns a MSG id, and the client owns idempotent delivery. Public `Message.messageId` is non-null, and C5 deduplicates deliveries by id within a bounded, non-configurable per-channel window before fanout; C7 relies on that window to absorb replay duplicates, and duplicates beyond the window remain possible and stay declared in the recovery event. The C2 decoder keeps its nullable-id tolerance until C8 verifies the updated server; a null id then becomes a protocol violation at the delivery layer. This supersedes the earlier "no implicit deduplication" wording below for message delivery; ordering is still preserved and no durable cursor or global ordering claim follows.

Errors keep the existing three classes — `ConfigurationError`, `ProtocolError`, `ConnectionError` — with no new hierarchy, base class or `category` alias field. `ConnectionErrorCode` widens to cover the shared contract's remaining categories as their stages land: `OperationInProgress` (C4), `DeliveryUnknown` (C5), `Authentication` and `Permission` (C7). The `code`/`name` values are the shared-contract categories; `"Configuration"` and `"ProtocolError"` complete the eleven.

Never exported: `ConnectionHandler`, `ConnectionHandle`, `MessageDecoder`, `encodeClientCommand`, `decodeServerMessage`, Zod schemas, `NODE_PUB`, any signing facility.

### Minimalism constraints (binding for C4–C7)

- `Client` is a stateless configuration holder with exactly one method, `channel()`. It gains no registry, shared state or connection pool.
- One `Subscription<T>` type serves message and presence interests (`Subscription<never>` yields nothing; `cancel()` is the point). No second handle type and no `Segment` class.
- No error hierarchy; only the code-union widening above.
- No reconnect or limit knobs in `ClientOptions`. Shared-contract defaults (10 retries, full jitter, 64-command/1 MiB writer, 256-delivery/1 MiB queue) are authoritative and non-configurable in v1. Only the two spec-marked-configurable timeouts are options.
- No event framework: `events()` is one bounded async iterable of a two-arm union.
- Prefer adding a method to an existing class over adding a class; prefer a documented pattern over a convenience export. Every new public identifier must trace to a specification requirement.

## Lifecycle and ownership (SDK-03–08)

Construction is side-effect free. Each explicitly created channel handle owns one socket; segment interests share it. State changes follow idle → connecting → connected, unexpected loss → reconnecting → connected/failed, and explicit close → closing → closed. Closed is terminal; failed requires explicit connect. Concurrent connect rejects with OperationInProgress. Connected confirms only WebSocket establishment.

Use a 15-second combined credential/handshake deadline. C3 close is synchronous and idempotent; C4 adds the five-second channel close budget. Close releases SDK callbacks and listeners. Late work is suppressed by attempt settlement and, from C4, connection generation. Callback failures cannot corrupt state.

Publishing completes on local native WebSocket acceptance, with no server receipt, durability or delivery guarantee. No offline queue or automatic resend; interrupted submission may report DeliveryUnknown when observable. Writer bounds are 64 commands and 1 MiB including native `bufferedAmount`.

Message and presence interests have separate per-segment reference counts. Last presence cancellation sends PRES_UNSUB. UNSUB is sent only when both counts reach zero on a non-default segment; default retains remote membership. Cancellation releases local intent immediately. If required cleanup cannot enter a full writer, invalidate the socket and enter failed with Backpressure rather than leave stale remote interest silently active. No reserved unbounded cleanup queue.

The aggregate delivery queue is bounded by 256 deliveries and 1 MiB, counting fanout copies. Overflow aborts the socket, enters failed, and exposes Backpressure/possible loss through terminal iterator state outside the full queue. State/error inspection must remain available; no automatic reconnect loop for a slow consumer.

Presence queries are serialized, with a 10-second deadline and OperationInProgress for overlap. Match segment/page/perPage. Cancellation before submission releases the query slot; timeout/cancellation after submission retires that socket before another query and requests bounded recovery while preserving intent. No query retry. Unexpected replies remain unsolicited protocol events. SERVER_MSG is a channel-wide raw notice, not a typed join/leave event or receipt.

Restore message interests then presence interests in registration order. Recovery permits 10 retries, full jitter in [0, min(30 seconds, 500 ms × 2^retryIndex)], beginning at index zero; reset after 60 seconds connected. Each attempt requests fresh credentials. Deterministic configuration/permission failures, protocol corruption and explicit close do not retry. Hidden browser handshake status stays unknown. Recovery reports possible gaps and duplicates; preserve arrival order with no durable cursor or global ordering claim. Message delivery is deduplicated by server-assigned id within the bounded REV-01 window; duplicates beyond it remain possible.

C3 implements an internal native transport factory and per-attempt credential acquisition. See [transport contract](transport.md). C4 owns channel state and queues; C7 adds monotonic outage measurement and jittered recovery.

## Codec decisions (SDK-01; WIRE-01–05)

`encodeClientCommand` and `decodeServerMessage` are internal synchronous functions. The package entrypoint remains empty. Outbound schema discrimination uses command names PUB, SUB, UNSUB, PRES_SUB, PRES_UNSUB and PRES_LIST with descriptive fields `segmentId`, `messageId`, `payload`, `page`, `perPage`. Unknown object fields are stripped. Omitted/undefined messageId encodes null; explicit null and empty IDs reject. Empty payload bytes are valid. One outbound command per message, with bulk identifiers/payloads and LF delimiters.

Observed layout evidence: realtime [output models](../../../celeris-realtime/app/src/server_to_client_message), [assembler](../../../celeris-realtime/app/src/message_parser/message_assembler/mod.rs), [integer parser](../../../celeris-realtime/app/src/message_parser/parsers/integer_parser.rs), [command parsers](../../../celeris-realtime/app/src/message_parser/parsers/command_parser), and [newline tests](../../../celeris-realtime/app/src/tests/test_message_parser_newlines.rs). Fixtures are hand-authored from these layouts; no production encoder generated expected bytes. Rust tests were inspected, not run in this pass.

Decoded MSG carries tokenReference, segmentId, nullable messageId, bigint timestamp and owned payload. SERVER_MSG carries bigint timestamp and owned raw payload. PRES_LIST_RESPONSE preserves bigint metadata and connection entries; an out-of-range page may have from > to. Arrays use `{ command: "ARRAY", messages }` recursively. Scalar top-level values and client/internal commands are rejected. Simple or bulk byte fields are accepted where a textual/payload field is expected; text is strict UTF-8 with BOM preserved. Numeric headers use minus-optional decimal digits, at most 20 characters, and signed-64 range; plus signs, whitespace and fractions reject. The encoder emits canonical decimal. Signer timestamp min=1 does not constrain wire timestamps, which include zero and the full signed-64 range.

Limits: outbound 128 KiB including overhead, inbound 1 MiB, 32 array nesting levels and 4096 total fragments including commands and each field. Length/count validation precedes allocating or reading content. Complete input consumption is required. Returned payloads are copied, including standalone error bytes. The parser uses only message-local state.

Standalone `-Err` messages use the remaining transport message as raw error content. Names are bounded ASCII identifiers (64 bytes); content remains untrusted bytes, never an exception message or diagnostic. Arrays containing errors reject rather than guessing missing boundaries. Later diagnostics must sanitize and bound any displayed server content.

## Identifier evidence and open findings

[Token DTO](../../../celeris-realtime/app/src/channel/channel_token_dto.rs) validates channels as nonempty alphanumeric/hyphen, at most 255 bytes. Future client channel configuration will use the same ASCII restriction. C2 does not add unused channel schemas. Segment/message IDs must be nonempty and CR/LF-free; colons remain valid. Unicode is preserved without trimming/normalization. Token/user references additionally prohibit colons at the trusted issuer because [Redis presence parsing](../../../celeris-realtime/app/src/redis_service.rs) uses `splitn(3, ':')`. No client operation in C2 creates user references; incoming text is not silently normalized or rewritten.

| Finding | Refreshed evidence                                                                                                                                             | Disposition                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D-001   | [Token timestamp check](../../../celeris-realtime/app/src/channel/channel_token_service.rs) still uses TimeDelta::minutes(60), with TODO for 60 seconds        | Open server security/release gate; fresh issuance does not fix acceptance                                    |
| D-002   | Assembler error has no trailing delimiter/length; output batching exists in [client server](../../../celeris-realtime/app/src/channel/server/client_server.rs) | Open protocol release gate; reject nested errors locally                                                     |
| D-003   | Simple-string assembler appends raw identifiers, DTO lacks full delimiter checks, and Redis reference splitting is colon-sensitive                             | Open server security/release gate; local outbound checks cannot detect every maliciously valid-looking frame |

Client-server permission filtering requires write for PUB, read-or-write for SUB/UNSUB, and read for presence; NODE_PUB rejects. The 128 KiB frame bound is configured there. These are source observations; C2 does not execute permissions, replay or server integration. Those scenarios remain C8.

Outbound segment and message identifiers must contain well-formed Unicode: reject lone UTF-16 surrogates before encoding to prevent replacement-character collisions. Valid surrogate pairs and U+FFFD remain accepted; no normalization occurs.

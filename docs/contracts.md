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

This is recorded client-side compatibility review, not a claim of changes to S0. ACK-01 was acknowledged by `@useceleris/server` S4 (2026-09-21, against client revision `d26d80f`): the server consumes `Credentials`/`CredentialRequest`/`CredentialProvider` via type-only import and re-exports `CredentialRequest`; see the server [contracts — S4 client integration](../../sdk-js-server/docs/contracts.md). Spec-level acknowledgement remains pending. Provider cancellation rejects acquisition and suppresses stale results using attempt identity; an uncooperative provider cannot create a late socket. The server signer itself is synchronous and has no cancellation API. Codec operations likewise remain synchronous.

## Public API surface (SDK-03–09; decided 2026-09-20, revised same day to handler-based events)

Names for the C4–C7 public surface are now fixed; C11 revised three of them (HELP-01, ENDPOINT-01, MSG-01 below) while nothing was yet published. The entrypoint stays empty until C4 exports the first subset. Zod inference never crosses into public declarations: every exported type below is hand-written, and internal `ClientCommand`/`ServerMessage` shapes map onto `MessageMetadata`, `ServerNotice` and `PresencePage`. Consumer usage is mirrored in [EXAMPLES.md](../EXAMPLES.md), which must change in the same commit as this section.

**DEV-01 (recorded deviation from specs conventions):** events are consumed through handler objects with named `on*` registration methods, not async iterables. The specs' JavaScript conventions mandate "bounded async iterables"; this local decision supersedes that for this package, pending spec revision. Consequence: delivery is synchronous listener dispatch — there is no consumer-side delivery queue, so the shared contract's 256-delivery/1 MiB queue and its `Backpressure` overflow path do not apply to inbound delivery (writer bounds are unchanged). A slow listener blocks dispatch instead of growing a queue; native receive buffering remains the platform limit. Listener exceptions are contained and cannot corrupt SDK state.

```ts
export function createClient(options: ClientOptions): Client;

export type ClientOptions = {
  readonly credentialProvider: CredentialProvider;
  readonly baseUrl?: string; // ENDPOINT-01: defaults to wss://realtime.useceleris.com;
  // wss only, ws via allowInsecureLoopback
  readonly allowInsecureLoopback?: boolean; // default false
  readonly connectTimeoutMs?: number; // default 15_000
  readonly presenceQueryTimeoutMs?: number; // default 10_000
  // onDiagnostic is DROPPED from v1 (C7 decision): no DiagnosticEvent type
  // exists. The events handler already carries every safe signal, and the
  // reconnect scheduler's replay-lookback cap stays silent and documented.
};

export class Client {
  channel(reference: string): Channel; // side-effect free; new handle each call
}

export type ChannelState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "closing"
  | "closed";

export class Channel {
  // One Channel = ONE WebSocket client. Creating another Channel (even for the
  // same reference) creates another socket. All segments of this channel are
  // multiplexed over this single connection.
  readonly state: ChannelState;
  connect(options?: { signal?: AbortSignal }): Promise<void>; // OperationInProgress on concurrent
  close(): Promise<void>; // idempotent, terminal, 5 s budget; closes every segment handler
  segment(segmentId?: string): Segment; // side-effect-free proxy; omitted = "default"
  events(): ChannelEventHandler; // channel-level: state, recovery, errors, untagged notices
}

export class Segment {
  // A Segment handler is a lightweight PROXY over its channel's single
  // connection — it never owns a socket. Any number of handler instances for
  // the same segmentId share the channel connection and one interest
  // ref-count and per-segment listener set. This mirrors the
  // server, which keeps one socket plus a per-connection map of segment
  // handles with independent replay cursors (SEG-01).
  readonly segmentId: string;
  subscribe(): Subscription; // joins for messages (SUB); ref-counted channel-wide
  // MSG-01: payload first, the rest of the message second.
  onMessage(
    listener: (payload: Uint8Array, metadata: MessageMetadata) => void,
  ): () => void; // this segment's deliveries on this channel
  publish(options: {
    payload: Uint8Array; // empty valid; ≤128 KiB encoded
    messageId?: string; // optional; empty rejected
    signal?: AbortSignal;
  }): Promise<void>; // resolves on local acceptance only; server auto-joins the segment
  subscribePresence(): Subscription; // PRES_SUB; server also joins the segment for messages
  // PRES-01: typed join/leave for THIS segment, from the segment-tagged
  // PRES_NOTIFY frame. Delivered only while a presence interest is held.
  onPresence(listener: (event: PresenceEvent) => void): () => void;
  presenceList(options: {
    page: number; // 1..2147483647, reject not clamp
    perPage: number; // 1..100, reject not clamp
    signal?: AbortSignal;
  }): Promise<PresencePage>; // serialized; one in flight per CHANNEL
}

export interface Subscription {
  cancel(): void; // idempotent dispose; releases this interest
}

export interface ChannelEventHandler {
  // Named registration only — no generic on(name, fn), no string event keys.
  // Each method registers one listener, dispatched in registration order,
  // and returns its idempotent dispose function.
  onStateChange(listener: (state: ChannelState) => void): () => void;
  onRecovery(listener: (event: RecoveryEvent) => void): () => void;
  onNotice(listener: (notice: ServerNotice) => void): () => void; // raw SERVER_MSG (acks, refusals)
  onError(listener: (error: ChannelError) => void): () => void; // async terminal failures
  // ChannelError = ConfigurationError | ConnectionError | ProtocolError.
  // The three error classes and ConnectionErrorCode are public exports so
  // consumers can type onError listeners and rejections.
}

export type MessageMetadata = {
  readonly tokenReference: string;
  readonly segmentId: string;
  readonly messageId: string; // REV-01: server-assigned, always present; null is terminal ProtocolError
  readonly timestamp: bigint;
};
export type MessageListener = (
  payload: Uint8Array,
  metadata: MessageMetadata,
) => void;
export type ServerNotice = {
  readonly timestamp: bigint;
  readonly payload: Uint8Array;
};
export type PresencePage = {
  readonly segmentId: string;
  readonly total: bigint;
  readonly perPage: bigint;
  readonly currentPage: bigint;
  readonly from: bigint; // from > to possible; raw metadata preserved
  readonly to: bigint;
  readonly connections: readonly PresenceConnection[];
};
export type PresenceConnection = {
  readonly tokenReference: string;
  readonly connectionId: string;
  readonly timestamp: bigint;
};
export type PresenceEvent = {
  readonly segmentId: string;
  readonly tokenReference: string;
  readonly connectionId: string;
  readonly joined: boolean; // false = left
  readonly timestamp: bigint;
};
export type PresenceListener = (event: PresenceEvent) => void;

export type RecoveryEvent = {
  readonly retryIndex: number;
  readonly possibleGaps: true;
  readonly possibleDuplicates: true; // beyond the REV-01 dedup window
};

// HELP-01: payload encoding helpers. Pure functions over bytes, not methods
// on Segment — they never touch a connection.
export function textPayload(value: string): Uint8Array;
export function jsonPayload(value: unknown): Uint8Array;
export function readText(payload: Uint8Array): string;
export function readJson<T>(payload: Uint8Array): T; // asserts, does not validate

export type PayloadCodec<T> = {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
};
export type BoundPayloadCodec<T> = {
  encodePayload(value: T): Uint8Array;
  readPayload(payload: Uint8Array): T;
};
export function createPayloadCodec<T>(
  codec: PayloadCodec<T>,
): BoundPayloadCodec<T>;

export type { Credentials, CredentialRequest, CredentialProvider }; // shapes above, exported from C4
```

Operation errors reject their Promises. Asynchronous terminal failures (native socket error, callback containment) surface through `events().onError` and drive the state to `failed` via `onStateChange`; nothing is silently dropped. A frame that cannot be decoded is **not** such a failure — it is reported through the same hook and the channel stays connected (DECODE-01).

**REV-01 (2026-09-20; VERIFIED live in C8):** the server always assigns a MSG id — corroborated by server source (omitted ids replaced with `msg_{node}_{ulid}` before fanout) and verified against the running e2e stack: every delivered, replayed and cross-node message carried a `msg_*` id. The client owns idempotent delivery: public `MessageMetadata.messageId` is non-null, and deliveries are deduplicated by id within a bounded, non-configurable per-channel window (a 1024-entry insertion-order id set) before fanout; ids are recorded even when no listener exists. The window survives reconnect and clears on each explicit `connect()`; C7 relies on it to absorb replay duplicates, and duplicates beyond the window remain possible and stay declared in the recovery event. The lenient interim is retired: a MSG whose decoded id is null is protocol corruption at the delivery layer (`ProtocolError`, terminal). This supersedes the earlier "no implicit deduplication" wording below for message delivery; ordering is still preserved and no durable cursor or global ordering claim follows. Spec revision remains pending.

Errors keep the existing three classes — `ConfigurationError`, `ProtocolError`, `ConnectionError` — with no new hierarchy, base class or `category` alias field. `ConnectionErrorCode` widened as stages landed: `OperationInProgress` (C4), `DeliveryUnknown` (C5), `Permission` (C7). Ten of the shared contract's eleven categories are realized (`"Configuration"` and `"ProtocolError"` come from the other two classes). **DEV-02:** `Authentication` is omitted — native WebSocket exposes the handshake HTTP status in no runtime, and no authentication-named wire error exists, so the category has no knowable source; it joins the union only when one appears (spec revision pending).

C7 decisions: known server error names map to codes at the router — `PermissionDeniedError` becomes `ConnectionError("Permission", "Server denied permission.")`; every other name (RateLimitError, ParserError, SendError, unknown) stays the fixed Transport report. Messages remain fixed and server bytes never surface; the channel remains connected either way, and denials stay uncorrelated. `onDiagnostic` is dropped from v1 (recorded decision): no diagnostics hook or DiagnosticEvent ships, and the scheduler's silent replay-lookback cap remains documented behavior. Handshake failures keep bounded retries under Transport and are never labeled authorization failures.

**HELP-01 (2026-09-23, C11):** payloads stay opaque bytes on the wire, but every consumer was writing the same `new TextEncoder().encode(JSON.stringify(v))` pair, so the package exports four pure functions (`textPayload`, `jsonPayload`, `readText`, `readJson`) and one adapter (`createPayloadCodec`). Per-format helpers were rejected: a `protobufPayload` or `msgpackPayload` would drag a serializer into a package whose only runtime dependency is zod, so the adapter takes the caller's `encode`/`decode` closures — their schema, their library — and returns the same `encodePayload`/`readPayload` shape the built-ins have. The helpers are free functions rather than `Segment` methods because they touch no connection state and must be usable on the publishing and consuming side alike. Failures reuse the closed error set: `ConfigurationError` with the fixed messages `"Value is not JSON-serializable."`, `"Payload is not valid UTF-8."`, `"Payload is not valid JSON."` and `"Codec must provide encode and decode functions."`, carrying no `cause` and never echoing the input. A caller's own `encode`/`decode` throw propagates unchanged — it is their error, not an SDK failure, mirroring how the server package propagates its claims callback. `readJson<T>` asserts and does not validate; untrusted payloads still need a schema check. No size checks: `publish()` already enforces the 128 KiB bound.

**ENDPOINT-01 (2026-09-23, C11):** consumers do not configure where Celeris lives. `baseUrl` defaults to `wss://realtime.useceleris.com` through the existing Zod default, so `createClient({ credentialProvider })` is the whole production setup. The option stays accepted, because the client may not read environment variables (`process` is banned in shipped code by the portability test) and local, CI and staging targeting has no other route; `validateBaseUrl` and `allowInsecureLoopback` are unchanged.

**MSG-01 (2026-09-23, C11):** `onMessage` hands the listener the payload first and the remaining fields second, as `MessageMetadata`. The exported `Message` type is replaced by `MessageMetadata` (the same fields minus `payload`) plus the exported `MessageListener` alias. This separates content from envelope so the HELP-01 helpers compose directly with a listener, and it keeps every field reachable rather than forcing destructuring. Dedup, ordering and containment behaviour are untouched. This is a breaking change to the C5 listener shape, acceptable only because nothing is published yet.

**PRES-01 (2026-09-23, C12):** presence join and leave are delivered as a typed per-segment event, `Segment.onPresence`, carrying `{ segmentId, tokenReference, connectionId, joined, timestamp }`. This retires the standing promise that the SDK would never emit typed presence events. That promise was not a principle — it was a consequence of the wire, where join and leave existed only as untagged prose on `SERVER_MSG` that could not be routed to a segment and could only be recognized by matching English sentences. The server replaced that prose with `PRES_NOTIFY`, which is segment-tagged and fully structured, so the reason is gone while the rule it served (never parse prose into events) is untouched and still binding for the acks and refusals that remain prose. The listener lives on `Segment`, not `ChannelEventHandler`: the frame is segment-tagged, presence is a facet of a joined segment (SEG-01), and the four-method limit on the channel handler stands. The event flag is narrowed from the wire's `:1`/`:0` to `joined: boolean` — a flag, not the raw bigint metadata that presence pages pass through unconverted. Events arrive only while a presence interest is held, because the server fans them out to presence subscribers alone; the SDK adds no gate of its own. Rejected: re-emitting through `onNotice`, which would have preserved the letter of the promise while discarding the structure the new frame exists to carry.

**DECODE-01 (2026-09-23, C12):** no decoding failure closes the connection. An unrecognized command is skipped and ignored; every other frame-level failure drops that one frame and is reported through `events().onError` with the channel still `connected`. This is safe rather than merely lenient: a decoder is constructed per transport message over that message's own bytes, so nothing spans frames and a malformed frame cannot desynchronize the next one — dropping it costs exactly one frame. An unknown command is skippable only where its boundary is knowable, which is the same rule errors already follow (D-002): running to the end of the transport message, either alone or as the final element of every enclosing array. Elsewhere it remains a `ProtocolError`, which is now non-fatal like any other. This supersedes REV-01's clause making a null-id `MSG` terminal — that message is undeliverable because it cannot be deduplicated, which is the message's problem and not the connection's — and it retires the policy that protocol corruption does not retry, which becomes moot once there is nothing to retry. The motivation is recorded twice over: D-002 was this same shape of incident, where batched error frames were rejected and every permission denial killed the connection, and the server's `PRES_NOTIFY` rollout would otherwise have permanently killed every presence-subscribed client on its first join or leave, with no version negotiation existing by which a server could avoid it.

Never exported: `openConnection`, `ConnectionHandle`, `MessageDecoder`, `encodeClientCommand`, `decodeServerMessage`, Zod schemas, `NODE_PUB`, any signing facility.

### Minimalism constraints (binding for C4–C7, and for every later surface change)

- `Client` is a stateless configuration holder with exactly one method, `channel()`. It gains no registry, shared state or connection pool.
- `Segment` is a fully stateless proxy: it holds only its `segmentId` and the channel's delegate functions. Listeners live on `Channel` in one shared per-segment `ListenerSet` (all handler instances of a segment share it; dispose functions remain per listener), alongside interest ref-counts, dedup, writer bounds and presence-query serialization. `segment()` never opens a socket, sends a command, allocates server resources, or grows channel state; network effects come only from `subscribe()`, `publish()`, `subscribePresence()` and `presenceList()`. (SEG-01 supersedes the earlier "no `Segment` class" rule.)
- One `Subscription` shape (`cancel()`); dispose functions are the listener handle.
- No error hierarchy; only the code-union widening above.
- No reconnect or limit knobs in `ClientOptions`. Shared-contract defaults (10 retries, full jitter, 64-command/1 MiB writer) are authoritative and non-configurable in v1. Only the two spec-marked-configurable timeouts are options.
- No event framework: `ChannelEventHandler` has exactly four named `on*` methods. No generic `on(name, fn)`, no string event keys, no wildcard listeners, no once/prepend variants, no listener-count APIs. Dispatch is synchronous in registration order with contained listener exceptions.
- Prefer adding a method to an existing class over adding a class; prefer a documented pattern over a convenience export. Every new public identifier must trace to a specification requirement or a recorded local decision (DEV-01, REV-01, SEG-01, HELP-01, ENDPOINT-01, MSG-01, PRES-01, DECODE-01).

## Segment model (SEG-01; owner directive 2026-09-20, verified against celeris-realtime source)

One channel connection is one WebSocket; every segment of that channel is multiplexed over it. Connecting automatically makes the connection a member of the default segment `"default"`, and the client tests for it by comparing that one identifier. **Corrected 2026-09-23:** this paragraph previously required a set-membership predicate rather than an equality check, which no longer described the shipped code — the 2026-09-21 simplification pass replaced a one-element `defaultSegments` set with a `defaultSegmentId` comparison. Re-reading the server settles it in favour of the equality check: `DEFAULT_SEGMENTS` is a compile-time constant holding exactly one live element (`&["default" /* "private" */]`), identical for every application, token and deployment — no configuration, claim or database row can widen it, and its history shows it shrinking from two entries to one rather than growing. Segment handlers are subscribers-and-proxies over the channel connection: many handler instances may point at the same channel, but each additional `Channel` is a separate WebSocket client. Server-source facts that bind the design:

- The server mirrors this shape exactly: one socket plus a per-connection `HashMap<SegmentId, SegmentHandle>`, each joined segment served by its own listener task with an independent replay cursor. Replay applies per segment JOIN, not per connect — a late `subscribe()` on a live channel replays per the token's replay mode.
- `MSG` and `PRES_NOTIFY` both carry `segment_id`, so message and presence demux to handlers is exact. `SERVER_MSG` and `-Err` carry no segment id — acks and refusals remain unroutable and surface only channel-wide (`events().onNotice`/`onError`). There are no correlation ids; nothing gates on prose. **Revised 2026-09-23:** join and leave were prose on `SERVER_MSG` until the server replaced them with the typed, segment-tagged `PRES_NOTIFY` frame (PRES-01).
- `PUB` auto-joins the segment server-side: publishing from a handler makes the connection a member (visible in presence, and delivering messages when the token has read access) even with no local subscription. Documented, not hidden.
- `PRES_SUB` force-joins the segment for messages too; `PRES_UNSUB` removes only the presence interest — message membership survives. Presence is a facet of a joined segment, not an independent subscription.
- Segments are created lazily on first SUB/PUB/PRES_SUB and evaporate when the last member leaves and the backlog idles; UNSUB on an empty segment gets prose "does not exist". Segment names are nearly unconstrained server-side (nonempty UTF-8); the client keeps its stricter CR/LF/lone-surrogate rejection.
- The default segment cannot be remote-unsubscribed (server refuses with prose); handler cancellation on it is local-only. The refusal is an ordinary `SERVER_MSG`, not an `-Err` frame, so it would surface on `onNotice` rather than `onError` — moot in practice, because the client never sends UNSUB for the default segment. Its connect-time auto-join grants message membership only: presence commands are sent for it like any other segment, and a default presence interest is restored on reconnect while a default message interest is not.
- Read access is evaluated once at join: a write-only token is a member that receives nothing. No client warning is synthesized; C8 verifies against real tokens.
- Multiple connections from one token are independent per connection (membership, presence, cursors); echo suppression excludes by (token, connection) pair, so a sibling connection of the same token receives that token's publishes. Rate-limit keys are per token, shared across its connections.
- Joining a segment spawns a real server task: handler `subscribe()` is a network operation, not a local filter.

## Lifecycle and ownership (SDK-03–08)

Construction is side-effect free. Each explicitly created channel handle owns one socket; segment interests share it. State changes follow idle → connecting → connected, unexpected loss → reconnecting → connected/failed, and explicit close → closing → closed. Closed is terminal; failed requires explicit connect. Concurrent connect rejects with OperationInProgress. Connected confirms only WebSocket establishment.

Use one combined credential/handshake deadline per attempt: configurable `connectTimeoutMs`, default 15 seconds. `ConnectionHandle.close()` detaches data listeners immediately but keeps the native close listener so the close event stays observable; the channel distinguishes expected from unexpected closes by its own state (C4 revision of the earlier "explicit close does not report unexpected close" wording, which now applies at the channel layer). `Channel.close()` awaits the native close event capped by the five-second budget, is idempotent through a memoized promise, and terminal. Late work is suppressed by attempt settlement plus the C4 connection generation and state gating. Callback failures cannot corrupt state.

C4 decisions: an initial `connect()` failure or cancellation moves the channel to `failed` and rejects the promise without dispatching `onError` (no double-reporting; `onError` covers asynchronous failures with no pending promise). `connect()` on a closing/closed channel rejects `NotConnected`. On successful recovery the `connected` state change dispatches before the `RecoveryEvent`. A throwing listener is contained and reported once through `onError` as a fixed safe error; exceptions from `onError` listeners are swallowed without re-entry. Public declarations reference `AbortSignal`, so consumers compile with the platform library that declares it (DOM or the Node types), mirroring the AbortController runtime capability floor.

Publishing completes on local native WebSocket acceptance, with no server receipt, durability or delivery guarantee. No offline queue or automatic resend; a native send that throws after hand-off reports `DeliveryUnknown` (acceptance uncertain). Writer bounds are 64 commands and 1 MiB including native `bufferedAmount`. The command count uses an observed-drain approximation — no native drain event exists, so the counter resets whenever `bufferedAmount` is observed zero at send time and may overcount between sends; the byte bound is exact.

C5 decisions: a mid-connection server ERROR frame is reported once through `events().onError` as fixed `ConnectionError("Transport", "Server reported an error.")` — no server bytes or name until diagnostics land — and the channel **remains connected** (server source: `-Err` never closes the socket; denied commands are dropped individually). Consequently a permission-denied publish resolves locally and the error arrives later, uncorrelated — the protocol has no acks. The default segment never receives SUB or UNSUB from the client (membership is automatic at connect; the server refuses default UNSUB). SUB for registered interests is flushed on every transition to connected in registration order, before the `connected` state change is observable; an initial-connect flush failure rejects `connect()` without `onError` (the C4 rule), while a reconnect flush failure fails terminally with `onError`. Runtime SUB/UNSUB write failures invalidate the socket and fail the channel rather than leave stale remote interest.

Message and presence interests have separate per-segment reference counts. Last presence cancellation sends PRES_UNSUB. UNSUB is sent only when both counts reach zero on a non-default segment; default retains remote membership. Cancellation releases local intent immediately. If required cleanup cannot enter a full writer, invalidate the socket and enter failed with Backpressure rather than leave stale remote interest silently active. No reserved unbounded cleanup queue.

C6 decisions: PRES_SUB/PRES_UNSUB are sent uniformly on every segment **including default** — the server has no default carve-out for presence, and connect-time auto-join grants message membership only (server-source verified). The both-counts-zero UNSUB rule is a necessary condition on the message-cancel path: cancelling the last message interest while presence is held sends nothing (membership lingers server-side, same precedent as PUB auto-join), and presence cancellation never sends UNSUB. Interest flush on connected transitions is messages first, then presence, each in registration order. The presence query is one nullable pending record per channel; its deadline timer starts at send. A synchronous PRES_LIST send failure rejects publish-like without occupying the slot (a post-`DeliveryUnknown` response arrives unsolicited and is ignored). Responses match the pending query by segment id plus bigint equality of `currentPage`/`perPage`; non-matching and unsolicited responses are ignored while any pending query keeps waiting. Timeout or caller abort after send rejects the query and retires the connection into bounded recovery (reject and clear first, then enter reconnecting before closing the handle so the synchronous native close is state-gated away). Connection loss or terminal failure rejects a pending query with a fixed Transport error; explicit `close()` rejects it Cancelled. No response arithmetic exists — raw bigint metadata passes through (`from > to` preserved), and the decoder already bounds all numerics to signed-64.

Inbound delivery is synchronous listener dispatch (DEV-01): decoded messages fan out to registered listeners in registration order with no consumer-side delivery queue, so the shared contract's 256-delivery/1 MiB queue bound and its overflow path do not apply. Listener exceptions are contained per listener and reported through `onError` without corrupting SDK state. Native receive buffering remains the platform limit; writer bounds are unchanged.

Presence queries are serialized, with a 10-second deadline and OperationInProgress for overlap. Match segment/page/perPage. Cancellation before submission releases the query slot; timeout/cancellation after submission retires that socket before another query and requests bounded recovery while preserving intent. No query retry. Unexpected replies remain unsolicited protocol events. SERVER_MSG is a channel-wide raw notice, not a typed join/leave event or receipt.

Restore message interests then presence interests in registration order. Recovery permits 10 retries, full jitter in [0, min(30 seconds, 500 ms × 2^retryIndex)], beginning at index zero; reset after 60 seconds connected. Each attempt requests fresh credentials. Deterministic configuration/permission failures and explicit close do not retry; an undecodable frame has nothing to retry, because the connection is never lost (DECODE-01). Hidden browser handshake status stays unknown. Recovery reports possible gaps and duplicates; preserve arrival order with no durable cursor or global ordering claim. Message delivery is deduplicated by server-assigned id within the bounded REV-01 window; duplicates beyond it remain possible.

C3 implements direct native WebSocket ownership and per-attempt credential acquisition. See [transport contract](transport.md). C4 owns channel state, the connection generation, and the reconnect scheduler with injectable monotonic clock, wall clock, and randomness; C7 restores interests over it.

## Codec decisions (SDK-01; WIRE-01–05)

`encodeClientCommand` and `decodeServerMessage` are internal synchronous functions kept off the package entrypoint (the public surface is fixed above). Outbound schema discrimination uses command names PUB, SUB, UNSUB, PRES_SUB, PRES_UNSUB and PRES_LIST with descriptive fields `segmentId`, `messageId`, `payload`, `page`, `perPage`. Unknown object fields are stripped. Omitted/undefined messageId encodes null; explicit null and empty IDs reject. Empty payload bytes are valid. One outbound command per message, with bulk identifiers/payloads and LF delimiters.

Observed layout evidence: realtime [output models](../../../celeris-realtime/app/src/server_to_client_message), [assembler](../../../celeris-realtime/app/src/message_parser/message_assembler/mod.rs), [integer parser](../../../celeris-realtime/app/src/message_parser/parsers/integer_parser.rs), [command parsers](../../../celeris-realtime/app/src/message_parser/parsers/command_parser), and [newline tests](../../../celeris-realtime/app/src/tests/test_message_parser_newlines.rs). Fixtures are hand-authored from these layouts; no production encoder generated expected bytes. Rust tests were inspected, not run in this pass.

Decoded MSG carries tokenReference, segmentId, nullable messageId, bigint timestamp and owned payload. SERVER_MSG carries bigint timestamp and owned raw payload. PRES_LIST_RESPONSE preserves bigint metadata and connection entries; an out-of-range page may have from > to. Arrays use `{ command: "ARRAY", messages }` recursively. Scalar top-level values and client/internal commands are rejected. Simple or bulk byte fields are accepted where a textual/payload field is expected; text is strict UTF-8 with BOM preserved. Numeric headers use minus-optional decimal digits, at most 20 characters, and signed-64 range; plus signs, whitespace and fractions reject. The encoder emits canonical decimal. Signer timestamp min=1 does not constrain wire timestamps, which include zero and the full signed-64 range.

Limits: outbound 128 KiB including overhead, inbound 1 MiB, 32 array nesting levels and 4096 total fragments including commands and each field. Length/count validation precedes allocating or reading content. Complete input consumption is required. Returned payloads are copied, including standalone error bytes. The parser uses only message-local state.

Standalone `-Err` messages use the remaining transport message as raw error content. Names are bounded ASCII identifiers (64 bytes); content remains untrusted bytes, never an exception message or diagnostic. **C8 revision (D-002, live observation):** the server's output batching wraps errors in arrays (`*1\n-Err\n...`), so an error in tail position — every enclosing array consuming its final element — is accepted with rest-of-message content, which is boundary-unambiguous. An error anywhere else in an array still rejects rather than guessing boundaries; D-002 stays open for that genuinely ambiguous case. Later diagnostics must sanitize and bound any displayed server content.

## Identifier evidence and open findings

[Token DTO](../../../celeris-realtime/app/src/channel/channel_token_dto.rs) validates channels as nonempty alphanumeric/hyphen, at most 255 bytes. Future client channel configuration will use the same ASCII restriction. C2 does not add unused channel schemas. Segment/message IDs must be nonempty and CR/LF-free; colons remain valid. Unicode is preserved without trimming/normalization. Token/user references additionally prohibit colons at the trusted issuer because [Redis presence parsing](../../../celeris-realtime/app/src/redis_service.rs) uses `splitn(3, ':')`. No client operation in C2 creates user references; incoming text is not silently normalized or rewritten.

| Finding | Refreshed evidence                                                                                                                                             | Disposition                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D-001   | [Token timestamp check](../../../celeris-realtime/app/src/channel/channel_token_service.rs) still uses TimeDelta::minutes(60), with TODO for 60 seconds        | Open server security/release gate; fresh issuance does not fix acceptance                                    |
| D-002   | Assembler error has no trailing delimiter/length; output batching exists in [client server](../../../celeris-realtime/app/src/channel/server/client_server.rs) | Open protocol release gate; reject nested errors locally                                                     |
| D-003   | Simple-string assembler appends raw identifiers, DTO lacks full delimiter checks, and Redis reference splitting is colon-sensitive                             | Open server security/release gate; local outbound checks cannot detect every maliciously valid-looking frame |

Client-server permission filtering requires write for PUB, read-or-write for SUB/UNSUB, and read for presence; NODE_PUB rejects. The 128 KiB frame bound is configured there. These are source observations; C2 does not execute permissions, replay or server integration. Those scenarios remain C8.

Outbound segment and message identifiers must contain well-formed Unicode: reject lone UTF-16 surrogates before encoding to prevent replacement-character collisions. Valid surrogate pairs and U+FFFD remain accepted; no normalization occurs.

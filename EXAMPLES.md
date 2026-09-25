# @useceleris/client — consumer examples

> Every snippet below is verified: types are checked against the public surface on every `npm run check` ([drift suite](tests/package/examples-drift.test.ts)), and the runnable variants in [examples/](examples) execute against packed artifacts and a real Celeris stack ([examples suite](tests/celeris/examples.test.ts)). It changes in the same commit as any surface change.

Credentials are always minted by a trusted server. The browser never sees a signing secret; it fetches short-lived opaque credentials from the application's own authenticated endpoint.

## The model in three sentences

A `Channel` is **one WebSocket client** — creating another `Channel`, even for the same reference, opens another socket. Every segment of that channel is multiplexed over that single connection, and connecting automatically makes you a member of the `"default"` segment. `Segment` handlers are lightweight proxies over the channel connection: create as many as you like for the same segment, they all share the one socket and one interest count — they never own connections of their own.

## Setup (browser or server runtime)

```ts
import { createClient, type CredentialRequest } from "@useceleris/client";

const client = createClient({
  // The endpoint is built in; set baseUrl only for a local or self-hosted
  // stack (ws:// also needs allowInsecureLoopback).
  credentialProvider: async (request: CredentialRequest) => {
    // Your authenticated application endpoint signs least-privilege
    // credentials for exactly the requested channel. Fresh per attempt.
    const response = await fetch("/api/realtime-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelReference: request.channelReference,
        reason: request.reason, // "initial" | "reconnect"
        replayLookbackMs: request.replayLookbackMs, // present only on reconnect
      }),
      signal: request.signal, // cancellation propagates
    });
    if (!response.ok) throw new Error("credential request failed");
    return response.json(); // { payload, signature }
  },
});
```

`createClient` performs no network work. `client.channel()` and `channel.segment()` are also side-effect free; nothing connects until `connect()`.

## Connect and observe lifecycle

```ts
const channel = client.channel("room-42"); // this handle = one WebSocket client

// events() returns the channel's single ChannelEventHandler.
// Each on* call registers a listener and returns its dispose function.
const events = channel.events();

const stopStates = events.onStateChange((state) => {
  console.log("state:", state);
});

events.onRecovery((recovery) => {
  // Reconnected. Replay may have gaps; duplicates beyond the
  // client's bounded dedup window are possible.
  console.log("recovered after retry", recovery.retryIndex);
});

events.onError((error) => {
  // Async failures: socket errors, server error frames, and frames this
  // version could not decode. Only a socket error costs the connection —
  // an undecodable frame is dropped on its own.
  console.error(error.code, error.message);
});

await channel.connect(); // opens the socket; you are now a member of "default"
console.log(channel.state); // "connected"

stopStates(); // dispose one listener; idempotent
```

A lost connection retries automatically with fresh credentials (10 attempts, full jitter). `failed` is not terminal — call `connect()` again explicitly. `close()` is terminal, idempotent, and closes every segment handler with it:

```ts
await channel.close(); // ≤5 s graceful budget; channel and its segments are done
```

## Segments

```ts
// Proxies over the SAME connection — no new sockets here.
const lobby = channel.segment(); // the "default" segment; already a member
const chat = channel.segment("chat");
const chatAgain = channel.segment("chat"); // same segment, same shared interest

// Receive: listeners see this segment's messages on this channel.
const stopChat = chat.onMessage((payload, metadata) => {
  // Payload first, then who sent it, its server id and timestamp.
  console.log(metadata.messageId, metadata.tokenReference, readJson(payload));
});

// Join for messages (sends SUB; a real server-side operation — the server
// spawns a per-segment listener with its own replay cursor).
const membership = chat.subscribe();

// Publish to this segment. Resolution = the local socket ACCEPTED the bytes.
// NOT a server receipt. Note: publishing auto-joins the segment server-side,
// even without subscribe() — you'll appear in its presence.
await chat.publish({ payload: jsonPayload({ hello: "world" }) });

// The default segment needs no subscribe() — membership came with connect().
lobby.onMessage((_payload, metadata) =>
  console.log("lobby:", metadata.messageId),
);

// Otherwise it is an ordinary segment: publish to it exactly as above.
await lobby.publish({ payload: textPayload("hello lobby") });

// subscribe() on it is accepted but puts nothing on the wire — the client
// never emits SUB or UNSUB for "default". You get a local interest handle
// that is counted like any other, and no server-side operation happens.
const lobbyMembership = lobby.subscribe();
lobbyMembership.cancel();

// Tear down: dispose listeners, cancel the interest. When the LAST interest
// for a non-default segment on this channel is cancelled, UNSUB is sent.
// The default segment is never remote-unsubscribed (the server refuses).
stopChat();
membership.cancel(); // idempotent
```

Error handling on publish:

```ts
try {
  await chat.publish({ payload: bytes });
} catch (error) {
  if (error instanceof ConnectionError) {
    if (error.code === "NotConnected") {
      /* offline: nothing was queued */
    }
    if (error.code === "Backpressure") {
      /* writer full: slow down */
    }
    if (error.code === "DeliveryUnknown") {
      /* interrupted mid-send: do not assume either way */
    }
  }
}
```

A permission-denied publish is different: it **resolves locally**, then the server's error frame arrives later through `events().onError` with no correlation to the call — the protocol has no acks.

## Presence

```ts
const chat = channel.segment("chat");

// Presence interest. Server-side this ALSO joins the segment for messages;
// cancelling presence does not leave it. Presence is a facet of a joined
// segment, not an independent subscription.
const watching = chat.subscribePresence();

// The default segment is the one place presence differs from messages:
// connect-time auto-join grants message membership only, never a presence
// subscription, so PRES_SUB IS sent here — unlike SUB, which the client
// never emits for "default".
const lobbyPresence = channel.segment().subscribePresence();

// Join and leave arrive as typed, segment-tagged events while a presence
// interest is held.
const stopPresence = chat.onPresence((event) => {
  console.log(
    event.joined ? "joined" : "left",
    event.tokenReference,
    event.connectionId,
    event.timestamp,
  );
});

// Acks and refusals are still untagged prose at the CHANNEL level. Never
// parse prose into events.
const stopNotices = channel.events().onNotice((notice) => {
  console.log("notice:", new TextDecoder().decode(notice.payload));
});

// Paginated snapshot: one in-flight query per CHANNEL, 10 s deadline.
const page = await chat.presenceList({ page: 1, perPage: 50 });
for (const connection of page.connections) {
  console.log(connection.tokenReference, connection.connectionId);
}
// Out-of-range pages return raw metadata with from > to and no entries.

watching.cancel();
lobbyPresence.cancel(); // PRES_UNSUB; the server accepts this one
stopPresence();
stopNotices();
```

Two things to know before building on the event stream. It is **node-local**: the server fans notifications out only to watchers connected to the same node, while `presenceList()` aggregates across the cluster — so in a multi-node deployment a watcher will not see a joiner on another node, and reconciling events against a snapshot drifts. And suppression is per connection, not per token: your own other tabs appear as joins and leaves.

## Multiple connections

```ts
const a = client.channel("room-42");
const b = client.channel("room-42"); // a SECOND WebSocket client
```

Two channels are fully independent — separate sockets, memberships, presence entries and replay cursors, even under one token. Echo suppression is per connection: `b` receives what `a` publishes.

## Error handling

All SDK failures carry a stable `code` — match on `code`, never on message text:

```ts
import { ConnectionError } from "@useceleris/client";

try {
  await channel.connect();
} catch (error) {
  if (error instanceof ConnectionError) {
    switch (error.code) {
      case "Timeout": // credential+handshake deadline (default 15 s)
      case "Cancelled": // your AbortSignal fired
      case "Transport": // network/handshake failure; safe fixed message
        break;
    }
  }
  // ConfigurationError means the call site is wrong; fix it.
}

// Permission denials arrive asynchronously through events().onError with
// code "Permission", uncorrelated to any command — the protocol has no acks.
channel.events().onError((error) => {
  if (error instanceof ConnectionError && error.code === "Permission") {
    /* the token lacks access to something it tried */
  }
});
```

## Encoding payloads

Payloads are opaque bytes. Helpers cover the two common encodings, and one adapter wraps any other serializer.

```ts
// Text and JSON, both directions.
await chat.publish({ payload: textPayload("hello") });
await chat.publish({ payload: jsonPayload({ body: "hello", at: Date.now() }) });

chat.onMessage((payload, metadata) => {
  console.log(metadata.tokenReference, readText(payload));
});
```

`readJson<T>()` asserts the type rather than validating it — schema-check payloads from peers you do not control. Invalid UTF-8, invalid JSON, and values `JSON.stringify` cannot represent (`undefined`, bigint, circular) each throw a `ConfigurationError` with a fixed message.

For protobuf, MessagePack, CBOR or anything else, wrap your encoder once. The SDK never bundles serializers, so you keep your own library and version:

```ts
type Chat = { body: string };

// Swap these two functions for your serializer's encode/decode.
const chatCodec = createPayloadCodec<Chat>({
  encode: (value) => jsonPayload(value),
  decode: (bytes) => readJson<Chat>(bytes),
});

await chat.publish({ payload: chatCodec.encodePayload({ body: "hello" }) });
chat.onMessage((payload) => console.log(chatCodec.readPayload(payload).body));
```

Errors thrown by your own `encode`/`decode` propagate unchanged — they are yours, not the SDK's.

## MessagePack payloads

```ts
type Reading = { sensor: string; value: number; at: number };

const readings = createPayloadCodec<Reading>({
  encode: (value) => encode(value),
  decode: (bytes) => decode(bytes) as Reading,
});

await chat.publish({
  payload: readings.encodePayload({ sensor: "t-1", value: 21.5, at: 1 }),
});
chat.onMessage((payload, metadata) => {
  const reading = readings.readPayload(payload);
  console.log(metadata.tokenReference, reading.sensor, reading.value);
});
```

`@msgpack/msgpack` returns a `Uint8Array` directly, so the codec is a one-liner each way. It preserves binary fields and distinguishes integers from floats, which JSON cannot.

## Protobuf payloads

```ts
// Define the schema once; generated classes work the same way.
const ChatMessage = new Type("ChatMessage")
  .add(new Field("body", 1, "string"))
  .add(new Field("sentAt", 2, "uint64"));

type ChatWire = { body: string; sentAt: number };

const chatWire = createPayloadCodec<ChatWire>({
  encode: (value) => ChatMessage.encode(value).finish(),
  decode: (bytes) => ChatMessage.decode(bytes) as unknown as ChatWire,
});

await chat.publish({
  payload: chatWire.encodePayload({ body: "hello", sentAt: 1 }),
});
chat.onMessage((payload) => console.log(chatWire.readPayload(payload).body));
```

Protobuf keeps payloads compact and schema-checked. Field numbers are the contract: add fields, never renumber or reuse them. The SDK never inspects your bytes, so schema evolution and validation stay yours.

## Replay, gaps and duplicates

Reconnects request fresh credentials with a replay lookback covering the outage plus a five-second overlap, and joining a segment replays per the token's replay mode. Replayed messages carry their original server-assigned ids, and the client deduplicates within a bounded 1024-id window per channel — duplicates beyond it remain possible, which is why every `RecoveryEvent` declares `possibleGaps` and `possibleDuplicates`. There is no durable cursor: replay is bounded local recovery, not history.

Restoration treats the default segment the way connecting does. Named segments are rejoined with a fresh SUB on the new socket; the default segment needs none, because the server auto-joins it again on the new connection, so a listener on it keeps receiving with no action from the caller. A default presence interest _is_ re-sent, since presence was never part of that auto-join.

## Working with bigint values

`MessageMetadata.timestamp` and all presence metadata are `bigint` (exact signed-64 wire values). `JSON.stringify` throws on bigint — serialize them explicitly as decimal strings:

```ts
const serialized = JSON.stringify(
  { total: page.total, timestamp: metadata.timestamp },
  (key, value) => (typeof value === "bigint" ? value.toString() : value),
);
void serialized;
```

## What this API will never do

No offline queue, no automatic resend of publishes, no server receipts or acks (the protocol has none — acks and refusals are untagged prose), no durable history, no global ordering, no signing in the browser. Presence join and leave _are_ typed, because the wire frame carrying them is.

# @useceleris/client — consumer examples

> **Status: C4–C6 are implemented — everything below runs today.** This file mirrors the fixed surface in [docs/contracts.md](docs/contracts.md) and changes in the same commit as any surface change. C9 promotes these snippets to verified packed-artifact examples against packed artifacts.

Credentials are always minted by a trusted server. The browser never sees a signing secret; it fetches short-lived opaque credentials from the application's own authenticated endpoint.

## The model in three sentences

A `Channel` is **one WebSocket client** — creating another `Channel`, even for the same reference, opens another socket. Every segment of that channel is multiplexed over that single connection, and connecting automatically makes you a member of the `"default"` segment. `Segment` handlers are lightweight proxies over the channel connection: create as many as you like for the same segment, they all share the one socket and one interest count — they never own connections of their own.

## Setup (browser or server runtime)

```ts
import { createClient, type CredentialRequest } from "@useceleris/client";

const client = createClient({
  baseUrl: "wss://realtime.example.com",
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
  // Async failures: socket errors, protocol violations, and server
  // error frames (which do NOT close the connection).
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
const stopChat = chat.onMessage((message) => {
  // message.segmentId === "chat"; timestamp is bigint; payload is Uint8Array.
  const body = JSON.parse(new TextDecoder().decode(message.payload));
  console.log(message.messageId, body);
});

// Join for messages (sends SUB; a real server-side operation — the server
// spawns a per-segment listener with its own replay cursor).
const membership = chat.subscribe();

// Publish to this segment. Resolution = the local socket ACCEPTED the bytes.
// NOT a server receipt. Note: publishing auto-joins the segment server-side,
// even without subscribe() — you'll appear in its presence.
await chat.publish({
  payload: new TextEncoder().encode(JSON.stringify({ hello: "world" })),
});

// The default segment needs no subscribe() — membership came with connect().
lobby.onMessage((message) => console.log("lobby:", message.messageId));

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
```

A permission-denied publish is different: it **resolves locally**, then the server's error frame arrives later through `events().onError` with no correlation to the call — the protocol has no acks.

## Presence

```ts
const chat = channel.segment("chat");

// Presence interest. Server-side this ALSO joins the segment for messages;
// cancelling presence does not leave it. Presence is a facet of a joined
// segment, not an independent subscription.
const watching = chat.subscribePresence();

// Join/leave notices arrive as raw prose SERVER_MSG at the CHANNEL level —
// the wire does not tag them with a segment. Never parse prose into events.
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
stopNotices();
```

## Multiple connections

```ts
const a = client.channel("room-42");
const b = client.channel("room-42"); // a SECOND WebSocket client
```

Two channels are fully independent — separate sockets, memberships, presence entries and replay cursors, even under one token. Echo suppression is per connection: `b` receives what `a` publishes.

## Error handling

All SDK failures carry a stable `code` — match on `code`, never on message text:

```ts
try {
  await channel.connect();
} catch (error) {
  switch (error.code) {
    case "Timeout": // credential+handshake deadline (default 15 s)
    case "Cancelled": // your AbortSignal fired
    case "Transport": // network/handshake failure; safe fixed message
    case "Configuration": // invalid options; fix the call site
      break;
  }
}

// Permission denials arrive asynchronously through events().onError with
// code "Permission", uncorrelated to any command — the protocol has no acks.
channel.events().onError((error) => {
  if (error.code === "Permission") {
    /* the token lacks access to something it tried */
  }
});
}
```

## What this API will never do

No offline queue, no automatic resend of publishes, no server receipts or acks (the protocol has none — server responses are untagged prose), no durable history, no global ordering, no typed presence events, no signing in the browser.

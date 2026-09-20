# @useceleris/client — consumer examples

> **Status: the lifecycle and reconnect surface (C4) is implemented — Setup, Connect and Error handling below run today.** Publish, Subscribe and Presence remain target API for C5/C6 and do not run yet. This file mirrors the fixed surface in [docs/contracts.md](docs/contracts.md) and changes in the same commit as any surface change. C9 promotes these snippets to verified packed-artifact examples.

Credentials are always minted by a trusted server. The browser never sees a signing secret; it fetches short-lived opaque credentials from the application's own authenticated endpoint.

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

`createClient` performs no network work. `client.channel()` is also side-effect free; nothing connects until `connect()`.

## Connect and observe lifecycle

```ts
const channel = client.channel("room-42");

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
  // Async terminal failures (socket error, protocol violation).
  // The state moves to "failed"; call connect() to resume.
  console.error(error.code, error.message);
});

await channel.connect(); // resolves when the WebSocket is open
console.log(channel.state); // "connected"

stopStates(); // dispose one listener; idempotent
```

A lost connection retries automatically with fresh credentials (10 attempts, full jitter). `failed` is not terminal — call `connect()` again explicitly. `close()` is terminal and idempotent:

```ts
await channel.close(); // ≤5 s graceful budget; channel is done
```

## Publish

```ts
const bytes = new TextEncoder().encode(JSON.stringify({ hello: "world" }));

try {
  await channel.publish({ payload: bytes, segmentId: "chat" });
  // Resolution means the local socket ACCEPTED the bytes.
  // It is NOT a server receipt or delivery guarantee.
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

Payloads are bytes; serialize above the SDK (JSON shown, Protobuf works the same). Optional `messageId` is application metadata. Encoded commands over 128 KiB are rejected before any write.

## Subscribe

```ts
const subscription = channel.subscribe("chat");

const stopMessages = subscription.onMessage((message) => {
  // message.messageId is always present (server-assigned) and the
  // client has already deduplicated deliveries by id.
  // message.timestamp is a bigint; message.payload is a Uint8Array.
  const body = JSON.parse(new TextDecoder().decode(message.payload));
  console.log(message.messageId, message.timestamp, body);
});

// Later: dispose the listener, or cancel the whole subscription.
stopMessages(); // removes this listener only
subscription.cancel(); // idempotent; releases the interest and all its listeners
```

Omitting the segment subscribes the default segment. Multiple subscriptions to the same segment on one channel are fine — each receives every delivery independently, and cancelling one preserves the others' interest. Dispatch is synchronous in registration order; a throwing listener is contained and reported through `events().onError` without blocking other listeners.

## Presence

```ts
// Register presence interest (join/leave notices are NOT typed events).
const presence = channel.subscribePresence("chat");

// Raw server notices — prose text from the server, delivered as bytes
// through the channel event handler. Never parse this prose into
// structured events.
const stopNotices = channel.events().onNotice((notice) => {
  console.log("notice:", new TextDecoder().decode(notice.payload));
});

// Paginated snapshot: serialized, one in flight per channel, 10 s deadline.
const page = await channel.presenceList({
  segmentId: "chat",
  page: 1,
  perPage: 50,
});
for (const connection of page.connections) {
  console.log(connection.tokenReference, connection.connectionId);
}
// Out-of-range pages return raw metadata with from > to and no entries.

presence.cancel();
stopNotices();
```

## Error handling

All SDK failures carry a stable `code` matching the shared-contract category — match on `code`, never on message text:

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
```

## What this API will never do

No offline queue, no automatic resend of publishes, no server receipts, no durable history, no global ordering, no typed presence events, no signing in the browser.

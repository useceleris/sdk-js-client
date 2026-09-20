# @useceleris/client — consumer examples

> **Status: target API for C4–C7. Not implemented yet; nothing here runs today.** The package entrypoint is empty until those stages land. This file mirrors the fixed surface in [docs/contracts.md](docs/contracts.md) and changes in the same commit as any surface change. C9 promotes these snippets to verified packed-artifact examples.

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
        reason: request.reason,                    // "initial" | "reconnect"
        replayLookbackMs: request.replayLookbackMs, // present only on reconnect
      }),
      signal: request.signal,                      // cancellation propagates
    });
    if (!response.ok) throw new Error("credential request failed");
    return response.json();                        // { payload, signature }
  },
});
```

`createClient` performs no network work. `client.channel()` is also side-effect free; nothing connects until `connect()`.

## Connect and observe lifecycle

```ts
const channel = client.channel("room-42");

// Observe state changes and recovery through one bounded stream.
const events = channel.events();
void (async () => {
  for await (const event of events) {
    if (event.kind === "state") console.log("state:", event.state);
    if (event.kind === "recovery") {
      // Reconnected. Replay may have gaps; duplicates beyond the
      // client's bounded dedup window are possible.
      console.log("recovered after retry", event.retryIndex);
    }
  }
})();

await channel.connect();           // resolves when the WebSocket is open
console.log(channel.state);        // "connected"
```

A lost connection retries automatically with fresh credentials (10 attempts, full jitter). `failed` is not terminal — call `connect()` again explicitly. `close()` is terminal and idempotent:

```ts
await channel.close();             // ≤5 s graceful budget; channel is done
```

## Publish

```ts
const bytes = new TextEncoder().encode(JSON.stringify({ hello: "world" }));

try {
  await channel.publish({ payload: bytes, segmentId: "chat" });
  // Resolution means the local socket ACCEPTED the bytes.
  // It is NOT a server receipt or delivery guarantee.
} catch (error) {
  if (error.code === "NotConnected") { /* offline: nothing was queued */ }
  if (error.code === "Backpressure") { /* writer full: slow down */ }
  if (error.code === "DeliveryUnknown") { /* interrupted mid-send: do not assume either way */ }
}
```

Payloads are bytes; serialize above the SDK (JSON shown, Protobuf works the same). Optional `messageId` is application metadata. Encoded commands over 128 KiB are rejected before any write.

## Subscribe

```ts
const subscription = channel.subscribe("chat");

try {
  for await (const message of subscription) {
    // message.messageId is always present (server-assigned) and the
    // client has already deduplicated deliveries by id.
    // message.timestamp is a bigint; message.payload is a Uint8Array.
    const body = JSON.parse(new TextDecoder().decode(message.payload));
    console.log(message.messageId, message.timestamp, body);
  }
  // Normal end: subscription was cancelled.
} catch (error) {
  // Terminal iterator error, e.g. Backpressure after queue overflow:
  // the channel is now "failed"; call channel.connect() to resume.
} finally {
  subscription.cancel();           // idempotent; always safe in finally
}
```

Omitting the segment subscribes the default segment. A slow consumer that overflows the bounded delivery queue terminates iterators with `Backpressure` — nothing is silently dropped.

## Presence

```ts
// Register presence interest (join/leave notices are NOT typed events).
const presence = channel.subscribePresence("chat");

// Raw server notices — prose text from the server, delivered as bytes.
// Never parse this prose into structured events.
const notices = channel.notices();
void (async () => {
  for await (const notice of notices) {
    console.log("notice:", new TextDecoder().decode(notice.payload));
  }
})();

// Paginated snapshot: serialized, one in flight per channel, 10 s deadline.
const page = await channel.presenceList({ segmentId: "chat", page: 1, perPage: 50 });
for (const connection of page.connections) {
  console.log(connection.tokenReference, connection.connectionId);
}
// Out-of-range pages return raw metadata with from > to and no entries.

presence.cancel();
notices.cancel();
```

## Error handling

All SDK failures carry a stable `code` matching the shared-contract category — match on `code`, never on message text:

```ts
try {
  await channel.connect();
} catch (error) {
  switch (error.code) {
    case "Timeout":       // credential+handshake deadline (default 15 s)
    case "Cancelled":     // your AbortSignal fired
    case "Transport":     // network/handshake failure; safe fixed message
    case "Configuration": // invalid options; fix the call site
      break;
  }
}
```

## What this API will never do

No offline queue, no automatic resend of publishes, no server receipts, no durable history, no global ordering, no typed presence events, no signing in the browser.

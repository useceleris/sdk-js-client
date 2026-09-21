# @useceleris/client

Realtime client for Celeris channels: connection lifecycle with automatic recovery, segment messaging, and presence — for browsers, Node.js, Bun, and Deno. Private (`0.0.0`); publication is gated by C10 in [STAGES.md](STAGES.md).

**The model in three sentences.** A `Channel` is one WebSocket client — creating another `Channel`, even for the same reference, opens another socket. Every segment of that channel is multiplexed over that single connection, and connecting automatically makes you a member of the `"default"` segment. `Segment` handlers are lightweight proxies over the channel connection: create as many as you like, they share the socket and one interest count.

## Quickstart

```ts
import { createClient } from "@useceleris/client";

const client = createClient({
  baseUrl: "wss://realtime.example.com",
  // A trusted server signs short-lived opaque credentials; the browser
  // fetches them from YOUR authenticated endpoint. Never bundle
  // @useceleris/server or a signing secret into client code.
  credentialProvider: async (request) => {
    const response = await fetch("/api/realtime-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelReference: request.channelReference,
        reason: request.reason,
        replayLookbackMs: request.replayLookbackMs,
      }),
      signal: request.signal,
    });
    return response.json(); // { payload, signature }
  },
});

const channel = client.channel("room-42");
const chat = channel.segment("chat");
chat.onMessage((message) => {
  console.log(message.messageId, new TextDecoder().decode(message.payload));
});
chat.subscribe();
await channel.connect();
await chat.publish({ payload: new TextEncoder().encode("hello") });
```

Full walkthroughs — lifecycle events, presence, permissions, error handling — live in [EXAMPLES.md](EXAMPLES.md); runnable variants in [examples/](examples) are executed against packed artifacts and a real Celeris stack by the qualification suites.

## Delivery semantics, honestly

- `publish()` resolves when the local socket accepted the bytes — there is **no server receipt or ack** anywhere in the protocol; server responses are untagged prose notices.
- Lost connections retry automatically (10 attempts, full jitter, fresh credentials, replay lookback). Recovery restores your subscriptions and reports **possible gaps and duplicates**; a bounded 1024-id window deduplicates replayed messages, duplicates beyond it remain possible.
- No offline queue, no automatic resend, no durable history, no global ordering, no typed presence events.
- Permission denials arrive uncorrelated through `events().onError` with code `"Permission"`; a denied publish still resolves locally.
- Publishing to a segment joins it server-side; subscribing to presence also joins it for messages.

## Limits and defaults

| What             | Value                                            |
| ---------------- | ------------------------------------------------ |
| Outbound command | 128 KiB encoded, rejected before any write       |
| Inbound message  | 1 MiB                                            |
| Writer bounds    | 64 pending commands / 1 MiB incl. socket buffer  |
| Connect deadline | `connectTimeoutMs`, default 15 s                 |
| Presence query   | one in flight per channel, default 10 s deadline |
| Reconnect        | 10 retries, full jitter ≤30 s, reset after 60 s  |
| Dedup window     | 1024 message ids per channel                     |

`Message.timestamp` and presence metadata are `bigint` — `JSON.stringify` needs an explicit replacer; the documented convention is decimal strings (`value.toString()`).

## Runtime support

Node.js ≥ 22.15, Bun, Deno, and evergreen browsers (Chrome/Edge 120+, Firefox 121+, Safari 17+) with native `WebSocket`, `BigInt`, `TextEncoder`/`TextDecoder`, `URL`, and `AbortController`. ESM primary with a tested CommonJS entrypoint; the only runtime dependency is zod, and public declarations carry no schema inference. Details: [runtime support](docs/runtime-support.md).

## Development

`npm run check` — build, typechecks, formatting, full local suite. `npm run test:celeris` — acceptance against a real Celeris stack (see [testing](docs/testing.md)). Contracts and recorded decisions: [contracts](docs/contracts.md); stage tracker and evidence: [STAGES.md](STAGES.md), [verification](docs/verification.md). Read [CONVENTIONS.md](CONVENTIONS.md) before contributing.

# @useceleris/client

Realtime client for Celeris channels: connection lifecycle with automatic recovery, segment messaging, and presence — for browsers, Node.js, Bun, and Deno.

**The model in three sentences.** A `Channel` is one WebSocket client — creating another `Channel`, even for the same reference, opens another socket. Every segment of that channel is multiplexed over that single connection, and connecting automatically makes you a member of the `"default"` segment. `Segment` handlers are lightweight proxies over the channel connection: create as many as you like, they share the socket and one interest count.

## Quickstart

```ts
import { createClient } from "@useceleris/client";

const client = createClient({
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
chat.onMessage((payload, metadata) => {
  console.log(metadata.messageId, readText(payload));
});
chat.subscribe();
await channel.connect();
await chat.publish({ payload: new TextEncoder().encode("hello") });
```

The endpoint is built in; pass `baseUrl` only for a local or self-hosted stack. Payloads are opaque bytes: `textPayload`/`jsonPayload` and `readText`/`readJson` cover the common cases, and `createPayloadCodec` wraps any other serializer (protobuf, MessagePack, CBOR) without the package depending on one.

Full walkthroughs — lifecycle events, presence, permissions, error handling — live in [EXAMPLES.md](EXAMPLES.md); runnable variants in [examples/](examples) are executed against packed artifacts and a real Celeris stack by the qualification suites.

## Delivery semantics, honestly

- `publish()` resolves when the local socket accepted the bytes — there is **no server receipt or ack** anywhere in the protocol; server responses are untagged prose notices.
- Lost connections retry automatically (10 attempts, full jitter, fresh credentials, replay lookback). Recovery restores your subscriptions and reports **possible gaps and duplicates**; a bounded 1024-id window deduplicates replayed messages, duplicates beyond it remain possible.
- No offline queue, no automatic resend, no durable history, no global ordering.
- Errors the server sends — `PermissionDeniedError`, `RateLimitError`, `MessageSizeLimitError`, `ParserError`, `SendError`, `InternalError` — arrive through `events().onError` as a `ServerError` carrying the server's `type`, `subType` (the command it answers), `message` and `resource` (what that command names, such as the segment). A denied or oversized publish still resolves locally, since publishing has no receipt. A failed presence query is the exception: its error names the query, so `presenceList()` rejects with it at once.
- Publishing to a segment joins it server-side; subscribing to presence also joins it for messages.

## Limits and defaults

| What             | Value                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------- |
| Outbound command | 2 MiB encoded, rejected before any write                                               |
| Plan payload cap | enforced by the server per plan; see below                                             |
| Writer bounds    | 64 pending commands / 2 MiB incl. socket buffer                                        |
| Connect deadline | `connectTimeoutMs`, default 15 s                                                       |
| Presence query   | one in flight per channel, default 10 s deadline; a timeout never drops the connection |
| Reconnect        | 10 retries, full jitter ≤30 s, reset after 60 s                                        |
| Dedup window     | 1024 message ids per channel                                                           |

Received messages are never size-checked: the platform has already buffered them by the time they arrive, so the client processes whatever the server sends. Each plan caps publish payloads — 64 KiB free, 128 KiB standard, 512 KiB pro, 1024 KiB prime. A publish over your plan's cap resolves locally and is rejected afterwards with a `MessageSizeLimitError`, and it still counts toward your usage.

Timestamps (`MessageMetadata.timestamp` and the presence and notice timestamps) are `bigint` — `JSON.stringify` needs an explicit replacer; the documented convention is decimal strings (`value.toString()`). Every other figure, including presence page counts, is a `number`.

## Runtime support

Node.js ≥ 22.15, Bun, Deno, and evergreen browsers (Chrome/Edge 120+, Firefox 121+, Safari 17+) with native `WebSocket`, `BigInt`, `TextEncoder`/`TextDecoder`, `URL`, and `AbortController`. ESM primary with a tested CommonJS entrypoint; the only runtime dependency is zod, and public declarations carry no schema inference. Details: [runtime support](docs/runtime-support.md).

## Development

`npm run check` runs the build, both typechecks, formatting and the full local suite — this is the gate every change must pass. `npm run test:celeris` runs the acceptance suites against a real Celeris stack; they need `CELERIS_WS_URL`, `CELERIS_CLIENT_ID` and `CELERIS_SIGNING_SECRET`, read from a gitignored `.env` or from the environment.

Read [CONVENTIONS.md](CONVENTIONS.md) and [code conventions](docs/code-conventions.md) before contributing, and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## License

[Apache 2.0](LICENSE).

# @useceleris/client

[![npm](https://img.shields.io/npm/v/@useceleris/client)](https://www.npmjs.com/package/@useceleris/client)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Realtime client for Celeris channels: segment messaging, presence and automatic reconnection, for browsers, Node.js, Bun and Deno.

**The model in three sentences.** A `Channel` is one WebSocket client — creating another `Channel`, even for the same reference, opens another socket. Every segment of that channel is multiplexed over that single connection, and connecting automatically makes you a member of the `"default"` segment. `Segment` handlers are lightweight proxies over the channel connection: create as many as you like, they share the socket and one interest count.

## Install

```sh
npm install @useceleris/client
```

Runs on Node.js 22.15+, Bun 1.3+, Deno 2.5+ and browsers. The runtime must provide native `WebSocket`, `BigInt`, `TextEncoder`/`TextDecoder`, `URL`, `AbortController` and `crypto.getRandomValues` (used for message ids). Browser qualification runs on the Chromium, Firefox and WebKit engines plus branded Chrome and Edge; Safari releases are not separately qualified. ESM with a tested CommonJS entry point and TypeScript declarations; the only runtime dependency is Zod. Details: [runtime support](docs/runtime-support.md).

## Quickstart

A browser module. `/api/realtime-credentials` is your own endpoint, which signs credentials with [`@useceleris/server`](https://www.npmjs.com/package/@useceleris/server).

```ts
import { createClient, readText, textPayload } from "@useceleris/client";

const client = createClient({
  credentialProvider: async (request) => {
    const response = await fetch("/api/realtime-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelReference: request.channelReference,
        replayLookbackMs: request.replayLookbackMs, // only on reconnect
      }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error("credential request failed");

    return response.json(); // { payload, signature }
  },
});

const channel = client.channel("room-42");
const chat = channel.segment("chat");

chat.onMessage((payload, metadata) => {
  console.log(metadata.tokenReference, readText(payload));
});
chat.subscribe();

await channel.connect();
await chat.publish({ payload: textPayload("hello") });
```

Open it in two tabs: each receives what the other publishes. A connection receives its own publishes only when its credentials allow echo.

## Credentials

The client never signs. It calls your `credentialProvider` for every connection attempt — the first `connect()` and every automatic reconnect — and expects `{ payload, signature }` exactly as your server signed them. Fetch them from your own authenticated endpoint (a same-origin `fetch` sends the session cookie; add an `authorization` header for bearer tokens, and use an absolute URL outside the browser).

| Request field      | Type                       | Meaning                                                                                |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------- |
| `channelReference` | `string`                   | The channel being opened                                                               |
| `reason`           | `"initial" \| "reconnect"` | Why the client is asking                                                               |
| `disconnectedAt`   | `number` (reconnect only)  | Unix milliseconds when the outage began                                                |
| `replayLookbackMs` | `number` (reconnect only)  | Suggested replay window: the outage plus 5 s, at most 4,294,967,295                    |
| `signal`           | `AbortSignal`              | Aborted when the attempt times out or is cancelled, including by `close()`; forward it |

Your endpoint treats every field as untrusted: it authorizes the channel and decides whether to grant replay. A provider that throws or rejects fails the attempt with a `Transport` error (your error is not forwarded); output that is not two non-empty strings fails with a `ConfigurationError`. Never ship a signing secret or `@useceleris/server` in a browser or mobile bundle.

## Client options

`createClient(options)` validates its options eagerly and throws a `ConfigurationError` naming the field and rule that failed. Every timeout, size and count is a positive integer.

| Option                    | Default                         | Meaning                                                                           |
| ------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `credentialProvider`      | required                        | Returns `{ payload, signature }` for every connection attempt                     |
| `baseUrl`                 | `wss://realtime.useceleris.com` | The realtime socket endpoint; override only for a local or self-hosted stack      |
| `allowInsecureLoopback`   | `false`                         | Accepts `ws://` for loopback hosts                                                |
| `connectTimeoutMs`        | `15000`                         | Deadline for a first connection attempt, covering credentials and handshake       |
| `reconnectTimeoutMs`      | `connectTimeoutMs`              | Deadline for each reconnect attempt, covering credentials and handshake           |
| `presenceQueryTimeoutMs`  | `10000`                         | Deadline for `presenceList()`                                                     |
| `publishQueueSize`        | `64`                            | Publishes that may wait for writer room; further ones reject with `Backpressure`  |
| `deduplicationWindowSize` | `1024`                          | Message ids remembered per channel to drop duplicates, such as overlapping replay |

## Channels and connection

`client.channel(reference)` returns a new, unconnected handle; a reference is 1–255 ASCII letters, digits, `-` or `_`. Creating clients, channels and segments does no network work.

| State          | Meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| `idle`         | Created, never connected                                              |
| `connecting`   | `connect()` is running                                                |
| `connected`    | Socket open; the channel is a member of `"default"`                   |
| `reconnecting` | The socket was lost; retrying automatically                           |
| `failed`       | A first connect or automatic recovery gave up; call `connect()` again |
| `closing`      | `close()` is running                                                  |
| `closed`       | Terminal; create a new channel to connect again                       |

`connect({ signal })` opens the socket; one deadline (`connectTimeoutMs`, default 15 s) covers the credential request and the handshake. A failed first connect rejects, sets `failed` and is not retried. Calling `connect()` while connecting, connected or reconnecting rejects with `OperationInProgress`. `close()` is idempotent and terminal: it cancels recovery, rejects queued publishes and a pending presence query with `Cancelled`, and resolves within a 5 s budget.

```ts
const events = channel.events();

const stopStates = events.onStateChange((state) => {
  console.log("state:", state);
});

try {
  await channel.connect({ signal: AbortSignal.timeout(10_000) });
} catch (error) {
  if (error instanceof ConnectionError) console.error(error.code); // "Timeout", "Cancelled", "Transport", ...
}

stopStates(); // every on* registration returns its own disposer
await channel.close();
```

## Segments, subscribing and receiving

A listener and a subscription are separate. `onMessage()` registers a local callback; `subscribe()` asks the server to join the segment, which is a real server operation, not a local filter. The `"default"` segment is joined on connect, so it needs only a listener.

```ts
const chat = channel.segment("chat");

const stopChat = chat.onMessage((payload, metadata) => {
  // Payload first; metadata has the sender, segment, message id and timestamp.
  console.log(metadata.tokenReference, metadata.messageId, readText(payload));
});
const membership = chat.subscribe();

channel.defaultSegment().onMessage((payload) => {
  console.log("default:", readText(payload));
});

// Later:
stopChat();
membership.cancel(); // idempotent
```

Subscriptions are counted per channel and segment: the first sends the join, the last `cancel()` sends the leave, unless a presence subscription still holds the segment. The default segment is never left. Subscribing before `connect()` is fine — held subscriptions are sent on connect and restored after every reconnect. Read access is checked when the server joins the segment, so a write-only member receives nothing. A segment id is any non-empty string without CR or LF.

## Publishing

```ts
await chat.publish({ payload: textPayload("hello") });

// Supply your own id; otherwise the client generates a random one.
await chat.publish({ payload: textPayload("edited"), messageId: "msg-7f3a" });

try {
  await chat.publish({
    payload: textPayload("maybe"),
    signal: AbortSignal.timeout(2_000), // withdraws it if still waiting for room
  });
} catch (error) {
  if (!(error instanceof ConnectionError)) throw error;

  // "NotConnected": not connected, or the connection dropped before it went out.
  // "Backpressure": publishQueueSize publishes (64 by default) are already waiting.
  // "Cancelled": your signal fired, or close() ran, before it was sent.
  // "DeliveryUnknown": the socket threw mid-send; it may or may not have gone out.
  console.warn(error.code);
}
```

`publish()` resolves when the bytes are handed to the local socket. That is local acceptance only: there is no server receipt. Publishing joins the segment server-side, even without `subscribe()`. An encoded command over 2 MiB rejects with a `ConfigurationError` before anything is sent; your plan's smaller payload cap is enforced by the server, which reports a `MessageSizeLimitError` through `onError` after the publish has resolved. When the socket's writer is full, a publish waits for room. The payload is copied when `publish()` is called, so the buffer can be reused at once.

## Payloads

Payloads are opaque bytes (`Uint8Array`). Helpers cover text and JSON:

```ts
await chat.publish({ payload: textPayload("hello") });
await chat.publish({ payload: jsonPayload({ type: "typing", active: true }) });

chat.onMessage((payload) => {
  const event = readJson<{ type: string; active: boolean }>(payload);
  console.log(event.type, event.active);
});
```

`readJson<T>()` asserts the type rather than validating it; schema-check payloads from peers you do not control. Invalid UTF-8, invalid JSON and values `JSON.stringify` cannot represent throw a `ConfigurationError` that does not repeat the payload.

For any other format, wrap your serializer once with `createPayloadCodec`. The SDK bundles none, and errors from your `encode`/`decode` propagate unchanged:

```ts
import { encode, decode } from "@msgpack/msgpack";

type Reading = { sensor: string; value: number };

const readings = createPayloadCodec<Reading>({
  encode: (value) => encode(value),
  decode: (bytes) => decode(bytes) as Reading,
});

await chat.publish({
  payload: readings.encodePayload({ sensor: "t-1", value: 21.5 }),
});
chat.onMessage((payload) => console.log(readings.readPayload(payload).value));
```

## Presence

Presence describes connections, not users: one person with three tabs appears three times. Join and leave events arrive while a presence subscription is held; `presenceList()` returns a paginated listing.

```ts
const stopPresence = chat.onPresence((event) => {
  console.log(event.joined ? "joined" : "left", event.tokenReference);
});
const watching = chat.subscribePresence();

async function listConnections(
  segment: Segment,
): Promise<PresenceConnection[]> {
  const connections: PresenceConnection[] = [];

  for (let page = 1; ; page += 1) {
    const result = await segment.presenceList({ page, perPage: 100 });
    connections.push(...result.connections);

    if (result.connections.length === 0 || result.to >= result.total)
      return connections;
  }
}

console.log((await listConnections(chat)).length, "connections");

watching.cancel();
stopPresence();
```

`subscribePresence()` also joins the segment for messages, and cancelling it does not leave. Connect-time membership of `"default"` does not include presence, so subscribe to it like any other segment. Events are node-local — a watcher sees joins and leaves on its own server node — while `presenceList()` aggregates the cluster; pages are not an atomic snapshot, and past the last page `connections` is empty with `from > to`. A query needs a connected channel, allows one in flight per channel (`OperationInProgress` otherwise), validates `page` (1–2,147,483,647) and `perPage` (1–100) without clamping, and times out after `presenceQueryTimeoutMs` (default 10 s) without dropping the connection. A refused query rejects with a `ServerError` whose `subType` is `"PRES_LIST"`.

## Events and errors

Calls you make throw or reject at the call site; a failed first `connect()` and a failed presence query are reported only there. Everything asynchronous — server errors, undecodable frames, a listener that threw, recovery giving up — arrives through `channel.events().onError`. Match SDK errors on `code`, never on message text; messages name the field and rule that failed but never include your input, credentials or server text.

| Class                | `code`                | Raised when                                                                                                                              |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigurationError` | `Configuration`       | The call is wrong: an invalid option, identifier, payload or credential shape, or a command over 2 MiB. Fix the code.                    |
| `ConnectionError`    | `Timeout`             | The connect deadline or a presence query deadline elapsed                                                                                |
|                      | `Cancelled`           | Your abort signal fired, or `close()` cancelled the operation                                                                            |
|                      | `Transport`           | The handshake or socket failed, the credential provider threw, or a listener threw                                                       |
|                      | `NotConnected`        | The channel is not connected or is closed, or the connection dropped before a queued publish went out                                    |
|                      | `Backpressure`        | `publishQueueSize` publishes (64 by default) are already waiting, or a presence query found the writer full or paused after a rate limit |
|                      | `OperationInProgress` | `connect()` while already active, or a second `presenceList()` in flight                                                                 |
|                      | `DeliveryUnknown`     | The socket threw after the bytes were handed over                                                                                        |
| `ProtocolError`      | `ProtocolError`       | A received frame could not be decoded; it is dropped, the connection stays up, and `field`/`offset` say where                            |

A rejected handshake is reported as `Transport`: no runtime exposes the handshake status to script, so the client cannot tell a bad credential from a network failure.

Errors the server sends arrive as a `ServerError` with every field as sent: `type`, `subType` (the command it answers, or `null`), `message` and `resource` (what that command names, such as the segment). The connection stays up. `ServerError` has no `code`, so narrow with `instanceof`:

```ts
channel.events().onError((error) => {
  if (error instanceof ServerError) {
    switch (error.type) {
      case "PermissionDeniedError": // the token lacks access, e.g. subType "SUB"
        break;
      case "MessageSizeLimitError": // a publish exceeded your plan's payload cap
        break;
      case "RateLimitError": // the client pauses and resends; slow down if it repeats
        break;
      default: // "ParserError", "SendError", "InternalError", or a newer type
        break;
    }

    console.warn(error.type, error.subType, error.resource, error.message);
    return;
  }

  console.error(error.code, error.message);
});
```

## Reconnection and recovery

A connected channel that loses its socket retries automatically with fresh credentials (`reason: "reconnect"`): up to 10 failed attempts, each after a random delay of up to 0.5 s × 2ⁿ (at most 30 s). Each attempt's deadline is `reconnectTimeoutMs` (defaulting to `connectTimeoutMs`), covering its credential request and handshake. The failure budget resets when a connection had stayed up for 60 s before it dropped. Only `Transport` and `Timeout` failures are retried; any other failure, or the tenth, is reported through `onError` and the channel enters `failed`. Held subscriptions are re-sent on the new socket, and the server rejoins `"default"` itself. Publishes are never re-sent across a reconnect.

```ts
channel.events().onRecovery((recovery) => {
  // possibleGaps and possibleDuplicates are always true.
  console.log("recovered; failed attempts so far:", recovery.retryIndex);
  void reloadStateFromYourApi();
});
```

The recovery event follows the `connected` state change; it does not mean replay has finished. Replay applies when your server signs it: each segment join then replays recent messages with their original ids. The client drops ids it has already delivered within a `deduplicationWindowSize`-id window per channel (1024 by default), which survives reconnects and is cleared by an explicit `connect()`. Gaps beyond the replay window and duplicates older than the dedup window remain possible, so reload authoritative state from your own API after recovery.

## Delivery semantics, honestly

- `publish()` resolves on local socket acceptance. The protocol has no receipts or acks; the server's answers to subscriptions are untagged prose notices (`events().onNotice`) — do not parse them.
- No offline queue, no durable history, no global ordering. Publishes still waiting when the connection drops are rejected.
- A `RateLimitError` never names the command it dropped, so the client pauses (1 s plus growing jitter) and resends what it sent in the last 2 s: subscriptions first, as their current state, then up to 64 publishes, each at most once and with its original id so receivers drop a copy that had already arrived. After 8 limits in a row it treats the limit as a used-up quota: it stops resending and re-sends the subscriptions it dropped on a slow probe (after 1 min, doubling to at most 1 h) until commands go through without a limit; the probe schedule survives a reconnect. Resends count toward usage, and a resent subscription can re-announce a presence join.
- A denied or oversized publish still resolves locally; its `ServerError` arrives later through `onError` and cannot be matched to the call. A failed presence query is the exception: it rejects `presenceList()`.
- Subscription changes go out ahead of publishes, but never ahead of an earlier publish to their own segment.
- Publishing joins the segment server-side; subscribing to presence also joins it for messages.

## Limits and defaults

| What              | Value                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound command  | 2 MiB encoded, rejected before any write                                                                                                    |
| Publish payload   | Per plan, enforced by the server: 64 KiB free, 128 KiB standard, 512 KiB pro, 1024 KiB prime                                                |
| Writer bounds     | 64 pending commands / 2 MiB incl. socket buffer; `publishQueueSize` queued publishes (64 by default), plus resends                          |
| Rate-limit pause  | 1 s plus full jitter growing with consecutive limits, ≤31 s                                                                                 |
| Resends           | Last 2 s of commands, at most 64 publishes, each once                                                                                       |
| Quota probe       | After 8 limits in a row: dropped subscriptions retried after 1 min, doubling to 1 h                                                         |
| Connect deadline  | `connectTimeoutMs`, default 15 s, covering credentials and handshake                                                                        |
| Presence query    | `presenceQueryTimeoutMs`, default 10 s; one in flight per channel; `perPage` ≤ 100                                                          |
| Reconnect         | 10 failed attempts, each bounded by `reconnectTimeoutMs` (default `connectTimeoutMs`), full jitter ≤30 s, budget reset after 60 s connected |
| Replay lookback   | Outage plus 5 s, at most 4,294,967,295 ms                                                                                                   |
| Dedup window      | `deduplicationWindowSize` message ids per channel, 1024 by default                                                                          |
| Close             | 5 s graceful budget                                                                                                                         |
| Channel reference | 1–255 ASCII letters, digits, `-` or `_`                                                                                                     |

Received messages are never size-checked: the platform has already buffered them by the time they arrive. A publish over your plan's cap still counts toward your usage.

## Runtime notes

- Listeners run synchronously, in registration order. One that throws is contained and reported through `onError` as a `Transport` error; the channel keeps running. Catch rejections from async work you start in a listener yourself.
- Listeners of one message share its `Uint8Array`; copy it before mutating.
- Timestamps (`MessageMetadata.timestamp` and the presence and notice timestamps) are `bigint`, the exact signed 64-bit value. Every other figure, including presence counts and `retryIndex`, is a `number`. `JSON.stringify` throws on bigint, so serialize timestamps as decimal strings:

  ```ts
  const line = JSON.stringify(metadata, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  ```

- Channels are independent: two channels for one reference have separate sockets, memberships, presence entries and replay. Echo suppression is per connection, so one receives what the other publishes.
- Importing the package has no side effects. Close channels you no longer need: an open socket and its retry timers keep a Node.js process alive.

## Local development and self-hosting

The production endpoint, `wss://realtime.useceleris.com`, is built in. Set `baseUrl` only for a local or self-hosted Celeris stack; it is the realtime socket endpoint, not your credential endpoint.

```ts
const client = createClient({
  baseUrl: "ws://localhost:8080", // your local Celeris stack
  allowInsecureLoopback: true, // never in production
  credentialProvider: fetchCredentials,
});
```

`baseUrl` must use `wss://`; `ws://` is accepted only for `localhost`, `127.x.x.x` or `[::1]` with `allowInsecureLoopback: true`. It must not contain a username, password, query string or fragment. The client connects to `<baseUrl>/channel/<reference>`.

## Further documentation

- Guides: [useceleris.com/docs/sdks/javascript](https://useceleris.com/docs/sdks/javascript)
- API reference: [useceleris.com/docs/api-reference/client](https://useceleris.com/docs/api-reference/client)
- More examples: [EXAMPLES.md](EXAMPLES.md), and runnable programs in [examples/](examples)

## Development

`npm run check` runs the build, both typechecks, formatting and the local suite, which needs Node, Bun, Deno and the Playwright browsers; [runtime support](docs/runtime-support.md) describes the matrix. `npm run test:celeris` runs the acceptance suites against a real Celeris stack and needs `CELERIS_WS_URL`, `CELERIS_CLIENT_ID` and `CELERIS_SIGNING_SECRET`, read from a gitignored `.env` or the environment.

Read [CONVENTIONS.md](CONVENTIONS.md) and the [code conventions](docs/code-conventions.md) before contributing, and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## License

[Apache 2.0](LICENSE).

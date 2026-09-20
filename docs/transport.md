# C3 direct connection

C3 uses native WebSocket directly. `ConnectionHandler.openConnection()` requests credentials, builds channel URL, waits for native `open`, then returns `ConnectionHandle`. C3 stays internal; package entrypoint remains empty.

## Credentials and connection

Applications supply asynchronous credential provider. Every attempt receives new request and must return fresh opaque credentials.

```ts
type CredentialRequest = {
  readonly channelReference: string;
  readonly reason: "initial" | "reconnect";
  readonly disconnectedAt?: number;
  readonly replayLookbackMs?: number;
  readonly signal: AbortSignal;
};
```

Initial requests omit outage fields. Reconnect requests include both fields. C7 calculates them; C3 only validates and forwards them. Credential values remain unchanged except URL encoding.

One 15-second deadline covers credential acquisition and WebSocket handshake. Caller cancellation aborts provider signal. Timeout, cancellation, provider failure, error, or close before open rejects once, closes any socket, and removes attempt listeners. Late results do nothing.

Base URLs require WSS. Explicit development opt-in permits WS only for localhost, IPv6 loopback, or 127.0.0.0/8. User information, existing query parameters, and fragments are invalid. Deployment path prefixes remain intact. Payload and signature become query parameters exactly once.

## Open connection

`ConnectionHandle.send()` requires open socket, copies supplied byte view, rejects commands over 128 KiB, and rejects when native `bufferedAmount` plus command bytes exceeds 1 MiB. Success means local native send acceptance only.

`ConnectionHandle.close()` is synchronous and idempotent. It removes SDK listeners and requests native close. C4 adds channel states and five-second graceful-close budget.

Incoming messages must be `ArrayBuffer` and at most 1 MiB. `MessageDecoder` produces `ServerMessage` values. Text, Blob, unsupported data, malformed protocol, oversized messages, native errors, and callback failures close connection and report fixed safe errors. Explicit close does not report unexpected close.

Native errors expose no trusted handshake status or body. Error values never contain URLs, credentials, frames, native causes, close reasons, or callback exceptions. Imports create no socket or timer.

## C7 reconnect contract

C7 owns automatic reconnect. It records original outage, measures elapsed time monotonically, and requests fresh credentials with `ceil(elapsed outage) + 5000` milliseconds of replay, capped at `4294967295`. Failed retries keep original outage time.

Retry defaults remain ten attempts, full jitter from 500 ms exponential base capped at 30 seconds, and retry-budget reset after 60 seconds connected. Explicit close stops recovery. Message interests restore before presence interests; publishes never resend automatically.

Five-second replay overlap may produce duplicates. Delayed detection, credential/handshake time, and server retention may still create gaps. No lossless reconnect or implicit deduplication promised.

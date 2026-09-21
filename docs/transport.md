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

One configurable deadline (`timeoutMs`, default 15 seconds) covers credential acquisition and WebSocket handshake. Caller cancellation aborts provider signal. Timeout, cancellation, provider failure, error, or close before open rejects once, closes any socket, and removes attempt listeners. Late results do nothing.

Base URLs require WSS. Explicit development opt-in permits WS only for localhost, IPv6 loopback, or 127.0.0.0/8. User information, existing query parameters, and fragments are invalid. Deployment path prefixes remain intact. Payload and signature become query parameters exactly once.

## Open connection

`ConnectionHandle.send()` requires open socket, copies supplied byte view, rejects commands over 128 KiB, and rejects when native `bufferedAmount` plus command bytes exceeds 1 MiB. Success means local native send acceptance only. A native send that throws after hand-off reports `DeliveryUnknown` — acceptance is uncertain. The handle exposes a read-only `bufferedAmount` accessor consumed by the channel's 64-command observed-drain writer heuristic (C5); the handle itself keeps no counter.

`ConnectionHandle.close()` is synchronous and idempotent. It removes message/error listeners, requests native close, and keeps the close listener so the native close event stays observable through `onClose` (C4 revision). The channel layer owns states and the five-second graceful-close budget, and distinguishes expected from unexpected closes by its own state.

Incoming messages must be `ArrayBuffer` and at most 1 MiB. `MessageDecoder` produces `ServerMessage` values. Text, Blob, unsupported data, malformed protocol, oversized messages, native errors, and callback failures close connection and report fixed safe errors. `onClose` fires once for every native close, explicit or not; expected-versus-unexpected filtering lives in the channel state machine.

Native errors expose no trusted handshake status or body. Error values never contain URLs, credentials, frames, native causes, close reasons, or callback exceptions. Imports create no socket or timer.

## C4 reconnect scheduler

C4 owns automatic reconnect. It records original outage once, measures elapsed time with an injectable monotonic clock, and requests fresh credentials with `ceil(elapsed outage) + 5000` milliseconds of replay, capped at `4294967295` (silent cap — `onDiagnostic` and its truncation diagnostic are dropped from v1 by recorded C7 decision). Failed retries keep the original outage time. The C5/C6 interest flush restores message then presence interests over this scheduler, verified end-to-end in C7.

Retry defaults remain ten attempts, full jitter from 500 ms exponential base capped at 30 seconds, and retry-budget reset after 60 seconds connected. Explicit close stops recovery. Message interests restore before presence interests; publishes never resend automatically.

Five-second replay overlap may produce duplicates. Delayed detection, credential/handshake time, and server retention may still create gaps. No lossless reconnect or implicit deduplication promised.

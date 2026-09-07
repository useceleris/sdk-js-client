# C3 transport and credential contract

C3 is internal. `openConnection(configuration, options)` returns a promise of a transport with binary `send`, `pendingBytes` and idempotent asynchronous `close`. It creates one native WebSocket per successful credential acquisition. The public entrypoint remains empty. Construction/imports do no network work; calling `openConnection` explicitly starts an attempt.

## Configuration and provider

Configuration contains `baseUrl`, `channelReference`, optional `allowInsecureLoopback` (false), and optional `recovery` (initial with null outage/lookback). Reconnect context contains `reason: "reconnect"`, integer Unix-millisecond `disconnectedAt` and integer `replayLookbackMs` in 0..4294967295. C3 validates and forwards this context; C7 will calculate it immediately before each request.

Options contain `credentialProvider`, `onMessage`, optional `onClose`, `onError`, `onDiagnostic`, `signal` and an internal `transportFactory`. Providers receive the request object in [contracts](contracts.md), including an attempt-owned AbortSignal. Each attempt invokes the provider anew. Credentials are nonempty well-formed strings, copied and preserved without decoding or Base64 normalization.

A trusted application can adapt the synchronous server signer:

```ts
async function credentialProvider(
  request: CredentialRequest,
): Promise<Credentials> {
  return signer.sign({
    ...authorizedClaims,
    replay:
      request.replayLookbackMs === null
        ? false
        : { lookbackMs: request.replayLookbackMs },
  });
}
```

This is integration guidance, not a client import or public example executable today. Browser providers call an authenticated application endpoint with the channel and requested replay duration. The application authorizes both before signing. The callback shape supersedes the old positional shared/server references; those repositories are unchanged and acknowledgement is pending.

Require WSS except explicit WS opt-in for URL-normalized localhost, 127.0.0.0/8 or ::1. No DNS-based loopback inference. Reject userinfo, queries and fragments. Preserve a deployment path prefix, trim trailing slashes and append `/channel/{reference}`. Channel references are ASCII alphanumeric/hyphen, 1–255 characters. URLSearchParams encodes each opaque query value once. Never expose assembled credential URLs in diagnostics.

## Attempt, transport and cleanup

One 15-second deadline includes provider and handshake. Cancellation and timeout abort the provider signal, reject once, suppress late completion and close any created socket. Successful open removes attempt cancellation/deadline listeners; subsequent lifetime belongs to C4. No retry loop exists in C3.

The native adapter sets arraybuffer mode and passes complete binary messages in event order. Reject text/unsupported representations and messages over 1 MiB with ProtocolError. Custom factories must implement the native event subset, asynchronous open events, arraybuffer delivery and finite nonnegative bufferedAmount. There is no Blob conversion queue or alternate runtime fallback.

Send copies the supplied byte view, requires an open transport, limits each command to 128 KiB and checks pending native bytes plus submission against 1 MiB. Acceptance is local only. C4 will own serialized writes, command counts and delivery queues; C3 invokes callbacks synchronously without its own delivery queue.

Close requests native shutdown once and waits for close or five seconds, then detaches SDK listeners. Browser APIs cannot force TCP termination; cleanup completion does not promise that the underlying connection has already terminated. Unexpected native close calls onClose; native errors or message-handler failures call onError once and initiate cleanup. Explicit close does not emit unexpected-close callbacks. Callback/diagnostic exceptions cannot prevent cleanup or recursively report errors.

Errors contain fixed messages and safe codes; arbitrary provider/native errors, close reasons and causes are excluded. Diagnostics report only credentials/handshake/connected/failed phases and safe failure categories. Native handshake status is opaque; C3 does not infer authentication denial. Native receive buffering before callback delivery is outside SDK control. Native browser WebSocket exposes no application ping or force-terminate control.

## C7 automatic reconnect — specified, not implemented

Record the first observed disconnection time for the outage. Retry failures preserve that time. Track elapsed outage using a monotonic clock; retain Unix milliseconds separately for provider context. Each attempt requests a fresh token with `ceil(elapsedOutageMs) + 5000`, capped at 4294967295 with an explicit truncation diagnostic. Initial requests use null outage/lookback. Successful establishment clears the outage; another disconnect starts a new one.

Use ten full-jitter retries, 500 ms exponential base capped at 30 seconds; reset the retry budget only after 60 seconds connected. Explicit close/cancellation and terminal configuration/protocol failures do not retry. Restore message then presence interests, excluding cancelled ownership. Never resend publishes automatically.

The five-second allowance intentionally overlaps history and may yield duplicates. Provider/handshake delay, delayed disconnect detection and server retention/availability can still leave gaps. No lossless guarantee, implicit deduplication or server-confirmed delivery follows from replay.

Future C7 tests: growing lookback, five-second allowance, repeated failures retaining outage start, wall-clock changes, capped lookback diagnostics, retry exhaustion/reset, close during recovery, fresh credentials, stale results and message-before-presence restoration. These are not C3 execution evidence.

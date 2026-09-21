# Test inventory

This inventory covers the implemented C0–C9 package: reconnect scheduler, segment messaging, presence, verified recovery restoration, live Celeris qualification, and verified examples. Update it when tested behavior changes. Fixtures contain independent expected bytes and objects; runtime tests compare observations from the real codec with those expectations.

## Command encoding

[Encoding tests](../tests/codec/encoding.test.ts) and [shared vectors](../tests/fixtures/codec-vectors.ts) cover:

- PUB, SUB, UNSUB, PRES_SUB, PRES_UNSUB and PRES_LIST framing, byte lengths, optional message IDs, empty and arbitrary binary payloads.
- Explicit valid pagination endpoints; rejection of missing, null, fractional, overflowing and incorrectly typed values.
- Invalid command names, fields and payload types; empty identifiers and CR/LF rejection.
- Lone high/low surrogates at different positions, reversed/consecutive surrogates and mixed valid/invalid pairs, across all six commands and publish message IDs. Reject these before UTF-8 encoding can replace them and collide with valid identifiers.
- Valid astral characters, minimum/maximum surrogate pairs, the replacement character, composed/decomposed accents, embedded NUL and segment colons. Preserve bytes without normalization.
- Complete 128 KiB command limit including overhead, oversized Unicode identifiers, input preservation, unknown-field removal, output ownership and payload views with nonzero offsets.
- Fixed Configuration errors without supplied values or causes; a failed oversized encoding cannot affect a subsequent valid command.

## Message decoding

[Decoding tests](../tests/codec/decoding.test.ts) and shared vectors cover:

- MSG, SERVER_MSG, PRES_LIST_RESPONSE, standalone errors and empty/nested response arrays.
- Simple/bulk fields, LF/CRLF, absent versus empty values, Unicode/BOM preservation and exact signed-64 timestamps.
- Presence connection entries and pagination metadata, including empty results and pages beyond the last result.
- Raw notice/error content and arbitrary binary payloads; no interpretation of notice prose.
- Invalid UTF-8: isolated continuation, overlong encoding, encoded surrogate, truncated multibyte sequence and code point beyond Unicode. The same bytes remain valid in opaque payloads.
- Invalid markers/commands, malformed lengths, numeric overflow, missing fields, every truncation of a fixed message, invalid terminators, ambiguous nested errors and trailing bytes.
- Exact 1 MiB input bound, depth 32, 4096-fragment budget and oversized declared allocations.
- Caller/sibling payload mutation isolation and input views that exclude surrounding storage.
- 512 deterministic mutated frames, requiring either a decoded result or a safe ProtocolError.

[Boundary tests](../tests/codec/boundaries.test.ts) cover maximum-length LF/CRLF headers, missing delimiters, oversized headers and 64 KiB payloads containing newline/marker bytes. Header scanning stays bounded; bulk contents use declared lengths.

[Protocol error tests](../tests/codec/protocol-errors.test.ts) check fixed reasons, trusted field names, zero-based offsets, redaction, resource limits and strict decimal spelling. Whitespace, plus signs, radix prefixes, fractions and exponents fail; supported leading-zero and negative-zero spellings remain valid.

## Package and declarations

- [Package tests](../tests/package/package.test.ts): installed tarball metadata, exact package identity, version/private status, exports, artifact targets, contents and sole runtime dependency Zod.
- [Portability tests](../tests/package/portability.test.ts): production source/artifacts contain no Node-specific globals/imports; production compilation excludes Node ambient types.
- [Declaration consumers](../tests/declarations/declarations.test.ts): installed NodeNext ESM/CommonJS and bundler resolution, portable declarations and private module boundaries.
- [Codec type tests](../tests/declarations/codec-types.test.ts): byte inputs/outputs, bigint fields and readonly output properties.

## Actual runtimes and browsers

[Runtime tests](../tests/runtime/runtime.test.ts) execute installed imports and internal codec fixtures separately. Eight configured Node/Bun/Deno versions execute ESM; Node/Bun also execute CommonJS. Chromium, Firefox and WebKit execute browser bundles. Shared golden vectors, malformed inbound vectors and invalid outbound identifiers run in these actual engines. Node-hosted unit tests additionally cover boundaries, mutation and detailed errors; those are not all repeated in every engine.

Installed consumers verify the exact seven-value public export surface (`Channel`, `Client`, `ConfigurationError`, `ConnectionError`, `ProtocolError`, `Segment`, `createClient`), private export boundaries and import safety. Declaration consumers compile real `createClient`/`channel` usage in all three module modes and assert the built declarations contain no schema inference. Import guards reject access to networking, environment-dependent capabilities and background timers. Internal codec bundles do not establish a public codec API.

See [runtime support](runtime-support.md) for matrix configuration and [verification](verification.md) for exact versions/results. Missing qualification runtimes fail rather than skip. Branded-browser and cross-OS qualification remain pending.

## Running and scope

`npm run check` runs build, typecheck, formatting and tests. `npm run test` runs once; `npm run test:watch` watches. Supply the documented eight-runtime matrix for full qualification.

These tests do not prove server acceptance or resolve D-001–D-003. Runtime primitives and build-tool behavior are setup, not independent test subjects.

## C3 credentials and transport

Error-boundary regressions cover providers throwing or rejecting `ConfigurationError` and message callbacks throwing `ProtocolError`. Both become fixed Transport errors without supplied messages, fields, or causes; genuine credential validation and decoder errors retain their SDK classifications.

[Connection tests](../tests/transport/connection.test.ts) cover initial/reconnect context, fresh providers, opaque values, invalid results, safe synchronous/asynchronous failures, open settlement, cancellation during acquisition/handshake, shared deadlines, late results, duplicate events, binary decoding, send limits, callbacks, and cleanup.

[URL tests](../tests/transport/url.test.ts) cover path prefixes, exact query values, URL component restrictions, loopback opt-in and channel character/length boundaries. [Type tests](../tests/declarations/connection-types.test.ts) verify portable asynchronous contracts and readonly credentials. No transport-adapter suite exists; tests replace global WebSocket with one small native-shaped double.

[Actual transport tests](../tests/runtime/transport.test.ts) exercise local WS/WSS servers with exact synthetic credential query values. Client sends a valid encoded command; `ConnectionHandler` decodes a valid `SERVER_MSG`. All eight runtimes execute ESM WS, trusted WSS with an isolated test CA and untrusted-WSS rejection. Node/Bun additionally execute CommonJS WS. Chromium/Firefox/WebKit execute WS and reject untrusted WSS. Browser trusted-CA success is not qualified; no system trust store is modified or certificate verification disabled.

Internal bundles exercise transport implementation separately from installed package imports. Celeris authorization/replay integration is covered by the C8 acceptance suites. Automatic reconnect scheduling is tested deterministically in the C4 channel suites; restoration is verified in the C7 suite.

## C4 channel lifecycle and reconnect scheduler

[Lifecycle](../tests/channel/lifecycle.test.ts), [close](../tests/channel/close.test.ts) and [reconnect](../tests/channel/reconnect.test.ts) suites drive `Channel` directly with injected monotonic clock, wall clock and randomness seams plus the shared [WebSocket double](../tests/helpers/websocket.ts) and fake timers, so every scheduler scenario is deterministic. They cover the seven states, concurrent-connect rejection, initial-failure semantics without `onError`, configurable `connectTimeoutMs`, listener dispatch order/disposal/containment, memoized idempotent close with the five-second budget, generation-based stale suppression, per-index jitter bounds, ten-retry exhaustion, sixty-second budget reset, preserved outage with growing capped lookback, fresh credentials per attempt, recovery-event ordering, and zero leaked timers on every terminal path. [Channel type contracts](../tests/declarations/channel-types.test.ts) pin the hand-written public shapes. These tests do not prove server acceptance; restoration and messaging have their own suites.

## C5 segments and messaging

The [messaging suite](../tests/channel/messaging.test.ts) drives `Channel.segment()` proxies with the shared WebSocket double, hand-authored MSG/ARRAY/ERROR/SERVER_MSG frames and golden outbound bytes. It covers proxy statelessness and eager identifier validation, shared interest counts across handler instances, default-segment rules (no SUB/UNSUB ever sent), publish acceptance semantics with `NotConnected`/`Cancelled`/`ConfigurationError`/`Backpressure`/`DeliveryUnknown` boundaries, the 64-command observed-drain heuristic, connect-time and reconnect-time SUB flushes with the initial-versus-reconnect failure split, segment-exact fan-out, the 1024-id dedup window (record-before-fanout, eviction, reconnect persistence, connect reset), the lenient null-id interim, error-frame reporting while remaining connected, listener containment and mid-dispatch disposal, and nested ARRAY ordering. [Channel type contracts](../tests/declarations/channel-types.test.ts) pin `Message` and the `Segment` signatures. These tests do not prove server acceptance.

## C6 presence

The [presence suite](../tests/channel/presence.test.ts) covers presence interests and page queries with golden PRES_SUB/PRES_UNSUB/PRES_LIST bytes and hand-authored PRES_LIST_RESPONSE frames. It verifies shared ref-counts across handler instances, uniform presence commands on the default segment (deliberate contrast with message SUB/UNSUB), the tightened both-counts-zero UNSUB rule in both cancellation orders, messages-then-presence flush ordering on connect and reconnect, interest-write failure invalidation, the single per-channel query slot (overlap rejection, slot release on every settle path), bounds rejection without clamping, timeout and abort-after-send retirement into bounded recovery with subsequent re-query, unsolicited/mismatched/late response handling, query rejection on loss/close/terminal failure, publish-like send-failure semantics, raw `from > to` metadata pass-through, and `onNotice` raw delivery with disposal and containment. These tests do not prove server acceptance.

## C7 recovery restoration

The [restoration suite](../tests/channel/restoration.test.ts) verifies the C5/C6 flush end-to-end across the C4 scheduler: messages-then-presence reflush in registration order with cancelled message and presence intent excluded and only interest frames on the recovery socket (publishes never resent); restoration frames sent before the `connected` state change and `RecoveryEvent`; replayed duplicate ids absorbed by the REV-01 window while new ids flow; reconnect flush into a full writer failing terminally with socket invalidation and zero timers; identical restoration on a second recovery cycle. The messaging suite additionally pins the C7 error-name mapping (`PermissionDeniedError` → `Permission` with a fixed message, all other names Transport, channel connected, no server bytes surfaced), and a declaration test pins the realized `ConnectionErrorCode` union (`Authentication` recorded absent per DEV-02). These tests do not prove server acceptance (C8).

## C8 Celeris qualification

Acceptance suites in [tests/celeris](../tests/celeris) run against a real Celeris server and stay separate from local evidence: `npm run test:celeris` uses [vitest.celeris.config.ts](../vitest.celeris.config.ts), which the default config excludes. The suites fail loudly when the environment is missing — they never skip.

Setup (local stack): `celeris-realtime`'s self-contained e2e compose provides the three-node stack. When the host's dev stack is running, its kafka and app ports collide — bring the stack up with a compose override that drops the kafka host ports (debug-only) and moves the app nodes to 9101-9103 (`docker compose -p celeris_rt_e2e -f .infra/tests/compose.e2e.yaml -f <override> up -d --wait`; the override used is recorded in verification evidence). Seed the qualification app directly: mint the AES-encrypted signing secret with a small `node:crypto` script implementing the server's `password_utils` format (base64 of salt‖nonce‖AES-256-GCM ciphertext+tag, PBKDF2-HMAC-SHA256 key from `APP_SECRET`), then insert the `accounts` and `apps` rows via `docker exec … psql` with `ON CONFLICT` upserts. Then export `CELERIS_WS_URL=ws://localhost:9101`, `CELERIS_WS_URL_SECONDARY=ws://localhost:9102`, `CELERIS_CLIENT_ID=js-qual`, `CELERIS_SIGNING_SECRET=js-qual-secret` and run `npm run test:celeris`. The [credentials helper](../tests/celeris/helpers/credentials.ts) signs per the protocol document with `node:crypto` and never imports the server package.

Coverage: authentication accept/reject (invalid signature, unknown client, expired and future timestamps, channel restriction — all rejected as Transport, never an authorization label; the observed 60-minute acceptance window is recorded against the documented 60-second intent, D-001), greeting notices via `onNotice`, cross-connection binary delivery with server-assigned `msg_*` ids (REV-01 verification), per-connection echo and `allow_echo`, segment demux and unsubscribe effects, default-segment auto-delivery, 100 KiB payload round-trip, read-only Permission denial arriving uncorrelated, write-only membership, cross-node fanout and presence consistency, raw presence join notices and live pagination (`from > to` past the last page), persistent membership after presence cancellation, replay with preserved ids, and dedup absorption of overlapping replay.

Not proven here (explicit blockers in the tracker): slow-consumer forced disconnect, regional behavior beyond the local three-kafka topology, branded Chrome/Edge/Safari and cross-OS runs, the recorded eight-runtime matrix rerun, and deployed-staging evidence.

## C9 examples

Two layers keep the documentation honest. The [examples-drift suite](../tests/package/examples-drift.test.ts) runs in the default `npm run check`: it extracts every `ts` block from EXAMPLES.md, wraps each in its own async function behind one canonical import preamble with a few ambient declarations (`client`, `channel`, `chat`, `bytes`, `page`, `message`), and type-checks the lot strictly against the public surface — a snippet that stops compiling fails the build. The [examples suite](../tests/celeris/examples.test.ts) runs under the celeris config: it packs and installs the artifact, compiles [examples/node-quickstart.ts](../examples/node-quickstart.ts) against the installed package and runs it on host Node/Bun/Deno, and bundles [examples/browser-quickstart.ts](../examples/browser-quickstart.ts) as an IIFE (copied into the consumer so the bare import resolves from the tarball) and runs it in Chromium/Firefox/WebKit with a Node-side signer endpoint standing in for the application's credential API. Each asserts its success marker against the live stack. Deployed-target example runs remain STAGE-SMOKE-01.

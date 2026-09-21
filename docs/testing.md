# Test inventory

This inventory covers the implemented C0–C7 package: reconnect scheduler, segment messaging, presence, and verified recovery restoration. Update it when tested behavior changes. Fixtures contain independent expected bytes and objects; runtime tests compare observations from the real codec with those expectations.

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

Internal bundles exercise transport implementation separately from installed package imports. Celeris authorization/replay integration remains C8. Automatic reconnect scheduling is tested deterministically in the C4 channel suites; restoration is verified in the C7 suite.

## C4 channel lifecycle and reconnect scheduler

[Lifecycle](../tests/channel/lifecycle.test.ts), [close](../tests/channel/close.test.ts) and [reconnect](../tests/channel/reconnect.test.ts) suites drive `Channel` directly with injected monotonic clock, wall clock and randomness seams plus the shared [WebSocket double](../tests/helpers/websocket.ts) and fake timers, so every scheduler scenario is deterministic. They cover the seven states, concurrent-connect rejection, initial-failure semantics without `onError`, configurable `connectTimeoutMs`, listener dispatch order/disposal/containment, memoized idempotent close with the five-second budget, generation-based stale suppression, per-index jitter bounds, ten-retry exhaustion, sixty-second budget reset, preserved outage with growing capped lookback, fresh credentials per attempt, recovery-event ordering, and zero leaked timers on every terminal path. [Channel type contracts](../tests/declarations/channel-types.test.ts) pin the hand-written public shapes. These tests do not prove server acceptance; restoration and messaging have their own suites.

## C5 segments and messaging

The [messaging suite](../tests/channel/messaging.test.ts) drives `Channel.segment()` proxies with the shared WebSocket double, hand-authored MSG/ARRAY/ERROR/SERVER_MSG frames and golden outbound bytes. It covers proxy statelessness and eager identifier validation, shared interest counts across handler instances, default-segment rules (no SUB/UNSUB ever sent), publish acceptance semantics with `NotConnected`/`Cancelled`/`ConfigurationError`/`Backpressure`/`DeliveryUnknown` boundaries, the 64-command observed-drain heuristic, connect-time and reconnect-time SUB flushes with the initial-versus-reconnect failure split, segment-exact fan-out, the 1024-id dedup window (record-before-fanout, eviction, reconnect persistence, connect reset), the lenient null-id interim, error-frame reporting while remaining connected, listener containment and mid-dispatch disposal, and nested ARRAY ordering. [Channel type contracts](../tests/declarations/channel-types.test.ts) pin `Message` and the `Segment` signatures. These tests do not prove server acceptance.

## C6 presence

The [presence suite](../tests/channel/presence.test.ts) covers presence interests and page queries with golden PRES_SUB/PRES_UNSUB/PRES_LIST bytes and hand-authored PRES_LIST_RESPONSE frames. It verifies shared ref-counts across handler instances, uniform presence commands on the default segment (deliberate contrast with message SUB/UNSUB), the tightened both-counts-zero UNSUB rule in both cancellation orders, messages-then-presence flush ordering on connect and reconnect, interest-write failure invalidation, the single per-channel query slot (overlap rejection, slot release on every settle path), bounds rejection without clamping, timeout and abort-after-send retirement into bounded recovery with subsequent re-query, unsolicited/mismatched/late response handling, query rejection on loss/close/terminal failure, publish-like send-failure semantics, raw `from > to` metadata pass-through, and `onNotice` raw delivery with disposal and containment. These tests do not prove server acceptance.

## C7 recovery restoration

The [restoration suite](../tests/channel/restoration.test.ts) verifies the C5/C6 flush end-to-end across the C4 scheduler: messages-then-presence reflush in registration order with cancelled message and presence intent excluded and only interest frames on the recovery socket (publishes never resent); restoration frames sent before the `connected` state change and `RecoveryEvent`; replayed duplicate ids absorbed by the REV-01 window while new ids flow; reconnect flush into a full writer failing terminally with socket invalidation and zero timers; identical restoration on a second recovery cycle. The messaging suite additionally pins the C7 error-name mapping (`PermissionDeniedError` → `Permission` with a fixed message, all other names Transport, channel connected, no server bytes surfaced), and a declaration test pins the realized `ConnectionErrorCode` union (`Authentication` recorded absent per DEV-02). These tests do not prove server acceptance (C8).

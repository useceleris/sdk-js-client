# Test inventory

This inventory covers the implemented C0–C3 package. Update it when tested behavior changes. Fixtures contain independent expected bytes and objects; runtime tests compare observations from the real codec with those expectations.

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

Installed consumers verify the empty public export surface, private export boundaries and import safety. Import guards reject access to networking, environment-dependent capabilities and background timers. Internal codec bundles do not establish a public codec API.

See [runtime support](runtime-support.md) for matrix configuration and [verification](verification.md) for exact versions/results. Missing qualification runtimes fail rather than skip. Branded-browser and cross-OS qualification remain pending.

## Running and scope

`npm run check` runs build, typecheck, formatting and tests. `npm run test` runs once; `npm run test:watch` watches. Supply the documented eight-runtime matrix for full qualification.

Channel lifecycle, subscriptions, publishing lifecycle, presence query orchestration and reconnect behavior are future C4+ work. These tests do not prove server acceptance or resolve D-001–D-003. Runtime primitives and build-tool behavior are setup, not independent test subjects.

## C3 credentials and transport

[Credential attempt tests](../tests/transport/connection.test.ts) cover initial/reconnect context, fresh providers, opaque values, invalid results, safe synchronous/asynchronous failures, cancellation before/during acquisition and handshake, shared deadlines, late resolution/rejection, duplicate events, diagnostic reentrancy, missing capabilities and safe internal imports.

[URL tests](../tests/transport/url.test.ts) cover path prefixes, exact query values, URL component restrictions, loopback opt-in and channel character/length boundaries. [Adapter tests](../tests/transport/adapter.test.ts) cover binary ordering, text/oversize rejection, view ownership, send/buffering bounds, safe send errors, bounded idempotent close, listener removal, late messages and callback failures. [Type tests](../tests/declarations/connection-types.test.ts) verify portable asynchronous contracts and readonly credentials.

[Actual transport tests](../tests/runtime/transport.test.ts) exercise a local WS/WSS echo server with exact synthetic credential query values. All eight runtimes execute ESM WS, trusted WSS with an isolated test CA and untrusted-WSS rejection. Node/Bun additionally execute CommonJS WS. Chromium/Firefox/WebKit execute WS and reject untrusted WSS. Browser trusted-CA success is not qualified by this suite; no system trust store is modified or certificate verification disabled. Fixtures contain only a synthetic local certificate/key, with no production credentials.

Internal bundles exercise transport implementation separately from installed empty-package imports. Celeris authorization/replay integration remains C8. Automatic reconnect scenarios in [transport](transport.md) remain future C7 tests.

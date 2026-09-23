# C0–C2 verification

Recorded 2026-09-06 on macOS 26.6.2 (25G83), Apple Silicon. Node-hosted Vitest used Node 24.13.0. Client HEAD at final review: `7c27f54b20052d7382e51cd8d38c9712fb94b11f` plus uncommitted C0–C2 files. The checkout was initially unborn; an init commit containing package metadata appeared during work and was preserved. This task did not create a commit. Source/spec/server baselines and clean inspection states are recorded in [contracts](contracts.md).

Source/test snapshot SHA-256: `84e93830e00dbebfb5b10b6d841a7287980cb96bafeac3bfb95fa307c4ff0c00`. This hashes sorted relative paths, a NUL separator and file bytes for every authored TypeScript file in src/tests. It identifies the tested uncommitted implementation independently of HEAD.

## Executed results

| Check                                         | Result                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check` with the eight-runtime matrix | Passed: build, production/tooling typecheck, formatting, and `npm run test`                                                                |
| Latest complete Vitest run                    | 131 passed, 7 suites, zero failed/skipped; 10.19 seconds                                                                                   |
| Codec unit behavior                           | 96 tests: encoding, decoding, independent vectors, boundaries, ownership, redaction and 512 deterministic mutations                        |
| Type/package checks                           | 4 tests: schema-derived buffer types, bigint/readonly output, installed declaration modes, package metadata/contents and portability       |
| Runtime/browser execution                     | 31 tests: installed ESM imports in eight runtimes; CJS in six Node/Bun runtimes; corresponding codec runs; three browser bundle/codec runs |
| Local Markdown links                          | 41 checked; no broken local targets                                                                                                        |
| Whitespace/diff review                        | 37 tracked/untracked files checked; no whitespace errors; C3–C10 remain unchecked                                                          |
| `npm audit --json`                            | Zero advisories across runtime/dev dependencies                                                                                            |
| `npm install` restoration                     | Package manifest and lockfile SHA-256 unchanged; audit again reported zero advisories                                                      |

Each codec execution compares 9 independently authored outbound vectors, 12 inbound vectors and 33 malformed-message vectors. Expected values are not generated with package helpers. Byte/depth/count boundaries, truncation and mutation fuzzing have additional Node-hosted unit coverage; they are not claimed as full replicated runtime suites. No standalone runtime API, build-tool cleanup or runtime-version tests were added.

## Runtime evidence

| Runtime             | Exact version | Installed package                           | Internal codec       |
| ------------------- | ------------- | ------------------------------------------- | -------------------- |
| Node floor          | 22.15.0       | ESM/CJS pass                                | ESM/CJS vectors pass |
| Node 22 current     | 22.23.2       | ESM/CJS pass                                | ESM/CJS vectors pass |
| Node 24 current     | 24.20.0       | ESM/CJS pass                                | ESM/CJS vectors pass |
| Node current        | 26.8.1        | ESM/CJS pass                                | ESM/CJS vectors pass |
| Bun floor           | 1.3.0         | ESM/CJS pass                                | ESM/CJS vectors pass |
| Bun current         | 1.4.2         | ESM/CJS pass                                | ESM/CJS vectors pass |
| Deno floor          | 2.5.0         | ESM pass                                    | ESM vectors pass     |
| Deno current        | 2.9.6         | ESM pass                                    | ESM vectors pass     |
| Playwright Chromium | 153.0.8010.12 | Installed consumer bundle/import guard pass | Vectors pass         |
| Playwright Firefox  | 155.0         | Installed consumer bundle/import guard pass | Vectors pass         |
| Playwright WebKit   | 26.6          | Installed consumer bundle/import guard pass | Vectors pass         |

Current runtime versions were refreshed through npm registry metadata, then the existing isolated server-qualification executables were reused read-only. The full matrix used the eight executable locations under `/private/tmp/celeris-s01/runtimes`; recreate equivalent isolated installations and set CELERIS_RUNTIME_MATRIX as documented in [runtime support](runtime-support.md). No global runtime installations were changed. Browser versions were obtained from launched engines; cache installations did not replace system browsers.

Node/Bun/Deno package consumers load the tarball by exact npm name. Browser consumers are bundled from a temporary tarball installation. Codec fixtures deliberately bundle internal source separately; codec internals are not shipped/exposed merely for testing. Import guards reject crypto, network and timer access; source/built checks reject Node/environment references. No network connection to Celeris or server test execution occurred.

## Requirement and scenario mapping

| Stage / requirements                   | Evidence and applicability                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C0; SDK-01–11, REL-01                  | Contract/source review and explicit discrepancy/default decisions. Future lifecycle, credential and recovery scenarios are documented, not claimed implemented.                                              |
| C1; SDK-09–11, LANG-01, SEC-01, REL-02 | Exact package name, latest dependency/license/advisory review, installed artifacts/declarations and real engine execution. Server-revision integration remains C8.                                           |
| C1; LANG-02–03                         | Portable type/ownership contracts only; asynchronous lifecycle and browser background/resume remain C3–C8.                                                                                                   |
| C2; SDK-01, WIRE-01–02, WIRE-05        | Fixed command/response vectors, null/empty distinction, binary and Unicode, nested arrays and rejected internal commands. Bare scalars are field-only; top-level server messages are commands/arrays/errors. |
| C2; WIRE-03–04                         | Signed-64 endpoints, invalid text/numbers, truncation/trailing data, 128 KiB outbound and 1 MiB inbound limits, depth 32/fragments 4096, unsafe IDs and ambiguous error rejection.                           |
| PUB-03–04, PRES-01, PRES-03            | Codec-only ID/size/pagination/raw-notice portions pass. Actual writes, queues, presence queries and server behavior remain later stages.                                                                     |
| SEC-03; D-001–D-003                    | Local rejection is tested; unresolved malicious-peer/server behavior remains a release blocker. No claim of complete framing-injection prevention.                                                           |

## Readability and maintenance review

Reviewed all files listed below for scope, descriptive naming, schema reuse, copied byte ownership, bounded parsing, deprecated APIs, fixture independence and cleanup. Removed an unnecessary identifier forwarding helper/non-null assertion and moved browser-only fixture copying out of common package setup. Reused the server's small process/import/portability patterns; replaced its manual runtime-config validation with the already-required Zod. Kept direct build commands and no generic validation/transport framework. Production output types use no schemas.

During verification, corrected a two-byte arithmetic mistake in a boundary fixture and the browser harness's generated filename assumption. An attempted TypeScript compiler-API portability check was removed because latest TypeScript 7 does not expose that API; the server's established static check is used. The reproduced upstream Vitest declaration limitation remains confined to tooling skipLibCheck; production and installed consumers keep full checking. Earlier failing setup runs are superseded by the passing complete run above.

- `.github/workflows/ci.yml`
- `.gitignore`
- `.prettierignore`
- `AGENTS.md`
- `README.md`
- `STAGES.md`
- `docs/code-conventions.md`
- `docs/contracts.md`
- `docs/runtime-support.md`
- `docs/verification.md`
- `package-lock.json`
- `package.json`
- `src/commands.ts`
- `src/decode.ts`
- `src/encode.ts`
- `src/errors.ts`
- `src/index.ts`
- `src/messages.ts`
- `tests/codec/decoding.test.ts`
- `tests/codec/encoding.test.ts`
- `tests/declarations/codec-types.test.ts`
- `tests/declarations/declarations.test.ts`
- `tests/fixtures/browser-consumer.ts`
- `tests/fixtures/codec-consumer.ts`
- `tests/fixtures/codec-vectors.ts`
- `tests/fixtures/consumer-require.ts`
- `tests/fixtures/consumer.ts`
- `tests/fixtures/import-guard.ts`
- `tests/helpers/commands.ts`
- `tests/helpers/package-fixture.ts`
- `tests/helpers/runtimes.ts`
- `tests/package/package.test.ts`
- `tests/package/portability.test.ts`
- `tests/runtime/runtime.test.ts`
- `tsconfig.json`
- `tsconfig.tooling.json`
- `vitest.config.ts`

## Pending gates

Server-owner acknowledgement of the provider contract remains pending; the server repo and specification suite were not changed. D-001–D-003 remain open. The existing tracker now distinguishes local C0–C2 completion from stable-release readiness. C3–C10, real Celeris integration, branded-browser floors, Linux/Windows execution evidence, cross-OS release qualification and performance/soak work remain pending. The simple Linux CI workflow was authored but not executed remotely in this pass. The empty public entrypoint supplies no realtime feature or signing API. Nothing was published.

## Protocol character readability — 2026-09-07

Replaced 11 numeric marker/delimiter comparisons in `src/decode.ts` with direct character `charCodeAt(0)` expressions, and the framing newline assignment in `tests/codec/decoding.test.ts`. Added the convention to `AGENTS.md`. Reviewed these files and this evidence entry; existing decoder edits, numeric bounds, payload data and golden fixtures were preserved. No package dependency or test additions.

Build, typecheck, formatting and whitespace/diff checks passed. `npm run test` passed all 131 tests in 7 suites (9.90 seconds), using the same eight Node/Bun/Deno versions recorded above and Chromium/Firefox/WebKit. Temporary runtime installations were recreated under `/private/tmp/celeris-client-runtimes`; package dependencies and global runtimes were unchanged. The existing experimental TypeScript 7 build warning remains. Prior evidence and release blockers remain historical/pending as recorded above.

## Marker dispatch refactor — 2026-09-07

`MessageDecoder` now dispatches markers with short switches. Private handlers own message arrays, standalone errors, command messages and bulk bytes. Reviewed `src/decode.ts`, `AGENTS.md` and this evidence entry: each marker is consumed once; cursor, fragment/depth limits, error boundaries and byte ownership are preserved. Corrected stale closing comments and retained existing edits. Fixture hashes confirm all golden/support fixtures are unchanged. No tests, dependencies or public APIs were added.

`npm run check` passed build, typecheck, formatting and all 131 tests in 7 suites (10.61 seconds), using the eight-runtime matrix and three browser engines recorded above. Whitespace/diff checks passed, including the untracked decoder file. The existing TypeScript 7 experimental warning and pending release gates remain unchanged.

## Numeric parsing and contextual errors — 2026-09-07

Reviewed `src/decode.ts`, `src/errors.ts`, `src/commands.ts`, the updated decoding tests, new `tests/codec/protocol-errors.test.ts`, AGENTS.md, code conventions and this entry. Integer conversion now uses BigInt with safe exception translation; separate decimal-only and signed-64 checks preserve protocol acceptance. Identifier/error-name validation has no lookahead. Protocol errors expose fixed reasons plus readonly trusted field labels and zero-based field/header offsets, with no input values or native causes. Marker dispatch, fragment/depth/byte bounds and owned payload copies remain intact. No framework, dependency or public API was added; valid golden fixtures were unchanged.

`npm run check` passed build, production/tooling typecheck, formatting and 170 tests in 8 suites (10.22 seconds), including the eight-runtime/three-browser matrix. The 39 new focused Node-hosted cases cover context, offsets, redaction, numeric spellings and limit failures; cross-runtime fixtures retain their existing golden/rejection checks. Source search found no remaining lookahead patterns. Whitespace/diff checks passed. Existing tool warnings and pending release gates remain as previously recorded.

## Boundary-based decoder — 2026-09-07

Compared realtime revision `9b67cb6634a9c24754e75df25e2cbc2df1b26f26`: `app/src/message_parser/mod.rs` dispatches by marker and finds LF with iterator scanning; bulk/simple/array parsers use boundaries and slices. Client headers now use bounded native indexOf searches; bulk payloads retain declared-length slicing. No Rust allocation/validation permissiveness was copied. One MessageDecoder still owns cursor/fragments, with dedicated response readers and explicitly named diagnostic start positions.

Reviewed `src/decode.ts`, `tests/codec/boundaries.test.ts`, AGENTS.md, code conventions and this entry. Existing golden fixtures, contextual errors, numeric validation, ownership and limits remain unchanged. Nine added Node-hosted cases cover maximum-length LF/CRLF headers, missing/oversized delimiters, bounded search windows and 64 KiB newline/marker-rich payload ownership. Temporary benchmark code was also reviewed; no permanent benchmark framework, dependency or public API was added. A test-only unknown-value narrowing issue was fixed before the successful run.

`npm run check` passed build, typecheck, formatting and 179 tests in 9 suites (15.00 seconds), including all eight runtimes and three browser engines. Whitespace/diff review passed. Existing tool warnings and release gates remain unchanged.

### Before/after exploratory timing

Node 24.13.0 on this macOS/Apple Silicon host. Captured pre-edit and post-edit decoders were bundled with the same tsdown settings into temporary files. Each workload warmed up for 5,000 operations per implementation; five measured rounds alternated implementation order. Values below are median microseconds per decode, including caught ProtocolError construction for malformed inputs. Short messages used 100,000 operations per round; other workloads used 10,000. No timing assertions were added.

| Workload                        | Before | After |
| ------------------------------- | ------ | ----- |
| Short peer message              | 0.966  | 1.232 |
| 64 KiB bulk payload             | 2.104  | 2.125 |
| Malformed 64 KiB numeric header | 5.469  | 5.436 |

This run showed about 28% slower short-message decoding and approximately unchanged bulk/malformed-header timing. It does not demonstrate a general speedup; the refactor provides explicit bounded searches and clearer response structure. These are local exploratory timings, not cross-runtime benchmarks, allocation measurements or release performance qualification.

## Sequential header reading restored — 2026-09-07

At the user's request, readLine again advances byte by byte until LF and trims the optional preceding CR. Header bounds and contextual errors remain unchanged; bulk bytes still use declared lengths. Dedicated response readers and fieldStartOffset naming are retained. Removed indexOf spies and assertions from boundary tests while preserving behavioral cases. Updated AGENTS.md and code conventions; prior native-search timings above are historical, not measurements of this revision.

Reviewed the decoder, boundary tests and changed documentation. `npm run check` passed build, typecheck, formatting and all 179 tests in 9 suites (11.36 seconds), with the eight-runtime/three-browser matrix. Diff checks passed. No dependencies, public APIs or golden fixtures changed.

## Identifier collision fix and edge-case review — 2026-09-07

Rejected lone UTF-16 surrogates before UTF-8 encoding: previously `room-\ud800` encoded identically to valid `room-\ufffd`. The shared identifier schema now rejects lone surrogates while retaining valid pairs, replacement characters and unnormalized Unicode. No decoder, dependency or public API change was required.

Added eight invalid-identifier vectors, seven valid Unicode encoding vectors, five malformed UTF-8 vectors and five matching opaque-payload decoding vectors. Unit tests apply invalid identifiers to every command and publish message IDs; runtime fixtures execute invalid segment identifiers too. Added encoding/decoding tests for nonzero-offset byte views and owned output storage. Existing sequential header reading and bulk-length parsing remain unchanged. Nearby review found no further defect requiring a production change.

`npm run check` passed: build, both typechecks, formatting and **206 tests in nine suites**. Of these, 171 are Node-hosted codec tests; 31 runtime tests separately exercise installed imports and internal codec vectors; four package/declaration tests complete the count. Qualification used the existing eight-version matrix (Node 22.15.0/22.23.2/24.20.0/26.8.1, Bun 1.3.0/1.4.2, Deno 2.5.0/2.9.6) and installed Chromium/Firefox/WebKit engines. The existing TypeScript 7 experimental-API build warning remains. Historical results above are retained.

Reviewed every file changed in this pass: `src/commands.ts`, encoding/decoding tests, shared codec vectors, codec consumer, runtime assertions, README, AGENTS, contracts, this evidence and the new [test inventory](testing.md). Kept validation in the existing schema, reused fixture observations and added no helpers or dependencies. Diff whitespace checks and local Markdown links passed. Other repositories remain unchanged; server findings and pending platform/release gates remain open.

## Modular command encoder — 2026-09-07

Moved command layouts into focused private handlers on a per-operation `CommandEncoder`. An exhaustive switch dispatches PUB, PRES_LIST and the four segment-only commands. Validation still happens once at entry; handler types derive from Zod output. Shared byte accounting, bulk framing and final assembly retain existing limits and ownership. No public API, dependency or wire-format changes.

Added a regression proving a failed oversized operation cannot affect subsequent valid encoding. Existing golden fixtures remain unchanged. `npm run check` passed: build, production/tooling typechecks, formatting and **207 tests in nine suites**, including the existing eight-runtime/three-browser matrix. This comprises 172 Node-hosted codec tests, 31 runtime tests and four package/declaration tests. The existing TypeScript 7 experimental-API warning remains.

Reviewed `src/encode.ts`, `tests/codec/encoding.test.ts`, code conventions, test inventory and this evidence for descriptive names, redundant framing and unnecessary abstractions. Complete layouts stay explicit; identical segment-only layouts share one handler. No registry, helper framework or extra class was added. Changed-file whitespace checks passed. Prior evidence and pending release/platform gates remain unchanged.

## C3 internal transport and reconnect-aware credentials — 2026-09-07

Implemented safe credential URLs, validated request-object provider context, one 15-second acquisition/handshake deadline, cancellation/stale-result suppression and native binary transport with bounded sends/receives and five-second cleanup. Public exports remain empty; automatic reconnect is specified for C7 only. See [transport contract](transport.md) and [test inventory](testing.md).

Source baseline: client HEAD `a083d3c41451a2faed79730ea45e992e2829c8d5`, with this pass uncommitted; server HEAD `05eee326ca4de20696e7da8fbd5b17a1461294b1` clean; specifications `d51738c0fe6aff5fa6d2fecc0bb8efb4169bbddf` clean. Realtime remains `9b67cb6634a9c24754e75df25e2cbc2df1b26f26`, now with concurrent modifications to PLATFORM_REFERENCE.md, channel_receiver_runner.rs, replay/support/delivery tests and e2e cross_region.rs. Those files were not changed by this pass. Source inspection is not executed Celeris integration. D-001 still uses 60 minutes with a TODO for 60 seconds; D-002/D-003 remain unresolved protocol/server findings. Other repositories and pending acknowledgement gates remain unchanged.

`npm run check` passed build, both typechecks, formatting and **292 tests across 14 suites**: 172 existing codec tests, 51 Node-hosted transport/credential tests, five package/declaration tests and 64 runtime tests (31 existing package/codec plus 33 transport). The eight-runtime matrix was Node 22.15.0/22.23.2/24.20.0/26.8.1, Bun 1.3.0/1.4.2 and Deno 2.5.0/2.9.6 on the macOS host. Existing Chromium/Firefox/WebKit engines ran both codec and transport cases. No runtime was skipped. Existing TypeScript 7 experimental build warnings remain.

Real transport evidence: ESM WS, trusted WSS and untrusted-WSS rejection across all eight runtimes; CommonJS WS across Node/Bun; WS and untrusted-WSS rejection across all three browser engines. Trusted browser private-CA WSS success is not established; no system certificate trust was changed and no TLS verification was disabled. A CA-as-leaf test certificate initially failed Deno validation; the fixture now uses a separate signed CA:false server leaf. These are synthetic echo-server checks, not Celeris authentication, replay or permission acceptance.

Installed only test dependencies ws 8.21.3 and @types/ws 8.18.1 through npm latest/exact commands; npm audit returned zero vulnerabilities. Zod remains the only runtime dependency. Source and fixture review covered all five new production modules, three transport suites, connection type checks, runtime orchestration and synthetic certificate/consumer fixtures, package metadata, README, AGENTS, contracts, runtime support, tracker, test inventory and evidence. Shared credential validation removes duplicate schema logic; command/codec behavior is unchanged. Native callbacks are bounded and sanitized, test server shutdown and temporary-directory ownership are explicit. No crypto implementation, custom build script, CI expansion or public API was added.

## C3 direct WebSocket replacement — 2026-09-07

Replaced the superseded adapter design with direct native WebSocket ownership. `ConnectionHandler.openConnection()` validates configuration, requests fresh credentials, applies one 15-second credential/handshake deadline, waits for `open`, decodes binary messages, and settles failures once. `ConnectionHandle` owns bounded send and synchronous idempotent close. Removed `connection2.ts`, the transport adapter, adapter-only tests, redundant `onOpen`, diagnostics framework, and separate transport-error module. Public entrypoint remains empty; C7 still owns automatic reconnect.

Client baseline: `b3343d40be5ffef820e3ac826222549caead74ce`, with this pass uncommitted. Inspected references: server `05eee326ca4de20696e7da8fbd5b17a1461294b1`, specifications `d51738c0fe6aff5fa6d2fecc0bb8efb4169bbddf`, realtime `6ed43c47c1dd04b3cc56785eeb522e2d59aa44db`; all reference checkouts were clean. No other repository changed.

`npm run check` passed build, production/tooling typechecks, formatting, and **291 tests across 13 suites**. Full matrix used Node 22.15.0/22.23.2/24.20.0/26.8.1, Bun 1.3.0/1.4.2, Deno 2.5.0/2.9.6, Chromium, Firefox, and WebKit. Direct transport runtime suite passed 33 checks: ESM WS/trusted-WSS/untrusted-WSS across eight runtimes, CommonJS WS across Node/Bun, and WS/untrusted-WSS across three browser engines. Initial fallback smoke used host Node 24.13.0, Bun 1.1.29, and Deno 2.9.6 before isolated matrix recreation. No runtime was skipped in final check. Existing TypeScript 7 experimental API warnings remain.

Focused direct-connection/type/URL suites passed 49 tests before full verification. Coverage includes open settlement, initial/reconnect request shapes, fresh credentials, exact URL encoding, safe failures, cancellation, shared timeout, stale results, binary decoding, malformed/oversized/unsupported messages, callback containment, send/buffering boundaries, copied byte views, explicit/unexpected close, and import safety. Runtime fixture sends a valid SUB frame and asserts decoded SERVER_MSG rather than testing a raw adapter echo.

Reviewed connection, credential and error source; connection/type/URL/runtime tests; transport consumer/certificate fixtures; contracts, transport, runtime support, conventions, AGENTS, tracker, test inventory, and this evidence. Direct code keeps two domain classes and one URL module. No new dependency, public export, build script, CI expansion, server change, or publication.

## C4 channel lifecycle and reconnect scheduler — 2026-09-20

Implemented the first public surface and the connection-level reconnect scheduler (rescoped from C7 by owner decision). `createClient`/`Client.channel()` construct side-effect-free handles; `Channel` owns the seven-state machine, handler-based events (DEV-01: named `on*` registrations returning dispose functions, synchronous ordered dispatch, contained listener exceptions), a memoized idempotent `close()` awaiting native close under the five-second budget, generation-based stale suppression, and ten full-jitter retries with sixty-second budget reset, preserved outage, and `ceil(elapsed)+5000` capped replay lookback via injectable monotonic clock/wall clock/randomness. C3 revisions: `ConnectionOptions.timeoutMs` (default 15 000) and close-listener retention so `onClose` reports every native close. Public credential types moved to a schema-free module; built declarations are asserted to contain no Zod reference. `ConnectionErrorCode` gained `OperationInProgress`; `ChannelError` unions the three exported error classes. `onDiagnostic` and the lookback-truncation diagnostic remain deferred (C7).

Client baseline: `92456f7b2530887f0a45a5c57f87bfd4a6dffa4f`, with this pass uncommitted. `npm run check` passed build, production/tooling typechecks, formatting, and **290 tests across 17 suites** on host Node 24.13.0, Bun 1.1.29, Deno 2.9.6, Chromium, Firefox, and WebKit (default runtime matrix; the recorded eight-runtime matrix rerun remains C8 qualification evidence). New channel suites (52 tests incl. type contracts) are fully deterministic. Installed ESM/CommonJS/browser consumers now observe exactly six value exports and blocked private paths; declaration consumers compile real `createClient` usage in all three module modes with `lib: ["ES2022", "DOM"]`, reflecting the `AbortSignal` platform-library requirement.

Reviewed channel, client, reconnect, credential-types, credentials, connection, errors and index source; channel/lifecycle/close/reconnect/type suites; websocket/channel helpers; consumer fixtures; runtime/declaration/package suites; README, EXAMPLES, contracts, transport, testing, tracker, and this evidence. One runtime dependency (zod) unchanged; no build script, CI expansion, server change, or publication.

## C5 segments and messaging — 2026-09-20

Implemented the SEG-01 segment surface over the C4 channel: `Channel.segment()` returns the stateless `Segment` proxy (id plus channel delegate functions only; listeners live on the channel in one shared per-segment set), with `subscribe()` (channel-wide ref-counted interest; SUB on first, UNSUB on last for non-default segments while connected), `onMessage()` and `publish()` (local-acceptance semantics; encoder-enforced 128 KiB bound; server auto-join documented). SUB interests flush on every connected transition in registration order before `connected` becomes observable; an initial-connect flush failure rejects without `onError` while a reconnect flush failure fails terminally. Inbound routing is generation-gated and throw-free: MSG demuxes by segment id through the REV-01 dedup window (1024-id insertion-order set recorded before fanout, kept across reconnect, cleared per `connect()`; lenient null-id interim delivers `""` and skips dedup until C8), ARRAY recurses, ERROR frames report one fixed safe error while the channel remains connected, SERVER_MSG and PRES_LIST_RESPONSE stay silent until C6. Added `DeliveryUnknown` to `ConnectionErrorCode`, mapped native mid-send throws to it, exposed a read-only `bufferedAmount` accessor, and enforced the 64-command observed-drain writer heuristic in the channel. New root CONVENTIONS.md (simplicity/maintainability rules) referenced from AGENTS.md in both packages.

Client baseline: `8b5500c491b89c3e53e0bdd5a534ba7eab080a7d`, with this pass uncommitted. `npm run check` passed build, production/tooling typechecks, formatting, and **317 tests across 18 suites** on host Node 24.13.0, Bun 1.1.29, Deno 2.9.6, Chromium, Firefox, and WebKit (default matrix; the eight-runtime rerun remains C8). The new messaging suite adds 26 deterministic tests with golden outbound bytes and hand-authored inbound frames; installed consumers now observe exactly seven value exports; declaration consumers compile `channel.segment().onMessage()` usage in all three module modes with no schema inference in built declarations.

Reviewed channel, segment, connection, commands, encode, errors and index source; messaging/lifecycle/close/reconnect/transport/type suites; consumer fixtures and helpers; CONVENTIONS, AGENTS, README, EXAMPLES, contracts, transport, testing, tracker, and this evidence. One runtime dependency (zod) unchanged; no build script, CI expansion, server change, or publication.

## C6 presence — 2026-09-20

Implemented presence over the SEG-01 segment surface: `Segment.subscribePresence()` (channel-wide ref-counted interest; PRES_SUB/PRES_UNSUB sent uniformly on every segment including default — server-source verified that connect-time auto-join grants message membership only), `Segment.presenceList()` (one nullable pending-query record per channel; deadline timer created at send from configurable `presenceQueryTimeoutMs`; publish-like rejection on synchronous send failure without occupying the slot; bigint-equality response matching on segment/currentPage/perPage; timeout or abort after send rejects and retires the connection into bounded recovery, entering reconnecting before closing the handle so the synchronous native close is state-gated; loss and terminal failures reject with a fixed Transport error; explicit close rejects Cancelled), and `ChannelEventHandler.onNotice` (raw untagged SERVER_MSG delivery with containment). The message-cancel UNSUB rule tightened to require a zero presence count; presence cancellation never sends UNSUB (lingering membership recorded, PUB-auto-join precedent). Interest flush is messages first then presence, registration order. Hand-written `ServerNotice`/`PresencePage`/`PresenceConnection` exported as types only; `presenceQueryTimeoutMs` threaded from `ClientOptions` through `Client` into the channel. No response arithmetic exists — raw bigint metadata passes through (`from > to` preserved) and the decoder bounds all numerics, satisfying the signed-64 acceptance line by construction.

Client baseline: `febeaf064affb63154c6a704d0a3d67b8021ab16`, with this pass uncommitted. `npm run check` passed build, production/tooling typechecks, formatting, and **343 tests across 19 suites** on host Node 24.13.0, Bun 1.1.29, Deno 2.9.6, Chromium, Firefox, and WebKit (default matrix; the eight-runtime rerun remains C8). The presence suite adds 25 deterministic tests with golden PRES_SUB/PRES_UNSUB/PRES_LIST bytes and hand-authored PRES_LIST_RESPONSE frames; a vitest fake-timer nuance (a zero-delay timer scheduled inside a timer callback needs a nonzero advance) is noted in the timeout test. Installed consumers still observe exactly seven value exports; built declarations remain free of schema inference.

Reviewed channel, segment, client and index source; presence/messaging/lifecycle/close/reconnect/type suites; channel helper; contracts, testing, tracker, EXAMPLES, and this evidence. One runtime dependency (zod) unchanged; no build script, CI expansion, server change, or publication.

## C7 recovery restoration — 2026-09-20

Verified the recovery-restoration mechanism end-to-end and landed the remaining C7 decisions. The C5/C6 interest flush over the C4 scheduler is proven deterministic: messages-then-presence reflush in registration order with cancelled intent excluded, only interest frames on the recovery socket (publishes never resent), restoration frames sent before the connected state change and RecoveryEvent, replayed duplicates absorbed by the REV-01 window while new ids flow, reconnect flush into a full writer failing terminally with socket invalidation and zero timers, and identical restoration on a second recovery cycle. Known server error names now map to codes at the router: `PermissionDeniedError` becomes `ConnectionError("Permission", "Server denied permission.")` with all other names keeping the fixed Transport report; the channel remains connected and server bytes never surface. `Authentication` is recorded absent (DEV-02: native WebSocket exposes no handshake status in any runtime and no authentication-named wire error exists), and `onDiagnostic` is dropped from v1 (recorded decision; the scheduler's silent replay-lookback cap remains documented). Ten of the shared contract's eleven error categories are realized.

Client baseline: `d14ae1a437b3742ff8fa9dd1fef7e25ca33a20c5`, with this pass uncommitted. `npm run check` passed build, production/tooling typechecks, formatting, and **350 tests across 20 suites** on host Node 24.13.0, Bun 1.1.29, Deno 2.9.6, Chromium, Firefox, and WebKit (default matrix; the eight-runtime rerun remains C8). The restoration suite adds five deterministic tests; the messaging suite gains the Permission-mapping case; a declaration test pins the exact realized `ConnectionErrorCode` union. Installed consumers still observe exactly seven value exports.

Reviewed channel, errors and index source; restoration/messaging/presence/lifecycle/close/reconnect/type suites; contracts, transport, testing, tracker, EXAMPLES, and this evidence. One runtime dependency (zod) unchanged; no build script, CI expansion, server change, or publication.

## C8 Celeris qualification — 2026-09-20

Qualified against a real three-node celeris-realtime stack, revision `b8265748f09a98789d304f368b4ee8cca1d6071d` (e2e compose `.infra/tests/compose.e2e.yaml`, images built from that revision; host ports remapped via a scratch compose override — kafka host ports dropped as debug-only, app nodes on 9101/9102/9103 — because the host's dev stack held 19092/29092/39092 and 9001-9003; user repositories unmodified). Qualification app seeded directly into the stack's Postgres: signing secret AES-encrypted by a node:crypto script reproducing the server's password_utils format, accounts/apps rows upserted via psql (client id `js-qual`, account/app 900777, free plan).

**All 20 gated acceptance scenarios passed** (`npm run test:celeris`: authentication 6, messaging 7, crossnode 2, presence 3, replay 2) on host Node 24.13.0. Findings and revisions from the live runs:

- **REV-01 VERIFIED:** every delivered, replayed and cross-node message carried a server-assigned `msg_{region}_{ulid}` id; replayed ids were byte-identical to the live deliveries. The lenient null-id interim is retired — a null id is now terminal `ProtocolError("Server message is missing its identifier.")` at the delivery layer, unit-covered.
- **D-002 live manifestation and decoder revision:** the server's output batching wraps error frames as the final array element (`*1\n-Err\n...`), which the previous conservative decoder rejected — every permission denial killed the connection. The decoder now accepts an error in tail position (every enclosing array consuming its final element; content = rest of message, boundary-unambiguous) and still rejects errors anywhere else in an array. New accept vectors and non-tail/nested reject vectors added; the offset-assertion vector updated.
- **Permission mapping confirmed live:** a read-only token's publish resolved locally and the denial arrived uncorrelated as `-Err PermissionDeniedError` → `ConnectionError("Permission")`, channel connected.
- **Live reconnect observation:** restarting app-1 under a connected channel produced reconnecting → fresh reconnect credentials with growing capped lookback (observed 5327 then 5698 ms = ceil(elapsed)+5000) → connected at retryIndex 1 → RecoveryEvent → interest restoration, and a post-recovery cross-node publish was delivered with a server id. Scratch script and log retained for this session.
- **D-001 observation:** a token 59 minutes old was accepted; 61 minutes and future timestamps rejected — the enforced window is 60 minutes against a documented 60-second intent. Recorded, not relied upon.

Client baseline: `eb308b9fbfc75573b24b6aed58fdd5735a41d50d`, with this pass uncommitted. Local evidence after the decoder revision and REV-01 flip: `npm run check` passing (see run recorded below). Celeris acceptance stays separate from local evidence via vitest.celeris.config.ts; suites fail loudly without the CELERIS_* environment. Blockers recorded: MATRIX-01 (eight-runtime rerun), STAGE-SMOKE-01 (deployed-staging smoke pending owner credentials), SLOW-01 (slow-consumer load scenario), PORT-01 (branded browsers/cross-OS).

Reviewed decode, channel source; codec vectors and protocol-error offsets; celeris helpers and five suites; contracts, testing, tracker, and this evidence. No new dependency, no server change beyond reading it, no publication.

## C9 documentation — 2026-09-21

Turned the documentation into verified artifacts. Two runnable examples — [node-quickstart](../examples/node-quickstart.ts) (Node/Bun/Deno; inline node:crypto signer standing in for the application's credential endpoint) and [browser-quickstart](../examples/browser-quickstart.ts) (fetches credentials from an endpoint, imports only the client package, no secrets; wrapped in `main()` because IIFE bundles cannot use top-level await) — are compiled against the installed tarball and executed against the C8 local stack by the celeris-config [examples suite](../tests/celeris/examples.test.ts): the Node quickstart on host Node 24.13.0, Bun 1.1.29 and Deno 2.9.6 (Deno with `--allow-net --allow-env`), the browser quickstart in Chromium, Firefox and WebKit with a Node-side signer endpoint. **Both passed (2/2) on 2026-09-20 against celeris-realtime `b8265748f09a98789d304f368b4ee8cca1d6071d`.**

A new default-run [drift suite](../tests/package/examples-drift.test.ts) type-checks every EXAMPLES.md `ts` block strictly against the public surface. Writing it surfaced two real defects in the published snippets — a stray closing brace in the error-handling block, and `catch (error)` narrowing that never compiled under `strict` — both fixed; the snippets now teach the `instanceof ConnectionError` pattern. EXAMPLES.md gained replay/gaps-duplicates and bigint-serialization sections, and its status banner became a verification note. The README was rewritten for consumers: the three-sentence segment model, a quickstart, an honest delivery-semantics list, a limits table, runtime floors, and development pointers.

Client baseline: `eb308b9fbfc75573b24b6aed58fdd5735a41d50d`, with this pass uncommitted. `npm run check` passed build, production/tooling typechecks, formatting, and **354 tests across 21 suites** on 2026-09-21. **Rerun caveat:** a fresh `npm run test:celeris` on 2026-09-21 was blocked — the Docker daemon stopped answering (500 from the engine socket, `docker info` hanging). No file under `src/` changed after the 2026-09-20 live runs (20/20 acceptance after the REV-01 flip, 2/2 examples); later changes were documentation, the drift suite, and formatter-only rewrites of example and test files. A confirming rerun is pending daemon recovery.

Reviewed both examples, the examples and drift suites, README, EXAMPLES, testing, tracker, and this evidence. No new dependency, no server change, no publication.

## Maintenance — simplification pass — 2026-09-21

Behavior-neutral simplification of the C4–C9 source ahead of server S4 (owner request 2026-09-21). No public-surface change: the entrypoint exports, declaration tests and packed-artifact assertions are untouched and still pass.

- `channel.ts`: collapsed `addMessageInterest`/`addPresenceInterest` into one ref-counting `addInterest` helper (identical SUB/UNSUB/PRES_SUB/PRES_UNSUB gating preserved); extracted `detachHandle()` for the three invalidate-then-fail sites and `close()`; extracted `rejectPresenceQueryOnConnectionLoss()` shared by `enterReconnecting`/`failTerminal`; `ListenerSet` now takes its containment callback in the constructor (dispatch sites lost the repeated closure); replaced the one-element `defaultSegments` set with a `defaultSegmentId` comparison; documented why `receiveSocketError` drops the handle without closing (the connection layer already closed it).
- `connection.ts`: dissolved the zero-field `ConnectionHandler` class into the module-level `openConnection()` function (same body, same settlement semantics); removed `ConnectionHandle.finishNativeClose()` and the `removeAllListeners` constructor argument — the native close listener registers with `{ once: true }` and `receiveClose` closes the handle, which is equivalent and idempotent.
- New `limits.ts` holds the shared wire limits (`maximumCommandBytes` 128 KiB, `maximumMessageBytes` 1 MiB) previously duplicated across `encode.ts`, `decode.ts` and `connection.ts`.
- `decode.ts`: replaced the two-overload `readIdentifier` with plain `readIdentifier`/`readNullableIdentifier`; marked `decodeServerMessage` as the codec test seam.
- `reconnect.ts`: un-exported the four internally-consumed constants; `credentials.ts`: un-exported `credentialsSchema` and removed the duplicate credential-type re-export path (all imports now use `credential-types.ts`); `channel.ts` re-exports `PresenceConnection` from `messages.ts` instead of restating it.
- `SegmentDelegates` was reviewed for removal and deliberately kept: passing `Channel` itself into `Segment` would force the five delegate methods public and into the published `.d.ts`, breaking the fixed C4–C7 surface. Recorded here so the indirection reads as load-bearing.
- Docs: corrected the stale REV-01 "lenient interim" line in contracts.md and testing.md (the interim retired in C8), the two "entrypoint remains empty" claims (transport.md, contracts.md), and the `ConnectionHandler` references (code-conventions.md, testing.md, contracts.md never-exported list). Dated journal entries above retain their original wording. `tsconfig.tooling.json` now typechecks `vitest.celeris.config.ts`.

Client baseline: `d26d80f6` plus this uncommitted pass, macOS 26.7, Node v24.13.0. `npm run build`, both typechecks, `format:check` and `npm test` (354 tests, 21 suites) all passed on 2026-09-21 after the refactor. Reviewed every changed source, test and doc file for removable code; deletions: `ConnectionHandler` class shell, `finishNativeClose`, `defaultSegments`, duplicate `PresenceConnection`, duplicate limit constants, dead constant exports, duplicate type re-export path. No new dependency, no behavior change intended, no publication.

## Maintenance — multi-region dev-environment run — 2026-09-22

`npm run test:celeris` executed unchanged against the operator's local multi-region dev environment (celeris-realtime `b826574`; three instances behind three regional HAProxy gateways — us `ws://localhost:19001`, eu-1 `:19002`, eu-2 `:19003` — with per-region Kafka): **22/22 in six suites (90.9 s)**. `CELERIS_WS_URL` targeted the us gateway and `CELERIS_WS_URL_SECONDARY` the eu-1 gateway, so the crossnode suite exercised genuine cross-region fanout and presence consistency through the gateway layer for the first time (C8 ran against direct nodes on one compose network). Authentication reproduced the D-001 window identically on the dev backend; the examples suite ran the node quickstart on host Node/Bun/Deno and the browser quickstart in Chromium/Firefox/WebKit against the gateway. Credentials were the operator's dev app identity, supplied as environment variables at run time and recorded nowhere. STAGE-SMOKE-01 remains open — this is a local `ws://` environment, not the deployed staging endpoint. No source or test changes in this pass.

## MATRIX-01 — eight-runtime matrix rerun — 2026-09-22

The rerun the tracker gated on stable release. Isolated runtime installations were recreated in a persistent directory (`<workspace>/.runtimes`, outside both repositories, no global installation touched) and selected with `CELERIS_RUNTIME_MATRIX`; `npm run check` then ran end to end.

| Runtime         | Exact version | Result                                               |
| --------------- | ------------- | ---------------------------------------------------- |
| Node floor      | v22.15.0      | pass                                                 |
| Node 22 current | v22.23.2      | pass                                                 |
| Node 24 current | v24.20.0      | pass                                                 |
| Node current    | v26.8.1       | pass                                                 |
| Bun floor       | 1.3.0         | pass                                                 |
| Bun current     | 1.4.2         | pass                                                 |
| Deno floor      | 2.5.0         | pass (ESM; CommonJS consumers are skipped by design) |
| Deno current    | 2.9.6         | pass                                                 |

**`npm run check` on 2026-09-22, macOS 26.7 (aarch64): 391 tests in 21 suites** (up from 354 on the default three-runtime selection — the packed-consumer and codec suites iterate the matrix, so the extra five runtimes add real executions, not repeats). Build, both typechecks and formatting passed in the same run. Chromium/Firefox/WebKit browser evidence comes from the same run's browser suites. The declared Bun floor (1.3.0) is now actually exercised — earlier C4–C9 passes used host Bun 1.1.29, which sits below the floor.

The sibling server package ran the identical matrix in the same session: **185 tests in 11 suites**, all eight runtimes green.

MATRIX-01 is closed. The runtime directory is reusable; recreate it from the versions above if it is removed.

## SLOW-01 — slow-consumer disconnect: recorded waiver — 2026-09-22

The tracker's gate for SLOW-01 is "load scenario or recorded waiver". A load scenario was attempted against the local multi-region dev environment and did not reproduce the disconnect; this records the attempts and the source analysis, and takes the waiver.

**Server mechanism (source inspection, celeris-realtime `b826574`).** The disconnect is not a bounded per-connection output queue. `segment_broadcast_runner.rs` keeps a per-segment backlog of `MAX_BACKLOG_CAPACITY = 100` entries (also evicting entries older than `MAX_BACKLOG_AGE_SECONDS = 60`); `pull_backlog_since_seq` returns `Lagging` when a listener's `last_seen_seq + 1` has fallen behind the oldest retained entry. `client_server.rs` then logs "Slow connection detected; shutting down" and closes with `actix_ws::CloseCode::Error`, i.e. **close code 1011**, reason "Connection closed by server". Reaching `Lagging` requires the per-connection segment listener to be blocked inside its send await long enough for 100+ newer publishes to evict its cursor. A connection that has not yet pulled (`last_seen_seq == None`) can never lag, so a replay-bearing token is required.

**Attempts (all against the dev stack, publisher = SDK channel, stalled reader = raw `ws` socket with `replay: true`, subscribed to the same segment, then `socket.pause()`).** Four configurations: 150 x 1 KiB through the `us` gateway; 150 x 64 KiB through the gateway (the client's own 1 MiB writer bound rejected 135 of 150 — an SDK-side limit, recorded separately as correct behavior); 150 x 100 KiB (~15 MB) through the gateway; and 150 x 100 KiB directly against `app-1` (`ws://localhost:9001`), bypassing HAProxy. In every case all publishes were accepted, the stalled socket received no close frame, the healthy SDK reader stayed connected, and the app logs contained no "Slow connection detected" line. Pausing a client socket does not propagate enough backpressure through the server's write path to block the listener in this topology, so the eviction race never starts.

**Waiver.** The mechanism, thresholds and close code are established by source inspection rather than an executed SDK scenario. The server's own coverage agrees this is hard to force deterministically: `app/src/tests/test_backlog_replay.rs` carries `lagging_client_forces_disconnect_when_backlog_evicted` marked `#[ignore = "timing-sensitive..."]`. No SDK assertion was weakened and no test was left failing; the attempted test file was removed rather than retained in a skipped state.

**SDK behavior if it does occur (by design, unchanged).** The client does not inspect WebSocket close codes: `receiveClose` takes no event, so a 1011 lagging close is handled exactly like any other transport close — `reconnecting`, bounded retry with a replay lookback, then a `RecoveryEvent` declaring possible gaps and duplicates on reconnect. Loss is therefore surfaced to the application (as declared gaps), while the reason is not distinguishable. Surfacing close codes would be a public-surface change and is out of scope for v1.

## Main qualification run — local multi-region environment — 2026-09-22

The local dev environment is the primary test target for this package. `npm run test:celeris` against the regional HAProxy gateways (`CELERIS_WS_URL=ws://localhost:19001`, `CELERIS_WS_URL_SECONDARY=ws://localhost:19002`; credentials supplied as environment variables, never recorded): **26 tests in 7 suites (108.8 s), all passing**, on macOS 26.7 with host Node v24.13.0 against celeris-realtime `b826574`.

Suites: authentication (including the D-001 window), messaging, crossnode (genuine cross-region fanout and presence through the gateway layer), presence, replay, examples (node quickstart on Node/Bun/Deno plus browser quickstart in Chromium/Firefox/WebKit), and the new payload-formats suite below.

**New: [payload formats](../tests/celeris/payload-formats.test.ts).** Payloads are opaque bytes to both the SDK and the server, so the suite proves that property for the three encodings applications actually use — JSON (multibyte UTF-8), MessagePack (fixmap with an embedded `bin8` field carrying NUL and 0xFF bytes), and protobuf (varint, length-delimited non-ASCII string, embedded message). Each vector is hand-encoded in the test (no serializer dependency added), published and received **byte-identically**, and then decoded on arrival — `JSON.parse` for the JSON document, header and `bin8` byte checks for MessagePack, and a varint/length-delimited field walk for protobuf — so the vectors validate themselves rather than mirroring a copy. Four tests.

## PORT-01 — branded browsers and cross-OS — 2026-09-22

The gate's finding was "support claims exceed branded-browser/cross-OS evidence". It is closed by adding the missing evidence where it is obtainable and narrowing the claims everywhere else.

- **Branded-channel selection** is env-driven: [tests/helpers/browsers.ts](../tests/helpers/browsers.ts) returns the three bundled engines plus any Playwright channels named in `CELERIS_BROWSER_CHANNELS`. Unset behavior is unchanged, and the helper replaced three copies of the same engine tuple in [runtime](../tests/runtime/runtime.test.ts), [transport](../tests/runtime/transport.test.ts) and [celeris examples](../tests/celeris/examples.test.ts).
- **Executed on macOS 26.7, 2026-09-22:** `CELERIS_BROWSER_CHANNELS=chrome` → **29 tests in 2 suites passing** across Chromium, Firefox, WebKit and branded Chrome 153 (package bundle, import guard, codec vectors, native transport and untrusted-TLS rejection in each).
- **Cross-OS** is delegated to CI: the workflow now runs the full `npm run check` on a `[ubuntu-latest, windows-latest]` matrix, with `CELERIS_BROWSER_CHANNELS=msedge` on Windows (the runner ships Edge). Previously CI was a single Linux job running only `npm run test`.
- **Claims narrowed** in [runtime support](runtime-support.md) to a per-target evidence table. Safari is now explicitly **not qualified** — Playwright cannot drive Safari, bundled WebKit is an engine proxy rather than a Safari release, and no Safari minimum version is claimed. Branded Firefox and mobile browsers are likewise unclaimed.

PORT-01 closes on the recorded macOS runs plus the first green ubuntu/windows CI runs; the CI half needs a push, which is the user's to make.

## CI qualification stack — 2026-09-22

The `test:celeris` suites now have a reproducible stack of their own, committed at [.ci/](../.ci): two realtime nodes behind the real HAProxy entrypoint and its discovery sidecar, plus Kafka, Redis, Postgres and ClickHouse. Tests connect to the entrypoint, so CI exercises the routing path production clients take rather than a direct node. Every Celeris image is pulled prebuilt from GHCR; nothing builds from source.

- Postgres is initialised with the service's schema dump and [seed.sql](../.ci/seed.sql), which creates account/app `900100` (client id `js-ci`) with the signing secret stored in the server's AES-256-GCM format, plus a generous plan so runs are never throttled. Regeneration recipe: [.ci/README.md](../.ci/README.md).
- **Verified locally 2026-09-22**: the full client suite (**26 tests in 7 suites**) and the sibling server suite (**12 tests in 3 suites**) both pass against this stack, with a realtime image built from `b826574`.
- **Two image notes, both recorded in .ci/README.md.** Bring-up initially failed every delivery test with `ProtocolError: Server message is missing its identifier` — the SDK's REV-01 rejection working correctly. The cause was local, not the registry: the `ghcr.io/useceleris/celeris-realtime:prod` pull was denied without authentication, so Docker silently used a cached copy from 2026-08-10 that predates server-assigned message ids. The current published tags carry that behavior, the compose defaults to `:prod`, and CI authenticates before pulling. Separately, the realtime image publishes `linux/arm64` only, so the live job runs on an arm64 runner.

Credentials and target URL now come from a gitignored `.env` (loaded by [vitest.celeris.config.ts](../vitest.celeris.config.ts)); real environment variables take precedence, so CI passes them directly. `CELERIS_WS_URL_SECONDARY` was removed — the cross-node suite opens independent connections through the single entrypoint, which distributes them across nodes.

CI itself was rebuilt in both repositories: triggers narrowed to pushes on `main` and pull requests, a concurrency group cancels superseded runs, the fast job runs the full `npm run check` on ubuntu and windows, and a second job brings the stack up and runs the qualification suites.

# @useceleris/client implementation stages

Created: 2026-09-06. Revised: 2026-09-07 for the direct native WebSocket design.

This tracker defines implementation order and completion evidence. It does not authorize publication or changes to Celeris services, specifications, or the server SDK.

## Sources and working rules

Use the [PRD](../../celeris-sdk-specs/SDK_PRD.md), [shared contract](../../celeris-sdk-specs/docs/shared-contract.md), [wire protocol](../../celeris-sdk-specs/docs/protocol.md), [JavaScript conventions](../../celeris-sdk-specs/docs/conventions/javascript.md), [conformance plan](../../celeris-sdk-specs/docs/conformance.md), [security policy](../../celeris-sdk-specs/docs/security-dependencies.md), [maintenance policy](../../celeris-sdk-specs/docs/maintenance.md), and [discrepancy register](../../celeris-sdk-specs/docs/discrepancies.md). Local decisions are recorded in [contracts](docs/contracts.md), [runtime support](docs/runtime-support.md), [test inventory](docs/testing.md), and [verification evidence](docs/verification.md).

Package: **`@useceleris/client`**. It owns realtime connections, messaging, presence, lifecycle, and recovery. It never signs credentials or depends on `@useceleris/server`; applications provide fresh credentials through a callback.

Keep the implementation direct:

- `ConnectionHandler` acquires credentials, builds the URL, opens the native WebSocket, wires events, and decodes incoming messages.
- `ConnectionHandle` sends bytes and closes its socket.
- `openConnection()` resolves only after the WebSocket opens. Credential or handshake failure rejects it.
- Add only the settlement, timeout, cancellation, and listener cleanup needed for those responsibilities. Do not add transport factories, registries, generic event frameworks, or a second adapter layer.
- Decode binary messages with `MessageDecoder`. Reject unsupported message data. Translate native failures into safe SDK errors; never cast native events to SDK errors.
- Keep runtime code portable across Node.js, Bun, Deno, and browsers. Use native WebSocket directly and keep imports side-effect free.
- The C4–C7 public surface is fixed in [contracts — Public API surface](docs/contracts.md), together with binding minimalism constraints (stateless `Client`, stateless `Segment` proxies, one `Subscription` shape, handler-based events with named `on*` methods per DEV-01, no error hierarchy, no extra configuration knobs, no generic event framework). Consumer usage is mirrored in [EXAMPLES.md](EXAMPLES.md); both change in the same commit as any surface change. Every new public identifier must trace to a specification requirement or a recorded local decision.
- Segment model (SEG-01, owner directive 2026-09-20): one `Channel` = one WebSocket client; all of that channel's segments are multiplexed over the single connection, and connecting auto-joins the default segment `"default"`. `Segment` handlers are subscribers-and-proxies over the channel connection — many handler instances may share one channel, but each new `Channel` is a new socket. Server facts that bind implementation: `MSG` is segment-tagged (exact demux) while `SERVER_MSG`/`-Err` are not (channel-level only, no correlation ids — never gate on prose); `PUB` auto-joins its segment; `PRES_SUB` force-joins for messages and `PRES_UNSUB` does not leave; replay applies per segment join; segments are lazy and evaporate when empty; the default segment cannot be remote-unsubscribed; read access is evaluated at join (a write-only member receives nothing); handler `subscribe()` is a network operation (the server spawns a per-segment listener task with its own replay cursor). Full detail in [contracts — Segment model](docs/contracts.md).

Status values: **Not started**, **In progress**, **Blocked**, **Complete**. Completion requires checked tasks, passing evidence, reviewed files, and no unresolved blocker that invalidates the acceptance gate.

## Status

| Stage                      | Status                                                                                               | Owner                                                                     | Evidence                                   | Completed  | Blockers                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------- |
| C0 — Contracts             | Complete                                                                                             | Codex                                                                     | [C0–C2 evidence](docs/verification.md)     | 2026-09-06 | Cross-repository acknowledgement pending                         |
| C1 — Foundation            | Complete                                                                                             | Codex                                                                     | [C0–C2 evidence](docs/verification.md)     | 2026-09-06 | Cross-OS/branded-browser evidence remains C8                     |
| C2 — Codec                 | Complete                                                                                             | Codex                                                                     | [Codec evidence](docs/verification.md)     | 2026-09-06 | D-002 and D-003 remain open                                      |
| C3 — Connection            | Complete                                                                                             | Codex                                                                     | [Direct C3 evidence](docs/verification.md) | 2026-09-07 | C8 Celeris/platform qualification remains                        |
| C4 — Lifecycle + reconnect | Complete                                                                                             | Claude                                                                    | [C4 evidence](docs/verification.md)        | 2026-09-20 | Eight-runtime matrix rerun remains C8; ACK-01/REV-01/DEV-01 open |
| C5 — Segments + messaging  | Complete                                                                                             | Claude                                                                    | [C5 evidence](docs/verification.md)        | 2026-09-20 | REV-01 lenient interim until C8; ACK-01/DEV-01 open              |
| C6 — Presence              | Complete                                                                                             | Claude                                                                    | [C6 evidence](docs/verification.md)        | 2026-09-20 | Restoration verification remains C7; D7 reading recorded         |
| C7 — Recovery restoration  | Complete                                                                                             | Claude                                                                    | [C7 evidence](docs/verification.md)        | 2026-09-20 | DEV-02 (Authentication unrealizable) recorded; C8 remains        |
| MATRIX-01                  | Eight-runtime matrix rerun (4 Node, 2 Bun, 2 Deno via CELERIS_RUNTIME_MATRIX) not executed this pass | Default host Node/Bun/Deno plus three browser engines recorded            | Matrix rerun before stable release         |
| STAGE-SMOKE-01             | Deployed-staging smoke evidence pending owner-supplied wss URL and credentials                       | Local three-node stack qualified; harness is env-driven and staging-ready | Staging smoke pass recorded                |
| SLOW-01                    | Slow-consumer forced disconnect not exercised (needs sustained load beyond free-plan caps)           | Server-side lagging disconnect remains a source observation               | Load scenario or recorded waiver           |
| C8 — Qualification         | Complete                                                                                             | Claude                                                                    | [C8 evidence](docs/verification.md)        | 2026-09-20 | MATRIX-01/STAGE-SMOKE-01/SLOW-01/PORT-01 open                    |
| C9 — Documentation         | Complete                                                                                             | Claude                                                                    | [C9 evidence](docs/verification.md)        | 2026-09-21 | Deployed-target example run folds into STAGE-SMOKE-01            |
| C10 — Release              | Not started                                                                                          | Unassigned                                                                | —                                          | —          | Depends on C8 and C9                                             |

## C0 — Contracts

**Dependencies:** None. **Requirements:** SDK-01–11, REL-01.

- [x] Record architecture revisions, discrepancies, runtime scope, lifecycle ownership, delivery limits, and recovery defaults.
- [x] Define opaque credentials and a request-object provider supporting initial and reconnect attempts.
- [x] Reconcile contract prose with the direct design: `openConnection()` awaits native open and initial requests may omit outage fields.
- [x] Record the revised C3 boundary without claiming cross-repository acknowledgement.

**Acceptance:** Existing decisions remain traceable and current connection semantics contain no contradiction.

## C1 — Foundation

**Dependencies:** C0. **Requirements:** SDK-09–11, LANG-01–03, SEC-01, REL-02.

- [x] Configure strict portable TypeScript, ESM/CommonJS artifacts, declarations, formatting, Vitest, and the exact npm identity.
- [x] Verify packed imports and codec execution across the recorded eight-runtime/three-engine matrix.
- [x] Remove or adapt obsolete adapter-specific test support after the direct C3 implementation is ready.
- [x] Re-run package, declaration, portability, and import-safety checks without exposing C3 internals publicly.

**Acceptance:** Foundation checks pass with the revised source and no obsolete transport layer remains.

## C2 — Codec

**Dependencies:** C1. **Requirements:** SDK-01, WIRE-01–05.

- [x] Implement bounded encoding and decoding with independent vectors, bigint fields, byte ownership, safe errors, and malformed-input checks.
- [x] Verify codec behavior across the recorded runtime/browser matrix.
- [x] Verify `MessageDecoder` integration through the native message callback, including binary, malformed, oversized, and unsupported data.

**Acceptance:** Codec vectors remain unchanged and connection integration reports decoder failures safely.

## C3 — Connection

**Dependencies:** C0–C2. **Requirements:** SDK-02–03, SDK-08, SDK-10; AUTH-03–05, LIFE-01, SEC-02, RES-04.

- [x] Keep `ConnectionHandler` responsible for validated configuration, fresh credential acquisition, safe URLs, native WebSocket creation, event wiring, and decoding.
- [x] Keep `ConnectionHandle` limited to sending bytes and closing its WebSocket. Enforce open-state and outbound size/buffering limits without a transport abstraction.
- [x] Make `openConnection()` resolve on `open`, and reject exactly once on invalid configuration, provider failure, cancellation, timeout, socket error, or close before open.
- [x] Apply one 15-second deadline across credentials and handshake. Abort provider work, close any socket, suppress late results, and remove listeners/timers on every terminal path.
- [x] Accept only binary WebSocket messages. Route protocol/native failures through fixed safe SDK errors and contain callback failures.
- [x] Invoke the request-object provider freshly per attempt. Initial requests omit outage fields; reconnect requests receive both from C7.
- [x] Test observable behavior with one small WebSocket double and local WS/WSS servers. Adapt useful runtime smoke tests; delete obsolete adapter tests and fixtures.

**Acceptance:** A connection acquires credentials, awaits native open, exchanges and decodes bounded binary messages, reports safe failures, and releases listeners/timers. The eight-runtime/three-browser smoke matrix passes separately from Celeris integration.

## C4 — Channel lifecycle and reconnect scheduler

**Dependencies:** C3. **Requirements:** SDK-02–03, SDK-07–08; LIFE-01–04, REC-01–04 (scheduler half), RES-01–04. Rescoped 2026-09-20: the connection-level reconnect scheduler moved here from C7 by owner decision.

- [x] Export the first public surface from the entrypoint: `createClient`, `Client.channel()`, `Channel` with `state`/`connect()`/`close()`/`events()`, `ChannelState`, `ChannelEventHandler` (named `on*` registration returning dispose functions — `onStateChange`/`onRecovery`/`onError` land here; `onNotice` lands with C6), `ChannelError`, `RecoveryEvent`, `Subscription` (type-only until C5/C6 return one), the credentials types `Credentials`/`CredentialRequest`/`CredentialProvider`, and the three error classes with `ConnectionErrorCode` (needed to type `onError` and rejections), exactly as fixed in [contracts](docs/contracts.md) including the DEV-01 handler deviation.
- [x] Reject concurrent connect with `OperationInProgress` (widened `ConnectionErrorCode`; no new error classes), permit explicit restart from failed, make explicit close terminal/idempotent, and apply the five-second close budget awaiting the native close event.
- [x] Plumb configurable `connectTimeoutMs` (default 15 000) into the C3 deadline via `ConnectionOptions.timeoutMs`; validate `presenceQueryTimeoutMs` as the plumbing point for C6.
- [x] Own one socket per channel and invalidate stale work with a connection generation plus state gating; writer serialization and delivery bounds arrive with C5 messaging.
- [x] Deliver state changes through `events()` — the channel's single stable `ChannelEventHandler` — dispatching synchronously in registration order with contained listener exceptions. Exactly the named `on*` methods; no generic `on(name, fn)`, string keys, once/prepend variants, or listener-count APIs.
- [x] Retry eligible disconnects up to ten times with full jitter from a 500 ms exponential base capped at 30 seconds; reset the budget after 60 seconds connected. Record the original outage once with injectable monotonic elapsed time plus a separate Unix `disconnectedAt`; failures do not reset them.
- [x] Before every retry request fresh credentials with `replayLookbackMs = ceil(elapsed outage) + 5000`, capped at `4294967295` (cap applied silently; the truncation diagnostic is deferred with `onDiagnostic`). Retry only `Transport`/`Timeout` failures; stop on explicit close, cancellation, deterministic configuration failures, protocol corruption, or exhaustion, suppressing stale results.
- [x] Emit `RecoveryEvent` (`retryIndex`, possible gaps, possible duplicates) through `events().onRecovery` after the `connected` state change; expose exhaustion through one `onError` plus the `failed` state.

**Tests** ([lifecycle](tests/channel/lifecycle.test.ts), [close](tests/channel/close.test.ts), [reconnect](tests/channel/reconnect.test.ts), [types](tests/declarations/channel-types.test.ts) — deterministic via injected clock/wall-clock/random seams and fake timers): all seven states with explicit restart from failed; concurrent `connect()` → `OperationInProgress`; initial failure/cancellation → `failed` with the promise rejection and no `onError`; `connectTimeoutMs` default and custom; dispatch order, idempotent dispose, dispose-mid-dispatch, duplicate registration, throwing-listener containment reported once via `onError`, `onError`-listener exceptions swallowed without re-entry; close idempotence with a memoized promise, five-second budget, attempt abort with late-credential suppression, retry-timer cleanup, stale socket events ignored; per-index jitter bounds `random() × min(30 s, 500 ms × 2^i)`, ten-retry exhaustion with one `onError`, sixty-second budget reset, preserved `disconnectedAt` with growing `ceil(elapsed)+5000` lookback and silent cap, wall-clock changes not affecting monotonic elapsed, fresh credentials per attempt, recovery event after `connected`, deterministic-failure and protocol-corruption stops, close mid-attempt, zero timers after every terminal path; import-guard still proves a side-effect-free entrypoint.

**Acceptance:** Exported surface asserted by declaration tests with no Zod inference in public `.d.ts` (checked against both built declaration files); packed-artifact consumers compile in all three module modes (with the platform library providing `AbortSignal`, mirroring the runtime capability floor) and observe exactly the six value exports; lifecycle, recovery, and resource ownership are deterministic; the only reconnect loop lives inside the channel state machine. Exporting the credentials types is the concrete ACK-01 artifact.

**Evidence / findings:** Implemented 2026-09-20; see [C4 evidence](docs/verification.md). Full `npm run check` passed locally with the default Node/Bun/Deno matrix and Chromium/Firefox/WebKit; the recorded eight-runtime matrix rerun remains for C8 qualification.

## C5 — Segments and messaging

**Status:** Complete. **Owner:** Claude. **Completed:** 2026-09-20.

**Dependencies:** C4. **Requirements:** SDK-04–05, SDK-08; PUB-01–04, SUB-01–04, RES-01–03. Reshaped 2026-09-20 for the SEG-01 segment model.

- [x] Export `Channel.segment(segmentId?)` returning the `Segment` proxy class (side-effect free; omitted → `"default"`; eager identifier validation) and the hand-written `Message` type — no Zod inference in public declarations. `Segment` holds only its id and the channel's delegate functions; listeners live on `Channel` in one shared per-segment set, and all connection state stays on `Channel`.
- [x] Implement `Segment.subscribe()` (join for messages via SUB; interest ref-counted channel-wide across all handler instances of that segment; returns `Subscription` with idempotent `cancel()`), `Segment.onMessage(listener)` (this segment's deliveries on this channel; dispose function returned; delivery requires membership plus read access, not merely a listener), and `Segment.publish(options)` (payload/`messageId?`/`signal?`; owned bytes; local WebSocket acceptance semantics; document the server-side auto-join effect).
- [x] Flush SUB for all active segment interests in registration order on every transition to connected (the hook C7 extends with presence ordering). `UNSUB` only when a segment's interest count reaches zero on a non-default segment while connected; never remote-unsubscribe the default segment; no UNSUB while disconnected — the segment is simply absent from the next flush.
- [x] Route inbound `MSG` by its segment id to that segment's handler listeners in registration order (exact demux — MSG is always segment-tagged). `SERVER_MSG` and `PRES_LIST_RESPONSE` stay silent until C6; a mid-connection `ERROR` frame is reported once via `events().onError` as a fixed safe error while the channel remains connected (the server never closes on `-Err`; denials arrive uncorrelated). Dispatch is synchronous per DEV-01; listener exceptions contained and reported via `onError`; the router itself never throws.
- [x] Reject offline publishes with `NotConnected`. Add `DeliveryUnknown` to `ConnectionErrorCode` and map a native mid-send failure to it. Enforce the 64-command writer bound with the observed-drain heuristic over native `bufferedAmount` (no drain event exists; documented approximation) alongside the exact 1 MiB byte bound. Never queue/resend uncertain publishes or infer acknowledgements.
- [x] Implement client-side idempotent delivery (REV-01): deduplicate deliveries by `messageId` within a bounded, non-configurable per-channel window (fixed-size id set, insertion-order eviction) before fanout; the window survives reconnect and clears on each explicit `connect()`. Lenient interim for a null id (owner decision): deliver with `messageId: ""` and skip dedup — no protocol violation until C8 verifies the updated server. `Message.messageId` stays non-null in the public type.

**Tests:** Publish resolves on local acceptance only with golden PUB bytes (default-segment resolution, `$-1` for omitted id); offline publish from every non-connected state → `NotConnected` with nothing sent or queued; pre-aborted signal → `Cancelled`; empty `messageId` and over-128 KiB commands → `ConfigurationError` before any write; empty and binary payload fidelity; 64-command heuristic (65th → `Backpressure` without send, observed-drain reset) and 1 MiB byte bound; native send throw → `DeliveryUnknown` with the channel still connected; subscribe-before-connect flushes SUB on connect in registration order; two handler instances of one segment share the interest count and each receives every delivery, cancelling one preserving the other; duplicate id within the window delivered once, ids beyond the 1024-entry window redelivered, window kept across reconnect and cleared on fresh `connect()`; null-id MSG delivered with `""` twice → twice; unsolicited server greeting SERVER_MSGs ignored; `-Err` → one fixed `onError` with the channel connected and later MSGs delivered; `UNSUB` rules incl. never for default; interest-write `Backpressure` → socket invalidated and `failed` (initial-connect flush failure rejects `connect()` without `onError` per the C4 rule; reconnect flush failure goes through `failTerminal`); throwing listener contained; dispose-mid-dispatch; ARRAY fan-out preserving arrival order; zero leaked timers after every terminal path.

**Acceptance:** Segment/publish exports match the contracts surface incl. SEG-01; no receipt or acknowledgement API exists anywhere and nothing gates on server prose; writer-bounds evidence recorded; dispatch order and containment deterministic; `Segment` proxies verifiably own no connection state. No server receipt or durable-delivery claim is made.

**Evidence / findings:** Implemented 2026-09-20; see [C5 evidence](docs/verification.md). Full `npm run check` passed with the default Node/Bun/Deno matrix plus Chromium/Firefox/WebKit; the eight-runtime rerun remains C8.

## C6 — Presence

**Status:** Complete. **Owner:** Claude. **Completed:** 2026-09-20.

**Dependencies:** C4 and C5. **Requirements:** SDK-05–06; SUB-02–03, PRES-01–03.

- [x] Implement `Segment.subscribePresence()` returning `Subscription` (PRES_SUB; presence interest ref-counted channel-wide per segment; document that the server force-joins the segment for messages and that PRES_UNSUB does not leave it — presence is a facet of a joined segment, per SEG-01), and add `onNotice` to `ChannelEventHandler` (raw SERVER_MSG bytes including presence prose and sub/unsub acks — untagged on the wire, channel-level only, never parsed into typed events).
- [x] Implement `Segment.presenceList(options)` returning `PresencePage`/`PresenceConnection` — serialized to one in-flight query per CHANNEL with validated response metadata and the configurable `presenceQueryTimeoutMs` (default 10 000).
- [x] Release a query cancelled before send; retire the connection after cancellation/timeout following send.

**Tests:** Presence interest counting per segment across handler instances and PRES_SUB/PRES_UNSUB emission; PRES_UNSUB emitted on last presence cancellation while message membership considerations stay per SEG-01; overlapping `presenceList` on ANY segment of one channel → `OperationInProgress`; `presenceQueryTimeoutMs` honored with 10 000 default; cancellation before send releases the slot while cancellation/timeout after send retires the connection; `page`/`perPage` bounds rejected, never clamped; out-of-range pages surface raw metadata with `from > to` and empty connections; unsolicited and late responses treated as protocol events; `onNotice` delivers raw bytes untyped with dispose-function removal; multiple connections per identity.

**Acceptance:** Presence exports match the contracts surface; exactly one in-flight query per channel is enforced; no typed join/leave event or subscription receipt exists anywhere in the API and nothing gates on prose; the signed-64 requirement is satisfied by construction — no response arithmetic exists (bigint equality matching, raw metadata pass-through; decoder bounds all numerics). Full recovery behavior remains C7/C8.

**Evidence / findings:** Implemented 2026-09-20; see [C6 evidence](docs/verification.md). Full `npm run check` passed with the default Node/Bun/Deno matrix plus Chromium/Firefox/WebKit; the eight-runtime rerun remains C8.

## C7 — Recovery restoration

**Status:** Complete. **Owner:** Claude. **Completed:** 2026-09-20.

**Dependencies:** C4–C6. **Requirements:** SDK-02, SDK-05, SDK-07; AUTH-04, SUB-01, REC-01–04 (restoration half). Rescoped 2026-09-20: the connection-level reconnect scheduler shipped in C4; the restoration mechanism (messages-then-presence flush on every connected transition, dedup window surviving reconnect) shipped with C5/C6 — C7 verifies it end-to-end and lands the remaining decisions.

- [x] Verify restoration of current intent over the C4 scheduler: message interests before presence interests, each in registration order, cancelled intent excluded, publishes never resent.
- [x] Verify the C5 idempotent-delivery window absorbs replay duplicates across reconnect (REV-01); duplicates beyond the bounded window remain possible and stay declared in the recovery event.
- [x] Map known server error names to codes: `PermissionDeniedError` → `Permission` with a fixed message; all other names stay the fixed Transport report; the channel remains connected. `Authentication` stays out of the union (DEV-02 — native WebSocket exposes no handshake status in any runtime and no authentication-named wire error exists); handshake failures keep bounded Transport retries, never an authorization label.
- [x] Record the `onDiagnostic` drop from v1: no diagnostics hook or DiagnosticEvent ships; the scheduler's silent replay-lookback cap remains documented behavior.

**Tests** ([restoration](tests/channel/restoration.test.ts) plus messaging additions): messages-then-presence reflush in registration order with cancelled message and presence intent excluded and only interest frames on the recovery socket (no publish resend); restoration frames sent before the `connected` state change and `RecoveryEvent`; replayed duplicate ids delivered once across reconnect while new ids flow; reconnect flush into a full writer → `failTerminal` with Backpressure `onError`, socket invalidated, zero timers; identical restoration on a second recovery cycle; `PermissionDeniedError` frame → one `Permission` error with fixed message and no server bytes, channel connected, deliveries continue; other error names stay Transport; the exact realized `ConnectionErrorCode` union is pinned by a declaration test.

**Acceptance:** Recovery restores current intent over the C4 scheduler with no retransmissions; every REC-01–04 restoration scenario has a deterministic test; `Permission` has a verifiable wire source and `Authentication` a recorded omission.

**Evidence / findings:** Implemented 2026-09-20; see [C7 evidence](docs/verification.md). Full `npm run check` passed with the default Node/Bun/Deno matrix plus Chromium/Firefox/WebKit; the eight-runtime rerun remains C8.

## C8 — Qualification

**Status:** Complete. **Owner:** Claude. **Completed:** 2026-09-20.

**Dependencies:** C2–C7. **Requirements:** SDK-01–09; WIRE-01–05, AUTH-03–05, LIFE-01–04, PUB-01–04, SUB-01–04, PRES-01–03, REC-01–04, RES-01–04, LANG-01–03, SEC-02–03.

- [x] Qualify against a real three-node Celeris stack (celeris-realtime e2e compose, host ports remapped via a scratch override to avoid the running dev stack): real signed credentials, permissions, presence, binary messaging, replay, reconnect, and cleanup through the gated `npm run test:celeris` suites in [tests/celeris](tests/celeris). Local evidence stays separate (default vitest config excludes the directory).
- [x] Verify REV-01 live (every delivered/replayed/cross-node message carried a server-assigned `msg_*` id) and retire the lenient null-id interim: a null id is now terminal `ProtocolError` at the delivery layer.
- [x] Resolve the live D-002 manifestation: the server batches error frames as the final array element (`*1\n-Err\n...`); the decoder now accepts a tail-position error (boundary-unambiguous) and still rejects errors anywhere else in an array. Without this, every permission denial killed the connection.
- [x] Observe live reconnect: node restart drove reconnecting → fresh reconnect credentials with growing capped lookback → connected with a recovery event → interests restored and cross-node delivery resumed (recorded in evidence).
- [x] Record the credential-freshness observation: the server accepts tokens up to 60 minutes old (documented intent is 60 seconds) — D-001 evidence, not relied upon.
- [x] Record explicit blockers for everything not run here (MATRIX-01, STAGE-SMOKE-01, SLOW-01, PORT-01) instead of weakening tests.

**Tests:** [authentication](tests/celeris/authentication.test.ts) (greetings via `onNotice`; invalid signature/unknown client/expired/future/restricted all rejected as Transport, never an authorization label; in-restriction accept; window observation), [messaging](tests/celeris/messaging.test.ts) (server-assigned ids, per-connection echo and `allow_echo`, segment demux and UNSUB effects, default auto-delivery, 100 KiB round-trip, read-only Permission denial arriving uncorrelated, write-only membership), [crossnode](tests/celeris/crossnode.test.ts) (fanout and presence consistency across nodes), [presence](tests/celeris/presence.test.ts) (raw join notices, live pagination incl. `from > to`, persistent membership after presence cancellation), [replay](tests/celeris/replay.test.ts) (identical ids on replay, dedup absorption of overlap) — 20 scenarios, all passing against the seeded stack on host Node with the default browser evidence carried by the local suites.

**Acceptance:** Every applicable scenario passes or has an explicit blocker row; platform and server findings remain visible (D-001 window, D-002 tail-position revision, REV-01 verification).

**Evidence / findings:** See [C8 evidence](docs/verification.md). Blockers: MATRIX-01, STAGE-SMOKE-01, SLOW-01, PORT-01 in the register below.

## C9 — Documentation

**Status:** Complete. **Owner:** Claude. **Completed:** 2026-09-21.

**Dependencies:** C5–C8. **Requirements:** SDK-09, SDK-11; LANG-01–03, REL-01, REL-03.

- [x] Provide packed-artifact examples using `@useceleris/client` for browsers and qualified server runtimes: [examples/node-quickstart.ts](examples/node-quickstart.ts) and [examples/browser-quickstart.ts](examples/browser-quickstart.ts), compiled against the installed tarball and executed against the C8-qualified local stack. [EXAMPLES.md](EXAMPLES.md) snippets are type-checked against the public surface on every `npm run check`.
- [x] Explain credential callbacks, readiness, ownership, cancellation, binary/bigint values, notices, replay, the bounded idempotent-delivery window, gaps/duplicates beyond it, and local publish acceptance — across the rewritten consumer [README](README.md) and EXAMPLES.md (new replay/gaps and bigint sections). Bigint serialization is documented as decimal strings.
- [x] Keep browser examples free of secrets and `@useceleris/server`: the browser quickstart fetches credentials from an endpoint and imports only the client package; the test's signer endpoint lives in the Node test process.

**Tests:** [examples-drift](tests/package/examples-drift.test.ts) (default run — every EXAMPLES.md `ts` block compiles strict against the public surface) and [examples](tests/celeris/examples.test.ts) (celeris config — the Node quickstart runs on host Node/Bun/Deno and the browser quickstart in Chromium/Firefox/WebKit, each asserting its success marker against the live stack).

**Acceptance:** Examples run on the claimed targets and describe only verified behavior; the EXAMPLES.md status banner is replaced by a verification note. Deployed-target example runs fold into STAGE-SMOKE-01.

**Evidence / findings:** See [C9 evidence](docs/verification.md). Writing the drift check surfaced two real snippet defects (a stray brace, and `catch (error)` narrowing that never compiled under strict) — both fixed, and the snippets now teach the `instanceof ConnectionError` pattern.

## C10 — Release

**Dependencies:** C8 and C9. **Requirements:** SDK-10–11; SEC-01–04, REL-01–03.

- [ ] Review dependencies, licenses, advisories, artifacts, declarations, exports, browser bundles, performance, and ownership.
- [ ] Verify npm scope access, provenance/SBOM, compatibility, changelog, security reporting, rollback guidance, and independent review.
- [ ] Resolve required protocol/security/platform gates before separately authorized publication.

**Acceptance:** Release evidence passes and publication receives separate authorization.

## Sequencing and blockers

The server SDK may continue independently through S3. S4 depends on the public client API introduced in C4. C4 owns the only reconnect scheduler; C6 requests recovery; C7 restores interests over it; C8 verifies combined behavior.

| ID      | Finding                                                                                                                                                                                            | Development handling                                                                                             | Stable-release gate                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| D-001   | Server token freshness differs from documented intent                                                                                                                                              | Always request fresh credentials                                                                                 | Service/security resolution and evidence                      |
| D-002   | Batched error boundaries are ambiguous; C8 observed the server batching errors as the final array element, and the decoder now accepts that tail-position case (rest-of-message content)           | Reject errors anywhere else in an array; never guess boundaries                                                  | Protocol disposition for the remaining ambiguous placements   |
| D-003   | Relayed identifiers can corrupt framing                                                                                                                                                            | Validate local identifiers; retain server concern                                                                | Service/security fix or verified resolution                   |
| PORT-01 | Support claims exceed branded-browser/cross-OS evidence                                                                                                                                            | Keep local evidence precise                                                                                      | C8 compatibility evidence                                     |
| ACK-01  | Request-object provider lacks server/spec acknowledgement                                                                                                                                          | C4 exports `Credentials`/`CredentialRequest`/`CredentialProvider` as the concrete artifact; coordinate before S4 | Cross-repository acknowledgement                              |
| REV-01  | Server always assigns MSG ids; client owns idempotent delivery. VERIFIED live in C8 (every delivered/replayed/cross-node message carried `msg_*`); strict null-id rejection shipped                | Dedup window before fanout; null id is terminal ProtocolError                                                    | Spec revision acknowledging always-present ids                |
| DEV-01  | Handler-based events deviate from specs conventions (async iterables) and remove the consumer delivery queue (owner decision 2026-09-20)                                                           | Implement C4–C7 with named `on*` dispatch per [contracts](docs/contracts.md); writer bounds unchanged            | Spec conventions revision acknowledging handler dispatch      |
| DEV-02  | `Authentication` category unrealizable: native WebSocket exposes no handshake status in any runtime and no authentication-named wire error exists (C7 record; `onDiagnostic` also dropped from v1) | Keep handshake failures as bounded Transport retries; `Permission` maps from known `-Err` names only             | Spec revision acknowledging the omission or a knowable source |

Preserve historical results in `docs/verification.md`. Previous adapter evidence remains historical; direct C3 evidence now satisfies the revised stage. C4–C10 remain unchecked.

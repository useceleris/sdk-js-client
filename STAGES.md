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
- The C4–C7 public surface is fixed in [contracts — Public API surface](docs/contracts.md), together with binding minimalism constraints (stateless `Client`, two subscription shapes, handler-based events with named `on*` methods per DEV-01, no error hierarchy, no extra configuration knobs, no generic event framework). Consumer usage is mirrored in [EXAMPLES.md](EXAMPLES.md); both change in the same commit as any surface change. Every new public identifier must trace to a specification requirement or a recorded local decision.

Status values: **Not started**, **In progress**, **Blocked**, **Complete**. Completion requires checked tasks, passing evidence, reviewed files, and no unresolved blocker that invalidates the acceptance gate.

## Status

| Stage                      | Status      | Owner      | Evidence                                   | Completed  | Blockers                                                         |
| -------------------------- | ----------- | ---------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------- |
| C0 — Contracts             | Complete    | Codex      | [C0–C2 evidence](docs/verification.md)     | 2026-09-06 | Cross-repository acknowledgement pending                         |
| C1 — Foundation            | Complete    | Codex      | [C0–C2 evidence](docs/verification.md)     | 2026-09-06 | Cross-OS/branded-browser evidence remains C8                     |
| C2 — Codec                 | Complete    | Codex      | [Codec evidence](docs/verification.md)     | 2026-09-06 | D-002 and D-003 remain open                                      |
| C3 — Connection            | Complete    | Codex      | [Direct C3 evidence](docs/verification.md) | 2026-09-07 | C8 Celeris/platform qualification remains                        |
| C4 — Lifecycle + reconnect | Complete    | Claude     | [C4 evidence](docs/verification.md)        | 2026-09-20 | Eight-runtime matrix rerun remains C8; ACK-01/REV-01/DEV-01 open |
| C5 — Messaging             | Not started | Unassigned | —                                          | —          | Depends on C4                                                    |
| C6 — Presence              | Not started | Unassigned | —                                          | —          | Depends on C4 and C5                                             |
| C7 — Recovery restoration  | Not started | Unassigned | —                                          | —          | Depends on C4–C6                                                 |
| C8 — Qualification         | Not started | Unassigned | —                                          | —          | Depends on C2–C7                                                 |
| C9 — Documentation         | Not started | Unassigned | —                                          | —          | Final examples depend on C8                                      |
| C10 — Release              | Not started | Unassigned | —                                          | —          | Depends on C8 and C9                                             |

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

## C5 — Messaging

**Dependencies:** C4. **Requirements:** SDK-04–05, SDK-08; PUB-01–04, SUB-01–04, RES-01–03.

- [ ] Export `Channel.publish(options)` (payload, optional `segmentId`/`messageId`/`signal`) with owned bytes and local WebSocket acceptance semantics, and `Channel.subscribe(segmentId?)` returning `MessageSubscription` (`onMessage` listeners returning dispose functions, idempotent `cancel()`) with the hand-written `Message` type — no Zod inference in public declarations.
- [ ] Support multiple concurrent subscriptions to the same segment on one channel through reference counting; each receives every delivery independently. Preserve default-segment rules. Dispatch is synchronous per DEV-01 — no consumer-side delivery queue; listener exceptions contained and reported via `onError`.
- [ ] Reject offline sends with `NotConnected`. Add `DeliveryUnknown` to `ConnectionErrorCode` for observably interrupted post-submission writes. Never queue/resend uncertain publishes or infer acknowledgements.
- [ ] Implement client-side idempotent delivery (REV-01): the server now always assigns MSG ids, and the client deduplicates deliveries by `messageId` within a bounded per-channel window before fanout to listeners. A MSG without an id is a protocol violation once REV-01 is verified. `Message.messageId` is non-null in the public type. The window is a fixed-size id set and is not configurable.

**Tests:** Publish resolves on local acceptance only; duplicate `messageId` within the dedup window delivered exactly once while ids beyond the window pass through; MSG without id → `ProtocolError`; offline publish → `NotConnected` without queueing; over-128 KiB encoded command rejected before any write; writer bounds (64 commands / 1 MiB including native `bufferedAmount`) → `Backpressure` without enqueueing; interrupted post-submission write → `DeliveryUnknown` where observable; empty `messageId` rejected while omitted encodes null; `UNSUB` sent only when message and presence counts both reach zero on a non-default segment, default segment never remote-unsubscribed; two subscriptions to the same segment each receive every delivery and cancelling one preserves the other's interest; a listener disposed mid-dispatch receives no further deliveries; a throwing `onMessage` listener is contained, reported via `onError`, and does not block other listeners or corrupt state; concurrent sends, multi-subscriber fanout, and binary payload fidelity including empty bytes.

**Acceptance:** Publish/subscribe exports match the contracts surface; no receipt or acknowledgement API exists anywhere; writer-bounds evidence is recorded; dispatch order and containment are deterministic. Messaging is bounded and ownership explicit; no server receipt or durable-delivery claim is made.

## C6 — Presence

**Dependencies:** C4 and C5. **Requirements:** SDK-05–06; SUB-02–03, PRES-01–03.

- [ ] Export `Channel.subscribePresence(segmentId?)` returning `Subscription` (interest only — no deliveries), add `onNotice` to `ChannelEventHandler` (raw SERVER_MSG bytes including presence prose, never parsed into typed events), and `Channel.presenceList(options)` returning `PresencePage`/`PresenceConnection` — independent presence ownership with correct PRES_UNSUB/UNSUB behavior.
- [ ] Serialize one presence page query per channel with validated response metadata and the configurable `presenceQueryTimeoutMs` (default 10 000).
- [ ] Release a query cancelled before send; retire the connection after cancellation/timeout following send.

**Tests:** Presence interest counting and PRES_SUB/PRES_UNSUB emission; overlapping `presenceList` → `OperationInProgress`; `presenceQueryTimeoutMs` honored with 10 000 default; cancellation before send releases the slot while cancellation/timeout after send retires the connection; `page`/`perPage` bounds rejected, never clamped; out-of-range pages surface raw metadata with `from > to` and empty connections; unsolicited and late responses treated as protocol events; `onNotice` delivers raw bytes untyped with dispose-function removal; multiple connections per identity.

**Acceptance:** Presence exports match the contracts surface; exactly one in-flight query is enforced; no typed join/leave event or subscription receipt exists anywhere in the API; response arithmetic is validated against signed-64 overflow. Full recovery behavior remains C7/C8.

## C7 — Recovery restoration

**Dependencies:** C4–C6. **Requirements:** SDK-02, SDK-05, SDK-07; AUTH-04, SUB-01, REC-01–04 (restoration half). Rescoped 2026-09-20: the connection-level reconnect scheduler — retries, jitter, budget reset, outage measurement, capped replay lookback, `RecoveryEvent`, exhaustion — shipped in C4.

- [ ] Restore message interests before presence interests in registration order over the C4 scheduler. Exclude cancelled intent and never resend publishes.
- [ ] Verify the C5 idempotent-delivery window absorbs replay duplicates across reconnect (REV-01); duplicates beyond the bounded window remain possible and stay declared in the recovery event.
- [ ] Add `Authentication`/`Permission` to `ConnectionErrorCode` only for known handshake statuses; browser-hidden status keeps bounded retries without an authorization label.
- [ ] Land the deferred `onDiagnostic` decision, including the lookback-truncation diagnostic the C4 scheduler applies silently today.

**Tests:** Restoration order messages-then-presence in registration order with cancelled intent excluded; no publish resend; replayed duplicates within the dedup window delivered once across a reconnect; interest restoration under a full writer invalidates the socket per contracts; known-status mapping to `Authentication`/`Permission` without retry.

**Acceptance:** Recovery restores current intent over the C4 scheduler with no retransmissions; every REC-01–04 restoration scenario has a deterministic test.

## C8 — Qualification

**Dependencies:** C2–C7. **Requirements:** SDK-01–09; WIRE-01–05, AUTH-03–05, LIFE-01–04, PUB-01–04, SUB-01–04, PRES-01–03, REC-01–04, RES-01–04, LANG-01–03, SEC-02–03.

- [ ] Run behavior tests on supported Node.js, Bun, Deno, Chrome/Edge, Firefox, and Safari with exact versions/revisions.
- [ ] Test real Celeris credentials, permissions, presence, binary messaging, replay, reconnect, regional behavior, slow consumers, malformed input, and cleanup.
- [ ] Keep local WebSocket evidence separate from Celeris acceptance; record failures instead of weakening tests.

**Acceptance:** Every applicable scenario passes or has an explicit blocker; platform and server findings remain visible.

## C9 — Documentation

**Dependencies:** C5–C8. **Requirements:** SDK-09, SDK-11; LANG-01–03, REL-01, REL-03.

- [ ] Provide packed-artifact examples using `@useceleris/client` for browsers and qualified server runtimes; promote [EXAMPLES.md](EXAMPLES.md) snippets to verified packed-artifact examples.
- [ ] Explain credential callbacks, readiness, ownership, cancellation, binary/bigint values, notices, replay, the bounded idempotent-delivery window, gaps/duplicates beyond it, and local publish acceptance. Document bigint diagnostic serialization as decimal strings.
- [ ] Keep browser examples free of secrets and `@useceleris/server`.

**Tests:** Every EXAMPLES.md snippet compiles and executes against packed artifacts on qualified runtimes and browsers.

**Acceptance:** Examples run on claimed targets and describe only verified behavior. The EXAMPLES.md status banner is removed only when the API it shows is shipped and green.

## C10 — Release

**Dependencies:** C8 and C9. **Requirements:** SDK-10–11; SEC-01–04, REL-01–03.

- [ ] Review dependencies, licenses, advisories, artifacts, declarations, exports, browser bundles, performance, and ownership.
- [ ] Verify npm scope access, provenance/SBOM, compatibility, changelog, security reporting, rollback guidance, and independent review.
- [ ] Resolve required protocol/security/platform gates before separately authorized publication.

**Acceptance:** Release evidence passes and publication receives separate authorization.

## Sequencing and blockers

The server SDK may continue independently through S3. S4 depends on the public client API introduced in C4. C4 owns the only reconnect scheduler; C6 requests recovery; C7 restores interests over it; C8 verifies combined behavior.

| ID      | Finding                                                                                                                                                   | Development handling                                                                                             | Stable-release gate                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| D-001   | Server token freshness differs from documented intent                                                                                                     | Always request fresh credentials                                                                                 | Service/security resolution and evidence                   |
| D-002   | Batched error boundaries are ambiguous                                                                                                                    | Preserve bounded fail-safe decoding                                                                              | Protocol disposition and conformance evidence              |
| D-003   | Relayed identifiers can corrupt framing                                                                                                                   | Validate local identifiers; retain server concern                                                                | Service/security fix or verified resolution                |
| PORT-01 | Support claims exceed branded-browser/cross-OS evidence                                                                                                   | Keep local evidence precise                                                                                      | C8 compatibility evidence                                  |
| ACK-01  | Request-object provider lacks server/spec acknowledgement                                                                                                 | C4 exports `Credentials`/`CredentialRequest`/`CredentialProvider` as the concrete artifact; coordinate before S4 | Cross-repository acknowledgement                           |
| REV-01  | Celeris update: server always assigns MSG ids; client owns idempotent delivery (user-reported 2026-09-20; specs still say optional id, no implicit dedup) | Design C5 dedup window and non-null public `messageId`; keep codec tolerant until verified                       | Spec revision + C8 verification against the updated server |
| DEV-01  | Handler-based events deviate from specs conventions (async iterables) and remove the consumer delivery queue (owner decision 2026-09-20)                  | Implement C4–C7 with named `on*` dispatch per [contracts](docs/contracts.md); writer bounds unchanged            | Spec conventions revision acknowledging handler dispatch   |

Preserve historical results in `docs/verification.md`. Previous adapter evidence remains historical; direct C3 evidence now satisfies the revised stage. C4–C10 remain unchecked.

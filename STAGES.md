# @useceleris/client implementation stages

Created: 2026-09-06. This is an implementation tracker, not a report of implemented functionality. Repository baseline: no SDK implementation present when this tracker was created.

## Scope and source of truth

Package: **`@useceleris/client`**. Own realtime messaging, presence, transport, codec, channel lifecycle and recovery. Never depend on the server package or include signing facilities.

Use the [PRD](../../celeris-sdk-specs/SDK_PRD.md), [shared contract](../../celeris-sdk-specs/docs/shared-contract.md), [wire protocol](../../celeris-sdk-specs/docs/protocol.md), [JavaScript conventions](../../celeris-sdk-specs/docs/conventions/javascript.md), [conformance scenarios](../../celeris-sdk-specs/docs/conformance.md), [security policy](../../celeris-sdk-specs/docs/security-dependencies.md), [maintenance policy](../../celeris-sdk-specs/docs/maintenance.md), and [discrepancy register](../../celeris-sdk-specs/docs/discrepancies.md). Coordinate with the [other package tracker](../sdk-js-server/STAGES.md).

The user's approved runtime scope supersedes the existing specifications' Node-only server wording: portable JavaScript, with Node.js, Bun and Deno initially qualified and Chrome/Edge, Firefox and Safari for the client. This tracker does not claim those targets already pass. Keep standard APIs and Uint8Array/AbortSignal/URL/public types runtime-neutral. Signing is synchronous and belongs to the separate trusted-server package; realtime uses WebSocket. Require capabilities only where needed; expose explicit narrow adapters for missing capabilities rather than silently loading Node-specific fallbacks. Portable signing still belongs exclusively in trusted servers.

The initial pass created this tracker only. The approved C0–C2 implementation now supplies contracts, foundation and an internal codec; see [verification](docs/verification.md). Later stages do not authorize backend edits or package publication. Account/billing APIs, durable offline queues, automatic uncertain resend, global ordering and invented acknowledgements remain out of scope.

## How to track progress

- Status values: **Not started**, **In progress**, **Blocked**, **Complete**. Assign an owner when a stage starts. Keep all tasks unchecked until implemented and verified.
- Complete requires checked tasks, acceptance evidence, relevant tests and reviewed findings; listing tests or writing this document is not completion. If required evidence cannot pass, mark Blocked and link the specific finding.
- Each evidence entry records command/check, result, package/spec/server revision, runtime/OS, date and sanitized artifact link. Record source inspection separately from executed tests.
- Scenario ranges below refer to existing conformance IDs; include each applicable scenario. Mark inherited or inapplicable cases explicitly with justification, never silently skip them.
- Update the stage table and its detail together; retain completed-stage evidence when later changes reopen work. Check off cross-repository prerequisites only against linked revision/results.

## Stage status

| Stage                          | Status      | Owner      | Evidence                        | Completed  | Blockers                                  |
| ------------------------------ | ----------- | ---------- | ------------------------------- | ---------- | ----------------------------------------- |
| C0 — Contracts                 | Complete    | Codex      | [Results](docs/verification.md) | 2026-09-06 | Release/acknowledgement gaps remain below |
| C1 — Foundation                | Complete    | Codex      | [Results](docs/verification.md) | 2026-09-06 | Release/acknowledgement gaps remain below |
| C2 — Codec                     | Complete    | Codex      | [Results](docs/verification.md) | 2026-09-06 | Release/acknowledgement gaps remain below |
| C3 — Transport and credentials | Not started | Unassigned | None yet                        | —          | See dependencies and blocker register     |
| C4 — Lifecycle                 | Not started | Unassigned | None yet                        | —          | See dependencies and blocker register     |
| C5 — Messaging                 | Not started | Unassigned | None yet                        | —          | See dependencies and blocker register     |
| C6 — Presence                  | Not started | Unassigned | None yet                        | —          | See dependencies and blocker register     |
| C7 — Recovery                  | Not started | Unassigned | None yet                        | —          | See dependencies and blocker register     |
| C8 — Qualification             | Not started | Unassigned | None yet                        | —          | See dependencies and blocker register     |
| C9 — Documentation             | Not started | Unassigned | None yet                        | —          | See dependencies and blocker register     |
| C10 — Release                  | Not started | Unassigned | None yet                        | —          | See dependencies and blocker register     |

## C0 — Contracts

**Dependencies:** None.

**Coverage:** SDK-01–11; REL-01.

- [x] Record spec and server commit hashes, dirty state, unresolved findings, and the reviewed source baseline. Resolve contradictory requirements before implementing affected behavior.
- [x] Record client-side compatibility review against S0/current synchronous signer, including the runtime-neutral provider, cancellation, opaque payload/signature output and versioned integration boundary. Server-owner acknowledgement remains pending separately.
- [x] Review lifecycle and operation completion, separate message/presence ownership, queue overflow signaling, restoration ordering, and cancellation when the writer is full. Record decisions rather than leaving different implementations to guess.
- [x] Record the user-approved portability extension: Node.js, Bun and Deno, plus browsers for the client. Existing Node-only signing language in the specs is superseded for this work; request corresponding spec maintenance separately.

**Acceptance:** Reviewed contract decisions and scenario mappings exist; unresolved platform gates are separated from implementable client work.

**Evidence / findings:** [C0–C2 verification](docs/verification.md), 2026-09-06. Source review and executed package/codec evidence are distinguished. D-001–D-003, server-owner acknowledgement and C8 cross-OS/branded-browser qualification remain open.

## C1 — Foundation

**Dependencies:** C0.

**Coverage:** SDK-09–11; LANG-01–03, SEC-01, REL-02.

- [x] Configure strict TypeScript, ES2022 output, ESM-first and CommonJS exports and portable declarations under the exact npm name @useceleris/client. No import-time sockets, timers or environment reads.
- [x] Create reproducible build, formatting, typechecking and test workflows. Record Node/Bun/Deno floors and refreshed current versions, with actual eight-runtime execution. Automate current Chromium/Firefox/WebKit; do not infer branded-browser floors. CI runs current Node/Bun/Deno and these engines in one Linux test job; full version and cross-OS qualification is recorded separately.
- [x] Document narrow injectable transport/clock/randomness boundaries for later implementation. Keep node: imports, Buffer, process and Node-only types out of portable source, declarations and required runtime dependencies.
- [x] Compile and import packed artifacts as @useceleris/client from ESM/CommonJS consumers and supported runtime/browser fixtures; package installation must not depend on repository-relative paths.

**Acceptance:** Clean builds and consumer/type checks pass; capability/runtime matrix and dependency inventory are recorded.

**Evidence / findings:** [C0–C2 verification](docs/verification.md), 2026-09-06. Source review and executed package/codec evidence are distinguished. D-001–D-003, server-owner acknowledgement and C8 cross-OS/branded-browser qualification remain open.

## C2 — Codec

**Dependencies:** C0, C1.

**Coverage:** SDK-01; WIRE-01–05.

- [x] Implement protocol command/response layouts internally (no public exports), bulk binary lengths, null versus empty values, nested/empty arrays and exact signed-64 bigint handling.
- [x] Implement defensive byte, nesting and fragment bounds; reject malformed/trailing data and CR/LF identifiers. Handle standalone errors by their message boundary and fail safely for ambiguous batched errors.
- [x] Create independently derived versioned vectors with synthetic data, overflow/truncation/malicious-length cases, byte ownership tests and bounded fuzzing. Do not import production server codecs or depend on @useceleris/server.
- [x] Encode one client command per WebSocket message; keep internal node commands out of the public API and include encoded overhead in limits.

**Acceptance:** Golden and negative vectors pass identically across qualified JavaScript engines; unresolved D-002/D-003 remain visible.

**Evidence / findings:** [C0–C2 verification](docs/verification.md), 2026-09-06. Source review and executed package/codec evidence are distinguished. D-001–D-003, server-owner acknowledgement and C8 cross-OS/branded-browser qualification remain open.

## C3 — Transport and credentials

**Dependencies:** C1, C2.

**Coverage:** SDK-02, SDK-03, SDK-08, SDK-10; AUTH-03–05, LIFE-01, SEC-02, RES-04.

- [ ] Implement the native WebSocket adapter, binary response handling and ordered conversion. Record browser/runtime limitations around receive buffering, ping and handshake status.
- [ ] Build validated wss URLs and encode opaque signed query values exactly once. Restrict explicit development ws to the approved loopback policy and never log credential URLs.
- [ ] Implement the asynchronous credential provider with channel reference and AbortSignal, fresh invocation per attempt, the shared handshake deadline and stale-result invalidation.
- [ ] Test unavailable capabilities, provider failure, aborted acquisition, transport failure, TLS behavior and safe diagnostics through fake transports and real runtime smoke tests.

**Acceptance:** One channel can establish and terminate a transport with supplied synthetic credentials; browser code has no signing dependency.

**Evidence / findings:** None yet; add results and blocker IDs here.

## C4 — Lifecycle

**Dependencies:** C3.

**Coverage:** SDK-03, SDK-08; LIFE-01–04, RES-01–04.

- [ ] Implement idle/connecting/connected/reconnecting/failed/closing/closed transitions, duplicate-connect rejection, explicit failed restart and terminal explicit close.
- [ ] Own one socket per channel handle; serialize writes, preserve connection generations and suppress late callbacks. Bound writer and channel-wide delivery queues including fanout copies.
- [ ] Implement graceful close budget, forced cleanup, idempotent disposal and cancellation of pending work. Make overflow/final errors observable even when the normal delivery queue is full.
- [ ] Test races, callback reentrancy/failure, repeated teardown, operation settlement and memory/timer/listener leaks with injected time and transport.

**Acceptance:** Deterministic lifecycle and resource tests pass; no implicit reconnect implementation is duplicated outside the channel state machine.

**Evidence / findings:** None yet; add results and blocker IDs here.

## C5 — Messaging

**Dependencies:** C2, C4.

**Coverage:** SDK-04, SDK-05, SDK-08; PUB-01–04, SUB-01–04, RES-01–03.

- [ ] Implement Uint8Array publishing with owned retained data, optional nonempty message IDs and complete-command size validation. Reject offline sends and bound admitted work.
- [ ] Expose local transport acceptance only; distinguish uncertain interrupted delivery where observable and never automatically resend or infer receipts from echo.
- [ ] Implement bounded message iterables, segment reference counts and local interest independent of membership. Preserve default-segment and PUB membership behavior.
- [ ] Test subscriptions/cancellation while disconnected or saturated, concurrent sends, multiple listeners, empty/binary payloads and no invented acknowledged readiness.

**Acceptance:** Messaging scenarios pass with explicit completion/ownership behavior and no offline queue or server receipt claim.

**Evidence / findings:** None yet; add results and blocker IDs here.

## C6 — Presence

**Dependencies:** C4, C5.

**Coverage:** SDK-05, SDK-06; SUB-02–03, PRES-01–03.

- [ ] Implement separate presence reference counts, PRES_UNSUB for last presence interest and UNSUB only when both interest types reach zero outside default.
- [ ] Expose channel-wide raw notices without parsing prose into typed presence events. Return structured paginated snapshots and preserve actual metadata.
- [ ] Serialize one page query per channel; validate page bounds and matching metadata. A sent-query timeout/cancellation invalidates the socket and requests recovery; pre-write cancellation only releases the slot.
- [ ] Test late/unsolicited replies, overlapping queries, permission failures, timeouts and multiple connections per identity. Use the recovery boundary initially; complete end-to-end recovery with C7.

**Acceptance:** Presence tests pass against fake transport; full query-timeout recovery qualification is explicitly dependent on C7/C8.

**Evidence / findings:** None yet; add results and blocker IDs here.

## C7 — Recovery

**Dependencies:** C4, C5, C6.

**Coverage:** SDK-02, SDK-05, SDK-07; AUTH-04, SUB-01, REC-01–04.

- [ ] Implement shared finite full-jitter retry defaults, retry classification, stable-connection reset and explicit exhaustion; obtain fresh credentials every attempt.
- [ ] Restore message then presence intent in stable order; do not restore canceled intent or resend uncertain publishes. Integrate forced recovery from C6.
- [ ] Expose gaps/duplicates and local-arrival replay semantics without a durable cursor or global ordering promise. Handle browser resume and hidden handshake status honestly.
- [ ] Test injected timing/randomness, denied credentials, terminal corruption, repeated loss, explicit close during recovery and late credential completions.

**Acceptance:** Recovery and presence-timeout lifecycle tests pass without leaks or unintended retransmission.

**Evidence / findings:** None yet; add results and blocker IDs here.

## C8 — Qualification

**Dependencies:** C2–C7.

**Coverage:** SDK-01–09; WIRE-01–05, AUTH-03–05, LIFE-01–04, PUB-01–04, SUB-01–04, PRES-01–03, REC-01–04, RES-01–04, LANG-01–03, SEC-02–03.

- [ ] Run common vectors and behavioral tests in Node.js, Bun, Deno and Chrome/Edge, Firefox, Safari, recording exact runtime/OS/package/spec/server revisions.
- [ ] Use independently signed synthetic credentials and black-box Celeris tests for permissions, presence, binary messaging and same-node/same-region/cross-region replay.
- [ ] Exercise interrupted nodes/connections, slow consumers, malformed peer inputs, frame aggregation, queue saturation and background/resume behavior. Use bounded polling and reliable cleanup.
- [ ] Retain real server failures as findings rather than weakening tests or changing backend code. Attach results and justified platform-specific applicability for every mapped scenario.

**Acceptance:** Every applicable scenario has passing evidence or an explicit blocker; stage stays Blocked if its required acceptance depends on unresolved platform behavior.

**Evidence / findings:** None yet; add results and blocker IDs here.

## C9 — Documentation

**Dependencies:** C5–C7; final example verification requires C8.

**Coverage:** SDK-09, SDK-11; LANG-01–03, REL-01, REL-03.

- [ ] Write install/import examples using @useceleris/client for browsers and each qualified server runtime, with application-provided scoped credentials.
- [ ] Document ownership, binary/bigint values, cancellation, raw notices, resource limits, capability adapters and local-only publish completion.
- [ ] Run examples from packed artifacts, not source aliases. Keep credentials synthetic and omit @useceleris/server from browser dependencies.
- [ ] Document known limitations, runtime support, migration and troubleshooting without suggesting durable replay or guaranteed delivery.

**Acceptance:** Examples execute successfully on claimed targets and public documentation matches tested behavior.

**Evidence / findings:** None yet; add results and blocker IDs here.

## C10 — Release

**Dependencies:** C8, C9; applicable platform gates resolved.

**Coverage:** SDK-10, SDK-11; SEC-01–04, REL-01–03.

- [ ] Review exact dependencies, licenses, advisories, transitive portability, packed contents and browser bundles; verify no signing or Node-only leakage.
- [ ] Measure codec/startup/memory/bundle/soak workloads per runtime; establish budgets and explain regressions under the shared performance policy.
- [ ] Verify @useceleris/client scope permissions, registry settings, ESM/CommonJS exports, declarations, provenance/SBOM, compatibility table, changelog, named owners and security reporting.
- [ ] Obtain independent release review and authorized publication; run post-publish smoke checks and record rollback/yank/deprecation procedures. A tracking file does not itself authorize publication.

**Acceptance:** Release checklist and independent evidence pass, platform security gates are resolved, and any publishing step has separate authorization.

**Evidence / findings:** None yet; add results and blocker IDs here.

## Cross-repository sequencing

C0 records compatibility with the current S0/synchronous signer contract. Server-owner acknowledgement remains pending; no other repository was edited. S1–S3 can proceed while the client is being built. S4 needs C3/C4; S6 needs C8. Client codec, transport and integration tests use independently generated synthetic credentials rather than requiring @useceleris/server. The dependency direction is server → client only. Local packed prerelease artifacts can support development without prematurely publishing either package; stable server integration depends on a qualified installable client release.

C6 defines and tests the presence recovery request boundary; C7 implements the recovery scheduler, and C8 verifies the combined path. Documentation can be drafted earlier, but example acceptance waits for the implementation it demonstrates. A completed client package is not evidence that all six language SDKs have launched.

## Blocker register

Initial entries describe known dependencies/findings; they do not imply implementation tests have already failed. Add a named owner, resolution revision and test evidence as work proceeds.

| ID      | Finding / dependency                                                  | Development impact                                                                                                    | Stable release gate                                                                       | Owner / resolution evidence             |
| ------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| D-001   | Server accepts credentials older than the documented freshness window | Implement fresh signing and honest expiry behavior; never assume SDK freshness fixes server acceptance                | Recorded service/security resolution and boundary tests required                          | Service/security owner unassigned; open |
| D-002   | Batched error boundaries are ambiguous                                | Build bounded fail-safe parsing and negative fixtures; no guessed error splitting                                     | Protocol-owner disposition and compatible conformance evidence required                   | Protocol owner unassigned; open         |
| D-003   | Relayed identifiers can corrupt framing                               | Reject unsafe local identifiers; malicious peers remain a server concern                                              | Service/security fix or verified resolution with malicious-peer tests required            | Service/security owner unassigned; open |
| PORT-01 | Older specs describe Node-only signing; new scope includes Bun/Deno   | Record superseding scope and concrete capability/runtime matrix in stage 0/1; keep source docs unchanged in this pass | Reconcile spec support claims and attach real runtime qualification before stable release | SDK contract owner unassigned; open     |
| DEP-01  | Public realtime client is not implemented/published yet               | S4/S6 wait for linked client milestones; client development is independent                                            | Stable server dependency must be installable and qualified                                | Package owners unassigned; open         |

## Completion and maintenance

- [ ] All stages have owners, checked implementation tasks and verified acceptance evidence.
- [ ] Applicable conformance IDs and supported runtime versions are covered; inherited evidence is pinned to tested package versions.
- [ ] No unresolved required security/protocol release gate or unsupported delivery promise remains.
- [ ] Exact npm names, dependency direction, declarations, exports and examples agree.
- [ ] Package support, security response and future release maintenance have accountable owners.

Recheck the source discrepancy register before marking any blocker resolved. Historical baseline: the initial tracker had no completed implementation or runtime-test claims. Current C0–C2 evidence is linked above; C3–C10 and this overall release checklist remain unchecked.

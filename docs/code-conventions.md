# Code conventions

Apply the reviewed server SDK lessons selectively. Keep code easy to read and remove unnecessary behavior rather than compressing it into dense expressions.

Use descriptive domain names such as `encodeClientCommand`, `decodeServerMessage`, `segmentId` and `parsedCommand`. Small modules separate command validation, byte encoding, byte parsing, output types and safe errors. Do not introduce generic validation frameworks, speculative adapters, placeholder methods or custom build scripts.

Authored code and fixtures are TypeScript with extensionless local imports. Source/tooling use ESNext/Bundler resolution. Generated ESM/CommonJS and declarations retain required extensions; installed consumers verify NodeNext separately. Production compilation excludes Node ambient types.

Zod validates outbound input once and strips unknown object fields. Derive command types from the schemas. Binary framing checks operate directly on bounded bytes; decoding output types are plain readonly TypeScript properties. Readonly properties do not make Uint8Array elements immutable. Each encoded result and decoded payload owns its storage; callers must not concurrently mutate shared buffers during an operation.

Synchronous codec functions return synchronously and have no signals, timers or promise machinery. Use supported APIs, fixed Configuration/ProtocolError messages and no raw causes. Never attach credentials, input values or raw frames to exceptions.

Group tests by behavior. Fixed vectors describe expected protocol bytes/objects independently of codec helpers. Runtime fixtures invoke the real package or internal codec and report observations; Vitest owns assertions. Keep installed-package evidence distinct from bundled internal-code tests. Test tools and standard runtime primitives only as setup, not as independent subjects.

Before completion review every changed file, including all fixtures and helpers, for duplicated schemas, redundant parsing/copies, deprecated calls, unnecessary wrappers, dense setup and missing cleanup. Preserve necessary bounds and readability. Record the reviewed files and actual removals in verification evidence.

Protocol errors retain code `ProtocolError` and readonly `field`/`offset` properties. Use fixed descriptive reasons and code-authored field names. Offsets are zero-based field/header starts including the marker where present; trailing-data errors identify the first trailing byte. Missing fields identify the expected start, and top-level input/size failures use offset zero. Never interpolate received values or attach native causes. Parse numeric headers with BigInt inside try/catch, then enforce decimal-only spelling and signed-64 bounds. Use simple invalid-character checks instead of lookahead patterns.

Header reading advances byte by byte until LF, trimming one preceding CR for CRLF. Enforce the header limit while scanning. Bulk payloads are located by declared byte length and direct terminator checks, without scanning their contents. Keep internal views and copy payloads on return. Saved diagnostic positions use `fieldStartOffset`, distinct from the advancing cursor. Command dispatch delegates to focused peer-message, server-notice and presence-response readers.

Encoding validates once before creating per-call encoder state. An exhaustive command switch delegates complete layouts to focused handlers; commands with identical layouts share a handler. Derive handler types from the schema output. Add a schema variant, switch case, layout handler where necessary and independent golden vectors when introducing a command. Keep byte limits and final assembly shared; do not introduce registries or assume every command has a segment.

C3 uses native WebSocket directly. `openConnection()` owns credential acquisition, opening, events and decoding; `ConnectionHandle` owns send and close. Promise resolution is the only open signal. Keep attempt settlement local and explicit; do not add an adapter, factory, registry, diagnostics framework or redundant callback.

## Breathing room

Leave one blank line after a block closes — `if`, `for`, `while`, `switch`, `try` — before the next statement. The only exceptions are a closing brace followed directly by `else`, `catch`, `finally` or another closing brace. Also leave one blank line between a declaration and a multi-line block that uses it.

```ts
let message: ServerMessage;

try {
  message = decode(bytes);
} catch {
  return;
}

deliver(message);
```

Prettier keeps a single blank line but never adds one, so nothing enforces this automatically; it is checked in review. Code packed straight against the block before it is harder to read, and is treated as a defect.

## Constants

Every fixed value lives in `src/constants.ts` — limits, bounds, timeouts, defaults, and shared text encoder/decoder instances — named in `SCREAMING_SNAKE_CASE`:

```ts
export const MAXIMUM_COMMAND_BYTES = 2 * 1024 * 1024;

export const DEFAULT_SEGMENT_ID = "default";
```

Import them by name; do not redeclare a value locally or repeat it as a bare literal. A value that appears in two places drifts: the connect timeout was once written in two files, and the replay lookback cap in two others. Keep each constant's explanation as a comment beside it.

Zod schemas are not constants in this sense. They are validation definitions, so they stay beside the code that uses them, in camelCase — though a limit a schema enforces still comes from `src/constants.ts`.

## Imports and the public surface

Import a type or value from the module that defines it. Never re-export from an internal module to save another file an import: a pass-through hides where a type actually lives and gives it two import paths.

`src/index.ts` is the only file that re-exports. Anything public is exported there, directly from its defining module.

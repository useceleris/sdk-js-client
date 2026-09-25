# Conventions

Simplicity and maintainability are paramount. These rules bind every change; detail lives in [code conventions](docs/code-conventions.md), and the surface contract in the specifications repository.

## Descriptive names

Use full domain words: `releaseMessageInterest`, `flushMessageInterests`, `segmentId`, `credentialProvider`. No abbreviations, no single-letter identifiers outside tight loop indexes. A name says what the thing is; a comment exists only to state a constraint the code cannot show.

## Simplicity over abstraction

Solve the current stage with the simplest structure that stays readable. Never add speculative generality: no registries, factories, adapters, event frameworks, dependency-injection containers, or wrapper layers. A helper class earns its place only by removing real, present duplication (`ListenerSet` qualifies; a "Manager" or "Service" does not). Prefer a function over a class, a method on an existing class over a new class, and a documented pattern over a convenience export.

## Design patterns only where necessary

Reach for a named design pattern only when a concrete, present requirement demands it, and record the why as a decision in the specifications repository. Absence of a pattern is the default, not a gap.

## Maintainability

- Small modules with one responsibility; the file name states it.
- Delete code in the same change that obsoletes it; never keep dead branches "just in case".
- Every public identifier traces to a specification requirement or a recorded decision (DEV-01, REV-01, SEG-01, ...).
- Errors carry fixed safe messages and stable codes; never interpolate received values or attach raw causes.
- Tests are deterministic (injected clocks/randomness, fake timers), grouped by behavior, and catch package-owned defects only.
- Before completion, review the full diff for anything deletable without weakening behavior or tests.

## Layout

Leave one blank line after every closing block before the next statement. Details and the exceptions are in [code conventions](docs/code-conventions.md#breathing-room).

Keep every fixed value in `src/constants.ts`, named in `SCREAMING_SNAKE_CASE`. Details are in [code conventions](docs/code-conventions.md#constants).

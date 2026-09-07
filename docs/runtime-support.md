# Runtime support and dependencies

## Qualification targets

Consumer floors: Node 22.15.0, Bun 1.3.0 and Deno 2.5.0. Additional qualification covers current Node 22/24/26 lines and current Bun/Deno. These are package/codec targets; realtime transport support requires C3–C8. Node consumer floors are independent of the development host: tsdown 0.23.0 requires Node ^22.18.0 / ^24.11.0 / >=26; Vitest 5 requires ^22.12.0 / ^24 / >=26.

The codec needs Uint8Array, bigint, TextEncoder and fatal UTF-8 TextDecoder. It does not need WebSocket, crypto or btoa. Production types use ES2022/DOM with no Node ambient types. C3 will require URL, AbortSignal and a transport with the capabilities in the contract. Other runtimes need explicit compatible capabilities/adapters and execution evidence; no implicit Node fallback.

Current Playwright Chromium/Firefox/WebKit are automated engine targets. They do not qualify branded Chrome/Edge/Firefox/Safari releases or establish a Safari minimum version. See [Playwright browser distinctions](https://playwright.dev/docs/browsers). C8 retains branded-browser and cross-OS evidence. Engines are installed in Playwright's cache without replacing system browsers.

## Running the matrix

`npm run test` defaults to development Node and Bun/Deno on PATH, plus all three Playwright engines. Missing executables fail. Full qualification uses `CELERIS_RUNTIME_MATRIX`, a JSON array of `{ name, kind, command }`; kind is node, bun or deno and command is an executable path. The server's eight-runtime layout is reused without version-comparison tests. Install missing floors in an isolated tooling directory, preserving global installations.

Vitest orchestrates processes and Playwright. ESM package imports and internal codec vectors execute in every selected runtime. CommonJS runs in Node/Bun; Deno is ESM-qualified. Browser tests bundle a consumer from an isolated tarball installation and run separate internal-codec fixtures. Neither imports alone nor Node-only unit execution proves codec conformance elsewhere.

CI intentionally runs one Linux job with Node 24, current Bun/Deno and the three browser engines, followed by `npm run test`. The eight-runtime matrix and Windows/macOS release qualification remain separate from CI. Build first before standalone typecheck so self-referencing fixture imports resolve the package's generated declarations; `npm run check` does this automatically.

## Installed dependency review — 2026-09-06

All versions were written by npm using the authorized `@latest --save-exact` install commands. Restore with npm install; review unexpected manifest/lock changes. No manual version pins, downgrades or forced installs.

| Dependency  | Installed | Role                       | License    | Declared Node engines      |
| ----------- | --------- | -------------------------- | ---------- | -------------------------- |
| zod         | 4.5.4     | Runtime command validation | MIT        | None declared              |
| typescript  | 7.0.2     | Compilation/typechecking   | Apache-2.0 | >=16.20.0                  |
| vitest      | 5.0.0     | Test orchestration         | MIT        | ^22.12.0 / ^24 / >=26      |
| prettier    | 3.9.6     | Formatting                 | MIT        | >=14                       |
| @types/node | 26.4.1    | Tooling declarations only  | MIT        | None declared              |
| tsdown      | 0.23.0    | Direct CLI build           | MIT        | ^22.18.0 / ^24.11.0 / >=26 |
| playwright  | 1.63.0    | Browser engine execution   | Apache-2.0 | >=20                       |

Metadata comes from installed package manifests; `npm audit --json` reported zero advisories at installation. This is current advisory evidence, not an independent security audit. Zod is the sole runtime dependency; there are no crypto, server SDK or WebSocket dependencies. Native binary framing remains package code because the Celeris grammar is not standard RESP.

Latest TypeScript/Vitest reproduce the server's third-party declaration failures: unresolved @vitest/expect/MarkOptions and benchmark-provider optionality. `skipLibCheck: true` is scoped to tooling only, after reproducing those errors. Production and installed declaration consumers retain full checking. tsdown also reports experimental TypeScript 7 API support. No dependency was downgraded; record/recheck these limitations when upgrading. The portability check uses the server's source/built-text checks rather than an unavailable TypeScript 7 compiler API.

References: [Zod parsing](https://zod.dev/basics), [Vitest](https://vitest.dev/guide/), [tsdown output](https://tsdown.dev/options/output-format), [TypeScript module resolution](https://www.typescriptlang.org/docs/handbook/modules/reference.html). Actual versioned execution, not documentation availability, establishes qualification.

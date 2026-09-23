# Runtime support and dependencies

## Qualification targets

Consumer floors: Node 22.15.0, Bun 1.3.0 and Deno 2.5.0. Additional qualification covers current Node 22/24/26 lines and current Bun/Deno. C3 qualifies internal package/codec and local native-transport execution; real Celeris integration remains C8. Node consumer floors are independent of the development host: tsdown 0.23.0 requires Node ^22.18.0 / ^24.11.0 / >=26; Vitest 5 requires ^22.12.0 / ^24 / >=26.

The codec needs Uint8Array, bigint, TextEncoder and fatal UTF-8 TextDecoder. It does not need WebSocket, crypto or btoa. Production types use ES2022/DOM with no Node ambient types. C3 requires URL, AbortController/AbortSignal, timers and native WebSocket. Other runtimes must provide those capabilities and execution evidence; no implicit Node fallback.

Browser support claims state exactly what has been executed (PORT-01, aligned 2026-09-22):

| Target                                 | Evidence                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playwright Chromium / Firefox / WebKit | Automated on macOS (development host) and on Linux and Windows in CI                                                                                 |
| Branded Chrome (`channel: "chrome"`)   | Automated on macOS; selected with `CELERIS_BROWSER_CHANNELS=chrome`                                                                                  |
| Branded Edge (`channel: "msedge"`)     | Automated on the Windows CI runner                                                                                                                   |
| Safari                                 | **Not qualified.** Playwright cannot drive Safari; bundled WebKit is an engine proxy, not a Safari release, and no Safari minimum version is claimed |
| Branded Firefox, mobile browsers       | **Not qualified.**                                                                                                                                   |

Set `CELERIS_BROWSER_CHANNELS` to a comma-separated list of Playwright channels to add branded builds where installed; unset runs the three bundled engines. See [Playwright browser distinctions](https://playwright.dev/docs/browsers). Engines are installed in Playwright's cache without replacing system browsers.

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

## C3 transport dependency and TLS evidence — 2026-09-07

Installed test-only `ws` 8.21.3 (MIT, Node >=10) and `@types/ws` 8.18.1 (MIT, no declared engines) using npm @latest --save-dev --save-exact. npm audit reported zero advisories. Zod remains the sole production dependency. No independent audit claim is made for these releases.

All eight runtime versions executed WS, trusted WSS using an isolated synthetic CA, and untrusted-WSS rejection; Node/Bun also executed CommonJS WS. Chromium/Firefox/WebKit executed WS and untrusted-WSS rejection. Trusted browser WSS with a private CA is not qualified here; system trust stores and global runtime installations are unchanged. No TLS verification bypass is used. Test CA trust is passed only to child processes via NODE_EXTRA_CA_CERTS or Deno --cert. The synthetic server leaf has CA:false; Deno correctly rejected the original CA-as-leaf fixture, which was corrected.

See [transport contract](transport.md) for native buffering, ping, handshake visibility and close limitations. Tests use fake timers for deterministic deadlines and real native runtimes for direct WebSocket behavior. Automatic reconnect is specified for C7, not implemented in C3.

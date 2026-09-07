# @useceleris/client

Private Celeris client foundation (`0.0.0`). C0–C3 supply contracts, portable packaging, an internal binary codec and transport/credential acquisition. There is no public realtime API yet; importing the package creates no connection.

Read [implementation stages](STAGES.md), [contracts](docs/contracts.md), [transport](docs/transport.md), [test inventory](docs/testing.md), [runtime support](docs/runtime-support.md), [code conventions](docs/code-conventions.md) and [verification evidence](docs/verification.md).

Use `npm install`, `npm run build`, `npm run typecheck`, `npm run test`, and `npm run format:check`. `npm run test:watch` is interactive. `npm run check` combines the completion checks. Tests require Node, Bun, Deno and Playwright Chromium/Firefox/WebKit; install engines using `npx playwright install chromium firefox webkit`. CI installs Linux browser prerequisites too. See runtime support for the full qualification matrix.

The eventual client accepts opaque application-issued credentials. Signing stays in trusted servers; this package never depends on `@useceleris/server`. No publishing, durable replay, global ordering or server-confirmed delivery is provided by this foundation.

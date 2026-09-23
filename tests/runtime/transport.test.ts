import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { readBrowserTargets } from "../helpers/browsers";
import { compileFixture } from "../helpers/package-fixture";
import { repositoryRoot } from "../helpers/commands";
import { readRuntimeMatrix } from "../helpers/runtimes";
import {
  testCertificate,
  testCertificateAuthority,
  testPrivateKey,
} from "../fixtures/transport-certificate";

const execute = promisify(execFile);
const runtimes = readRuntimeMatrix();
let directory: string;
let wsServer: WebSocketServer;
let secureServer: ReturnType<typeof createServer>;
let secureSockets: WebSocketServer;
let wsUrl: string;
let wssUrl: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "celeris-transport-"));
  writeFileSync(join(directory, "ca.pem"), testCertificateAuthority);
  for (const format of ["esm", "cjs", "iife"] as const) {
    compileFixture(
      join(repositoryRoot, "tests/fixtures/transport-consumer.ts"),
      format,
      directory,
    );
  }
  wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wsServer.once("listening", resolve));
  secureServer = createServer({ key: testPrivateKey, cert: testCertificate });
  secureSockets = new WebSocketServer({ server: secureServer });
  await new Promise<void>((resolve) =>
    secureServer.listen(0, "127.0.0.1", resolve),
  );
  for (const server of [wsServer, secureSockets]) {
    server.on("connection", (socket, request) => {
      const url = new URL(request.url!, "http://localhost");
      if (
        url.pathname !== "/channel/room-1" ||
        url.searchParams.get("payload") !== "a+/=&%識" ||
        url.searchParams.get("signature") !== "signature+/="
      ) {
        socket.close();
        return;
      }
      socket.on("message", () =>
        socket.send("@SERVER_MSG\n:1\n$5\nhello\n", { binary: true }),
      );
    });
  }
  const wsAddress = wsServer.address();
  const secureAddress = secureServer.address();
  if (
    !wsAddress ||
    typeof wsAddress === "string" ||
    !secureAddress ||
    typeof secureAddress === "string"
  )
    throw new Error("Missing test server address");
  wsUrl = `ws://127.0.0.1:${wsAddress.port}`;
  wssUrl = `wss://127.0.0.1:${secureAddress.port}`;
});

afterAll(async () => {
  for (const server of [wsServer, secureSockets]) {
    if (!server) continue;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (secureServer)
    await new Promise<void>((resolve) => secureServer.close(() => resolve()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});

for (const runtime of runtimes) {
  for (const mode of ["ws", "trusted-tls", "untrusted-tls"] as const) {
    test(`${runtime.name}: ${mode} native transport`, async () => {
      const trusted = mode === "trusted-tls";
      const configuration = {
        baseUrl: mode === "ws" ? wsUrl : wssUrl,
        rejectTls: mode === "untrusted-tls",
      };
      const script = `globalThis.transportConfiguration=${JSON.stringify(configuration)};await import(${JSON.stringify(pathToFileURL(join(directory, "transport-consumer.js")).href)});console.log(JSON.stringify(await globalThis.transportResult));`;
      const args =
        runtime.kind === "deno"
          ? [
              "eval",
              ...(trusted ? [`--cert=${join(directory, "ca.pem")}`] : []),
              script,
            ]
          : ["--input-type=module", "--eval", script];
      const { stdout } = await execute(runtime.command, args, {
        timeout: 25000,
        env: {
          ...process.env,
          ...(trusted
            ? { NODE_EXTRA_CA_CERTS: join(directory, "ca.pem") }
            : {}),
        },
      });
      expect(JSON.parse(stdout)).toEqual(
        mode === "untrusted-tls"
          ? { code: "Transport" }
          : { command: "SERVER_MSG", payload: [104, 101, 108, 108, 111] },
      );
    });
  }
  if (runtime.kind !== "deno") {
    test(`${runtime.name}: CommonJS native transport`, async () => {
      const script = `globalThis.transportConfiguration=${JSON.stringify({ baseUrl: wsUrl, rejectTls: false })};require(${JSON.stringify(join(directory, "transport-consumer.cjs"))});globalThis.transportResult.then(value=>console.log(JSON.stringify(value)));`;
      const { stdout } = await execute(runtime.command, ["--eval", script], {
        timeout: 25000,
      });
      expect(JSON.parse(stdout)).toEqual({
        command: "SERVER_MSG",
        payload: [104, 101, 108, 108, 111],
      });
    });
  }
}
for (const target of readBrowserTargets()) {
  test(`${target.name}: native transport and untrusted TLS rejection`, async () => {
    const browser = await target.launch();
    try {
      for (const rejectTls of [false, true]) {
        const page = await browser.newPage();
        await page.evaluate(
          (configuration) => {
            Object.assign(globalThis, {
              transportConfiguration: configuration,
            });
          },
          { baseUrl: rejectTls ? wssUrl : wsUrl, rejectTls },
        );
        await page.addScriptTag({
          path: join(directory, "transport-consumer.iife.js"),
        });
        expect(
          await page.evaluate(() => Reflect.get(globalThis, "transportResult")),
        ).toEqual(
          rejectTls
            ? { code: "Transport" }
            : {
                command: "SERVER_MSG",
                payload: [104, 101, 108, 108, 111],
              },
        );
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
}

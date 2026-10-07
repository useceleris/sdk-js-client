import { describe, expect, it } from "vitest";
import { copyFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { repositoryRoot, runCommand } from "../helpers/commands";
import { compileFixture, usePackageFixture } from "../helpers/package-fixture";
import { readBrowserTargets } from "../helpers/browsers";
import { readRuntimeMatrix } from "../helpers/runtimes";
import { signCredentials } from "./helpers/credentials";
import { clientId, signingSecret, websocketUrl } from "./helpers/environment";

const getFixture = usePackageFixture();
const runtimes = readRuntimeMatrix();

function startSignerEndpoint(): Promise<{ server: Server; url: string }> {
  // Stands in for the application's authenticated credential endpoint.
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        signCredentials(clientId(), signingSecret(), { allowEcho: true }),
      ),
    );
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        throw new Error("Signer endpoint failed to bind.");
      }

      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
} // end function startSignerEndpoint

describe("celeris examples", () => {
  it("runs the node quickstart on every configured runtime", () => {
    const { consumerDirectory } = getFixture();
    compileFixture(
      join(repositoryRoot, "examples/node-quickstart.ts"),
      "esm",
      consumerDirectory,
      true,
    );

    for (const runtime of runtimes) {
      const argumentsList =
        runtime.kind === "deno"
          ? [
              "run",
              "--allow-net",
              "--allow-env",
              "--no-config",
              "--node-modules-dir=manual",
              "node-quickstart.js",
            ]
          : ["node-quickstart.js"];
      const output = runCommand(
        runtime.command,
        argumentsList,
        consumerDirectory,
      );
      expect(output, `${runtime.name} quickstart output`).toMatch(
        /example: ok delivered=[1-9]\d* present=\d+/,
      );
    }
  });

  it("runs the browser quickstart in every engine", async () => {
    const { consumerDirectory } = getFixture();
    const bundleDirectory = join(consumerDirectory, "browser-example");
    // Copy into the consumer so the bare import resolves from the installed
    // tarball (the browser-consumer pattern in the runtime suite).
    copyFileSync(
      join(repositoryRoot, "examples/browser-quickstart.ts"),
      join(consumerDirectory, "browser-quickstart.ts"),
    );

    compileFixture(
      join(consumerDirectory, "browser-quickstart.ts"),
      "iife",
      bundleDirectory,
    );
    const { server, url } = await startSignerEndpoint();

    try {
      for (const target of readBrowserTargets()) {
        const browser = await target.launch();

        try {
          const page = await browser.newPage();
          await page.evaluate(
            ([wsUrl, endpoint]) => {
              Object.assign(globalThis, {
                celerisWsUrl: wsUrl,
                celerisCredentialEndpoint: endpoint,
              });
            },
            [websocketUrl(), url],
          );

          await page.addScriptTag({
            path: join(bundleDirectory, "browser-quickstart.iife.js"),
          });

          await page.waitForFunction(
            () => Reflect.get(globalThis, "exampleResult") !== undefined,
            undefined,
            { timeout: 25_000 },
          );
          const result = await page.evaluate(() =>
            Reflect.get(globalThis, "exampleResult"),
          );
          expect(result).toMatchObject({ ok: true });
        } finally {
          await browser.close();
        }
      }
    } finally {
      server.close();
    }
  });
});

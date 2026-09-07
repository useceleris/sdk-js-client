import { beforeAll, expect, test } from "vitest";
import { join } from "node:path";
import { copyFileSync } from "node:fs";
import { compileFixture, usePackageFixture } from "../helpers/package-fixture";
import { repositoryRoot } from "../helpers/commands";
import { readRuntimeMatrix, runConsumer } from "../helpers/runtimes";
import {
  encodingVectors,
  invalidIdentifierVectors,
  decodingVectors,
  malformedVectors,
} from "../fixtures/codec-vectors";
import { chromium, firefox, webkit } from "playwright";

const getFixture = usePackageFixture();
const runtimes = readRuntimeMatrix();
const expectedCodec = JSON.parse(
  JSON.stringify(
    {
      encoded: encodingVectors.map(({ expected }) => Array.from(expected)),
      invalidIdentifiers: invalidIdentifierVectors.map(() => "Configuration"),
      decoded: decodingVectors.map(({ expected }) => expected),
      malformed: malformedVectors.map(() => "ProtocolError"),
    },
    (_key, value: unknown) =>
      typeof value === "bigint"
        ? value.toString()
        : value instanceof Uint8Array
          ? Array.from(value)
          : value,
  ),
);

beforeAll(() => {
  const { consumerDirectory } = getFixture();
  for (const [entry, format] of [
    ["consumer.ts", "esm"],
    ["consumer-require.ts", "cjs"],
    ["codec-consumer.ts", "esm"],
    ["codec-consumer.ts", "cjs"],
  ] as const) {
    compileFixture(
      join(repositoryRoot, "tests/fixtures", entry),
      format,
      consumerDirectory,
      entry !== "codec-consumer.ts",
    );
  }
  compileFixture(
    join(repositoryRoot, "tests/fixtures/codec-consumer.ts"),
    "iife",
    join(consumerDirectory, "browser-codec"),
  );
  // Resolve browser imports from the installed tarball, not the repository.
  copyFileSync(
    join(repositoryRoot, "tests/fixtures/browser-consumer.ts"),
    join(consumerDirectory, "browser-consumer.ts"),
  );
  compileFixture(
    join(consumerDirectory, "browser-consumer.ts"),
    "iife",
    join(consumerDirectory, "browser-package"),
  );
});

for (const runtime of runtimes) {
  test(`${runtime.name}: installed ESM import and private boundary`, () => {
    expect(
      runConsumer(runtime, "consumer.js", getFixture().consumerDirectory),
    ).toEqual({ exports: [], privatePathBlocked: true });
  });
  test(`${runtime.name}: codec vectors`, () => {
    expect(
      runConsumer(runtime, "codec-consumer.js", getFixture().consumerDirectory),
    ).toEqual(expectedCodec);
  });
  if (runtime.kind !== "deno") {
    test(`${runtime.name}: installed CommonJS import and private boundary`, () => {
      expect(
        runConsumer(
          runtime,
          "consumer-require.cjs",
          getFixture().consumerDirectory,
        ),
      ).toEqual({ exports: [], privatePathBlocked: true });
    });
    test(`${runtime.name}: CommonJS codec vectors`, () => {
      expect(
        runConsumer(
          runtime,
          "codec-consumer.cjs",
          getFixture().consumerDirectory,
        ),
      ).toEqual(expectedCodec);
    });
  }
}

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  test(`${name}: installed package bundle and codec vectors`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.evaluate(() => {
        for (const name of [
          "crypto",
          "fetch",
          "WebSocket",
          "setTimeout",
          "setInterval",
        ]) {
          Object.defineProperty(globalThis, name, {
            configurable: true,
            get() {
              throw new Error(`Package import accessed ${name}`);
            },
          });
        }
      });
      await page.addScriptTag({
        path: join(
          getFixture().consumerDirectory,
          "browser-package/browser-consumer.iife.js",
        ),
      });
      expect(
        await page.evaluate(() => Reflect.get(globalThis, "clientExports")),
      ).toEqual([]);
      await page.addScriptTag({
        path: join(
          getFixture().consumerDirectory,
          "browser-codec/codec-consumer.iife.js",
        ),
      });
      expect(
        await page.evaluate(() => Reflect.get(globalThis, "codecObservations")),
      ).toEqual(expectedCodec);
      console.info(`${name}: ${browser.version()}`);
    } finally {
      await browser.close();
    }
  });
}

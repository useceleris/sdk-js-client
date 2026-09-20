import { expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, runCommand } from "../helpers/commands";
import { usePackageFixture } from "../helpers/package-fixture";

const getFixture = usePackageFixture();

test("latest TypeScript resolves the installed portable entrypoint in each module mode", () => {
  const { consumerDirectory } = getFixture();
  const compilerDirectory = join(repositoryRoot, "node_modules/typescript");
  const compilerPackage = JSON.parse(
    readFileSync(join(compilerDirectory, "package.json"), "utf8"),
  );
  const compiler = join(compilerDirectory, compilerPackage.bin.tsc);
  for (const mode of [
    { extension: "mts", module: "NodeNext", resolution: "NodeNext" },
    { extension: "cts", module: "NodeNext", resolution: "NodeNext" },
    { extension: "ts", module: "ESNext", resolution: "Bundler" },
  ]) {
    const filename = `consumer.${mode.extension}`;
    writeFileSync(
      join(consumerDirectory, filename),
      `import { createClient } from "@useceleris/client";
import type {
  ChannelState,
  CredentialRequest,
  Credentials,
} from "@useceleris/client";

async function credentialProvider(
  request: CredentialRequest,
): Promise<Credentials> {
  return { payload: request.channelReference, signature: "signature" };
}

const client = createClient({
  baseUrl: "wss://example.test",
  credentialProvider,
});
const channel = client.channel("room-42");
const state: ChannelState = channel.state;
const dispose = channel.events().onStateChange(() => undefined);
const stopMessages = channel.segment("chat").onMessage(() => undefined);
dispose();
stopMessages();
void state;
void channel.close();
// @ts-expect-error Codec internals are not public exports.
import { decodeServerMessage } from "@useceleris/client";
`,
    );
    const configuration = join(consumerDirectory, "tsconfig.json");
    writeFileSync(
      configuration,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: mode.module,
          moduleResolution: mode.resolution,
          strict: true,
          noEmit: true,
          types: [],
          // AbortSignal in the public surface requires the platform library
          // that declares it, mirroring the AbortController runtime capability.
          lib: ["ES2022", "DOM"],
          skipLibCheck: false,
        },
        files: [filename],
      }),
    );
    expect(() =>
      runCommand(
        process.execPath,
        [compiler, "-p", configuration],
        consumerDirectory,
      ),
    ).not.toThrow();
  }
});

test("published declarations carry no schema inference", () => {
  for (const declaration of ["dist/index.d.ts", "dist/index.d.cts"]) {
    const contents = readFileSync(join(repositoryRoot, declaration), "utf8");
    expect(contents).not.toMatch(/zod/);
  }
});

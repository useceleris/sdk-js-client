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
      `import * as client from "@useceleris/client";
const empty: keyof typeof client extends never ? true : false = true;
void empty;
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
          lib: ["ES2022"],
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

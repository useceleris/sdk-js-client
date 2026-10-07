import { afterAll, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNpm } from "./commands";

export function compileFixture(
  entry: string,
  format: "esm" | "cjs" | "iife",
  destination: string,
  externalPackage = false,
): void {
  runNpm([
    "exec",
    "--no",
    "--",
    "tsdown",
    entry,
    "--format",
    format,
    "--platform",
    "neutral",
    "--target",
    "es2022",
    "--out-dir",
    destination,
    "--no-clean",
    "--no-dts",
    "--no-treeshake",
    ...(externalPackage
      ? [
          "--deps.never-bundle",
          "@useceleris/client",
          "--deps.never-bundle",
          "@useceleris/client/dist/index.cjs",
        ]
      : [
          "--deps.always-bundle",
          "zod",
          "--deps.always-bundle",
          "@useceleris/client",
        ]),
  ]);
} // end function compileFixture

export function usePackageFixture(): () => { consumerDirectory: string } {
  let temporaryDirectory: string;
  let fixture: { consumerDirectory: string };

  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "celeris-client-"));
    runNpm(["run", "build"]);
    const [artifact] = JSON.parse(
      runNpm(["pack", "--json", "--pack-destination", temporaryDirectory]),
    ) as { filename: string }[];

    if (!artifact) {
      throw new Error("npm pack returned no artifact");
    }

    const consumerDirectory = join(temporaryDirectory, "consumer");
    mkdirSync(consumerDirectory);
    writeFileSync(
      join(consumerDirectory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(temporaryDirectory, artifact.filename),
      ],
      consumerDirectory,
    );
    fixture = { consumerDirectory };
  });

  afterAll(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
  return () => fixture;
} // end function usePackageFixture

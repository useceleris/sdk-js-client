import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { usePackageFixture } from "../helpers/package-fixture";
import { repositoryRoot } from "../helpers/commands";

const getFixture = usePackageFixture();

test("packs only intended artifacts and declares resolvable conditional exports", () => {
  const { consumerDirectory, packedFiles } = getFixture();
  const manifest = JSON.parse(
    readFileSync(
      join(consumerDirectory, "node_modules/@useceleris/client/package.json"),
      "utf8",
    ),
  );
  expect(manifest).toMatchObject({
    name: "@useceleris/client",
    version: "0.0.0",
    private: true,
    sideEffects: false,
  });
  expect(Object.keys(manifest.exports)).toEqual(["."]);
  for (const branch of Object.values(manifest.exports["."]) as {
    types: string;
    default: string;
  }[]) {
    for (const target of Object.values(branch)) {
      expect(packedFiles).toContain(target.slice(2));
    }
  }
  expect(
    packedFiles.every(
      (file) =>
        file.startsWith("dist/") ||
        ["README.md", "package.json"].includes(file),
    ),
  ).toBe(true);
  const localManifest = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  expect(manifest.dependencies).toEqual({
    zod: localManifest.dependencies.zod,
  });
});

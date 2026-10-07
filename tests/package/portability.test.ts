import { beforeAll, expect, test } from "vitest";
import { builtinModules } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, runNpm } from "../helpers/commands";

function listFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else {
      files.push(path);
    }
  }

  return files;
} // end function listFiles

beforeAll(() => {
  runNpm(["run", "build"]);
});

test("portable source and output contain no runtime-specific dependencies or globals", () => {
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/, "")),
  );
  const codeFiles = [
    ...listFiles(join(repositoryRoot, "src")),
    ...listFiles(join(repositoryRoot, "dist")),
  ].filter((file) => /\.(?:[cm]?ts|[cm]?js)$/.test(file));

  for (const file of codeFiles) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(
      /\b(?:Buffer|process|Bun|Deno|NodeJS)\b|\bnode:/,
    );
    const quotedValues = source.matchAll(
      /(?:from\s*|import\s*\(|require\s*\()?["']([^"']+)["']/g,
    );

    for (const match of quotedValues) {
      const value = match[1];

      if (value !== undefined) {
        expect(builtins.has(value), file).toBe(false);
      }
    }
  }

  const configuration = JSON.parse(
    readFileSync(join(repositoryRoot, "tsconfig.json"), "utf8"),
  );
  expect(configuration.compilerOptions.types).toEqual([]);
});

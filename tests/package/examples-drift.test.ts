import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, runCommand } from "../helpers/commands";

// Every TypeScript snippet in EXAMPLES.md must keep compiling against the
// public surface, so the document cannot drift from the implementation.
test("EXAMPLES.md snippets compile against the public surface", () => {
  const document = readFileSync(join(repositoryRoot, "EXAMPLES.md"), "utf8");
  const snippets = [...document.matchAll(/```ts\n([\s\S]*?)```/g)].map(
    (match) => match[1]!,
  );
  expect(snippets.length).toBeGreaterThanOrEqual(6);

  // Snippet-local import lines are stripped; one canonical preamble import
  // covers every public name the snippets use.
  const wrappedSnippets = snippets.map((snippet, index) => {
    const body = snippet
      .split("\n")
      .filter((line) => !/^import[ {]/.test(line))
      .join("\n");

    return `async function snippet${index}(): Promise<void> {\n${body}\n}\nvoid snippet${index};\n`;
  });

  const preamble = [
    'import { createClient, Client, Channel, Segment, ConnectionError, ServerError } from "@useceleris/client";',
    'import { textPayload, jsonPayload, readText, readJson, createPayloadCodec } from "@useceleris/client";',
    'import type { CredentialRequest, MessageMetadata, PresencePage } from "@useceleris/client";',
    // Serializer libraries used by the payload-format sections.
    'import { encode, decode } from "@msgpack/msgpack";',
    'import { Type, Field } from "protobufjs";',
    "declare const page: PresencePage;",
    "declare const metadata: MessageMetadata;",
    "declare const client: Client;",
    "declare const channel: Channel;",
    "declare const chat: Segment;",
    "declare const bytes: Uint8Array;",
    "void createClient;",
  ].join("\n");

  const directory = mkdtempSync(join(tmpdir(), "celeris-examples-"));

  try {
    writeFileSync(
      join(directory, "snippets.ts"),
      `${preamble}\n\n${wrappedSnippets.join("\n")}`,
    );

    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          types: [],
          lib: ["ES2022", "DOM"],
          skipLibCheck: false,
          paths: {
            "@useceleris/client": [
              join(repositoryRoot, "src/index.ts").replaceAll("\\", "/"),
            ],
            // The temp directory sits outside the repository, so the
            // documented serializers need explicit resolution.
            "@msgpack/msgpack": [
              join(repositoryRoot, "node_modules/@msgpack/msgpack").replaceAll(
                "\\",
                "/",
              ),
            ],
            protobufjs: [
              join(repositoryRoot, "node_modules/protobufjs").replaceAll(
                "\\",
                "/",
              ),
            ],
          },
        },
        files: ["snippets.ts"],
      }),
    );

    const compilerDirectory = join(repositoryRoot, "node_modules/typescript");
    const compilerPackage = JSON.parse(
      readFileSync(join(compilerDirectory, "package.json"), "utf8"),
    ) as { bin: { tsc: string } };
    expect(() =>
      runCommand(
        process.execPath,
        [join(compilerDirectory, compilerPackage.bin.tsc), "-p", directory],
        directory,
      ),
    ).not.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

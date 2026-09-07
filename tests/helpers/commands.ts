import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function runCommand(
  command: string,
  argumentsList: string[],
  workingDirectory = repositoryRoot,
): string {
  return execFileSync(command, argumentsList, {
    cwd: workingDirectory,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  }).trim();
}

export function runNpm(
  argumentsList: string[],
  workingDirectory = repositoryRoot,
): string {
  const npmExecutable = process.env.npm_execpath;
  if (!npmExecutable) {
    throw new Error("Run tests through npm test (npm_execpath required)");
  }

  return runCommand(
    process.execPath,
    [npmExecutable, ...argumentsList],
    workingDirectory,
  );
}

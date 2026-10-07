import { z } from "zod";
import { runCommand } from "./commands";

const runtimeSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["node", "bun", "deno"]),
  command: z.string().min(1),
});

export type Runtime = z.infer<typeof runtimeSchema>;

export function readRuntimeMatrix(): Runtime[] {
  const configuration = process.env.CELERIS_RUNTIME_MATRIX;
  return z
    .array(runtimeSchema)
    .min(1)
    .parse(
      configuration
        ? JSON.parse(configuration)
        : [
            { name: "node", kind: "node", command: process.execPath },
            { name: "bun", kind: "bun", command: "bun" },
            { name: "deno", kind: "deno", command: "deno" },
          ],
    );
} // end function readRuntimeMatrix

export function runConsumer(
  runtime: Runtime,
  filename: string,
  directory: string,
): unknown {
  const argumentsList =
    runtime.kind === "deno"
      ? ["run", "--no-config", "--node-modules-dir=manual", filename]
      : [filename];
  return JSON.parse(runCommand(runtime.command, argumentsList, directory));
} // end function runConsumer

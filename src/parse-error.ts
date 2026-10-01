import type { z } from "zod";

// Names every field that failed and the rule it broke. Zod's messages state
// the expected type, format or bound, never the value; the one exception, an
// unrecognized key, would repeat the caller's input, so its names are left out.
export function describeParseError(subject: string, error: z.ZodError): string {
  const failures = error.issues.map((issue) => {
    const rule =
      issue.code === "unrecognized_keys"
        ? "Contains an unsupported key"
        : issue.message;

    return issue.path.length === 0
      ? `${rule}.`
      : `${describePath(issue.path)}: ${rule}.`;
  });

  return `Invalid ${subject}. ${failures.join(" ")}`;
} // end function describeParseError

function describePath(path: readonly PropertyKey[]): string {
  return path
    .map((key, index) => {
      if (typeof key === "number") return `[${key}]`;

      return index === 0 ? String(key) : `.${String(key)}`;
    })
    .join("");
} // end function describePath

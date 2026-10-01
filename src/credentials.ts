import { z } from "zod";
import type { Credentials } from "./credential-types";
import { ConfigurationError } from "./errors";
import { describeParseError } from "./parse-error";
import { REPLAY_LOOKBACK_CAP_MS } from "./constants";

const credentialValueSchema = z
  .string()
  .min(1, "Must not be empty")
  .refine(
    (value) => !/[\uD800-\uDFFF]/u.test(value),
    "Must not contain unpaired UTF-16 surrogates",
  );

const credentialsSchema = z
  .object({
    payload: credentialValueSchema,
    signature: credentialValueSchema,
  })
  .readonly();

export function getSafeParsedCredentials(credentials: unknown): Credentials {
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success)
    throw new ConfigurationError(
      describeParseError("credentials", parsed.error),
    );

  return parsed.data;
} //end function getSafeParsedCredentials

const replayLookbackMsSchema = z.int().min(0).max(REPLAY_LOOKBACK_CAP_MS);

const recoverySchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("initial") }),
  z.object({
    reason: z.literal("reconnect"),
    disconnectedAt: z.int().min(0),
    replayLookbackMs: replayLookbackMsSchema,
  }),
]);

export const channelReferenceSchema = z
  .string()
  .min(1, "Must not be empty")
  .max(255, "Must be at most 255 characters")
  .refine(
    (value) => !/[^a-zA-Z0-9_-]/.test(value),
    "Must contain only ASCII letters, digits, hyphens (-) or underscores (_)",
  );

export const connectionConfigurationSchema = z.object({
  baseUrl: z.string().min(1, "Must not be empty"),
  channelReference: channelReferenceSchema,
  allowInsecureLoopback: z.boolean().default(false),
  recovery: recoverySchema.default({ reason: "initial" }),
});

export type ConnectionConfiguration = z.input<
  typeof connectionConfigurationSchema
>;

type ParsedConnectionConfiguration = z.output<
  typeof connectionConfigurationSchema
>;

export function getSafeParsedConnectionConfiguration(
  configuration: ConnectionConfiguration,
): ParsedConnectionConfiguration {
  const parsed = connectionConfigurationSchema.safeParse(configuration);
  if (!parsed.success)
    throw new ConfigurationError(
      describeParseError("connection configuration", parsed.error),
    );

  return parsed.data;
} // end function getSafeParsedConnectionConfiguration

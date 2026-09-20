import { z } from "zod";
import { ConfigurationError } from "./errors";

const credentialValueSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\uD800-\uDFFF]/u.test(value));

export const credentialsSchema = z
  .object({
    payload: credentialValueSchema,
    signature: credentialValueSchema,
  })
  .readonly();

export type Credentials = z.output<typeof credentialsSchema>;

export function getSafeParsedCredentials(credentials: unknown): Credentials {
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success) throw new ConfigurationError("Invalid credentials.");

  return parsed.data;
} //end function getSafeParsedCredentials

export type CredentialRequest = {
  readonly channelReference: string;
  readonly reason: "initial" | "reconnect";
  readonly disconnectedAt?: number;
  readonly replayLookbackMs?: number;
  readonly signal: AbortSignal;
};

export type CredentialProvider = (
  request: CredentialRequest,
) => Promise<Credentials>;

const replayLookbackMsSchema = z.int().min(0).max(4294967295);

const recoverySchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("initial") }),
  z.object({
    reason: z.literal("reconnect"),
    disconnectedAt: z.int().min(0),
    replayLookbackMs: replayLookbackMsSchema,
  }),
]);

export const connectionConfigurationSchema = z.object({
  baseUrl: z.string().min(1),
  channelReference: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !/[^a-zA-Z0-9-]/.test(value)),
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
    throw new ConfigurationError("Invalid connection configuration.");

  return parsed.data;
} // end function getSafeParsedConnectionConfiguration

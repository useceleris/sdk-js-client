import { z } from "zod";

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

export type CredentialRequest = {
  readonly channelReference: string;
  readonly reason: "initial" | "reconnect";
  readonly disconnectedAt: number | null;
  readonly replayLookbackMs: number | null;
  readonly signal: AbortSignal;
};

export type CredentialProvider = (
  request: CredentialRequest,
) => Promise<Credentials>;

export const connectionConfigurationSchema = z.object({
  baseUrl: z.string().min(1),
  channelReference: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !/[^a-zA-Z0-9-]/.test(value)),
  allowInsecureLoopback: z.boolean().default(false),
  recovery: z
    .discriminatedUnion("reason", [
      z.object({
        reason: z.literal("initial"),
        disconnectedAt: z.null().optional(),
        replayLookbackMs: z.int().min(0).max(4294967295).optional(),
      }),
      z.object({
        reason: z.literal("reconnect"),
        disconnectedAt: z.int().min(0),
        replayLookbackMs: z.int().min(0).max(4294967295),
      }),
    ])
    .default({
      reason: "initial",
      replayLookbackMs: 100,
    }),
});

export type ConnectionConfiguration = z.input<
  typeof connectionConfigurationSchema
>;

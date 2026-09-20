import { z } from "zod";

export const identifierSchema = z
  .string()
  .min(1)
  // Unicode mode rejects lone surrogates while preserving valid pairs.
  .refine((value) => !/[\r\n\uD800-\uDFFF]/u.test(value));
const segmentFields = { segmentId: identifierSchema };

export const clientCommandSchema = z.discriminatedUnion("command", [
  z.object({
    command: z.literal("PUB"),
    ...segmentFields,
    messageId: identifierSchema.optional(),
    payload: z.instanceof(Uint8Array<ArrayBufferLike>),
  }),
  z.object({ command: z.literal("SUB"), ...segmentFields }),
  z.object({ command: z.literal("UNSUB"), ...segmentFields }),
  z.object({ command: z.literal("PRES_SUB"), ...segmentFields }),
  z.object({ command: z.literal("PRES_UNSUB"), ...segmentFields }),
  z.object({
    command: z.literal("PRES_LIST"),
    ...segmentFields,
    page: z.int().min(1).max(2147483647),
    perPage: z.int().min(1).max(100),
  }),
]);

export type ClientCommand = z.input<typeof clientCommandSchema>;

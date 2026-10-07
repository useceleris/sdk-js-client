import { z } from "zod";
import { MAXIMUM_INTEGER32 } from "./constants";

export const identifierSchema = z
  .string()
  .min(1, "Must not be empty")
  // Unicode mode rejects lone surrogates while preserving valid pairs.
  .refine(
    (value) => !/[\r\n\uD800-\uDFFF]/u.test(value),
    "Must not contain CR, LF or unpaired UTF-16 surrogates",
  );

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
    page: z.int().min(1).max(MAXIMUM_INTEGER32),
    perPage: z.int().min(1).max(100),
    requestId: identifierSchema,
  }),
]);

export type ClientCommand = z.input<typeof clientCommandSchema>;

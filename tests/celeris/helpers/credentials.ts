import { createHmac } from "node:crypto";
import type { Credentials } from "../../../src/credential-types";

// Hand-authored signer per the protocol document, independent of
// @useceleris/server (client tests never import server code).
export type SigningPayload = {
  readonly timestamp?: number;
  readonly reference?: string;
  readonly channelReferences?: readonly string[] | null;
  readonly tokenPermission?:
    | { readonly read: boolean; readonly write: boolean }
    | readonly {
        readonly segment_id: string;
        readonly read: boolean;
        readonly write: boolean;
      }[];
  readonly replay?: boolean | number;
  readonly allowEcho?: boolean;
};

export function signCredentials(
  clientId: string,
  signingSecret: string,
  payload: SigningPayload = {},
): Credentials {
  const wirePayload: Record<string, unknown> = {
    timestamp: payload.timestamp ?? Date.now(),
  };
  if (payload.reference !== undefined)
    wirePayload.reference = payload.reference;
  if (payload.channelReferences !== undefined)
    wirePayload.channel_references = payload.channelReferences;
  if (payload.tokenPermission !== undefined)
    wirePayload.token_permission = payload.tokenPermission;
  if (payload.replay !== undefined) wirePayload.replay = payload.replay;
  if (payload.allowEcho !== undefined)
    wirePayload.allow_echo = payload.allowEcho;

  const encodedPayload = Buffer.from(
    JSON.stringify(wirePayload),
    "utf8",
  ).toString("base64");
  const digestHex = createHmac("sha512", signingSecret)
    .update(encodedPayload, "ascii")
    .digest("hex");
  const signature = Buffer.from(`${clientId}:${digestHex}`, "utf8").toString(
    "base64",
  );

  return { payload: encodedPayload, signature };
} // end function signCredentials

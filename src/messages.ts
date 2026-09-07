export type PresenceConnection = {
  readonly tokenReference: string;
  readonly connectionId: string;
  readonly timestamp: bigint;
};

export type ServerMessage =
  | {
      readonly command: "MSG";
      readonly tokenReference: string;
      readonly segmentId: string;
      readonly messageId: string | null;
      readonly timestamp: bigint;
      readonly payload: Uint8Array;
    }
  | {
      readonly command: "SERVER_MSG";
      readonly timestamp: bigint;
      readonly payload: Uint8Array;
    }
  | {
      readonly command: "PRES_LIST_RESPONSE";
      readonly segmentId: string;
      readonly total: bigint;
      readonly perPage: bigint;
      readonly currentPage: bigint;
      readonly from: bigint;
      readonly to: bigint;
      readonly connections: readonly PresenceConnection[];
    }
  | {
      readonly command: "ERROR";
      readonly name: string;
      readonly message: Uint8Array;
    }
  | { readonly command: "ARRAY"; readonly messages: readonly ServerMessage[] };

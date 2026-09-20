export type Credentials = {
  readonly payload: string;
  readonly signature: string;
};

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

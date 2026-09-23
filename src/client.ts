import { z } from "zod";
import { Channel } from "./channel";
import { validateBaseUrl } from "./connection-url";
import type { CredentialProvider } from "./credential-types";
import { channelReferenceSchema } from "./credentials";
import { ConfigurationError } from "./errors";
import { monotonicNow } from "./reconnect";

// Consumers do not configure where Celeris lives; overriding is for local
// stacks and other deployments (ENDPOINT-01).
const defaultBaseUrl = "wss://realtime.useceleris.com";

const clientOptionsSchema = z.object({
  baseUrl: z.string().min(1).default(defaultBaseUrl),
  allowInsecureLoopback: z.boolean().default(false),
  connectTimeoutMs: z.int().min(1).default(15_000),
  presenceQueryTimeoutMs: z.int().min(1).default(10_000),
});

export type ClientOptions = {
  readonly credentialProvider: CredentialProvider;
  readonly baseUrl?: string;
  readonly allowInsecureLoopback?: boolean;
  readonly connectTimeoutMs?: number;
  readonly presenceQueryTimeoutMs?: number;
};

export class Client {
  private readonly baseUrl: string;
  private readonly allowInsecureLoopback: boolean;
  private readonly connectTimeoutMs: number;
  private readonly presenceQueryTimeoutMs: number;
  private readonly credentialProvider: CredentialProvider;

  constructor(options: ClientOptions) {
    if (typeof options?.credentialProvider !== "function")
      throw new ConfigurationError("Invalid client options.");

    const parsed = clientOptionsSchema.safeParse(options);

    if (!parsed.success)
      throw new ConfigurationError("Invalid client options.");

    validateBaseUrl(parsed.data.baseUrl, parsed.data.allowInsecureLoopback);

    this.baseUrl = parsed.data.baseUrl;
    this.allowInsecureLoopback = parsed.data.allowInsecureLoopback;
    this.connectTimeoutMs = parsed.data.connectTimeoutMs;
    this.presenceQueryTimeoutMs = parsed.data.presenceQueryTimeoutMs;
    this.credentialProvider = options.credentialProvider;
  } // end constructor

  channel(reference: string): Channel {
    const parsed = channelReferenceSchema.safeParse(reference);

    if (!parsed.success)
      throw new ConfigurationError("Invalid channel reference.");

    return new Channel({
      baseUrl: this.baseUrl,
      channelReference: parsed.data,
      allowInsecureLoopback: this.allowInsecureLoopback,
      connectTimeoutMs: this.connectTimeoutMs,
      presenceQueryTimeoutMs: this.presenceQueryTimeoutMs,
      credentialProvider: this.credentialProvider,
      clock: monotonicNow,
      wallClock: Date.now,
      random: Math.random,
    });
  } // end method channel
} // end class Client

export function createClient(options: ClientOptions): Client {
  return new Client(options);
} // end function createClient

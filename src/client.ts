import { z } from "zod";
import { Channel } from "./channel";
import { validateBaseUrl } from "./connection-url";
import type { CredentialProvider } from "./credential-types";
import { channelReferenceSchema } from "./credentials";
import { ConfigurationError } from "./errors";
import { generateMessageId } from "./message-id";
import { describeParseError } from "./parse-error";
import { monotonicNow } from "./reconnect";
import {
  DEDUP_WINDOW_SIZE,
  DEFAULT_BASE_URL,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_PRESENCE_QUERY_TIMEOUT_MS,
  MAXIMUM_PENDING_COMMANDS,
} from "./constants";

const clientOptionsSchema = z.object({
  baseUrl: z.string().min(1).default(DEFAULT_BASE_URL),
  allowInsecureLoopback: z.boolean().default(false),
  connectTimeoutMs: z.int().min(1).default(DEFAULT_CONNECT_TIMEOUT_MS),
  // Defaults to the resolved connectTimeoutMs, applied after parsing: a zod
  // field cannot default to a sibling.
  reconnectTimeoutMs: z.int().min(1).optional(),
  presenceQueryTimeoutMs: z
    .int()
    .min(1)
    .default(DEFAULT_PRESENCE_QUERY_TIMEOUT_MS),
  publishQueueSize: z.int().min(1).default(MAXIMUM_PENDING_COMMANDS),
  deduplicationWindowSize: z.int().min(1).default(DEDUP_WINDOW_SIZE),
});

export type ClientOptions = {
  readonly credentialProvider: CredentialProvider;
  readonly baseUrl?: string;
  readonly allowInsecureLoopback?: boolean;
  readonly connectTimeoutMs?: number;
  readonly reconnectTimeoutMs?: number;
  readonly presenceQueryTimeoutMs?: number;
  readonly publishQueueSize?: number;
  readonly deduplicationWindowSize?: number;
};

export class Client {
  private readonly baseUrl: string;
  private readonly allowInsecureLoopback: boolean;
  private readonly connectTimeoutMs: number;
  private readonly reconnectTimeoutMs: number;
  private readonly presenceQueryTimeoutMs: number;
  private readonly publishQueueSize: number;
  private readonly deduplicationWindowSize: number;
  private readonly credentialProvider: CredentialProvider;

  constructor(options: ClientOptions) {
    if (typeof options?.credentialProvider !== "function")
      throw new ConfigurationError(
        "Invalid client options. credentialProvider: Must be a function.",
      );

    const parsed = clientOptionsSchema.safeParse(options);

    if (!parsed.success)
      throw new ConfigurationError(
        describeParseError("client options", parsed.error),
      );

    validateBaseUrl(parsed.data.baseUrl, parsed.data.allowInsecureLoopback);

    this.baseUrl = parsed.data.baseUrl;
    this.allowInsecureLoopback = parsed.data.allowInsecureLoopback;
    this.connectTimeoutMs = parsed.data.connectTimeoutMs;
    this.reconnectTimeoutMs =
      parsed.data.reconnectTimeoutMs ?? parsed.data.connectTimeoutMs;
    this.presenceQueryTimeoutMs = parsed.data.presenceQueryTimeoutMs;
    this.publishQueueSize = parsed.data.publishQueueSize;
    this.deduplicationWindowSize = parsed.data.deduplicationWindowSize;
    this.credentialProvider = options.credentialProvider;
  } // end constructor

  channel(reference: string): Channel {
    const parsed = channelReferenceSchema.safeParse(reference);

    if (!parsed.success)
      throw new ConfigurationError(
        describeParseError("channel reference", parsed.error),
      );

    return new Channel({
      baseUrl: this.baseUrl,
      channelReference: parsed.data,
      allowInsecureLoopback: this.allowInsecureLoopback,
      connectTimeoutMs: this.connectTimeoutMs,
      reconnectTimeoutMs: this.reconnectTimeoutMs,
      presenceQueryTimeoutMs: this.presenceQueryTimeoutMs,
      publishQueueSize: this.publishQueueSize,
      deduplicationWindowSize: this.deduplicationWindowSize,
      credentialProvider: this.credentialProvider,
      clock: monotonicNow,
      wallClock: Date.now,
      random: Math.random,
      generateMessageId,
    });
  } // end method channel
} // end class Client

export function createClient(options: ClientOptions): Client {
  return new Client(options);
} // end function createClient

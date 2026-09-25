// Every fixed value the package uses, in one place. Internal: none of these
// is part of the public surface.

// Outgoing size (LIMIT-01). Size is only ever checked on commands the client
// sends. Received messages are already fully buffered by the platform when
// they arrive, so checking them bounds no memory and only discards data.
//
// The command bound is the server's transport ceiling: above it no plan can
// accept a command. Each plan's own, smaller payload cap is enforced by the
// server and surfaces as a MessageSizeLimitError server error.
export const MAXIMUM_COMMAND_BYTES = 2 * 1024 * 1024;

// Equal to the command bound, so a maximum-size command always fits an empty
// buffer and anything queued behind it reports backpressure instead.
export const MAXIMUM_BUFFERED_BYTES = MAXIMUM_COMMAND_BYTES;

export const MAXIMUM_PENDING_COMMANDS = 64;

// Decoder bounds. These limit parsing work and recursion, not message size;
// no legitimate server message approaches them.
export const MAXIMUM_FRAGMENTS = 4096;

export const MAXIMUM_DEPTH = 32;

// "PRES_LIST_RESPONSE", the longest command the server sends.
export const MAXIMUM_COMMAND_NAME_BYTES = 18;

export const MAXIMUM_ERROR_NAME_BYTES = 64;

// "-9223372036854775808", the widest signed 64-bit integer.
export const MAXIMUM_INTEGER_LINE_BYTES = 20;

export const MINIMUM_INTEGER = -(1n << 63n);

export const MAXIMUM_INTEGER = (1n << 63n) - 1n;

// Connection defaults. Consumers do not configure where Celeris lives;
// overriding the base URL is for local stacks and other deployments
// (ENDPOINT-01).
export const DEFAULT_BASE_URL = "wss://realtime.useceleris.com";

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export const DEFAULT_PRESENCE_QUERY_TIMEOUT_MS = 10_000;

export const DEFAULT_SEGMENT_ID = "default";

// Recovery.
export const MAXIMUM_RETRIES = 10;

export const RETRY_BUDGET_RESET_MS = 60_000;

export const RETRY_BASE_DELAY_MS = 500;

export const RETRY_DELAY_CAP_MS = 30_000;

export const REPLAY_OVERLAP_MS = 5_000;

// The server's largest replay lookback: an unsigned 32-bit millisecond count.
export const REPLAY_LOOKBACK_CAP_MS = 4_294_967_295;

export const CLOSE_BUDGET_MS = 5_000;

export const DEDUP_WINDOW_SIZE = 1024;

// Text codecs. One-shot encode and decode keep no state between calls, so one
// shared instance of each serves every caller.
export const TEXT_ENCODER = new TextEncoder();

// Rejects malformed UTF-8: payload helpers and the protocol decoder must not
// silently alter the bytes they were given.
export const STRICT_TEXT_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

// Replaces malformed bytes rather than throwing: delivering a server error
// must never itself fail.
export const LENIENT_TEXT_DECODER = new TextDecoder("utf-8");

// Every fixed value the package uses, in one place. Internal: none of these
// is part of the public surface.

// Outgoing size (LIMIT-01). Size is only ever checked on commands the client
// sends. Received messages are already fully buffered by the platform when
// they arrive, so checking them bounds no memory and only discards data.
//
// The command bound is the server's transport ceiling: above it no plan can
// accept a command. Each plan's own, smaller command cap is enforced by the
// server and surfaces as a MessageSizeLimitError server error.
export const MAXIMUM_COMMAND_BYTES = 2 * 1024 * 1024;

// Equal to the command bound, so a maximum-size command always fits an empty
// buffer and anything queued behind it reports backpressure instead.
export const MAXIMUM_BUFFERED_BYTES = MAXIMUM_COMMAND_BYTES;

export const MAXIMUM_PENDING_COMMANDS = 64;

// Batching (BATCH-01). Commands waiting when the writer sends go out together
// in one `*N` frame of at most this many commands and bytes, header included.
// A command larger than the byte bound goes alone. The server refuses an array
// of more than 16 commands.
export const MAXIMUM_BATCH_COMMANDS = 16;

export const MAXIMUM_BATCH_BYTES = 64 * 1024;

export const MESSAGE_SIZE_LIMIT_ERROR_TYPE = "MessageSizeLimitError";

// Outbound recovery (RESEND-01). A rate limit is reported without saying
// which frame it dropped, so whatever went out recently is resent.
//
// The server reports drops at most once a second, and a second more covers
// the round trip, so a report concerns only commands sent within this window.
export const RATE_LIMIT_SUSPECT_WINDOW_MS = 2_000;

// Resending waits at least this long, past the per-second window the
// dropped frames were counted in.
export const RATE_LIMIT_COOLDOWN_MS = 1_000;

// Bounds the extra load, and the extra usage, a rate limit can cause.
export const MAXIMUM_PUBLISH_RESENDS = 1;

// After this many rate limits in a row the limit is treated as a used-up
// quota (per hour or per month): recent publishes are no longer resent, and
// recent subscriptions wait for a quota probe.
export const MAXIMUM_CONSECUTIVE_RATE_LIMITS = 8;

// A used-up quota refuses every frame, so the subscriptions it dropped are
// re-sent rarely rather than abandoned: first after a minute, then doubling.
export const QUOTA_PROBE_FIRST_DELAY_MS = 60_000;

export const QUOTA_PROBE_MAXIMUM_DELAY_MS = 3_600_000;

// How often a full writer is checked again: the platform has no drain event.
export const DRAIN_RETRY_MS = 50;

// The error type the server sends for any rate limit.
export const RATE_LIMIT_ERROR_TYPE = "RateLimitError";

// Generated message ids share every receiver's dedup window with ids from
// other publishers, so they are random and long enough never to collide.
export const MESSAGE_ID_RANDOM_BYTES = 16;

// Every generated message id names the SDK that made it (RESEND-01). The
// version is this package's; a test keeps it equal to package.json.
export const SDK_LANGUAGE = "js";

export const SDK_VERSION = "1.1.0";

// Decoder bounds. These limit parsing work and recursion, not message size;
// no legitimate server message approaches them.
export const MAXIMUM_FRAGMENTS = 4096;

export const MAXIMUM_DEPTH = 32;

// "PRES_LIST_RESPONSE", the longest command the server sends.
export const MAXIMUM_COMMAND_NAME_BYTES = 18;

export const MAXIMUM_ERROR_NAME_BYTES = 64;

// Integer64 (`:`) carries timestamps; it is also the range of bulk and array
// lengths. "-9223372036854775808" is its widest value.
export const MAXIMUM_INTEGER64_LINE_BYTES = 20;

export const MINIMUM_INTEGER64 = -(1n << 63n);

export const MAXIMUM_INTEGER64 = (1n << 63n) - 1n;

// Integer32 (`;`) carries every other integer, and decodes to a number.
// "-2147483648" is its widest value.
export const MAXIMUM_INTEGER32_LINE_BYTES = 11;

export const MINIMUM_INTEGER32 = -2_147_483_648;

export const MAXIMUM_INTEGER32 = 2_147_483_647;

// Connection defaults. Consumers do not configure where Celeris lives;
// overriding the base URL is for local stacks and other deployments
// (ENDPOINT-01).
export const DEFAULT_BASE_URL = "wss://realtime.useceleris.com";

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export const DEFAULT_PRESENCE_QUERY_TIMEOUT_MS = 10_000;

// The longest connect, reconnect or presence query timeout a client accepts
// (CONFIG-01). It also keeps every timer below the 2^31 − 1 ms that
// setTimeout can count; a longer delay fires at once.
export const MAXIMUM_TIMEOUT_MS = 15 * 60 * 1000;

export const DEFAULT_SEGMENT_ID = "default";

// The command a presence query error names as its sub type (QUERY-01).
export const PRESENCE_LIST_COMMAND = "PRES_LIST";

// Recovery (CONFIG-01). Failed reconnect attempts allowed per budget before
// the channel fails: the default, and the most maximumReconnectAttempts accepts.
export const DEFAULT_MAXIMUM_RECONNECT_ATTEMPTS = 10;

export const MAXIMUM_RECONNECT_ATTEMPTS_CEILING = 100;

export const RETRY_BUDGET_RESET_MS = 60_000;

export const RETRY_BASE_DELAY_MS = 500;

export const RETRY_DELAY_CAP_MS = 30_000;

// A rate limit already in hand disproves recovery only if commands flowed
// unrefused for longer than the longest pause plus the report window; any
// sooner, it may be a late report of the frames that just went out.
export const QUOTA_RETURN_CONFIRMATION_MS =
  RETRY_DELAY_CAP_MS + RATE_LIMIT_SUSPECT_WINDOW_MS;

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

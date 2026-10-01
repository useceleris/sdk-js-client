import { ConfigurationError } from "./errors";
import { MESSAGE_ID_RANDOM_BYTES } from "./constants";

// Every publish carries an id, so a resent copy is recognisable and receivers
// drop it (RESEND-01).
export function generateMessageId(): string {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new ConfigurationError(
      "crypto.getRandomValues is unavailable in this runtime; publishing needs it to give each message a unique id.",
    );
  }

  const bytes = globalThis.crypto.getRandomValues(
    new Uint8Array(MESSAGE_ID_RANDOM_BYTES),
  );

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
} // end function generateMessageId

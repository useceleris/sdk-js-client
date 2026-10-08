import { ConfigurationError } from "./errors";
import {
  MESSAGE_ID_RANDOM_BYTES,
  SDK_LANGUAGE,
  SDK_VERSION,
} from "./constants";

// Every publish carries an id, so a resent copy is recognisable and receivers
// drop it (RESEND-01). A generated id names the SDK that made it, then holds
// 16 random bytes as hex: msg__js_v1.1.0__0123456789abcdef0123456789abcdef.
// The double underscores keep it apart from the server's own msg_{node}_ ids.
export function generateMessageId(): string {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new ConfigurationError(
      "crypto.getRandomValues is unavailable in this runtime; publishing needs it to give each message a unique id.",
    );
  }

  const bytes = globalThis.crypto.getRandomValues(
    new Uint8Array(MESSAGE_ID_RANDOM_BYTES),
  );

  const random = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return messageIdPrefix(SDK_LANGUAGE, SDK_VERSION) + random;
} // end function generateMessageId

// "msg__", the language, "_v", the version, "__". An id holds only letters,
// digits, dots and underscores, so any other character of the version, such
// as the hyphen of a pre-release, becomes an underscore.
export function messageIdPrefix(language: string, version: string): string {
  return `msg__${language}_v${version.replace(/[^A-Za-z0-9.]/g, "_")}__`;
} // end function messageIdPrefix

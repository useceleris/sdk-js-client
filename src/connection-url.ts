import type { Credentials } from "./credential-types";
import { ConfigurationError } from "./errors";

export function validateBaseUrl(
  baseUrl: string,
  allowInsecureLoopback: boolean,
): URL {
  if (typeof globalThis.URL !== "function") {
    throw new ConfigurationError("URL is unavailable.");
  }

  let url: URL;

  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigurationError("Invalid connection URL.");
  }

  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.[0-9]+\.[0-9]+\.[0-9]+$/.test(url.hostname);

  if (
    url.username ||
    url.password ||
    baseUrl.includes("?") ||
    baseUrl.includes("#") ||
    !(
      url.protocol === "wss:" ||
      (url.protocol === "ws:" && allowInsecureLoopback && loopback)
    )
  ) {
    throw new ConfigurationError("Invalid connection URL.");
  }

  return url;
} // end function validateBaseUrl

export function createCredentialUrl(
  baseUrl: URL,
  channelReference: string,
  credentials: Credentials,
): string {
  const url = new URL(baseUrl.href);

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/channel/${channelReference}`;
  url.searchParams.set("payload", credentials.payload);
  url.searchParams.set("signature", credentials.signature);

  return url.href;
} // end function createCredentialUrl

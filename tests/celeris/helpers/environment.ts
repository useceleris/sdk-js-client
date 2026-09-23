import {
  createClient,
  Client,
  type Channel,
  type ChannelError,
  type Message,
  type Segment,
  type ServerNotice,
} from "../../../src/index";
import { signCredentials, type SigningPayload } from "./credentials";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy the three CELERIS_* values into a local ` +
        `.env (gitignored): CELERIS_WS_URL, CELERIS_CLIENT_ID and ` +
        `CELERIS_SIGNING_SECRET. Any stack works — change the URL and ` +
        `credentials to point elsewhere.`,
    );
  }

  return value;
} // end function requireEnvironment

export const websocketUrl = () => requireEnvironment("CELERIS_WS_URL");
export const clientId = () => requireEnvironment("CELERIS_CLIENT_ID");
export const signingSecret = () => requireEnvironment("CELERIS_SIGNING_SECRET");

let channelCounter = 0;
export function uniqueChannelReference(label: string): string {
  channelCounter += 1;

  return `jsqual-${label}-${Date.now()}-${channelCounter}`;
} // end function uniqueChannelReference

export function qualificationClient(
  payload: SigningPayload = {},
  baseUrl = websocketUrl(),
): Client {
  return createClient({
    baseUrl,
    allowInsecureLoopback: true,
    credentialProvider: async () =>
      signCredentials(clientId(), signingSecret(), payload),
  });
} // end function qualificationClient

export function waitFor<T>(
  register: (deliver: (value: T) => void) => () => void,
  predicate: (value: T) => boolean,
  timeoutMs = 15_000,
  description = "expected event",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose();
      reject(new Error(`Timed out waiting for ${description}.`));
    }, timeoutMs);
    const dispose = register((value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      dispose();
      resolve(value);
    });
  });
} // end function waitFor

export function nextMessage(
  segment: Segment,
  predicate: (message: Message) => boolean,
  description = "a message delivery",
  timeoutMs = 15_000,
): Promise<Message> {
  return waitFor<Message>(
    (deliver) => segment.onMessage(deliver),
    predicate,
    timeoutMs,
    description,
  );
} // end function nextMessage

export function nextNotice(
  channel: Channel,
  predicate: (notice: ServerNotice) => boolean,
  description = "a server notice",
  timeoutMs = 15_000,
): Promise<ServerNotice> {
  return waitFor<ServerNotice>(
    (deliver) => channel.events().onNotice(deliver),
    predicate,
    timeoutMs,
    description,
  );
} // end function nextNotice

export function nextError(
  channel: Channel,
  predicate: (error: ChannelError) => boolean,
  description = "a channel error",
  timeoutMs = 15_000,
): Promise<ChannelError> {
  return waitFor<ChannelError>(
    (deliver) => channel.events().onError(deliver),
    predicate,
    timeoutMs,
    description,
  );
} // end function nextError

export async function connectedChannel(
  reference: string,
  payload: SigningPayload = {},
  baseUrl?: string,
): Promise<Channel> {
  const channel = qualificationClient(payload, baseUrl).channel(reference);
  await channel.connect();

  return channel;
} // end function connectedChannel

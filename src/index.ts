export { createClient, Client, type ClientOptions } from "./client";
export {
  Channel,
  type ChannelError,
  type ChannelState,
  type ChannelEventHandler,
  type Message,
  type Subscription,
  type RecoveryEvent,
} from "./channel";
export { Segment } from "./segment";
export type {
  Credentials,
  CredentialRequest,
  CredentialProvider,
} from "./credential-types";
export {
  ConfigurationError,
  ConnectionError,
  ProtocolError,
  type ConnectionErrorCode,
} from "./errors";

export { createClient, Client, type ClientOptions } from "./client";
export {
  Channel,
  type ChannelError,
  type ChannelState,
  type ChannelEventHandler,
  type MessageMetadata,
  type MessageListener,
  type ServerNotice,
  type PresencePage,
  type PresenceConnection,
  type Subscription,
  type RecoveryEvent,
} from "./channel";
export { Segment } from "./segment";
export {
  textPayload,
  jsonPayload,
  readText,
  readJson,
  createPayloadCodec,
  type PayloadCodec,
  type BoundPayloadCodec,
} from "./payload";
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

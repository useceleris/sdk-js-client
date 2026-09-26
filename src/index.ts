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
  type PresenceEvent,
  type Subscription,
  type RecoveryEvent,
} from "./channel";

export type { PresenceConnection } from "./messages";

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
  ServerError,
  type ConnectionErrorCode,
  type ServerErrorType,
  type ServerErrorResource,
} from "./errors";

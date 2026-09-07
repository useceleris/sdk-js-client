import {
  getSafeParsedConnectionConfiguration,
  getSafeParsedCredentials,
  type ConnectionConfiguration,
  type CredentialProvider,
} from "./credentials";
import { createCredentialUrl, validateBaseUrl } from "./connection-url";
import { ProtocolError } from "./errors";
import { ConnectionError, type ConnectionErrorCode } from "./transport-errors";
import { MessageDecoder } from "./decode";
import { ServerMessage } from "./messages";
export type ConnectionDiagnostic = {
  readonly phase: "credentials" | "handshake" | "connected" | "failed";
  readonly code?: "Configuration" | ConnectionErrorCode;
};

export type ConnectionOptions = {
  readonly credentialProvider: CredentialProvider;
  readonly signal?: AbortSignal | undefined;
  readonly onMessage: (message: ServerMessage) => void;
  readonly onClose?: () => void;
  readonly onOpen?: () => void;
  readonly onError?: (error: ConnectionError | ProtocolError) => void;
};

export class ConnectionHandle {
  private readonly socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
  } // end constructor

  send(bytes: Uint8Array): void {
    this.socket.send(bytes);
  } // end method send

  close(): void {
    this.socket.close();
  } // end method close
} // end class ConnectionHandle

export class ConnectionHandler {
  async openConnection(
    configuration: ConnectionConfiguration,
    options: ConnectionOptions,
  ): Promise<ConnectionHandle> {
    const config = getSafeParsedConnectionConfiguration(configuration);
    const baseUrl = validateBaseUrl(
      config.baseUrl,
      !!config.allowInsecureLoopback,
    );

    const credentials = getSafeParsedCredentials(
      await options.credentialProvider({
        signal: options.signal,
        channelReference: config.channelReference,
        ...config.recovery,
      }),
    );

    const url = createCredentialUrl(
      baseUrl,
      config.channelReference,
      credentials,
    );

    const textEncoder = new TextEncoder();

    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    if (options.onOpen) {
      socket.addEventListener("open", () => options.onOpen?.());
    }

    if (options.onError) {
      socket.addEventListener("error", (event) =>
        options.onError?.(event as unknown as ConnectionError),
      );
    }

    if (options.onClose) {
      socket.addEventListener("close", () => options.onClose?.());
    }

    socket.addEventListener("message", (event) => {
      let data: Uint8Array;

      if (event.data instanceof ArrayBuffer) {
        data = new Uint8Array(event.data);
      } else {
        data = textEncoder.encode(event.data);
      }

      const serverMessage = new MessageDecoder(data).decode();
      options.onMessage(serverMessage);
    });

    return new ConnectionHandle(socket);
  } // end method openConnection
} // end class ConnectionHandler

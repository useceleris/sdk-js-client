import {
  getSafeParsedConnectionConfiguration,
  getSafeParsedCredentials,
  type ConnectionConfiguration,
  type CredentialProvider,
} from "./credentials";
import { createCredentialUrl, validateBaseUrl } from "./connection-url";
import { MessageDecoder } from "./decode";
import { ConfigurationError, ConnectionError, ProtocolError } from "./errors";
import type { ServerMessage } from "./messages";

const defaultConnectionTimeoutMs = 15_000;
const maximumCommandBytes = 128 * 1024;
const maximumBufferedBytes = 1024 * 1024;
const maximumMessageBytes = 1024 * 1024;

export type ConnectionOptions = {
  readonly credentialProvider: CredentialProvider;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onMessage: (message: ServerMessage) => void;
  readonly onClose?: () => void;
  readonly onError?: (error: ConnectionError | ProtocolError) => void;
};

export class ConnectionHandle {
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly removeDataListeners: () => void,
    private readonly removeAllListeners: () => void,
  ) {}

  send(bytes: Uint8Array): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      throw new ConnectionError("NotConnected", "Connection is not open.");
    }
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > maximumCommandBytes
    ) {
      throw new ConfigurationError("Invalid outgoing command.");
    }
    if (
      !Number.isFinite(this.socket.bufferedAmount) ||
      this.socket.bufferedAmount < 0
    ) {
      throw new ConnectionError(
        "Transport",
        "Invalid WebSocket buffering state.",
      );
    }
    if (this.socket.bufferedAmount + bytes.byteLength > maximumBufferedBytes) {
      throw new ConnectionError("Backpressure", "WebSocket buffer is full.");
    }

    try {
      this.socket.send(new Uint8Array(bytes));
    } catch {
      throw new ConnectionError("Transport", "WebSocket send failed.");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // The close listener stays attached so the native close event remains
    // observable through onClose; only data listeners detach here.
    this.removeDataListeners();

    if (
      this.socket.readyState !== this.socket.CLOSING &&
      this.socket.readyState !== this.socket.CLOSED
    ) {
      try {
        this.socket.close();
      } catch {
        // Handle remains closed when native close fails.
      }
    }
  }

  finishNativeClose(): void {
    this.closed = true;
    this.removeAllListeners();
  }
}

export class ConnectionHandler {
  async openConnection(
    configuration: ConnectionConfiguration,
    options: ConnectionOptions,
  ): Promise<ConnectionHandle> {
    const config = getSafeParsedConnectionConfiguration(configuration);
    if (
      typeof options?.credentialProvider !== "function" ||
      typeof options.onMessage !== "function"
    ) {
      throw new ConfigurationError("Invalid connection options.");
    }
    if (typeof globalThis.AbortController !== "function") {
      throw new ConfigurationError("AbortController is unavailable.");
    }
    if (typeof globalThis.WebSocket !== "function") {
      throw new ConfigurationError("WebSocket is unavailable.");
    }

    const baseUrl = validateBaseUrl(
      config.baseUrl,
      config.allowInsecureLoopback,
    );
    const controller = new AbortController();

    return new Promise<ConnectionHandle>((resolve, reject) => {
      let socket: WebSocket | undefined;
      let settled = false;

      const timeout = setTimeout(
        () =>
          fail(new ConnectionError("Timeout", "Connection attempt timed out.")),
        options.timeoutMs ?? defaultConnectionTimeoutMs,
      );

      const removeAttemptListeners = (): void => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancel);
        socket?.removeEventListener("open", opened);
        socket?.removeEventListener("error", handshakeFailed);
        socket?.removeEventListener("close", handshakeFailed);
      };

      const fail = (error: ConfigurationError | ConnectionError): void => {
        if (settled) return;
        settled = true;
        removeAttemptListeners();
        controller.abort();

        try {
          socket?.close();
        } catch {
          // Preserve selected safe error.
        }
        reject(error);
      };

      const cancel = (): void =>
        fail(new ConnectionError("Cancelled", "Connection attempt cancelled."));
      const handshakeFailed = (): void =>
        fail(new ConnectionError("Transport", "WebSocket handshake failed."));
      const opened = (): void => {
        if (settled || !socket) return;
        settled = true;
        removeAttemptListeners();
        resolve(this.createHandle(socket, options));
      };

      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) {
        cancel();
        return;
      }

      void this.requestCredentialsAndOpenSocket(
        config,
        baseUrl,
        options.credentialProvider,
        controller.signal,
        {
          isSettled: () => settled,
          onSocket: (createdSocket) => {
            socket = createdSocket;
            socket.addEventListener("open", opened);
            socket.addEventListener("error", handshakeFailed);
            socket.addEventListener("close", handshakeFailed);
          },
          onFailure: fail,
        },
      );
    });
  }

  private async requestCredentialsAndOpenSocket(
    config: ReturnType<typeof getSafeParsedConnectionConfiguration>,
    baseUrl: URL,
    credentialProvider: CredentialProvider,
    signal: AbortSignal,
    attempt: {
      isSettled(): boolean;
      onSocket(socket: WebSocket): void;
      onFailure(error: ConfigurationError | ConnectionError): void;
    },
  ): Promise<void> {
    let providedCredentials: unknown;
    try {
      providedCredentials = await credentialProvider({
        channelReference: config.channelReference,
        ...config.recovery,
        signal,
      });
    } catch {
      if (attempt.isSettled()) return;
      attempt.onFailure(
        new ConnectionError("Transport", "Credential acquisition failed."),
      );
      return;
    }
    if (attempt.isSettled()) return;

    let credentials: ReturnType<typeof getSafeParsedCredentials>;
    try {
      credentials = getSafeParsedCredentials(providedCredentials);
    } catch {
      attempt.onFailure(new ConfigurationError("Invalid credentials."));
      return;
    }

    try {
      const socket = new WebSocket(
        createCredentialUrl(baseUrl, config.channelReference, credentials),
      );
      attempt.onSocket(socket);
      socket.binaryType = "arraybuffer";
    } catch {
      if (attempt.isSettled()) return;
      attempt.onFailure(
        new ConnectionError("Transport", "WebSocket creation failed."),
      );
    }
  }

  private createHandle(
    socket: WebSocket,
    options: ConnectionOptions,
  ): ConnectionHandle {
    let handle: ConnectionHandle;

    const removeDataListeners = (): void => {
      socket.removeEventListener("message", receiveMessage);
      socket.removeEventListener("error", receiveError);
    };
    const removeAllListeners = (): void => {
      removeDataListeners();
      socket.removeEventListener("close", receiveClose);
    };
    const reportError = (error: ConnectionError | ProtocolError): void => {
      try {
        options.onError?.(error);
      } catch {
        // User callbacks cannot escape native event dispatch.
      }
      handle.close();
    };
    const receiveMessage = (event: MessageEvent): void => {
      if (!(event.data instanceof ArrayBuffer)) {
        reportError(
          new ProtocolError(
            "Expected a binary WebSocket message.",
            "message",
            0,
          ),
        );
        return;
      }
      if (event.data.byteLength > maximumMessageBytes) {
        reportError(
          new ProtocolError("WebSocket message exceeds 1 MiB.", "message", 0),
        );
        return;
      }

      let message: ServerMessage;
      try {
        message = new MessageDecoder(new Uint8Array(event.data)).decode();
      } catch (error) {
        reportError(
          error instanceof ProtocolError
            ? error
            : new ProtocolError("Message decoding failed.", "message", 0),
        );
        return;
      }
      try {
        options.onMessage(message);
      } catch {
        reportError(
          new ConnectionError("Transport", "Message callback failed."),
        );
      }
    };
    const receiveError = (): void =>
      reportError(new ConnectionError("Transport", "WebSocket failed."));
    const receiveClose = (): void => {
      handle.finishNativeClose();
      try {
        options.onClose?.();
      } catch {
        // User callbacks cannot escape native event dispatch.
      }
    };

    handle = new ConnectionHandle(
      socket,
      removeDataListeners,
      removeAllListeners,
    );
    socket.addEventListener("message", receiveMessage);
    socket.addEventListener("error", receiveError);
    socket.addEventListener("close", receiveClose);
    return handle;
  }
}

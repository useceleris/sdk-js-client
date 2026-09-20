import { ConnectionHandle, ConnectionHandler } from "./connection";
import type { CredentialProvider } from "./credential-types";
import { ConfigurationError, ConnectionError, ProtocolError } from "./errors";
import {
  closeBudgetMs,
  computeReplayLookbackMs,
  computeRetryDelayMs,
  maximumRetries,
  retryBudgetResetMs,
} from "./reconnect";

export type ChannelError = ConfigurationError | ConnectionError | ProtocolError;

export type ChannelState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "closing"
  | "closed";

export type RecoveryEvent = {
  readonly retryIndex: number;
  readonly possibleGaps: true;
  readonly possibleDuplicates: true;
};

export interface Subscription {
  cancel(): void;
}

export interface ChannelEventHandler {
  onStateChange(listener: (state: ChannelState) => void): () => void;
  onRecovery(listener: (event: RecoveryEvent) => void): () => void;
  onError(listener: (error: ChannelError) => void): () => void;
}

export type ChannelInternals = {
  readonly baseUrl: string;
  readonly channelReference: string;
  readonly allowInsecureLoopback: boolean;
  readonly connectTimeoutMs: number;
  readonly credentialProvider: CredentialProvider;
  readonly clock: () => number;
  readonly wallClock: () => number;
  readonly random: () => number;
};

type RecoveryContext =
  | { readonly reason: "initial" }
  | {
      readonly reason: "reconnect";
      readonly disconnectedAt: number;
      readonly replayLookbackMs: number;
    };

class ListenerSet<T> {
  private readonly entries: { callback: (value: T) => void }[] = [];

  add(callback: (value: T) => void): () => void {
    const entry = { callback };
    this.entries.push(entry);

    return () => {
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
    };
  } // end method add

  dispatch(value: T, containFailure: () => void): void {
    for (const entry of this.entries.slice()) {
      if (!this.entries.includes(entry)) continue;

      try {
        entry.callback(value);
      } catch {
        containFailure();
      }
    }
  } // end method dispatch
} // end class ListenerSet

export class Channel {
  private currentState: ChannelState = "idle";
  private generation = 0;
  private handle: ConnectionHandle | undefined;
  private retriesUsed = 0;
  private outage:
    { disconnectedAt: number; startedMonotonic: number } | undefined;
  private connectedAtMonotonic = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closeBudgetTimer: ReturnType<typeof setTimeout> | undefined;
  private attemptController: AbortController | undefined;
  private closePromise: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;
  private dispatchingErrors = false;

  private readonly connectionHandler = new ConnectionHandler();
  private readonly stateListeners = new ListenerSet<ChannelState>();
  private readonly recoveryListeners = new ListenerSet<RecoveryEvent>();
  private readonly errorListeners = new ListenerSet<ChannelError>();
  private readonly handler: ChannelEventHandler = {
    onStateChange: (listener) => this.stateListeners.add(listener),
    onRecovery: (listener) => this.recoveryListeners.add(listener),
    onError: (listener) => this.errorListeners.add(listener),
  };

  constructor(private readonly internals: ChannelInternals) {}

  get state(): ChannelState {
    return this.currentState;
  } // end getter state

  events(): ChannelEventHandler {
    return this.handler;
  } // end method events

  async connect(options?: { signal?: AbortSignal }): Promise<void> {
    if (
      this.currentState === "connecting" ||
      this.currentState === "connected" ||
      this.currentState === "reconnecting"
    ) {
      throw new ConnectionError(
        "OperationInProgress",
        "Connection is already in progress.",
      );
    }

    if (this.currentState === "closing" || this.currentState === "closed") {
      throw new ConnectionError("NotConnected", "Channel is closed.");
    }

    this.generation += 1;
    const generation = this.generation;
    this.retriesUsed = 0;
    this.outage = undefined;
    this.setState("connecting");

    try {
      await this.attempt({ reason: "initial" }, options?.signal);
    } catch (error) {
      if (generation === this.generation) {
        this.generation += 1;
        this.setState("failed");
      }
      throw error;
    }

    if (generation === this.generation) this.setState("connected");
  } // end method connect

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve;
    });

    this.generation += 1;
    this.clearRetryTimer();
    this.attemptController?.abort();
    this.attemptController = undefined;

    const handle = this.handle;
    this.handle = undefined;
    this.setState("closing");

    if (handle) {
      handle.close();
      if (this.currentState !== "closed") {
        this.closeBudgetTimer = setTimeout(
          () => this.finishClose(),
          closeBudgetMs,
        );
      }
    } else {
      this.finishClose();
    }

    return this.closePromise;
  } // end method close

  private finishClose(): void {
    if (this.currentState === "closed") return;

    if (this.closeBudgetTimer !== undefined) {
      clearTimeout(this.closeBudgetTimer);
      this.closeBudgetTimer = undefined;
    }

    this.setState("closed");
    this.resolveClose?.();
  } // end method finishClose

  private async attempt(
    recovery: RecoveryContext,
    callerSignal?: AbortSignal,
  ): Promise<void> {
    const generation = this.generation;
    const controller = new AbortController();
    this.attemptController = controller;
    const forwardAbort = (): void => controller.abort();
    callerSignal?.addEventListener("abort", forwardAbort, { once: true });
    if (callerSignal?.aborted) controller.abort();

    try {
      const handle = await this.connectionHandler.openConnection(
        {
          baseUrl: this.internals.baseUrl,
          channelReference: this.internals.channelReference,
          allowInsecureLoopback: this.internals.allowInsecureLoopback,
          recovery,
        },
        {
          credentialProvider: this.internals.credentialProvider,
          signal: controller.signal,
          timeoutMs: this.internals.connectTimeoutMs,
          onMessage: () => undefined,
          onClose: () => this.receiveSocketClose(generation),
          onError: (error) => this.receiveSocketError(generation, error),
        },
      );

      if (generation !== this.generation) {
        handle.close();
        throw new ConnectionError("Cancelled", "Connection attempt cancelled.");
      }

      this.handle = handle;
      this.connectedAtMonotonic = this.internals.clock();
      this.outage = undefined;
    } finally {
      callerSignal?.removeEventListener("abort", forwardAbort);
      if (this.attemptController === controller)
        this.attemptController = undefined;
    }
  } // end method attempt

  private receiveSocketClose(attemptGeneration: number): void {
    if (this.currentState === "closing") {
      this.finishClose();
      return;
    }

    if (attemptGeneration !== this.generation) return;

    if (this.currentState !== "connected") return;

    this.enterReconnecting();
  } // end method receiveSocketClose

  private receiveSocketError(
    attemptGeneration: number,
    error: ChannelError,
  ): void {
    if (attemptGeneration !== this.generation) return;
    if (this.currentState !== "connected") return;

    if (error instanceof ProtocolError) {
      this.handle = undefined;
      this.failTerminal(error);
      return;
    }
    this.enterReconnecting();
  } // end method receiveSocketError

  private enterReconnecting(): void {
    const now = this.internals.clock();
    if (now - this.connectedAtMonotonic >= retryBudgetResetMs)
      this.retriesUsed = 0;

    this.outage = {
      disconnectedAt: this.internals.wallClock(),
      startedMonotonic: now,
    };

    this.handle = undefined;
    this.setState("reconnecting");
    this.scheduleRetry();
  } // end method enterReconnecting

  private scheduleRetry(): void {
    const generation = this.generation;
    const delay = computeRetryDelayMs(this.retriesUsed, this.internals.random);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;

      if (generation !== this.generation) return;

      void this.runReconnectAttempt();
    }, delay);
  } // end method scheduleRetry

  private async runReconnectAttempt(): Promise<void> {
    const generation = this.generation;
    const outage = this.outage;

    if (!outage) return;

    const attemptIndex = this.retriesUsed;

    try {
      await this.attempt({
        reason: "reconnect",
        disconnectedAt: outage.disconnectedAt,
        replayLookbackMs: computeReplayLookbackMs(
          this.internals.clock() - outage.startedMonotonic,
        ),
      });
    } catch (error) {
      if (generation !== this.generation) return;
      if (
        error instanceof ConnectionError &&
        (error.code === "Transport" || error.code === "Timeout")
      ) {
        this.retriesUsed += 1;
        if (this.retriesUsed >= maximumRetries) {
          this.failTerminal(error);
          return;
        }
        this.scheduleRetry();
        return;
      }
      this.failTerminal(
        error instanceof ConfigurationError ||
          error instanceof ConnectionError ||
          error instanceof ProtocolError
          ? error
          : new ConnectionError("Transport", "Reconnect attempt failed."),
      );
      return;
    }

    if (generation !== this.generation) return;
    this.setState("connected");
    this.recoveryListeners.dispatch(
      {
        retryIndex: attemptIndex,
        possibleGaps: true,
        possibleDuplicates: true,
      },
      () => this.reportListenerFailure(),
    );
  } // end method runReconnectAttempt

  private failTerminal(error: ChannelError): void {
    this.generation += 1;
    this.clearRetryTimer();
    this.emitError(error);
    this.setState("failed");
  } // end method failTerminal

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  } // end method clearRetryTimer

  private setState(state: ChannelState): void {
    this.currentState = state;
    this.stateListeners.dispatch(state, () => this.reportListenerFailure());
  } // end method setState

  private reportListenerFailure(): void {
    this.emitError(
      new ConnectionError("Transport", "Listener callback failed."),
    );
  } // end method reportListenerFailure

  private emitError(error: ChannelError): void {
    if (this.dispatchingErrors) return;
    this.dispatchingErrors = true;
    try {
      this.errorListeners.dispatch(error, () => undefined);
    } finally {
      this.dispatchingErrors = false;
    }
  } // end method emitError
} // end class Channel

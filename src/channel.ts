import { identifierSchema } from "./commands";
import { openConnection, type ConnectionHandle } from "./connection";
import type { CredentialProvider } from "./credential-types";
import { encodeClientCommand } from "./encode";
import {
  ConfigurationError,
  ConnectionError,
  ProtocolError,
  ServerError,
} from "./errors";

import type { PresenceConnection, ServerMessage } from "./messages";
import { computeReplayLookbackMs, computeRetryDelayMs } from "./reconnect";

import { Segment, type SegmentDelegates } from "./segment";
import {
  CLOSE_BUDGET_MS,
  DEDUP_WINDOW_SIZE,
  DEFAULT_SEGMENT_ID,
  LENIENT_TEXT_DECODER,
  MAXIMUM_PENDING_COMMANDS,
  MAXIMUM_RETRIES,
  RETRY_BUDGET_RESET_MS,
} from "./constants";

// Replaces malformed bytes rather than throwing: error delivery must not fail.

export type ChannelError =
  ConfigurationError | ConnectionError | ProtocolError | ServerError;

export type MessageMetadata = {
  readonly tokenReference: string;
  readonly segmentId: string;
  readonly messageId: string; // server-assigned, always present (REV-01, C8-verified)
  readonly timestamp: bigint;
};

// Payload first so decoding composes; everything else arrives beside it.
export type MessageListener = (
  payload: Uint8Array,
  metadata: MessageMetadata,
) => void;

export type ServerNotice = {
  readonly timestamp: bigint;
  readonly payload: Uint8Array;
};

export type { PresenceConnection } from "./messages";

export type PresencePage = {
  readonly segmentId: string;
  readonly total: bigint;
  readonly perPage: bigint;
  readonly currentPage: bigint;
  readonly from: bigint; // from > to possible; raw metadata preserved
  readonly to: bigint;
  readonly connections: readonly PresenceConnection[];
};

// One connection joining or leaving one segment (PRES-01). Delivered only
// where subscribePresence() was called, because the server fans these out
// to presence subscribers alone.
export type PresenceEvent = {
  readonly segmentId: string;
  readonly tokenReference: string;
  readonly connectionId: string;
  readonly joined: boolean; // false = left
  readonly timestamp: bigint;
};

export type PresenceListener = (event: PresenceEvent) => void;

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
  onNotice(listener: (notice: ServerNotice) => void): () => void;
  onError(listener: (error: ChannelError) => void): () => void;
}

export type ChannelInternals = {
  readonly baseUrl: string;
  readonly channelReference: string;
  readonly allowInsecureLoopback: boolean;
  readonly connectTimeoutMs: number;
  readonly presenceQueryTimeoutMs: number;
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

// Variadic so message listeners can take (payload, metadata) while the
// other event listeners take a single value.
class ListenerSet<T extends readonly unknown[]> {
  private readonly entries: { callback: (...values: T) => void }[] = [];

  constructor(private readonly containFailure: () => void) {}

  add(callback: (...values: T) => void): () => void {
    const entry = { callback };
    this.entries.push(entry);

    return () => {
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
    };
  } // end method add

  dispatch(...values: T): void {
    for (const entry of this.entries.slice()) {
      if (!this.entries.includes(entry)) continue;

      try {
        entry.callback(...values);
      } catch {
        this.containFailure();
      }
    }
  } // end method dispatch
} // end class ListenerSet

class DedupWindow {
  private readonly identifiers = new Set<string>();

  isDuplicate(identifier: string): boolean {
    if (this.identifiers.has(identifier)) return true;

    this.identifiers.add(identifier);
    if (this.identifiers.size > DEDUP_WINDOW_SIZE) {
      const oldest = this.identifiers.values().next().value;
      if (oldest !== undefined) this.identifiers.delete(oldest);
    }

    return false;
  } // end method isDuplicate

  clear(): void {
    this.identifiers.clear();
  } // end method clear
} // end class DedupWindow

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

  private pendingCommands = 0;
  private readonly dedupWindow = new DedupWindow();
  private readonly segmentListeners = new Map<
    string,
    ListenerSet<Parameters<MessageListener>>
  >();
  private readonly presenceListeners = new Map<
    string,
    ListenerSet<[PresenceEvent]>
  >();
  private readonly messageInterests = new Map<string, number>();
  private readonly presenceInterests = new Map<string, number>();
  private pendingPresenceQuery:
    | {
        readonly segmentId: string;
        readonly page: number;
        readonly perPage: number;
        readonly resolve: (page: PresencePage) => void;
        readonly reject: (error: ChannelError) => void;
        readonly cleanup: () => void;
      }
    | undefined;

  private readonly stateListeners = new ListenerSet<[ChannelState]>(() =>
    this.reportListenerFailure(),
  );
  private readonly recoveryListeners = new ListenerSet<[RecoveryEvent]>(() =>
    this.reportListenerFailure(),
  );
  // Error-listener exceptions are swallowed: reporting them would re-enter
  // error dispatch (emitError also guards against that re-entry).
  private readonly errorListeners = new ListenerSet<[ChannelError]>(
    () => undefined,
  );
  private readonly noticeListeners = new ListenerSet<[ServerNotice]>(() =>
    this.reportListenerFailure(),
  );
  private readonly handler: ChannelEventHandler = {
    onStateChange: (listener) => this.stateListeners.add(listener),
    onRecovery: (listener) => this.recoveryListeners.add(listener),
    onNotice: (listener) => this.noticeListeners.add(listener),
    onError: (listener) => this.errorListeners.add(listener),
  };

  private readonly segmentDelegates: SegmentDelegates = {
    addMessageListener: (segmentId, listener) =>
      this.addMessageListener(segmentId, listener),
    addPresenceListener: (segmentId, listener) =>
      this.addPresenceListener(segmentId, listener),
    addMessageInterest: (segmentId) => this.addMessageInterest(segmentId),
    addPresenceInterest: (segmentId) => this.addPresenceInterest(segmentId),
    publishToSegment: (segmentId, options) =>
      this.publishToSegment(segmentId, options),
    queryPresence: (segmentId, options) =>
      this.queryPresence(segmentId, options),
  };

  constructor(private readonly internals: ChannelInternals) {}

  get state(): ChannelState {
    return this.currentState;
  } // end getter state

  events(): ChannelEventHandler {
    return this.handler;
  } // end method events

  segment(segmentId?: string): Segment {
    const resolved = segmentId ?? DEFAULT_SEGMENT_ID;
    if (!identifierSchema.safeParse(resolved).success)
      throw new ConfigurationError("Invalid segment identifier.");

    return new Segment(resolved, this.segmentDelegates);
  } // end method segment

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
    this.dedupWindow.clear();
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

    this.rejectPendingPresenceQuery(
      new ConnectionError("Cancelled", "Channel closed."),
    );
    this.generation += 1;
    this.clearRetryTimer();
    this.attemptController?.abort();
    this.attemptController = undefined;

    const handle = this.detachHandle();
    this.setState("closing");

    if (handle) {
      handle.close();
      if (this.currentState !== "closed") {
        this.closeBudgetTimer = setTimeout(
          () => this.finishClose(),
          CLOSE_BUDGET_MS,
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

  // Detach the socket reference before acting on it so no event delivered
  // during the follow-up can re-enter through a stale handle.
  private detachHandle(): ConnectionHandle | undefined {
    const handle = this.handle;
    this.handle = undefined;
    return handle;
  } // end method detachHandle

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
      const handle = await openConnection(
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
          onMessage: (message) => this.routeMessage(generation, message),
          onClose: () => this.receiveSocketClose(generation),
          onError: (error) => this.receiveSocketError(generation, error),
        },
      );

      if (generation !== this.generation) {
        handle.close();
        throw new ConnectionError("Cancelled", "Connection attempt cancelled.");
      }

      this.handle = handle;
      this.pendingCommands = 0;
      this.connectedAtMonotonic = this.internals.clock();
      this.outage = undefined;

      try {
        this.flushInterests();
      } catch (error) {
        this.handle = undefined;
        handle.close();
        throw error;
      }
    } finally {
      callerSignal?.removeEventListener("abort", forwardAbort);
      if (this.attemptController === controller)
        this.attemptController = undefined;
    }
  } // end method attempt

  private addMessageListener(
    segmentId: string,
    listener: MessageListener,
  ): () => void {
    let listeners = this.segmentListeners.get(segmentId);

    if (!listeners) {
      listeners = new ListenerSet<Parameters<MessageListener>>(() =>
        this.reportListenerFailure(),
      );
      this.segmentListeners.set(segmentId, listeners);
    }

    return listeners.add(listener);
  } // end method addMessageListener

  private addPresenceListener(
    segmentId: string,
    listener: PresenceListener,
  ): () => void {
    let listeners = this.presenceListeners.get(segmentId);

    if (!listeners) {
      listeners = new ListenerSet<[PresenceEvent]>(() =>
        this.reportListenerFailure(),
      );
      this.presenceListeners.set(segmentId, listeners);
    }

    return listeners.add(listener);
  } // end method addPresenceListener

  private addMessageInterest(segmentId: string): Subscription {
    return this.addInterest(
      this.messageInterests,
      segmentId,
      () => {
        if (segmentId !== DEFAULT_SEGMENT_ID)
          this.sendInterestCommand({ command: "SUB", segmentId });
      },
      () => {
        if (
          segmentId !== DEFAULT_SEGMENT_ID &&
          !this.presenceInterests.has(segmentId)
        )
          this.sendInterestCommand({ command: "UNSUB", segmentId });
      },
    );
  } // end method addMessageInterest

  // Unlike message SUB/UNSUB, presence commands apply to every segment
  // including the default one: the server's connect-time auto-join grants
  // message membership only, never a presence subscription.
  private addPresenceInterest(segmentId: string): Subscription {
    return this.addInterest(
      this.presenceInterests,
      segmentId,
      () => this.sendInterestCommand({ command: "PRES_SUB", segmentId }),
      () => this.sendInterestCommand({ command: "PRES_UNSUB", segmentId }),
    );
  } // end method addPresenceInterest

  // Ref-counts one interest map entry; the callbacks run only while
  // connected, on the first registration and on the last cancellation.
  private addInterest(
    interests: Map<string, number>,
    segmentId: string,
    sendSubscribe: () => void,
    sendUnsubscribe: () => void,
  ): Subscription {
    if (this.currentState === "closing" || this.currentState === "closed")
      throw new ConnectionError("NotConnected", "Channel is closed.");

    const count = (interests.get(segmentId) ?? 0) + 1;
    interests.set(segmentId, count);
    if (count === 1 && this.currentState === "connected") sendSubscribe();

    let cancelled = false;
    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;

        const remaining = (interests.get(segmentId) ?? 1) - 1;

        if (remaining > 0) {
          interests.set(segmentId, remaining);
          return;
        }

        interests.delete(segmentId);
        if (this.currentState === "connected") sendUnsubscribe();
      },
    };
  } // end method addInterest

  private async queryPresence(
    segmentId: string,
    options: {
      readonly page: number;
      readonly perPage: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<PresencePage> {
    if (this.currentState !== "connected" || !this.handle)
      throw new ConnectionError("NotConnected", "Channel is not connected.");
    if (this.pendingPresenceQuery)
      throw new ConnectionError(
        "OperationInProgress",
        "A presence query is already in flight.",
      );
    if (options?.signal?.aborted)
      throw new ConnectionError("Cancelled", "Presence query cancelled.");

    const bytes = encodeClientCommand({
      command: "PRES_LIST",
      segmentId,
      page: options.page,
      perPage: options.perPage,
    });

    // A synchronous send failure rejects without ever taking the query slot.
    this.sendCommand(bytes);

    return await new Promise<PresencePage>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.retirePendingPresenceQuery(
            new ConnectionError("Timeout", "Presence query timed out."),
          ),
        this.internals.presenceQueryTimeoutMs,
      );
      const abort = (): void =>
        this.retirePendingPresenceQuery(
          new ConnectionError("Cancelled", "Presence query cancelled."),
        );
      options.signal?.addEventListener("abort", abort, { once: true });

      this.pendingPresenceQuery = {
        segmentId,
        page: options.page,
        perPage: options.perPage,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        },
      };
    });
  } // end method queryPresence

  private takePendingPresenceQuery():
    NonNullable<typeof this.pendingPresenceQuery> | undefined {
    const pending = this.pendingPresenceQuery;
    if (!pending) return undefined;

    this.pendingPresenceQuery = undefined;
    pending.cleanup();
    return pending;
  } // end method takePendingPresenceQuery

  private rejectPendingPresenceQuery(error: ChannelError): void {
    this.takePendingPresenceQuery()?.reject(error);
  } // end method rejectPendingPresenceQuery

  private rejectPresenceQueryOnConnectionLoss(): void {
    this.rejectPendingPresenceQuery(
      new ConnectionError(
        "Transport",
        "Connection lost during presence query.",
      ),
    );
  } // end method rejectPresenceQueryOnConnectionLoss

  // A query that was already submitted cannot be retried or correlated:
  // reject it and retire the connection into bounded recovery.
  private retirePendingPresenceQuery(error: ChannelError): void {
    const pending = this.takePendingPresenceQuery();
    if (!pending) return;

    pending.reject(error);
    const handle = this.detachHandle();
    // Enter reconnecting before closing so the (possibly synchronous)
    // native close event is dropped by the state gate.
    this.enterReconnecting();
    handle?.close();
  } // end method retirePendingPresenceQuery

  private async publishToSegment(
    segmentId: string,
    options: {
      readonly payload: Uint8Array;
      readonly messageId?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<void> {
    if (this.currentState !== "connected" || !this.handle)
      throw new ConnectionError("NotConnected", "Channel is not connected.");
    if (options?.signal?.aborted)
      throw new ConnectionError("Cancelled", "Publish cancelled.");

    const bytes = encodeClientCommand({
      command: "PUB",
      segmentId,
      messageId: options.messageId,
      payload: options.payload,
    });

    this.sendCommand(bytes);
  } // end method publishToSegment

  private sendCommand(bytes: Uint8Array): void {
    const handle = this.handle;
    if (!handle)
      throw new ConnectionError("NotConnected", "Channel is not connected.");

    // No native drain event exists: the command count resets whenever the
    // buffer is observed empty at send time (documented approximation).
    if (handle.bufferedAmount === 0) this.pendingCommands = 0;
    if (this.pendingCommands >= MAXIMUM_PENDING_COMMANDS)
      throw new ConnectionError("Backpressure", "Command writer is full.");

    handle.send(bytes);
    this.pendingCommands += 1;
  } // end method sendCommand

  // Runtime interest writes cannot leave stale remote interest silently
  // active: a failed SUB/UNSUB invalidates the socket and fails the channel.
  private sendInterestCommand(command: {
    command: "SUB" | "UNSUB" | "PRES_SUB" | "PRES_UNSUB";
    segmentId: string;
  }): void {
    try {
      this.sendCommand(encodeClientCommand(command));
    } catch (error) {
      this.detachHandle()?.close();
      this.failTerminal(
        error instanceof ConfigurationError || error instanceof ConnectionError
          ? error
          : new ConnectionError("Transport", "Interest update failed."),
      );
    }
  } // end method sendInterestCommand

  private flushInterests(): void {
    for (const segmentId of this.messageInterests.keys()) {
      if (segmentId === DEFAULT_SEGMENT_ID) continue;

      this.sendCommand(encodeClientCommand({ command: "SUB", segmentId }));
    }

    for (const segmentId of this.presenceInterests.keys()) {
      this.sendCommand(encodeClientCommand({ command: "PRES_SUB", segmentId }));
    }
  } // end method flushInterests

  private routeMessage(
    attemptGeneration: number,
    message: ServerMessage,
  ): void {
    if (attemptGeneration !== this.generation) return;

    switch (message.command) {
      case "ARRAY":
        for (const entry of message.messages)
          this.routeMessage(attemptGeneration, entry);
        return;
      case "MSG":
        this.deliverMessage(message);
        return;
      case "ERROR":
        // The server never closes the socket on an error frame; report it
        // once, with its own name and message, and remain connected. It is
        // uncorrelated to any command, because the protocol has no ids for
        // that (ERR-01).
        this.emitError(
          new ServerError(
            message.name,
            LENIENT_TEXT_DECODER.decode(message.message),
          ),
        );
        return;
      case "SERVER_MSG":
        this.noticeListeners.dispatch({
          timestamp: message.timestamp,
          payload: message.payload,
        });

        return;
      case "PRES_NOTIFY":
        this.deliverPresence(message);
        return;
      case "PRES_LIST_RESPONSE":
        this.receivePresenceResponse(message);
        return;
      default:
        return;
    }
  } // end method routeMessage

  private receivePresenceResponse(
    response: Extract<ServerMessage, { command: "PRES_LIST_RESPONSE" }>,
  ): void {
    const pending = this.pendingPresenceQuery;
    // Non-matching and unsolicited responses are unsolicited protocol
    // events; a pending query keeps waiting for its match.
    if (
      !pending ||
      response.segmentId !== pending.segmentId ||
      response.currentPage !== BigInt(pending.page) ||
      response.perPage !== BigInt(pending.perPage)
    ) {
      return;
    }

    this.takePendingPresenceQuery();
    pending.resolve({
      segmentId: response.segmentId,
      total: response.total,
      perPage: response.perPage,
      currentPage: response.currentPage,
      from: response.from,
      to: response.to,
      connections: response.connections,
    });
  } // end method receivePresenceResponse

  private deliverMessage(
    message: Extract<ServerMessage, { command: "MSG" }>,
  ): void {
    // REV-01, verified against the live server in C8: every MSG carries a
    // server-assigned id. A missing id leaves the message undeliverable —
    // it cannot be deduplicated — so it is dropped and reported, without
    // taking the connection down with it (DECODE-01).
    if (message.messageId === null) {
      this.emitError(
        new ProtocolError(
          "Server message is missing its identifier.",
          "messageId",
          0,
        ),
      );
      return;
    }

    // Ids are recorded before fanout, even with no listeners.
    if (this.dedupWindow.isDuplicate(message.messageId)) return;

    const listeners = this.segmentListeners.get(message.segmentId);
    if (!listeners) return;

    listeners.dispatch(message.payload, {
      tokenReference: message.tokenReference,
      segmentId: message.segmentId,
      messageId: message.messageId,
      timestamp: message.timestamp,
    });
  } // end method deliverMessage

  private deliverPresence(
    event: Extract<ServerMessage, { command: "PRES_NOTIFY" }>,
  ): void {
    const listeners = this.presenceListeners.get(event.segmentId);
    if (!listeners) return;

    listeners.dispatch({
      segmentId: event.segmentId,
      tokenReference: event.tokenReference,
      connectionId: event.connectionId,
      joined: event.joined,
      timestamp: event.timestamp,
    });
  } // end method deliverPresence

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
      // A frame that could not be decoded was dropped by the connection
      // layer, which left the socket open. Report it and stay connected:
      // decoding never spans frames, so the next one is unaffected
      // (DECODE-01).
      this.emitError(error);
      return;
    }

    this.enterReconnecting();
  } // end method receiveSocketError

  private enterReconnecting(): void {
    this.rejectPresenceQueryOnConnectionLoss();
    const now = this.internals.clock();
    if (now - this.connectedAtMonotonic >= RETRY_BUDGET_RESET_MS)
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
        if (this.retriesUsed >= MAXIMUM_RETRIES) {
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
    this.recoveryListeners.dispatch({
      retryIndex: attemptIndex,
      possibleGaps: true,
      possibleDuplicates: true,
    });
  } // end method runReconnectAttempt

  private failTerminal(error: ChannelError): void {
    this.rejectPresenceQueryOnConnectionLoss();
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
    this.stateListeners.dispatch(state);
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
      this.errorListeners.dispatch(error);
    } finally {
      this.dispatchingErrors = false;
    }
  } // end method emitError
} // end class Channel

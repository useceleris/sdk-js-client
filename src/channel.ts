import {
  CommandQueue,
  type InterestCommand,
  type InterestKind,
} from "./command-queue";
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
import { describeParseError } from "./parse-error";
import { computeReplayLookbackMs, computeRetryDelayMs } from "./reconnect";

import { Segment, type SegmentDelegates } from "./segment";
import {
  CLOSE_BUDGET_MS,
  DEFAULT_SEGMENT_ID,
  LENIENT_TEXT_DECODER,
  PRESENCE_LIST_COMMAND,
  MESSAGE_SIZE_LIMIT_ERROR_TYPE,
  RATE_LIMIT_ERROR_TYPE,
  RETRY_BUDGET_RESET_MS,
} from "./constants";

export type ChannelError =
  ConfigurationError | ConnectionError | ProtocolError | ServerError;

export type MessageMetadata = {
  readonly tokenReference: string;
  readonly segmentId: string;
  readonly messageId: string; // always present: the publisher's or the server's (REV-01)
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

export type PresencePage = {
  readonly segmentId: string;
  readonly total: number;
  readonly perPage: number;
  readonly currentPage: number;
  readonly from: number; // from > to possible; raw metadata preserved
  readonly to: number;
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
  // Every delivery from any segment, after that segment's listeners (MSG-02).
  onMessage(listener: MessageListener): () => void;
}

export type ChannelInternals = {
  readonly baseUrl: string;
  readonly channelReference: string;
  readonly allowInsecureLoopback: boolean;
  readonly connectTimeoutMs: number;
  readonly reconnectTimeoutMs: number;
  readonly presenceQueryTimeoutMs: number;
  readonly publishQueueSize: number;
  readonly deduplicationWindowSize: number;
  readonly maximumReconnectAttempts: number;
  readonly credentialProvider: CredentialProvider;
  readonly clock: () => number;
  readonly wallClock: () => number;
  readonly random: () => number;
  readonly generateMessageId: () => string;
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

  constructor(private readonly windowSize: number) {}

  // Returns false for an identifier already in the window. A new one is
  // recorded, evicting the oldest once the window is full.
  recordIfNew(identifier: string): boolean {
    if (this.identifiers.has(identifier)) return false;

    this.identifiers.add(identifier);
    if (this.identifiers.size > this.windowSize) {
      const oldest = this.identifiers.values().next().value;
      if (oldest !== undefined) this.identifiers.delete(oldest);
    }

    return true;
  } // end method recordIfNew

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

  private readonly commandQueue: CommandQueue;
  private readonly dedupWindow: DedupWindow;
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
  // Issues presence query request ids. Kept per channel rather than per
  // socket, so an id is never reused across reconnects (QUERY-01).
  private presenceRequestCount = 0;
  private pendingPresenceQuery:
    | {
        readonly requestId: string;
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

  private readonly channelMessageListeners = new ListenerSet<
    Parameters<MessageListener>
  >(() => this.reportListenerFailure());

  private readonly handler: ChannelEventHandler = {
    onStateChange: (listener) => this.stateListeners.add(listener),
    onRecovery: (listener) => this.recoveryListeners.add(listener),
    onNotice: (listener) => this.noticeListeners.add(listener),
    onError: (listener) => this.errorListeners.add(listener),
    onMessage: (listener) => this.channelMessageListeners.add(listener),
  };

  private readonly segmentDelegates: SegmentDelegates = {
    addMessageListener: (segmentId, listener) =>
      this.addMessageListener(segmentId, listener),
    addPresenceListener: (segmentId, listener) =>
      this.addPresenceListener(segmentId, listener),
    addMessageInterest: (segmentId) => this.addInterest("message", segmentId),
    addPresenceInterest: (segmentId) => this.addInterest("presence", segmentId),
    publishToSegment: (segmentId, options) =>
      this.publishToSegment(segmentId, options),
    queryPresence: (segmentId, options) =>
      this.queryPresence(segmentId, options),
  };

  constructor(private readonly internals: ChannelInternals) {
    this.commandQueue = new CommandQueue(
      {
        handle: () => this.handle,
        interestCommand: (kind, segmentId) =>
          this.interestCommand(kind, segmentId),
        receiveInterestWriteFailure: () => this.receiveInterestWriteFailure(),
        clock: () => this.internals.clock(),
        random: () => this.internals.random(),
      },
      internals.publishQueueSize,
    );
    this.dedupWindow = new DedupWindow(internals.deduplicationWindowSize);
  } // end constructor

  get state(): ChannelState {
    return this.currentState;
  } // end getter state

  events(): ChannelEventHandler {
    return this.handler;
  } // end method events

  segment(segmentId: string): Segment {
    const parsed = identifierSchema.safeParse(segmentId);

    if (!parsed.success) {
      throw new ConfigurationError(
        describeParseError("segment ID", parsed.error),
      );
    }

    return new Segment(segmentId, this.segmentDelegates);
  } // end method segment

  // The segment every connection joins automatically (SEG-01).
  defaultSegment(): Segment {
    return this.segment(DEFAULT_SEGMENT_ID);
  } // end method defaultSegment

  async connect(options?: { signal?: AbortSignal }): Promise<void> {
    if (
      this.currentState === "connecting" ||
      this.currentState === "connected" ||
      this.currentState === "reconnecting"
    ) {
      throw new ConnectionError(
        "OperationInProgress",
        `connect() was already called; the channel is ${this.currentState}.`,
      );
    }

    if (this.currentState === "closing" || this.currentState === "closed") {
      throw new ConnectionError(
        "NotConnected",
        "Channel is closed; create a new one with client.channel().",
      );
    }

    this.generation += 1;
    const generation = this.generation;
    this.retriesUsed = 0;
    this.outage = undefined;
    this.dedupWindow.clear();
    this.setState("connecting");

    try {
      await this.establishConnection({ reason: "initial" }, options?.signal);
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
      new ConnectionError(
        "Cancelled",
        "Channel closed while the presence query was pending.",
      ),
    );
    this.generation += 1;
    this.clearRetryTimer();
    this.attemptController?.abort();
    this.attemptController = undefined;
    this.commandQueue.reset(
      new ConnectionError(
        "Cancelled",
        "Channel closed before the publish was sent.",
      ),
    );

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

  // Opens the WebSocket, installs it, and re-sends every subscription.
  private async establishConnection(
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
          timeoutMs:
            recovery.reason === "reconnect"
              ? this.internals.reconnectTimeoutMs
              : this.internals.connectTimeoutMs,
          onMessage: (message) => this.routeMessage(generation, message),
          onClose: () => this.receiveSocketClose(generation),
          onError: (error) => this.receiveSocketError(generation, error),
        },
      );

      if (generation !== this.generation) {
        handle.close();
        throw new ConnectionError(
          "Cancelled",
          "Connection attempt cancelled: the channel was closed or a newer attempt started.",
        );
      }

      this.handle = handle;
      this.connectedAtMonotonic = this.internals.clock();
      this.outage = undefined;
      this.flushInterests();

      // A refused subscription write detaches the socket it was sent on.
      if (this.handle !== handle) {
        throw new ConnectionError(
          "Transport",
          "Restoring subscriptions failed: the socket refused a write.",
        );
      }
    } catch (error) {
      // Waiting publishes stay for the next attempt (QUEUE-01).
      this.commandQueue.resetConnectionState();
      throw error;
    } finally {
      callerSignal?.removeEventListener("abort", forwardAbort);
      if (this.attemptController === controller) {
        this.attemptController = undefined;
      }
    }
  } // end method establishConnection

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
    listener: (event: PresenceEvent) => void,
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

  // Ref-counts one interest; the first registration and the last
  // cancellation queue a sync of that segment's subscription.
  private addInterest(kind: InterestKind, segmentId: string): Subscription {
    if (this.currentState === "closing" || this.currentState === "closed") {
      throw new ConnectionError(
        "NotConnected",
        "Channel is closed; create a new one with client.channel().",
      );
    }

    const interests =
      kind === "message" ? this.messageInterests : this.presenceInterests;
    const count = (interests.get(segmentId) ?? 0) + 1;
    interests.set(segmentId, count);
    if (count === 1) this.queueInterestSync(kind, segmentId);

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
        this.queueInterestSync(kind, segmentId);
      },
    };
  } // end method addInterest

  // Without a socket there is nothing to sync: installing one syncs every
  // held interest.
  private queueInterestSync(kind: InterestKind, segmentId: string): void {
    if (this.handle) this.commandQueue.queueInterest(kind, segmentId);
  } // end method queueInterestSync

  // The command that brings the server in line with the segment's interest
  // as it stands now. Subscriptions are synced as state, so a resend is
  // always safe.
  private interestCommand(
    kind: InterestKind,
    segmentId: string,
  ): InterestCommand | undefined {
    // Presence applies to every segment, the default one included: the
    // server's connect-time auto-join grants message membership only.
    if (kind === "presence") {
      return {
        command: this.presenceInterests.has(segmentId)
          ? "PRES_SUB"
          : "PRES_UNSUB",
        segmentId,
      };
    }

    // The server joins the default segment on connect and never leaves it.
    if (segmentId === DEFAULT_SEGMENT_ID) return undefined;

    // Watching presence is not membership, so it never holds the segment.
    return {
      command: this.messageInterests.has(segmentId) ? "SUB" : "UNSUB",
      segmentId,
    };
  } // end method interestCommand

  // The server's view of this connection's subscriptions is now unknown, so
  // the socket is replaced: reconnecting re-sends every subscription.
  private receiveInterestWriteFailure(): void {
    const handle = this.detachHandle();
    if (this.currentState === "connected") this.enterReconnecting();

    handle?.close();
  } // end method receiveInterestWriteFailure

  private async queryPresence(
    segmentId: string,
    options: {
      readonly page: number;
      readonly perPage: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<PresencePage> {
    const handle = this.handle;

    if (this.currentState !== "connected" || !handle) {
      throw new ConnectionError(
        "NotConnected",
        `Channel is not connected; it is ${this.currentState}.`,
      );
    }

    if (this.pendingPresenceQuery) {
      throw new ConnectionError(
        "OperationInProgress",
        "A presence query is already in flight; wait for it to settle before starting another.",
      );
    }

    if (options?.signal?.aborted) {
      throw new ConnectionError(
        "Cancelled",
        "Presence query cancelled: its abort signal was already aborted.",
      );
    }

    this.presenceRequestCount += 1;
    const requestId = `${this.presenceRequestCount}`;
    const bytes = encodeClientCommand({
      command: "PRES_LIST",
      segmentId,
      page: options.page,
      perPage: options.perPage,
      requestId,
    });

    // A synchronous send failure rejects without ever taking the query slot.
    this.commandQueue.sendNow(handle, bytes);

    // A timed-out or cancelled query frees its slot and leaves the connection
    // alone: a late reply carries the old request id and is dropped.
    return await new Promise<PresencePage>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.rejectPendingPresenceQuery(
            new ConnectionError(
              "Timeout",
              `Presence query timed out after ${this.internals.presenceQueryTimeoutMs} ms.`,
            ),
          ),
        this.internals.presenceQueryTimeoutMs,
      );
      const abort = (): void =>
        this.rejectPendingPresenceQuery(
          new ConnectionError(
            "Cancelled",
            "Presence query cancelled by its abort signal.",
          ),
        );
      options.signal?.addEventListener("abort", abort, { once: true });

      this.pendingPresenceQuery = {
        requestId,
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
        "Connection lost during the presence query; query again once the channel reconnects.",
      ),
    );
  } // end method rejectPresenceQueryOnConnectionLoss

  private async publishToSegment(
    segmentId: string,
    options: {
      readonly payload: Uint8Array;
      readonly messageId?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<void> {
    // While reconnecting, the publish waits in the queue for the next socket
    // (QUEUE-01). Anywhere else no recovery is in progress.
    if (
      this.currentState !== "connected" &&
      this.currentState !== "reconnecting"
    ) {
      throw new ConnectionError(
        "NotConnected",
        `Channel is not connected; it is ${this.currentState}.`,
      );
    }

    if (options?.signal?.aborted) {
      throw new ConnectionError(
        "Cancelled",
        "Publish cancelled: its abort signal was already aborted.",
      );
    }

    const messageId = options.messageId ?? this.internals.generateMessageId();
    const bytes = encodeClientCommand({
      command: "PUB",
      segmentId,
      messageId,
      payload: options.payload,
    });

    return this.commandQueue.publish(
      segmentId,
      messageId,
      bytes,
      options.signal,
    );
  } // end method publishToSegment

  // Restoration goes through the queue, so it waits for writer room and
  // reaches the server before any publish, messages first, then presence.
  private flushInterests(): void {
    const messages = Array.from(this.messageInterests.keys(), (segmentId) => ({
      kind: "message" as const,
      segmentId,
    }));

    const presence = Array.from(this.presenceInterests.keys(), (segmentId) => ({
      kind: "presence" as const,
      segmentId,
    }));

    this.commandQueue.restoreInterests([...messages, ...presence]);
  } // end method flushInterests

  private routeMessage(
    attemptGeneration: number,
    message: ServerMessage,
  ): void {
    if (attemptGeneration !== this.generation) return;

    switch (message.command) {
      case "ARRAY":
        for (const entry of message.messages) {
          this.routeMessage(attemptGeneration, entry);
        }

        return;
      case "MSG":
        this.deliverMessage(message);
        return;
      case "ERROR": {
        // The server never closes the socket on an error frame; report it
        // once, every field as sent, and remain connected (ERR-01).
        const error = new ServerError(
          message.type,
          message.subType,
          LENIENT_TEXT_DECODER.decode(message.message),
          message.resource,
        );

        // A presence query error names its query by request id and answers
        // that query alone. A stale id belongs to a query that was already
        // rejected and reported, so it is dropped (QUERY-01).
        if (message.subType === PRESENCE_LIST_COMMAND) {
          if (message.resource === this.pendingPresenceQuery?.requestId) {
            this.rejectPendingPresenceQuery(error);
          }

          return;
        }

        if (message.type === RATE_LIMIT_ERROR_TYPE) {
          this.commandQueue.receiveRateLimit();
        }

        // A publish refused for its size names itself by message id; the
        // other commands in its frame ran (BATCH-01).
        if (
          message.type === MESSAGE_SIZE_LIMIT_ERROR_TYPE &&
          message.subType === "PUB" &&
          typeof message.resource === "string"
        ) {
          this.commandQueue.forgetPublish(message.resource);
        }

        this.emitError(error);
        return;
      }

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
    // A response carrying any other request id answers a query that already
    // failed, so it is dropped; a pending query keeps waiting for its own.
    if (!pending || response.requestId !== pending.requestId) return;

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
    // REV-01, verified against the live server in C8: every MSG carries an
    // id, the publisher's or one the server assigns. A missing id leaves the
    // message undeliverable — it cannot be deduplicated — so it is dropped
    // and reported, without taking the connection down with it (DECODE-01).
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
    if (!this.dedupWindow.recordIfNew(message.messageId)) return;

    const metadata: MessageMetadata = {
      tokenReference: message.tokenReference,
      segmentId: message.segmentId,
      messageId: message.messageId,
      timestamp: message.timestamp,
    };

    // The segment's listeners first, then the channel's (MSG-02).
    this.segmentListeners
      .get(message.segmentId)
      ?.dispatch(message.payload, metadata);
    this.channelMessageListeners.dispatch(message.payload, metadata);
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
    this.commandQueue.resetConnectionState();
    const now = this.internals.clock();

    if (now - this.connectedAtMonotonic >= RETRY_BUDGET_RESET_MS) {
      this.retriesUsed = 0;
    }

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
      await this.establishConnection({
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
        if (this.retriesUsed >= this.internals.maximumReconnectAttempts) {
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
          : new ConnectionError(
              "Transport",
              "Reconnect attempt failed with an unexpected error.",
            ),
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

  // Waiting publishes fail with the error onError reports (QUEUE-01).
  private failTerminal(error: ChannelError): void {
    this.rejectPresenceQueryOnConnectionLoss();
    this.commandQueue.reset(error);
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
      new ConnectionError(
        "Transport",
        "A listener callback threw; the channel caught the error and kept running.",
      ),
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

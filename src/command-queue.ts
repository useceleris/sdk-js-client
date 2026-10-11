import type { ChannelError } from "./channel";
import type { ConnectionHandle } from "./connection";
import { encodeBatch, encodeClientCommand } from "./encode";
import { ConnectionError } from "./errors";
import { computeRetryDelayMs } from "./reconnect";
import {
  DRAIN_RETRY_MS,
  MAXIMUM_BATCH_BYTES,
  MAXIMUM_BATCH_COMMANDS,
  MAXIMUM_CONSECUTIVE_RATE_LIMITS,
  MAXIMUM_PENDING_COMMANDS,
  MAXIMUM_PUBLISH_RESENDS,
  QUOTA_PROBE_FIRST_DELAY_MS,
  QUOTA_RETURN_CONFIRMATION_MS,
  QUOTA_PROBE_MAXIMUM_DELAY_MS,
  RATE_LIMIT_COOLDOWN_MS,
  RATE_LIMIT_SUSPECT_WINDOW_MS,
} from "./constants";

export type InterestKind = "message" | "presence";

export type InterestCommand = {
  readonly command: "SUB" | "UNSUB" | "PRES_SUB" | "PRES_UNSUB";
  readonly segmentId: string;
};

export type CommandQueueDelegates = {
  readonly handle: () => ConnectionHandle | undefined;
  // The command that brings the server in line with the segment's interest
  // as it stands now, or undefined when nothing needs sending.
  readonly interestCommand: (
    kind: InterestKind,
    segmentId: string,
  ) => InterestCommand | undefined;
  // The socket refused a subscription write, so the server's view of this
  // connection's subscriptions is unknown.
  readonly receiveInterestWriteFailure: () => void;
  readonly clock: () => number;
  readonly random: () => number;
};

type QueuedPublish = {
  readonly segmentId: string;
  readonly messageId: string;
  readonly bytes: Uint8Array;
  // Its place in the order commands were queued in.
  readonly sequence: number;
  resends: number;
  // Settles the caller's promise; undefined once settled.
  settle: ((error?: ChannelError) => void) | undefined;
};

type PendingInterest = {
  readonly kind: InterestKind;
  readonly segmentId: string;
  readonly sequence: number;
};

// A command taken for the frame being packed.
type BatchedCommand =
  | (PendingInterest & { readonly bytes: Uint8Array })
  | { readonly publish: QueuedPublish; readonly bytes: Uint8Array };

const INTEREST_KINDS: readonly InterestKind[] = ["message", "presence"];

// Sends subscription changes ahead of publishes, packs the commands waiting
// when it sends into one frame (BATCH-01), waits out a full writer, and
// resends recent commands after a rate limit (RESEND-01). The server never
// says which frame a rate limit dropped, so everything sent within the suspect
// window is resent: subscriptions as their current state, publishes once and
// with their original message id, so receivers drop any copy that got through.
// Waiting publishes outlive a dropped socket and go out on the next one, after
// the restored subscriptions (QUEUE-01).
export class CommandQueue {
  // Segment → the sequence of its latest change.
  private readonly pendingInterests: Record<InterestKind, Map<string, number>> =
    { message: new Map(), presence: new Map() };

  private publishes: QueuedPublish[] = [];
  private sequence = 0;
  private recentInterests: {
    readonly kind: InterestKind;
    readonly segmentId: string;
    readonly sentAt: number;
  }[] = [];

  // Holds payloads, so it keeps no more than MAXIMUM_PENDING_COMMANDS.
  private recentPublishes: {
    readonly publish: QueuedPublish;
    readonly sentAt: number;
  }[] = [];

  private pendingCommands = 0;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  private rateLimitStreak = 0;
  private rateLimitStreakEndsAt = 0;
  // Subscriptions dropped while the limit was treated as a used-up quota,
  // re-sent by a probe on a slow, doubling schedule.
  private readonly abandonedInterests: Record<InterestKind, Set<string>> = {
    message: new Set(),
    presence: new Set(),
  };

  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private probeCount = 0;
  private firstSentSinceRateLimitAt: number | undefined;

  constructor(
    private readonly delegates: CommandQueueDelegates,
    private readonly publishQueueSize: number,
  ) {}

  queueInterest(kind: InterestKind, segmentId: string): void {
    this.markInterest(kind, segmentId);
    this.drain();
  } // end method queueInterest

  // Resolves once the publish is handed to the socket.
  publish(
    segmentId: string,
    messageId: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.publishes.length >= this.publishQueueSize) {
      return Promise.reject(
        new ConnectionError(
          "Backpressure",
          `The publish queue is full (size ${this.publishQueueSize}). Retry once some publishes have gone out.`,
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const withdraw = (): void => {
        const index = this.publishes.indexOf(publish);
        if (index >= 0) this.publishes.splice(index, 1);

        publish.settle?.(
          new ConnectionError(
            "Cancelled",
            "Publish cancelled by its abort signal before it was sent.",
          ),
        );
      };

      this.sequence += 1;
      const publish: QueuedPublish = {
        segmentId,
        messageId,
        bytes,
        sequence: this.sequence,
        resends: 0,
        settle: (error) => {
          publish.settle = undefined;
          signal?.removeEventListener("abort", withdraw);
          if (error) reject(error);
          else resolve();
        },
      };

      signal?.addEventListener("abort", withdraw, { once: true });
      this.publishes.push(publish);
      this.drain();
    });
  } // end method publish

  // For commands that are never queued or resent, such as presence queries.
  sendNow(handle: ConnectionHandle, bytes: Uint8Array): void {
    if (this.pauseTimer !== undefined) {
      throw new ConnectionError(
        "Backpressure",
        "Sending is paused after a rate limit; try again in a moment.",
      );
    }

    if (!this.hasRoom(handle)) {
      throw new ConnectionError(
        "Backpressure",
        `Command writer is full: ${MAXIMUM_PENDING_COMMANDS} commands are waiting to be sent. Retry once the socket has flushed them.`,
      );
    }

    handle.send(bytes);
    this.pendingCommands += 1;
    this.firstSentSinceRateLimitAt ??= this.delegates.clock();
  } // end method sendNow

  receiveRateLimit(): void {
    // A limit arriving while sending is paused, with nothing sent since the
    // last one, reports the same episode through another limit type (the
    // server throttles each type separately). It carries nothing new.
    if (
      this.pauseTimer !== undefined &&
      this.firstSentSinceRateLimitAt === undefined
    ) {
      return;
    }

    const now = this.delegates.clock();
    this.endProbingIfQuotaReturned(now, QUOTA_RETURN_CONFIRMATION_MS);

    // While probing the streak holds, so a probe's own limit cannot start
    // another full run of resends.
    if (this.probeCount === 0 && now > this.rateLimitStreakEndsAt) {
      this.rateLimitStreak = 0;
    }

    // A limit that keeps returning is a used-up quota rather than a burst,
    // and resending into it would never succeed.
    if (this.rateLimitStreak < MAXIMUM_CONSECUTIVE_RATE_LIMITS) {
      this.requeueRecent(now);
    } else {
      this.abandonRecent();
    }

    this.recentInterests = [];
    this.recentPublishes = [];
    this.firstSentSinceRateLimitAt = undefined;

    const delay =
      RATE_LIMIT_COOLDOWN_MS +
      computeRetryDelayMs(this.rateLimitStreak, this.delegates.random);
    this.rateLimitStreak += 1;
    this.rateLimitStreakEndsAt = now + delay + RATE_LIMIT_SUSPECT_WINDOW_MS;

    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = undefined;
      this.drain();
    }, delay);
  } // end method receiveRateLimit

  // The server refused this publish for its size, so a later rate limit must
  // not send it, and bill it, again.
  forgetPublish(messageId: string): void {
    this.recentPublishes = this.recentPublishes.filter(
      (sent) => sent.publish.messageId !== messageId,
    );
  } // end method forgetPublish

  // Restored subscriptions go ahead of every waiting publish, even one queued
  // earlier to the same segment, so the connection is a member of its
  // segments again before the publishes go out (QUEUE-01). Drains once all
  // are marked, so no publish slips between them.
  restoreInterests(
    interests: readonly { kind: InterestKind; segmentId: string }[],
  ): void {
    for (const { kind, segmentId } of interests) {
      this.pendingInterests[kind].set(segmentId, 0);
    }

    this.drain();
  } // end method restoreInterests

  // Waiting publishes fail with the error, and the socket state is cleared.
  reset(error: ChannelError): void {
    this.resetConnectionState();

    const publishes = this.publishes;
    this.publishes = [];
    for (const publish of publishes) publish.settle?.(error);
  } // end method reset

  // Nothing tied to the lost socket carries over: the next socket re-syncs
  // every subscription itself, and nothing it was handed is resent. Waiting
  // publishes stay for the next socket. The rate-limit streak and the probe
  // schedule stay too: a reconnect does not refill a quota.
  resetConnectionState(): void {
    clearTimeout(this.drainTimer);
    clearTimeout(this.pauseTimer);
    clearTimeout(this.probeTimer);
    this.drainTimer = undefined;
    this.pauseTimer = undefined;
    this.probeTimer = undefined;

    for (const kind of INTEREST_KINDS) {
      this.pendingInterests[kind].clear();
      this.abandonedInterests[kind].clear();
    }

    this.recentInterests = [];
    this.recentPublishes = [];
    this.pendingCommands = 0;
    this.firstSentSinceRateLimitAt = undefined;
  } // end method resetConnectionState

  // A newer change takes a newer sequence, so the sync follows every publish
  // queued before it.
  private markInterest(kind: InterestKind, segmentId: string): void {
    this.sequence += 1;
    this.pendingInterests[kind].set(segmentId, this.sequence);
  } // end method markInterest

  private requeueRecent(now: number): void {
    for (const sent of this.recentInterests) {
      if (now - sent.sentAt <= RATE_LIMIT_SUSPECT_WINDOW_MS) {
        this.markInterest(sent.kind, sent.segmentId);
      }
    }

    const resent: QueuedPublish[] = [];

    for (const sent of this.recentPublishes) {
      if (
        now - sent.sentAt <= RATE_LIMIT_SUSPECT_WINDOW_MS &&
        sent.publish.resends < MAXIMUM_PUBLISH_RESENDS
      ) {
        sent.publish.resends += 1;
        resent.push(sent.publish);
      }
    }

    this.publishes = [...resent, ...this.publishes];
  } // end method requeueRecent

  // Recent publishes are dropped; recent subscriptions wait for a probe.
  // Every subscription sent since the previous limit is handed to the probe,
  // however late the report: syncs are idempotent, so over-abandoning costs
  // at most a redundant frame, while missing one loses the subscription.
  private abandonRecent(): void {
    for (const sent of this.recentInterests) {
      this.abandonedInterests[sent.kind].add(sent.segmentId);
    }

    const abandoned = INTEREST_KINDS.some(
      (kind) => this.abandonedInterests[kind].size > 0,
    );
    if (!abandoned || this.probeTimer !== undefined) return;

    const delay = Math.min(
      QUOTA_PROBE_MAXIMUM_DELAY_MS,
      QUOTA_PROBE_FIRST_DELAY_MS * 2 ** this.probeCount,
    );
    this.probeCount += 1;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined;
      this.restoreAbandoned();
      this.drain();
    }, delay);
  } // end method abandonRecent

  private restoreAbandoned(): void {
    for (const kind of INTEREST_KINDS) {
      for (const segmentId of this.abandonedInterests[kind]) {
        this.markInterest(kind, segmentId);
      }

      this.abandonedInterests[kind].clear();
    }
  } // end method restoreAbandoned

  // Commands that went `quietSpanMs` without a rate limit following them
  // mean the quota is back: abandoned subscriptions are restored at once.
  private endProbingIfQuotaReturned(now: number, quietSpanMs: number): void {
    if (
      this.probeCount === 0 ||
      this.firstSentSinceRateLimitAt === undefined ||
      now - this.firstSentSinceRateLimitAt <= quietSpanMs
    ) {
      return;
    }

    clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    this.probeCount = 0;
    this.rateLimitStreak = 0;
    this.restoreAbandoned();
  } // end method endProbingIfQuotaReturned

  private drain(): void {
    const handle = this.delegates.handle();
    if (!handle || this.pauseTimer !== undefined) return;

    this.endProbingIfQuotaReturned(
      this.delegates.clock(),
      RATE_LIMIT_SUSPECT_WINDOW_MS,
    );

    while (this.sendBatch(handle));
  } // end method drain

  // Sends the waiting commands as one frame. False when draining has to stop.
  private sendBatch(handle: ConnectionHandle): boolean {
    if (!this.nextCommand()) return false;

    if (!this.hasRoom(handle)) {
      this.scheduleDrain();
      return false;
    }

    const batch = this.packBatch(
      MAXIMUM_PENDING_COMMANDS - this.pendingCommands,
    );

    try {
      handle.send(encodeBatch(batch.map((command) => command.bytes)));
    } catch (error) {
      if (error instanceof ConnectionError && error.code === "Backpressure") {
        this.unpackBatch(batch);
        this.scheduleDrain();
        return false;
      }

      return this.failBatch(batch, error as ChannelError);
    }

    this.pendingCommands += batch.length;
    this.firstSentSinceRateLimitAt ??= this.delegates.clock();

    for (const command of batch) {
      if ("publish" in command) {
        this.recordSentPublish(command.publish);
        command.publish.settle?.();
      } else {
        this.recordSentInterest(command.kind, command.segmentId);
      }
    }

    return true;
  } // end method sendBatch

  // Takes the waiting commands for one frame, in order: at most `room` and
  // MAXIMUM_BATCH_COMMANDS of them, within MAXIMUM_BATCH_BYTES with the array
  // header. A first command larger than that goes alone.
  private packBatch(room: number): BatchedCommand[] {
    const batch: BatchedCommand[] = [];
    let byteLength = 0;

    while (batch.length < Math.min(room, MAXIMUM_BATCH_COMMANDS)) {
      const command = this.nextCommand();
      if (!command) break;

      const frameLength =
        `*${batch.length + 1}\n`.length + byteLength + command.bytes.byteLength;
      if (batch.length > 0 && frameLength > MAXIMUM_BATCH_BYTES) break;

      if ("publish" in command) {
        this.publishes.shift();
      } else {
        this.pendingInterests[command.kind].delete(command.segmentId);
      }

      batch.push(command);
      byteLength += command.bytes.byteLength;
    }

    return batch;
  } // end method packBatch

  // The next command to send, left in place. A subscription change that needs
  // nothing sent is done here.
  private nextCommand(): BatchedCommand | undefined {
    for (
      let interest = this.nextReadyInterest();
      interest;
      interest = this.nextReadyInterest()
    ) {
      const command = this.delegates.interestCommand(
        interest.kind,
        interest.segmentId,
      );
      if (command) return { ...interest, bytes: encodeClientCommand(command) };

      this.pendingInterests[interest.kind].delete(interest.segmentId);
    }

    const publish = this.publishes[0];
    return publish && { publish, bytes: publish.bytes };
  } // end method nextCommand

  // The socket had no room for the frame, so its commands wait again.
  private unpackBatch(batch: readonly BatchedCommand[]): void {
    const publishes: QueuedPublish[] = [];

    for (const command of batch) {
      if ("publish" in command) {
        publishes.push(command.publish);
      } else {
        this.pendingInterests[command.kind].set(
          command.segmentId,
          command.sequence,
        );
      }
    }

    this.publishes = [...publishes, ...this.publishes];
  } // end method unpackBatch

  // Every publish in a frame the socket refused fails with its error;
  // ConnectionHandle.send throws nothing but SDK errors, such as
  // DeliveryUnknown. A refused subscription change leaves the server's view
  // unknown, so draining stops.
  private failBatch(
    batch: readonly BatchedCommand[],
    error: ChannelError,
  ): boolean {
    for (const command of batch) {
      if ("publish" in command) command.publish.settle?.(error);
    }

    if (batch.every((command) => "publish" in command)) return true;

    this.delegates.receiveInterestWriteFailure();
    return false;
  } // end method failBatch

  // The first subscription change with no earlier publish to its segment
  // still queued: the commands for one segment keep their call order, so a
  // change follows the publishes queued before it (RESEND-01).
  private nextReadyInterest(): PendingInterest | undefined {
    for (const kind of INTEREST_KINDS) {
      for (const [segmentId, sequence] of this.pendingInterests[kind]) {
        const blocked = this.publishes.some(
          (publish) =>
            publish.segmentId === segmentId && publish.sequence < sequence,
        );

        if (!blocked) return { kind, segmentId, sequence };
      }
    }

    return undefined;
  } // end method nextReadyInterest

  // No native drain event exists: the command count resets whenever the
  // buffer is observed empty (documented approximation).
  private hasRoom(handle: ConnectionHandle): boolean {
    if (handle.bufferedAmount === 0) this.pendingCommands = 0;

    return this.pendingCommands < MAXIMUM_PENDING_COMMANDS;
  } // end method hasRoom

  private recordSentInterest(kind: InterestKind, segmentId: string): void {
    const now = this.delegates.clock();

    while (
      this.recentInterests.length > 0 &&
      now - this.recentInterests[0]!.sentAt > RATE_LIMIT_SUSPECT_WINDOW_MS
    ) {
      this.recentInterests.shift();
    }

    this.recentInterests.push({ kind, segmentId, sentAt: now });
  } // end method recordSentInterest

  private recordSentPublish(publish: QueuedPublish): void {
    const now = this.delegates.clock();

    while (
      this.recentPublishes.length > 0 &&
      (this.recentPublishes.length >= MAXIMUM_PENDING_COMMANDS ||
        now - this.recentPublishes[0]!.sentAt > RATE_LIMIT_SUSPECT_WINDOW_MS)
    ) {
      this.recentPublishes.shift();
    }

    this.recentPublishes.push({ publish, sentAt: now });
  } // end method recordSentPublish

  private scheduleDrain(): void {
    if (this.drainTimer !== undefined) return;

    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drain();
    }, DRAIN_RETRY_MS);
  } // end method scheduleDrain
} // end class CommandQueue

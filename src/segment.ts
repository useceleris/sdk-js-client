import type { Message, PresencePage, Subscription } from "./channel";

export type SegmentDelegates = {
  addMessageListener(
    segmentId: string,
    listener: (message: Message) => void,
  ): () => void;
  addMessageInterest(segmentId: string): Subscription;
  addPresenceInterest(segmentId: string): Subscription;
  publishToSegment(
    segmentId: string,
    options: {
      readonly payload: Uint8Array;
      readonly messageId?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<void>;
  queryPresence(
    segmentId: string,
    options: {
      readonly page: number;
      readonly perPage: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<PresencePage>;
};

export class Segment {
  // A stateless proxy over its channel's single connection: it holds only
  // its segment identifier and the channel's delegate functions. All
  // connection state, interest counts and listeners live on the channel.
  constructor(
    readonly segmentId: string,
    private readonly delegates: SegmentDelegates,
  ) {}

  subscribe(): Subscription {
    return this.delegates.addMessageInterest(this.segmentId);
  } // end method subscribe

  onMessage(listener: (message: Message) => void): () => void {
    return this.delegates.addMessageListener(this.segmentId, listener);
  } // end method onMessage

  publish(options: {
    readonly payload: Uint8Array;
    readonly messageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    return this.delegates.publishToSegment(this.segmentId, options);
  } // end method publish

  subscribePresence(): Subscription {
    return this.delegates.addPresenceInterest(this.segmentId);
  } // end method subscribePresence

  presenceList(options: {
    readonly page: number;
    readonly perPage: number;
    readonly signal?: AbortSignal;
  }): Promise<PresencePage> {
    return this.delegates.queryPresence(this.segmentId, options);
  } // end method presenceList
} // end class Segment

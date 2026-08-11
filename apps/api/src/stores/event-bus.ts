import {
  SSE_BUFFER_SIZE,
  type CheckoutSessionView,
  type SseEnvelope,
  type SseEventType,
} from "@gametime/contracts";

type Subscriber = (envelope: SseEnvelope) => void;

interface Channel {
  nextId: number;
  buffer: SseEnvelope[];
  subscribers: Set<Subscriber>;
}

/**
 * One channel per session, plus a capped buffer of recent events so a client
 * that drops off can be caught up on what it missed.
 *
 * The buffer is the whole point. Without it, a client that briefly lost its
 * connection would reconnect and sit there silently out of date. If it fell
 * further behind than the buffer holds, it still receives a full copy of the
 * current state, so it recovers either way.
 *
 * In production this would be Redis: pub/sub to reach every server, and a
 * capped stream for the replay buffer.
 */
export class SessionEventBus {
  private channels = new Map<string, Channel>();

  private channel(sessionId: string): Channel {
    let existing = this.channels.get(sessionId);
    if (!existing) {
      existing = { nextId: 1, buffer: [], subscribers: new Set() };
      this.channels.set(sessionId, existing);
    }
    return existing;
  }

  publish(sessionId: string, type: SseEventType, view: CheckoutSessionView): SseEnvelope {
    const channel = this.channel(sessionId);
    const envelope: SseEnvelope = { id: channel.nextId++, type, view };

    channel.buffer.push(envelope);
    if (channel.buffer.length > SSE_BUFFER_SIZE) channel.buffer.shift();

    for (const subscriber of channel.subscribers) {
      // One dead connection must not stop the others being notified.
      try {
        subscriber(envelope);
      } catch {
        /* the SSE route cleans up on close */
      }
    }
    return envelope;
  }

  /** Sends everything after `lastEventId` first, then subscribes. Returns an unsubscribe function. */
  subscribe(sessionId: string, subscriber: Subscriber, lastEventId?: number): () => void {
    const channel = this.channel(sessionId);

    if (lastEventId !== undefined && Number.isFinite(lastEventId)) {
      for (const envelope of channel.buffer) {
        if (envelope.id > lastEventId) subscriber(envelope);
      }
    }

    channel.subscribers.add(subscriber);
    return () => channel.subscribers.delete(subscriber);
  }

  subscriberCount(sessionId: string): number {
    return this.channels.get(sessionId)?.subscribers.size ?? 0;
  }

  /**
   * Remove the channel for a deleted session. Capping the buffer is not enough
   * on its own: without this, the map gains one entry for every checkout ever
   * started and never loses any.
   */
  dropSession(sessionId: string): void {
    this.channels.delete(sessionId);
  }

  clear(): void {
    this.channels.clear();
  }
}
